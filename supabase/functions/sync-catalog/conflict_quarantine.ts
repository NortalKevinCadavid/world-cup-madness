/**
 * Slice 002 / T040 — per-row conflict-quarantine classifier for the
 * sync-catalog coordinator.
 *
 * Pure-function module: takes a single fixture (or result) plus a snapshot of
 * the matching catalog row and decides whether the incoming row should land
 * in `public.match_pending_review` instead of being applied to `matches` /
 * `match_results`. Per spec Clarifications 2026-05-15 Q2 the quarantine path
 * is PER ROW — sibling rows in the same payload continue to apply normally
 * (the hybrid abort/quarantine policy). Structural anomalies (R-004) live
 * in `payload_sanity.ts`; this module owns only the cross-run conflict
 * branches (R-005).
 *
 * Conflict_class vocabulary (D-006 reconciliation)
 *   Migration 0023 (`match_pending_review`) ships a CHECK whitelist with:
 *     'team_assignment_change' | 'status_backward_transition' |
 *     'score_before_finished'  | 'kickoff_change_after_lock' |
 *     'unknown_team'           | 'other'
 *   Older research drafts used `_changed` and `score_before_kickoff`; the
 *   migration is the load-bearing contract. Every verdict this module
 *   produces is one of those exact strings so the INSERT will not trip the
 *   CHECK at runtime.
 *
 * Why split it out
 *   The coordinator file is now ~750 lines and T040 + T041 both add branches
 *   into the same UPSERT loop. Pulling the conflict classifier into a pure
 *   function keeps the coordinator's quarantine branch small (lookup
 *   existing → call classify → on quarantine: INSERT row + continue) and
 *   makes the decision trivially Deno-test-able without a Postgres harness.
 */

import type { NormalizedFixture } from '../_shared/providers/types.ts';

/**
 * The six conflict classes migration 0023 accepts. Free text in the DB so
 * future slices can add more without an ALTER; this union pins the strings
 * the coordinator is allowed to emit today.
 */
export type ConflictKind =
  | 'team_assignment_change'
  | 'status_backward_transition'
  | 'kickoff_change_after_lock'
  | 'score_before_finished'
  | 'unknown_team'
  | 'other';

/**
 * Snapshot of the existing matches row at the moment of detection. The
 * coordinator joins through match_provider_external_ids to find the row;
 * a NULL snapshot means there is no existing match for the provider's
 * (provider_name, provider_match_id) pair — i.e., this is a brand-new
 * fixture introduction.
 */
export interface ExistingMatchSnapshot {
  id: string;
  home_team_id: string;
  away_team_id: string;
  status: 'scheduled' | 'in_progress' | 'finished' | 'postponed' | 'cancelled';
  kickoff_utc: string;
}

/**
 * Inputs the coordinator passes for each incoming fixture. homeTeamId /
 * awayTeamId are the resolved internal UUIDs (or NULL if the provider's
 * short_code did not map to any team row — surface area for the
 * `unknown_team` class). lockWindowMinutes is currently hard-coded to 60
 * pending Slice 003's lock-window read; kickoffToleranceMinutes comes from
 * `tournament_config.provider_sync.kickoff_tolerance_minutes` (default 5).
 */
