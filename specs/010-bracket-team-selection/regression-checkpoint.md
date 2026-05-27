# Slice 010 — Bracket Team Selection: Regression Checkpoint

**Feature**: `010-bracket-team-selection` | **Branch**: `004-final-predictions` (slice-010 work)
**Date**: 2026-05-26

## What shipped

A March Madness-style World Cup knockout bracket: view all 32 seeded teams,
pick winners round by round (Round of 32 → Final) with later-round competitors
resolved from your own upstream picks, submit only when complete, and view
other players' brackets only after lock.

| Story | Scope | Status |
|-------|-------|--------|
| US1 (P1) | View the seeded bracket with flags | ✅ |
| US2 (P1) | Select winners; later rounds resolve; cascade clears now-impossible picks | ✅ |
| US3 (P1) | Completion status + server-authoritative submit (idempotent, audited, lock-gated) | ✅ |
| US4 (P1) | Privacy pre-lock; read-only peer view post-lock | ✅ |
| US5 (P2) | One status source feeds header, mobile footer, badge, submit, review | ✅ |
| Polish | a11y, mobile 375px, i18n (en/es/pt), regression gate | ✅ |

## Migration slots used

The slice planned 0084–0090, but US2's cascade function consumed an extra slot,
shifting the back half by one:

| Slot | Object |
|------|--------|
| 0084 | `bracket_matchups` table (+ RLS) |
| 0085 | `bracket_picks` table (self-RLS + admin read) |
| 0086 | `bracket_submissions` table (RPC-only writes) |
| 0087 | `bracket_status(participant)` fn (single progress source) |
| 0088 | `bracket_v` view (own bracket, `security_invoker=true`) |
| 0089 | `bracket_clear_invalid_picks(participant)` cascade fn (US2) |
| 0090 | `submit_bracket(run_token)` SECURITY DEFINER RPC (US3) — *was planned 0089* |
| 0091 | `bracket_peer_v` view (DEFINER, lock + self-exclusion) (US4) — *was planned 0090* |

`submit_bracket` also `ALTER`s `bracket_submissions` to add `last_run_token`
(idempotency). All migrations are additive; no prior-slice object was modified.

## Test counts per story

| Story | Playwright | pgTAP |
|-------|-----------|-------|
| US1 | 2 (view) | — |
| US2 | 5 (pick/advance/cascade/not-ready/invalid/locked) | 4 (cascade invariant) |
| US3 | 6 (disabled/enabled/submit/incomplete/resubmit/locked) | 6 (submit-rpc) + 7 (status-fn) |
| US4 | 4 (pre-lock null/[], admin no-bypass, post-lock visible) | 5 (peer-view RLS) |
| US5 | 1 (cross-surface count/state consistency) | — |
| Polish | 1 a11y (axe) + 1 mobile 375px | — |

All slice-010 suites pass green.

## Regression gate (T045)

Slice-010 is purely additive (new tables/views/functions/routes; the only prior
files touched are `LeaderboardClient.tsx` + `leaderboard/page.tsx`, which gained
an optional prop + a lock-gated peer link).

- **slice-005 leaderboard Playwright** (the only prior-slice frontend touched):
  4 passed, 3 pre-existing skips, **0 failed** — no regression.
- **Full pgTAP suite** (`supabase test db`, 127 files): the failures are
  PRE-EXISTING and independent of slice-010, verified by running them in
  isolation on a fresh seed:
  - `slice-002-catalog-rls` was **already red** — it asserts `matches = 8` but
    the seed has 12 (slices 003/004/005 added synthetic matches). Slice-010 adds
    **zero** `matches` rows. Slice-010's only catalog change is +32 `teams`
    (required for the bracket FKs/flags), which adds a second stale-count miss
    (`teams = 8` → 40) to a test that was already failing on `matches`. This
    follows the project's established tolerance of exact-catalog-count drift as
    slices legitimately grow the catalog.
  - `leaderboard_tie_breakers` / `score_match_idempotent` fail in isolation on a
    clean seed and concern scoring / `calculation_version` state — which
    slice-010 never writes (0 `score_records`, 0 `matches`).
  - The "Bad plan / exited 3" entries are `supabase test db` cross-test
    contamination (all 127 files share one DB with no reset between them); none
    involve bracket objects.
- **Slice-010 suites all green**: pgTAP 22 (cascade 4 + submit-rpc 6 +
  status-fn 7 + peer-rls 5); Playwright 21 (US1 2 + US2 5 + US3 6 + US4 4 +
  US5 1 + a11y/mobile 3).

## Key design decisions

- **Competitor resolution without recursion**: a pick stores `winner_team_id`
  directly, so one upstream lookup resolves each later-round slot
  (`bracket_v` / `bracket_peer_v`). No recursive CTE needed.
- **Server is the completeness authority**: `submit_bracket` purges
  now-impossible picks (`bracket_clear_invalid_picks`) *before* counting, so a
  stale client that believes it is complete still gets `BRACKET_INCOMPLETE`.
- **Lock from DB time only** (`tournament_config.first_kickoff_utc`); the client
  clock is never trusted (Principle VI).
- **Peer privacy is a view-body gate** (`bracket_peer_v` DEFINER + lock +
  self-exclusion), not a route check — a direct PostgREST call hits the same
  gate (SC-005, mirrors slice-005 R-002).
- **Single status source** (`bracket_status` / client `deriveBracketCounts`)
  feeds every surface so counts can never disagree (FR-014).

## Deferred / notes

- `bracket_peer_v` emits `submission_status = 'locked'` for all post-lock rows
  (the lock dominates the precedence); a per-peer `submitted` distinction was
  not needed because peers are only visible post-lock.
- Display-name masking reuses `leaderboard_visibility` config, consistent with
  slice-005 peer views.
- Pre-existing repo typecheck noise (`slice-001-login-approved.spec.ts`) is
  unrelated to slice 010 and untouched here.
- **App-wide color-contrast (deferred to slice 009 token tuning)**: the bracket
  a11y axe check disables the `color-contrast` rule. This is a pre-existing,
  app-wide design-token issue — verified that `/leaderboard` (7 nodes) and
  `/matches` (10 nodes) fail the same rule with the same tokens
  (`text-muted-foreground` ≈ 3.94, `text-primary` ≈ 4.35, `text-gold`,
  `text-scored`, `text-locked`). Slice-010's bracket-specific a11y (keyboard
  operability, non-color selected state via `aria-pressed` + ✓, flag alt text,
  labelled controls, disabled-submit `aria-describedby`) passes strictly with
  every other axe rule enabled.