export interface ClassifyMatchInput {
  fixture: NormalizedFixture;
  existing: ExistingMatchSnapshot | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  lockWindowMinutes: number;
  kickoffToleranceMinutes: number;
  /** Optional clock override for deterministic unit tests. Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Verdict discriminator. `ok` proceeds to UPSERT; `quarantine` diverts the
 * row to match_pending_review with the specific conflict_class.
 */
export type MatchVerdict =
  | { kind: 'ok' }
  | { kind: 'quarantine'; conflict_class: ConflictKind };

/**
 * Classify a single incoming fixture against the existing catalog row.
 *
 * Detection order (matters for the test gates):
 *   1. unknown_team — homeTeamId or awayTeamId did not resolve from
 *      teams.short_code. Cheapest check, also the most catastrophic if we
 *      let it through (an UPSERT with NULL team_id would violate the NOT
 *      NULL constraint on matches.home_team_id / away_team_id).
 *   2. No existing row → ok (brand-new fixture; coordinator INSERTs).
 *   3. team_assignment_change — incoming home or away team_id differs from
 *      the existing row. Per spec Edge Case "team A vs B at one time, team A
 *      vs C the next", this MUST be quarantined, never auto-merged.
 *   4. status_backward_transition — finished → in_progress, finished →
 *      scheduled, in_progress → scheduled. Only scheduled / in_progress /
 *      finished participate in the forward ladder; postponed / cancelled
 *      are unordered and never trip this branch (per data-model.md § Entity
 *      2 status lifecycle).
 *   5. kickoff_change_after_lock — kickoff_utc moved by more than the
 *      configured tolerance AND we are already inside the lock window (60
 *      minutes before existing kickoff). The lock window comes from Slice
 *      003 (not yet shipped); we hard-code 60 minutes today and read from
 *      tournament_config once Slice 003 lands.
 */
export function classifyMatch(input: ClassifyMatchInput): MatchVerdict {
  const {
    fixture,
    existing,
    homeTeamId,
    awayTeamId,
    lockWindowMinutes,
    kickoffToleranceMinutes,
    nowMs,
  } = input;

  // ----- 1. unknown_team -----------------------------------------------------
  // Either side of the fixture is a team we don't have in the catalog. The
  // matches table requires non-null home_team_id + away_team_id; without the
  // mapping we cannot UPSERT, so quarantine is the only safe path.
  if (homeTeamId === null || awayTeamId === null) {
    return { kind: 'quarantine', conflict_class: 'unknown_team' };
  }

  // ----- 2. brand-new fixture -----------------------------------------------
  // No existing row means this is the first time we've seen this provider
  // pair (provider_name, provider_match_id). The coordinator INSERTs it.
  if (!existing) {
    return { kind: 'ok' };
  }

  // ----- 3. team_assignment_change ------------------------------------------
  // Either home or away team_id differs from the existing matches row. Spec
  // Edge Case + Clarifications Q2: per-row team change must quarantine, the
  // existing row is the source of truth until an admin resolves.
  if (
    existing.home_team_id !== homeTeamId ||
    existing.away_team_id !== awayTeamId
  ) {
    return { kind: 'quarantine', conflict_class: 'team_assignment_change' };
  }

  // ----- 4. status_backward_transition --------------------------------------
  // Only the forward ladder is ordered: scheduled < in_progress < finished.
  // postponed / cancelled sit outside the ladder (terminal admin states) and
  // are NOT treated as backward transitions — those are admin-driven
  // overrides handled in Slice 006, not provider sync anomalies.
  const ladder: ExistingMatchSnapshot['status'][] = [
    'scheduled',
    'in_progress',
    'finished',
  ];
  const oldIdx = ladder.indexOf(existing.status);
  const newIdx = ladder.indexOf(
    fixture.status as ExistingMatchSnapshot['status'],
  );
  if (oldIdx >= 0 && newIdx >= 0 && newIdx < oldIdx) {
    return { kind: 'quarantine', conflict_class: 'status_backward_transition' };
  }

  // ----- 5. kickoff_change_after_lock ---------------------------------------
  // Reschedules within the lock window are user-visible (predictions are
  // already locked) and must be human-reviewed. The tolerance keeps minor
  // provider clock drift (typically <5 min) from spamming the queue.
  //
  // TODO(slice-003): replace the hard-coded 60-minute lockWindowMinutes with
  // a read from tournament_config.locking.lock_window_minutes once Slice 003
  // ships the lock-window envelope.
  const kickoffOld = new Date(existing.kickoff_utc).getTime();
  const kickoffNew = new Date(fixture.kickoffUtc).getTime();
  if (Number.isFinite(kickoffOld) && Number.isFinite(kickoffNew)) {
    const diffMin = Math.abs(kickoffOld - kickoffNew) / 1000 / 60;
    const lockBoundary = kickoffOld - lockWindowMinutes * 60 * 1000;
    const now = nowMs ?? Date.now();
    if (diffMin > kickoffToleranceMinutes && now >= lockBoundary) {
      return { kind: 'quarantine', conflict_class: 'kickoff_change_after_lock' };
    }
  }

  return { kind: 'ok' };
}

/**
 * Result-side classifier. The coordinator only invokes this once it has
 * resolved the provider result to an internal match_id via the provider
 * mapping. matchStatus is the existing matches.status value; if it is
 * anything other than 'finished' the provider is shipping a score for a
 * match the catalog says hasn't ended, which is the R-005
 * `score_before_finished` anomaly.
 */
export interface ClassifyResultInput {
  matchStatus:
    | 'scheduled'
    | 'in_progress'
    | 'finished'
    | 'postponed'
    | 'cancelled'
    | null;
}

export type ResultVerdict =
  | { kind: 'ok' }
  | { kind: 'quarantine'; conflict_class: 'score_before_finished' };

export function classifyResult(input: ClassifyResultInput): ResultVerdict {
  if (input.matchStatus !== 'finished') {
    return { kind: 'quarantine', conflict_class: 'score_before_finished' };
  }
  return { kind: 'ok' };
}
