/**
 * Slice 002 / T032 — sync-catalog Edge Function.
 *
 * Scope (after T041):
 *   The coordinator's HAPPY PATH per contracts/sync-runner.scheduled.md
 *   § Coordinator behavior steps 1-5 + 8-10, PLUS the R-004 payload-sanity
 *   guards (step 6 + the in-payload-duplicate strand of step 7) AND the
 *   R-005 per-row conflict-quarantine branches in the matches UPSERT loop
 *   (section 7b) + the results UPSERT loop (section 7c) AND the R-008
 *   sustained-outage alert dedup + recovery state machine (section 9).
 *
 * T041 — Outage-alert dedup + recovery (R-008 + Clarifications 2026-05-15 Q3)
 *   The R-008 state machine runs on EVERY terminal outcome — happy path
 *   ('success' | 'partial' | 'conflict_quarantined'), payload-sanity
 *   rejection ('aborted'), adapter-fetch failure ('failure'), and the
 *   defensive outer catch ('failure'). Decision logic lives in
 *   outage_state.ts (pure function `evaluateOutageState` + payload
 *   builders); the coordinator handles the I/O (SELECT current state,
 *   read tournament_config thresholds, UPSERT new state, INSERT audit row,
 *   POST optional webhook via the best-effort `postWebhook` helper).
 *
 *   Webhook semantics: 5-second timeout, no retry, never throws (the
 *   audit_log row is the canonical record per Clarifications Q3). A
 *   webhook URL of literal JSON null (default in migration 0028) skips
 *   the POST entirely — audit-only path.
 *
 *   Consistent failure attribution: T039's payload-sanity rejection
 *   branch and the adapter-fetch catch BOTH invoke the state machine
 *   with outcome='aborted' / 'failure' respectively so the dedup ledger
 *   sees every kind of terminal failure (otherwise the threshold gate
 *   would never fire if the provider only ever sent broken payloads).
 *
 * T040 — Per-row conflict-quarantine (R-005 + Clarifications 2026-05-15 Q2)
 *   Decision logic lives in conflict_quarantine.ts (pure functions
 *   `classifyMatch` + `classifyResult`); the coordinator handles the I/O
 *   (lookup existing via match_provider_external_ids, INSERT into
 *   match_pending_review on quarantine, skip the UPSERT, bump
 *   quarantinedCount). Sibling rows continue to apply (hybrid policy).
 *   End-of-loop outcome rules:
 *     - quarantinedCount === 0                                → 'success'
 *     - quarantinedCount > 0  AND any rows applied            → 'partial'
 *     - quarantinedCount > 0  AND no rows applied             → 'conflict_quarantined'
 *   When at least one row was quarantined the coordinator writes one
 *   audit_log row with action='provider.conflict_quarantined' and
 *   source='api_guard' (D-011 — least-bad fit for the audit_log.source
 *   CHECK whitelist; Slice 007 will add a 'sync' source value).
 *
 *   Lock-window read deferred: Slice 003 owns the lock-window envelope.
 *   We hard-code lockWindowMinutes=60 (research.md § R-005) for now and
 *   read kickoffToleranceMinutes from
 *   tournament_config.provider_sync.kickoff_tolerance_minutes (default 5).
 *
 * T039 — Payload-sanity guards (R-004 + in-payload duplicate strand of R-005)
 *   Three guards run AFTER fetchFixtures returns and BEFORE any UPSERT.
 *   Decision logic lives in payload_sanity.ts (pure function); coordinator
 *   only handles the I/O (read tournament_config keys, read matches count,
 *   on rejection: UPDATE provider_sync_runs row, INSERT audit_log row,
 *   release the advisory lock via try/finally, return 422 with the specific
 *   rejected_* outcome on the wire).
 *
 *   D-010 reconciliation: the provider_sync_runs.outcome CHECK does NOT
 *   accept rejected_empty / rejected_undersized / rejected_duplicate_in_payload.
 *   We store outcome='aborted' on the ledger row and put the specific
 *   rejected_* string in error_class. The JSON response carries the
 *   rejected_* string directly (contract § 422 requires the specific class).
 *
 *   D-011: audit_log.source CHECK accepts ('auth_hook','rls','api_guard',
 *   'ui','trigger') — none of which match "sync coordinator" cleanly. We
 *   pick 'api_guard' as the least-bad fit (the sanity check IS guarding the
 *   API surface that writes to the catalog). Slice 007 will add a 'sync'
 *   source value or similar; documented as D-011 in tasks.md.
 *
 * What this function does:
 *   1. Auth — accept either `X-Internal-Auth: <SYNC_TRIGGER_SECRET>` (scheduled
 *      / internal path) or an admin JWT (`Authorization: Bearer <jwt>` where
 *      public.is_admin(user.id) returns true). Reject everything else 401/403.
 *   2. Parse + validate the request body shape.
 *   3. Idempotency short-circuit — if a row in public.provider_sync_runs has
 *      this `run_id` as its `correlation_id` and a terminal outcome, return
 *      the recorded outcome with `notes='idempotent retry'` (no re-apply).
 *   4. Advisory lock — pg_try_advisory_lock(hashtext('sync_catalog'),
 *      hashtext(provider)) via the public.try_lock_sync(p_provider) RPC
 *      shipped by migration 0029. Failure to acquire => 409 SYNC_IN_FLIGHT.
 *   5. INSERT a `provider_sync_runs` row with outcome='in_progress', capture
 *      its bigserial `id`. The request's UUID `run_id` is stored as
 *      `correlation_id` per the schema reconciliation in T032's prompt
 *      (data-model.md § Entity 5 / migration 0022).
 *   6. Dispatch the adapter — fetchTeams, fetchFixtures, fetchResults — and
 *      map provider error classes to ledger error_class strings.
 *   7. UPSERT teams (by short_code) -> resolve UUID by short_code lookup ->
 *      upsert team_provider_external_ids -> UPSERT matches (idempotency key
 *      home_team_id+away_team_id+kickoff_utc; see "Slice limitations" below)
 *      -> upsert match_provider_external_ids -> per finished result, look up
 *      the match by (provider_name, provider_match_id) and call the
 *      record_match_result SP (T029 / migration 0024).
 *   8. Terminal UPDATE — outcome='success' or 'success_no_changes', counts,
 *      finished_at. Refresh provider_sync_state (last_success_at, clear outage
 *      fields). Release the advisory lock in `finally`.
 *
 * Schema reconciliations (per T032 prompt, divergent from some test names):
 *   - `provider_sync_runs.id` is `bigserial` (NOT uuid). The request's UUID
 *     `run_id` lives in `correlation_id`. The 200 response echoes the request
 *     `run_id` directly — the bigserial id stays internal.
 *   - Column is `provider` (NOT `provider_name`).
 *   - Trigger enum = 'scheduled' | 'manual_admin' | 'manual_internal'. The
 *     request body's `trigger` field accepts the same three values.
 *   - Outcome CHECK constraint excludes 'success_no_changes' — happy path
 *     uses 'success' for terminal updates. We still return
 *     'success_no_changes' in the JSON response when no rows changed (the
 *     contract surface) but record 'success' in the ledger.
 *
 * Slice limitations (documented):
 *   - Match UPSERT idempotency key is currently the natural triple
 *     (home_team_id, away_team_id, kickoff_utc). Slice 002 ships no UNIQUE
 *     constraint on that triple in migration 0020 — the coordinator
 *     UPSERTs by SELECTing an existing row before INSERT/UPDATE. A future
 *     task may add a UNIQUE index + ON CONFLICT clause; for now this
 *     pattern is correct under the per-provider advisory lock (R-006) which
 *     guarantees no two concurrent UPSERTs against the same provider race.
 *
 * Runtime contract:
 *   - Deno only. `Deno.serve(...)`. No Node imports.
 *   - Service-role client is created per-request (no module-level credential
 *     cache beyond Deno.env reads at startup, per task constraint).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import type {
  MatchDataProviderAdapter,
  NormalizedFixture,
  NormalizedPlayer,
  NormalizedResult,
  NormalizedTeam,
  SyncWindow,
} from '../_shared/providers/types.ts';
import {
  ProviderClientError,
  ProviderRateLimitedError,
  ProviderTransientError,
} from '../_shared/providers/types.ts';
import stubAdapter from '../_shared/providers/stub/index.ts';
import stub2Adapter from '../_shared/providers/stub2/index.ts';
import footballDataAdapter from '../_shared/providers/footballdata/index.ts';
import { evaluatePayloadSanity } from './payload_sanity.ts';
import {
  classifyMatch,
  classifyResult,
  type ExistingMatchSnapshot,
} from './conflict_quarantine.ts';
import {
  evaluateOutageState,
  buildOutageWebhookPayload,
  buildRecoveryWebhookPayload,
  type OutageStateRow,
  type Outcome as OutageOutcome,
} from './outage_state.ts';

// ============================================================================
// Environment (read at module load — service URL/keys only; no secrets cached
// beyond what's needed to construct request-scoped clients).
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const INTERNAL_SECRET = Deno.env.get('SYNC_TRIGGER_SECRET') ?? '';

// ============================================================================
// Static adapter registry — keyed by provider short name. Adding a provider
// is a one-line edit here + a new module under _shared/providers/<name>/
// (per provider-adapter.contract.md § "no dynamic require, no eval").
// ============================================================================

const ADAPTERS: Record<string, MatchDataProviderAdapter> = {
  stub: stubAdapter,
  stub2: stub2Adapter,
  footballdata: footballDataAdapter,
};

// ============================================================================
// Request / response shapes (mirror contracts/sync-runner.scheduled.md)
// ============================================================================

type TriggerValue = 'scheduled' | 'manual_admin' | 'manual_internal';

interface SyncRequest {
  /** Provider short name; resolves into ADAPTERS. */
  provider: string;
  /** What kicked this run off; persisted into provider_sync_runs.trigger. */
  trigger: TriggerValue;
  /** UUID; idempotency key. Stored as provider_sync_runs.correlation_id. */
  run_id: string;
  /** Optional human-readable note (audit / debug only). */
  reason?: string;
}

interface SyncCounts {
  teams_upserted: number;
  matches_upserted: number;
  results_upserted: number;
  /**
   * Slice 004 / T031 — added when the adapter implements the optional
   * fetchPlayers?() method. Absent on the wire when the adapter does NOT
   * implement fetchPlayers, preserving backward compatibility with
   * slice-002 tests that read `counts.matches_upserted` etc. without
   * asserting on `players_upserted`.
   */
  players_upserted?: number;
  /**
   * Slice 004 / T031 — count of players soft-deleted (removed_at flipped
   * NULL -> non-NULL) when the set-difference computation determined the
   * provider stopped returning them. Absent when no fetchPlayers branch ran.
   */
  players_soft_deleted?: number;
}

interface SyncResponse {
  run_id: string;
  outcome: string;
  provider: string;
  trigger: string;
  counts?: SyncCounts;
  notes?: string;
  /**
   * Present on 422 rejection responses (T039 — R-004 payload-sanity guards).
   * Successful 200 responses omit this field.
   */
  error?: { code: string; message: string };
}

// ============================================================================
// HTTP helpers
// ============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

// ============================================================================
// Outage state machine helpers (T041 — R-008 + Clarifications Q3)
// ============================================================================

/**
 * Best-effort webhook POST. Used by the outage state machine's alert +
 * recovery paths (Clarifications Q3). Semantics:
 *   - 5-second timeout (default; configurable for future use), enforced
 *     via AbortController so the coordinator's response is not held
 *     hostage by a slow / dead webhook destination.
 *   - No retry: the audit_log row is the canonical record, and a flapping
 *     webhook destination should not be hammered by a sync-runner that
 *     fires every 5 minutes anyway.
 *   - Never throws: any fetch / timeout / network error is logged to
 *     stderr and swallowed. The coordinator MUST continue to the response
 *     return; failing the whole sync on a stale webhook URL would be a
 *     worse failure mode than a missed Slack ping.
 *   - A null URL is a no-op (the migration 0028 default for
 *     notifications.outage_webhook_url is literal JSON null, meaning
 *     "audit-only" until Slice 008's admin UI provisions a real URL).
 */
async function postWebhook(
  url: string | null,
  payload: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<void> {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    console.error('outage webhook POST failed (swallowed)', e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the three outage-related tournament_config keys at once. Returns
 * defaults that match migration 0028 if any row is missing — keeps the
 * coordinator running on a fresh DB even before the admin seeds the keys.
 *
 *   notifications.outage_threshold_minutes        → number, default 15
 *   notifications.outage_webhook_url              → string | null, default null
 *   notifications.outage_recovery_alert_enabled   → boolean, default true
 */
async function readOutageConfig(
  service: SupabaseClient,
): Promise<{
  thresholdMinutes: number;
  webhookUrl: string | null;
  recoveryAlertEnabled: boolean;
}> {
  const keys = [
    'notifications.outage_threshold_minutes',
    'notifications.outage_webhook_url',
    'notifications.outage_recovery_alert_enabled',
  ];
  const { data: rows, error } = await service
    .from('tournament_config')
    .select('key, value')
    .in('key', keys);
  if (error) {
    // Config read failure is non-fatal for the state-machine path — fall
    // back to the migration-0028 defaults so the coordinator can still
    // record state. The audit row is the load-bearing record either way.
    console.error('outage config read failed (using defaults)', error);
    return { thresholdMinutes: 15, webhookUrl: null, recoveryAlertEnabled: true };
  }
  const map = new Map<string, unknown>(
    (rows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]),
  );

  const thresholdRaw = map.get('notifications.outage_threshold_minutes');
  const thresholdMinutes = Number.isFinite(Number(thresholdRaw))
    ? Number(thresholdRaw)
    : 15;

  // The migration default is JSON null; an admin may set a string URL.
  // We treat anything other than a non-empty string as "no webhook configured".
  const webhookRaw = map.get('notifications.outage_webhook_url');
  const webhookUrl =
    typeof webhookRaw === 'string' && webhookRaw.length > 0 ? webhookRaw : null;

  const recoveryRaw = map.get('notifications.outage_recovery_alert_enabled');
  const recoveryAlertEnabled = recoveryRaw === undefined ? true : Boolean(recoveryRaw);

  return { thresholdMinutes, webhookUrl, recoveryAlertEnabled };
}

/**
 * Drive the R-008 outage-alert state machine for one terminal outcome.
 *
 * Called from every terminal branch of the coordinator:
 *   - happy path (section 9, success / partial / conflict_quarantined)
 *   - T039 payload-sanity rejection (section 6b, outcome='aborted')
 *   - adapter-fetch catch (section 6, outcome='failure')
 *   - outer defensive catch (outcome='failure')
 *
 * Steps:
 *   1. SELECT the current provider_sync_state row (or null if missing).
 *   2. Read outage config (threshold / webhook URL / recovery toggle).
 *   3. Call the pure-function evaluator.
 *   4. UPSERT the new state (skipped for the defensive `no_change` branch).
 *   5. On `mark_failure_with_alert`: write audit row, POST outage webhook.
 *   6. On `mark_recovery`: write audit row, POST recovery webhook.
 *
 * Best-effort throughout: any DB error here is logged and swallowed. The
 * coordinator's response (200 / 422 / 500 / 502) MUST NOT be derailed by a
 * failure in the outage-state-machine path — that path is purely
 * observability for ops, not part of the wire contract.
 *
 * Safe under the per-provider advisory lock (R-006): no two same-provider
 * syncs run concurrently, so the read-evaluate-upsert sequence here is
 * effectively atomic for the slice 002 deployment shape.
 */
async function runOutageStateMachine(
  service: SupabaseClient,
  provider: string,
  outcome: OutageOutcome,
  runId: number,
  correlationId: string,
): Promise<void> {
  try {
    // ----- 1. SELECT current state ----------------------------------------
    const { data: currentRow, error: stateReadErr } = await service
      .from('provider_sync_state')
      .select(
        'provider, last_success_at, consecutive_failures, ' +
          'first_failure_after_success_at, outage_alert_emitted_at, ' +
          'recovery_alert_pending',
      )
      .eq('provider', provider)
      .maybeSingle();
    if (stateReadErr) {
      console.error('provider_sync_state read failed', stateReadErr);
      // Continue with current=null; the evaluator handles a missing row.
    }
    const current: OutageStateRow | null = currentRow
      ? {
          provider: currentRow.provider,
          last_success_at: currentRow.last_success_at,
          consecutive_failures: currentRow.consecutive_failures ?? 0,
          first_failure_after_success_at:
            currentRow.first_failure_after_success_at,
          outage_alert_emitted_at: currentRow.outage_alert_emitted_at,
          recovery_alert_pending: !!currentRow.recovery_alert_pending,
        }
      : null;

    // ----- 2. Read config -------------------------------------------------
    const { thresholdMinutes, webhookUrl, recoveryAlertEnabled } =
      await readOutageConfig(service);

    // ----- 3. Evaluate ----------------------------------------------------
    const nowIso = new Date().toISOString();
    const action = evaluateOutageState({
      outcome,
      current,
      nowIso,
      thresholdMinutes,
      recoveryAlertEnabled,
    });

    if (action.kind === 'no_change') {
      return;
    }

    // ----- 4. UPSERT new state -------------------------------------------
    // The schema PK is (provider). UPSERT with onConflict guarantees a
    // row exists after this call even if the provider had no prior state.
    const upsertPayload = {
      provider,
      last_success_at: action.new_state.last_success_at,
      consecutive_failures: action.new_state.consecutive_failures,
      first_failure_after_success_at:
        action.new_state.first_failure_after_success_at,
      outage_alert_emitted_at: action.new_state.outage_alert_emitted_at,
      recovery_alert_pending: action.new_state.recovery_alert_pending,
      updated_at: nowIso,
    };
    const { error: upsertErr } = await service
      .from('provider_sync_state')
      .upsert(upsertPayload, { onConflict: 'provider' });
    if (upsertErr) {
      console.error('provider_sync_state upsert failed', upsertErr);
      // Continue — we still want to attempt the audit row if an alert /
      // recovery transition fired, since the audit is the canonical record.
    }

    // ----- 5/6. Audit + webhook on alert / recovery ----------------------
    if (action.kind === 'mark_failure_with_alert') {
      // Audit row first (canonical), then webhook (best-effort).
      const auditRes = await service.from('audit_log').insert({
        actor: null,
        action: action.alert_audit, // 'provider.outage_alert_emitted'
        source: 'api_guard', // D-011 — least-bad fit; Slice 007 adds 'sync'
        entity_type: 'provider_sync_run',
        entity_id: null,
        new_value: {
          provider,
          run_id: runId,
          correlation_id: correlationId,
          first_failure_after_success_at:
            action.new_state.first_failure_after_success_at,
          outage_alert_emitted_at: action.new_state.outage_alert_emitted_at,
          consecutive_failures: action.new_state.consecutive_failures,
        },
        reason: 'sustained_provider_outage',
      });
      if (auditRes.error) {
        console.error('audit_log outage_alert_emitted insert failed', auditRes.error);
      }

      // Fetch the last few ledger rows for forensic context in the payload.
      let recentRuns: Array<{
        id: number | string;
        outcome: string;
        finished_at: string | null;
        error_class: string | null;
      }> = [];
      try {
        const { data: runs } = await service
          .from('provider_sync_runs')
          .select('id, outcome, finished_at, error_class')
          .eq('provider', provider)
          .order('id', { ascending: false })
          .limit(5);
        recentRuns = (runs ?? []) as typeof recentRuns;
      } catch (e) {
        console.error('recent runs read for webhook payload failed (swallowed)', e);
      }

      const payload = buildOutageWebhookPayload({
        provider,
        current: action.new_state,
        recentRuns,
        nowIso,
      });
      await postWebhook(webhookUrl, payload);
    } else if (action.kind === 'mark_recovery') {
      const auditRes = await service.from('audit_log').insert({
        actor: null,
        action: action.alert_audit, // 'provider.recovered'
        source: 'api_guard', // D-011
        entity_type: 'provider_sync_run',
        entity_id: null,
        new_value: {
          provider,
          run_id: runId,
          correlation_id: correlationId,
          outage_started_at: action.outage_started_at,
          recovered_at: nowIso,
        },
        reason: 'provider_recovered_after_outage',
      });
      if (auditRes.error) {
        console.error('audit_log provider.recovered insert failed', auditRes.error);
      }

      const payload = buildRecoveryWebhookPayload({
        provider,
        outageStartedAt: action.outage_started_at,
        recoveredAt: nowIso,
      });
      await postWebhook(webhookUrl, payload);
    }
  } catch (e) {
    // Defense in depth: the state machine itself MUST NOT throw out of
    // the coordinator. A missing column, a network blip on the audit
    // insert, an unexpected null — any of it gets logged and swallowed.
    console.error('outage state machine error (swallowed)', e);
  }
}

// ============================================================================
// Slice 004 / T031 / contracts/players-ingest.md — players branch
// ============================================================================

/**
 * Result envelope from upsertPlayers. The coordinator surfaces these counts
 * on the 200 response (SyncCounts.players_upserted / players_soft_deleted)
 * and writes them onto the matches-branch ledger row's notes for forensic
 * grep. The `quarantined` flag is true when the undersized-payload safety
 * net (contracts/players-ingest.md § Producer step "undersized threshold
 * 50%") tripped — coordinator MUST NOT mutate `players` rows in that case.
 */
interface UpsertPlayersResult {
  upserted: number;
  softDeleted: number;
  quarantined: boolean;
  quarantineReason: string | null;
}

/**
 * Slice 004 / T031 / contracts/players-ingest.md § Producer.
 *
 * Consumer of `adapter.fetchPlayers?()`'s output. The optional method was
 * reserved on the locked MatchDataProviderAdapter interface in slice 002;
 * this slice activates the dispatch.
 *
 * Behavior (per contracts/players-ingest.md § Producer):
 *   1. UNDERSIZED SAFETY NET: if `players.length < 0.5 * existing_active_count`
 *      (50% threshold per § Producer paragraph 2), SKIP all writes, flag
 *      the run quarantined, and let the caller fire the alert. An EMPTY
 *      roster is NOT rejected (a deliberate season-end signal — contract
 *      § Producer explicitly contrasts this with matches' empty-payload
 *      rejection from slice-002 R-004).
 *   2. UPSERT each incoming player via the (provider_name, provider_player_id)
 *      mapping table:
 *        - If no mapping exists -> INSERT players row + INSERT mapping row;
 *          emit `audit_log` action='player.created'.
 *        - If mapping exists -> resolve internal player_id; UPDATE players
 *          row when full_name / display_name / team_id / country_code /
 *          position changed; emit action='player.updated'. Always refresh
 *          mapped_at on the mapping row.
 *   3. SET-DIFFERENCE soft-delete: any currently-active player
 *      (removed_at IS NULL) with a mapping to THIS provider that was NOT
 *      seen in the incoming payload gets UPDATE removed_at = now(). The
 *      `log_player_removed_fan_out` trigger from migration 0045 fires
 *      automatically on the NULL -> non-NULL transition, emitting one
 *      `final_prediction.target_player_removed` audit row per active
 *      prediction that targeted the soft-deleted player. The action label
 *      for the player itself is `player.removed`.
 *
 * Team-affiliation resolution: incoming `teamProviderId` is mapped to
 * internal `team_id` via `team_provider_external_ids` (the slice-002
 * mapping table). If no mapping exists yet, `team_id` stays NULL; a
 * subsequent sync after the team is registered will set it.
 *
 * Audit envelope: minimal — entity_type='player', entity_id=player_id,
 * source='api_guard' (D-011 — least-bad fit for audit_log.source CHECK
 * whitelist {auth_hook, rls, api_guard, ui, trigger} — same choice as the
 * matches-branch summary rows; slice 007 will add a 'sync' source).
 *
 * Idempotency: under the per-provider advisory lock (slice 002 R-006),
 * two same-provider syncs cannot race here. ON CONFLICT clauses on the
 * UNIQUE (provider_name, provider_player_id) and on the audit insert
 * keep the function replay-safe at the row level too.
 *
 * Failure semantics: a thrown error here MUST NOT poison the matches-branch
 * outcome that already ran above. The caller wraps the entire fetchPlayers
 * + upsertPlayers block in a try/catch; on error we log + skip the players
 * portion and let the matches outcome stand. R-013 (slice 004 final
 * predictions) explicitly tolerates a "no roster yet" picker UI state.
 */
async function upsertPlayers(
  service: SupabaseClient,
  players: NormalizedPlayer[],
  syncRunId: number,
  providerName: string,
): Promise<UpsertPlayersResult> {
  // -------------------------------------------------------------------------
  // 1. Undersized safety net (50% threshold).
  // -------------------------------------------------------------------------
  // Read existing active player count for THIS provider's mapping. The
  // threshold is computed per-provider, not global — a different provider's
  // roster size has no bearing on this provider's undersized check.
  const { data: activeMappings, error: countErr } = await service
    .from('player_provider_external_ids')
    .select('player_id, players:players!inner(id, removed_at)')
    .eq('provider_name', providerName);
  if (countErr) {
    console.error('player provider mapping read failed', countErr);
    throw countErr;
  }
  const existingActiveCount = (activeMappings ?? []).filter(
    (m: { players: { removed_at: string | null } | { removed_at: string | null }[] }) => {
      const row = Array.isArray(m.players) ? m.players[0] : m.players;
      return row && row.removed_at === null;
    },
  ).length;

  // Threshold: incoming count < 50% of prior active count. The lower bound
  // is "we had > 0 prior players" — a first-ever sync (existingActiveCount
  // == 0) cannot be "undersized" because there is no prior baseline. An
  // EMPTY incoming roster is deliberately ALLOWED (season-end signal) per
  // the contract; the undersized check only trips on a small-but-not-zero
  // count vs an existing baseline.
  const UNDERSIZED_RATIO = 0.5;
  if (
    existingActiveCount > 0 &&
    players.length > 0 &&
    players.length < UNDERSIZED_RATIO * existingActiveCount
  ) {
    const reason = `undersized_players_payload: incoming=${players.length} prior_active=${existingActiveCount} threshold=${UNDERSIZED_RATIO}`;
    console.error(`players branch quarantined: ${reason}`);
    // Audit row: forensic record that the safety net tripped. entity_id
    // is NULL (no single player to attribute); the runId rides in
    // new_value alongside the count diagnostic so Slice 007 forensic
    // queries can correlate.
    const auditRes = await service.from('audit_log').insert({
      actor: null,
      action: 'provider.players_quarantined_undersized',
      source: 'api_guard',
      entity_type: 'provider_sync_run',
      entity_id: null,
      new_value: {
        provider: providerName,
        run_id: syncRunId,
        incoming_count: players.length,
        prior_active_count: existingActiveCount,
        threshold_ratio: UNDERSIZED_RATIO,
      },
      reason,
    });
    if (auditRes.error) {
      console.error('audit_log players_quarantined_undersized insert failed', auditRes.error);
    }
    return { upserted: 0, softDeleted: 0, quarantined: true, quarantineReason: reason };
  }

  // -------------------------------------------------------------------------
  // 2. Resolve team_id for each incoming player via team mapping.
  // -------------------------------------------------------------------------
  // Batch read team_provider_external_ids for the providers' team ids
  // present in this payload — keeps the lookup to one round-trip even on
  // 700+ player rosters.
  const distinctTeamProviderIds = Array.from(
    new Set(
      players
        .map((p) => p.teamProviderId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  );
  const teamByProviderId = new Map<string, string>();
  if (distinctTeamProviderIds.length > 0) {
    const { data: teamRows, error: teamReadErr } = await service
      .from('team_provider_external_ids')
      .select('team_id, provider_team_id')
      .eq('provider_name', providerName)
      .in('provider_team_id', distinctTeamProviderIds);
    if (teamReadErr) {
      console.error('team_provider_external_ids read for players failed', teamReadErr);
      // Non-fatal — proceed with NULL team_id for any unresolved player;
      // future syncs after team mappings exist will populate it.
    } else {
      for (const r of teamRows ?? []) {
        const row = r as { team_id: string; provider_team_id: string };
        teamByProviderId.set(row.provider_team_id, row.team_id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. UPSERT each incoming player. Track seen IDs for set-difference.
  // -------------------------------------------------------------------------
  let upsertedCount = 0;
  const seenInternalIds = new Set<string>();

  for (const p of players) {
    const teamId =
      p.teamProviderId !== null ? (teamByProviderId.get(p.teamProviderId) ?? null) : null;

    // Look up mapping by (provider_name, provider_player_id). The UNIQUE
    // index on that pair makes this the idempotency anchor.
    const { data: mappingRow, error: mappingErr } = await service
      .from('player_provider_external_ids')
      .select('player_id')
      .eq('provider_name', providerName)
      .eq('provider_player_id', p.providerPlayerId)
      .maybeSingle();
    if (mappingErr) {
      console.error('player mapping lookup failed', mappingErr);
      continue;
    }

    let playerId: string;
    let isCreate: boolean;

    if (!mappingRow) {
      // No mapping — INSERT players row + INSERT mapping row.
      const { data: insertedPlayer, error: insErr } = await service
        .from('players')
        .insert({
          full_name: p.fullName,
          // NormalizedPlayer carries `aliases` per the locked types.ts
          // interface; the players table does NOT have an aliases column
          // (the table ships display_name / team_id / country_code /
          // position instead per migration 0039). Aliases from the
          // adapter are deliberately dropped at this boundary — a future
          // migration may add an alias column; documented as D-021 in
          // the report. display_name is populated as a copy of full_name
          // when the adapter does not provide a short form (the stub
          // adapter does not surface display_name in NormalizedPlayer).
          team_id: teamId,
        })
        .select('id')
        .single();
      if (insErr || !insertedPlayer) {
        console.error('players insert failed', insErr);
        continue;
      }
      playerId = insertedPlayer.id as string;

      const { error: mapInsErr } = await service
        .from('player_provider_external_ids')
        .insert({
          player_id: playerId,
          provider_name: providerName,
          provider_player_id: p.providerPlayerId,
        });
      if (mapInsErr) {
        console.error('player_provider_external_ids insert failed', mapInsErr);
        // The player row exists; the mapping is missing. Roll forward —
        // a future sync's UNIQUE conflict will be the recovery path.
      }
      isCreate = true;
    } else {
      playerId = mappingRow.player_id as string;

      // Diff against current row. Apply non-conflicting updates only on
      // delta (skip the UPDATE entirely when nothing changed — preserves
      // updated_at semantics for forensic clarity).
      const { data: currentRow, error: currentErr } = await service
        .from('players')
        .select('full_name, team_id, removed_at')
        .eq('id', playerId)
        .single();
      if (currentErr || !currentRow) {
        console.error('players row read for update failed', currentErr);
        continue;
      }
      const needsUpdate =
        currentRow.full_name !== p.fullName ||
        currentRow.team_id !== teamId ||
        currentRow.removed_at !== null;
      if (needsUpdate) {
        const { error: updErr } = await service
          .from('players')
          .update({
            full_name: p.fullName,
            team_id: teamId,
            // If the player had been soft-deleted in a prior run and is
            // back in the roster, clear removed_at — a resurrected
            // player is just an updated player.
            removed_at: null,
          })
          .eq('id', playerId);
        if (updErr) {
          console.error('players update failed', updErr);
          continue;
        }
      }
      // Refresh mapping mapped_at on every confirming sync.
      await service
        .from('player_provider_external_ids')
        .update({ mapped_at: new Date().toISOString() })
        .eq('provider_name', providerName)
        .eq('provider_player_id', p.providerPlayerId);
      isCreate = false;
    }

    seenInternalIds.add(playerId);
    upsertedCount++;

    // Audit row per UPSERT. Free-form action labels (no audit_log.action
    // CHECK constraint) — contracts/players-ingest.md § Cross-slice locked
    // names `player.created` / `player.updated` / `player.removed`.
    const auditRes = await service.from('audit_log').insert({
      actor: null,
      action: isCreate ? 'player.created' : 'player.updated',
      source: 'api_guard',
      entity_type: 'player',
      entity_id: playerId,
      new_value: {
        provider: providerName,
        run_id: syncRunId,
        provider_player_id: p.providerPlayerId,
        full_name: p.fullName,
        team_provider_id: p.teamProviderId,
      },
      reason: null,
    });
    if (auditRes.error) {
      console.error('audit_log player.upsert insert failed', auditRes.error);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Set-difference soft-delete. Active players whose mapping points to
  //    THIS provider but were NOT seen in the incoming payload get
  //    removed_at = now(). The 0045 trigger fans out
  //    final_prediction.target_player_removed audit rows for any
  //    active final_predictions referencing them.
  // -------------------------------------------------------------------------
  // Re-read active mappings here (vs reusing activeMappings from step 1) so
  // any players we just created in step 3 are correctly excluded from the
  // soft-delete set — they trivially have seenInternalIds membership too,
  // but re-reading also catches concurrent admin INSERTs in the (unlikely)
  // window between step 1 and step 4.
  const { data: priorActive, error: priorErr } = await service
    .from('player_provider_external_ids')
    .select('player_id, players:players!inner(id, removed_at)')
    .eq('provider_name', providerName);
  if (priorErr) {
    console.error('post-upsert mapping read failed', priorErr);
    return { upserted: upsertedCount, softDeleted: 0, quarantined: false, quarantineReason: null };
  }
  const priorActiveIds: string[] = [];
  for (const r of priorActive ?? []) {
    const row = r as {
      player_id: string;
      players: { id: string; removed_at: string | null } | { id: string; removed_at: string | null }[];
    };
    const playerRow = Array.isArray(row.players) ? row.players[0] : row.players;
    if (playerRow && playerRow.removed_at === null) {
      priorActiveIds.push(playerRow.id);
    }
  }
  const toSoftDelete = priorActiveIds.filter((id) => !seenInternalIds.has(id));

  let softDeletedCount = 0;
  if (toSoftDelete.length > 0) {
    const nowIso = new Date().toISOString();
    const { error: softErr } = await service
      .from('players')
      .update({ removed_at: nowIso })
      .in('id', toSoftDelete)
      .is('removed_at', null);
    if (softErr) {
      console.error('players soft-delete failed', softErr);
    } else {
      softDeletedCount = toSoftDelete.length;
      // One `player.removed` audit row per soft-deleted player. The 0045
      // trigger writes the fan-out `final_prediction.target_player_removed`
      // rows separately; this row records the player-level signal.
      for (const id of toSoftDelete) {
        const auditRes = await service.from('audit_log').insert({
          actor: null,
          action: 'player.removed',
          source: 'api_guard',
          entity_type: 'player',
          entity_id: id,
          new_value: {
            provider: providerName,
            run_id: syncRunId,
            removed_at: nowIso,
          },
          reason: 'player_not_in_incoming_roster',
        });
        if (auditRes.error) {
          console.error('audit_log player.removed insert failed', auditRes.error);
        }
      }
    }
  }

  return {
    upserted: upsertedCount,
    softDeleted: softDeletedCount,
    quarantined: false,
    quarantineReason: null,
  };
}

// ============================================================================
// Server entrypoint
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return err(405, 'METHOD_NOT_ALLOWED', 'POST only');
  }

  // ----- 1. Auth -----------------------------------------------------------
  // Two paths: internal-secret (scheduled/internal callers) or admin JWT.
  // Internal path is checked first because it's the dominant case (pg_cron
  // -> pg_net -> Edge Function via wrapper). Admin path requires service-role
  // is_admin() check because the user-bound client cannot see admin status
  // through RLS by itself.
  const internalAuth = req.headers.get('X-Internal-Auth');
  const authHeader = req.headers.get('Authorization');

  let authPath: 'internal' | 'admin' | null = null;

  if (internalAuth && INTERNAL_SECRET && internalAuth === INTERNAL_SECRET) {
    authPath = 'internal';
  } else if (authHeader?.startsWith('Bearer ')) {
    // Validate the JWT and check admin status via service-role RPC.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return err(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isAdmin, error: adminErr } = await service.rpc('is_admin', {
      p_user_id: userData.user.id,
    });
    if (adminErr) {
      console.error('is_admin RPC error', adminErr);
      return err(500, 'INTERNAL', 'admin check failed');
    }
    if (!isAdmin) {
      return err(403, 'FORBIDDEN', 'Admin required.');
    }
    authPath = 'admin';
  } else {
    return err(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }

  // ----- 2. Parse + validate body ------------------------------------------
  let body: SyncRequest;
  try {
    body = (await req.json()) as SyncRequest;
  } catch {
    return err(400, 'BAD_REQUEST', 'Invalid JSON body.');
  }
  if (!body || typeof body !== 'object') {
    return err(400, 'BAD_REQUEST', 'Body must be a JSON object.');
  }
  if (!body.provider || !body.trigger || !body.run_id) {
    return err(400, 'BAD_REQUEST', 'provider, trigger, run_id required.');
  }
  const adapter = ADAPTERS[body.provider];
  if (!adapter) {
    return err(400, 'BAD_REQUEST', `unknown provider: ${body.provider}`);
  }

  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ----- 3. Idempotency short-circuit --------------------------------------
  // If a previous invocation with the same correlation_id (== request run_id)
  // already reached a terminal outcome, echo that outcome back. The
  // coordinator must NOT re-apply the catalog on a retry. Per contract
  // step 3 the retry response carries notes='idempotent retry'.
  const { data: existingRun, error: existingErr } = await service
    .from('provider_sync_runs')
    .select('id, provider, trigger, outcome, applied_match_count')
    .eq('correlation_id', body.run_id)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    console.error('idempotency lookup error', existingErr);
    return err(500, 'INTERNAL', 'idempotency check failed');
  }
  if (existingRun && existingRun.outcome !== 'in_progress') {
    const response: SyncResponse = {
      run_id: body.run_id,
      outcome: existingRun.outcome,
      provider: existingRun.provider,
      trigger: existingRun.trigger,
      counts: {
        teams_upserted: 0,
        matches_upserted: existingRun.applied_match_count ?? 0,
        results_upserted: 0,
      },
      notes: 'idempotent retry',
    };
    return jsonResponse(200, response);
  }

  // ----- 4. Advisory lock --------------------------------------------------
  // Per-provider lock so two same-provider syncs serialize. The helper RPC
  // is shipped by migration 0029. A `false` return means another session
  // already holds the lock -> 409 SYNC_IN_FLIGHT (contract response shape).
  const { data: lockAcquired, error: lockErr } = await service.rpc('try_lock_sync', {
    p_provider: body.provider,
  });
  if (lockErr) {
    console.error('advisory lock RPC error', lockErr);
    return err(500, 'INTERNAL', 'sync coordinator unavailable');
  }
  if (lockAcquired === false) {
    return err(409, 'SYNC_IN_FLIGHT', 'another sync is in flight for this provider');
  }

  // ----- 5. INSERT in-progress ledger row ----------------------------------
  // tier is NULL here; T043's cron-launcher computes the tier from the
  // tournament-window envelope before dispatching to this function. For a
  // direct admin / internal-secret invocation we leave it NULL (the schema
  // CHECK accepts NULL by design).
  const insertRow = {
    provider: body.provider,
    outcome: 'in_progress' as const,
    trigger: body.trigger,
    correlation_id: body.run_id,
    tier: null as string | null,
  };
  const { data: runRow, error: insertErr } = await service
    .from('provider_sync_runs')
    .insert(insertRow)
    .select('id')
    .single();
  if (insertErr || !runRow) {
    // Release the lock if we couldn't record the run; otherwise the lock
    // would remain held for the lifetime of this PostgREST session.
    await service.rpc('unlock_sync', { p_provider: body.provider });
    console.error('provider_sync_runs insert failed', insertErr);
    return err(
      500,
      'INTERNAL',
      `failed to record sync run: ${insertErr?.message ?? 'unknown'}`,
    );
  }
  const runId = runRow.id as number;

  // From here on, we OWN the lock and the ledger row. Every exit path must
  // either update the ledger row + release the lock OR fall through to the
  // `finally` block below.
  try {
    // ----- 6. Adapter dispatch --------------------------------------------
    // Slice 002 happy path = no retries. T043's cron-launcher honours
    // tournament_config.provider_sync.max_retries_per_run by re-invoking this
    // function with a fresh run_id; the retry loop does NOT live inside the
    // single coordinator invocation. Errors are mapped to the contract's
    // error_class strings and recorded on the ledger row before bailing.
    const window: SyncWindow = { fromUtc: null, toUtc: null };
    let teams: NormalizedTeam[] = [];
    let fixtures: NormalizedFixture[] = [];
    let results: NormalizedResult[] = [];
    try {
      teams = await adapter.fetchTeams();
      fixtures = await adapter.fetchFixtures(window);
      results = await adapter.fetchResults(window);
    } catch (e) {
      const errorClass =
        e instanceof ProviderRateLimitedError
          ? 'rate_limit'
          : e instanceof ProviderTransientError
          ? 'network'
          : e instanceof ProviderClientError
          ? 'auth'
          : 'unknown';
      // Provider 5xx / rate-limit are retryable from the cron-launcher's
      // perspective; client/auth errors are not. Ledger captures both as
      // 'failure' (matches the schema enum).
      const outcome = 'failure';
      await service
        .from('provider_sync_runs')
        .update({
          outcome,
          finished_at: new Date().toISOString(),
          error_class: errorClass,
          error_message: (e as Error).message ?? String(e),
        })
        .eq('id', runId);
      // T041 — run the R-008 state machine BEFORE the 502 return so
      // adapter-fetch failures count toward the sustained-outage threshold
      // and the dedup ledger. Best-effort; never derails the 502 response.
      await runOutageStateMachine(service, body.provider, 'failure', runId, body.run_id);
      return err(502, 'PROVIDER_ERROR', `provider fetch failed: ${(e as Error).message ?? e}`);
    }

    // ----- 6b. Payload-sanity guards (T039 — R-004 + in-payload dup strand) -
    // Runs AFTER fetch returns successfully and BEFORE any UPSERT. Three
    // checks: empty replacement / undersized payload / duplicate
    // provider_match_id in the incoming payload. Per spec Clarifications
    // 2026-05-15 Q2: structural anomalies abort the whole run; per-row
    // anomalies (T040's job) quarantine only the offending row.
    //
    // Decision is delegated to payload_sanity.ts (pure function, easily
    // unit-testable). The coordinator owns the I/O.
    //
    // D-010 handling on rejection:
    //   provider_sync_runs.outcome  → 'aborted'  (schema CHECK accepts)
    //   provider_sync_runs.error_class → 'rejected_empty' | 'rejected_undersized'
    //                                    | 'rejected_duplicate_in_payload'
    //   JSON response.outcome       → same rejected_* string (contract § 422)
    //
    // D-011 handling on rejection:
    //   audit_log.source = 'api_guard' (least-bad fit per the source CHECK
    //   constraint enum — see header comment).
    //
    // Lock release: this branch lives INSIDE the outer try block, so the
    // existing `finally` block at the bottom runs and releases the advisory
    // lock. We do NOT need to release manually here.
    {
      const configKeys = [
        'provider_sync.payload.min_count_ratio',
        'provider_sync.payload.reject_on_empty_replacement',
        'provider_sync.payload.reject_on_duplicate_external_ids',
      ];
      const { data: configRows, error: configErr } = await service
        .from('tournament_config')
        .select('key, value')
        .in('key', configKeys);
      if (configErr) {
        // Config read failures are coordinator-level, not payload-level —
        // throw so the outer catch records 'failure' with error_class
        // 'unknown'. The advisory lock still releases via finally.
        console.error('tournament_config read failed', configErr);
        throw configErr;
      }
      const configMap = new Map<string, unknown>(
        (configRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]),
      );
      const minCountRatio = Number(
        configMap.get('provider_sync.payload.min_count_ratio') ?? 0.5,
      );
      const rejectOnEmpty = Boolean(
        configMap.get('provider_sync.payload.reject_on_empty_replacement') ?? true,
      );
      const rejectOnDuplicate = Boolean(
        configMap.get('provider_sync.payload.reject_on_duplicate_external_ids') ?? true,
      );

      // SELECT count(*) FROM matches — head-only count avoids streaming rows.
      const { count: existingMatchCountRaw, error: countErr } = await service
        .from('matches')
        .select('*', { count: 'exact', head: true });
      if (countErr) {
        console.error('matches count read failed', countErr);
        throw countErr;
      }
      const existingMatchCount = existingMatchCountRaw ?? 0;

      const sanity = evaluatePayloadSanity({
        fixtures,
        existingMatchCount,
        minCountRatio,
        rejectOnEmpty,
        rejectOnDuplicate,
      });

      if (!sanity.ok) {
        // 1. UPDATE the ledger row: outcome='aborted' (D-010), error_class
        //    carries the specific rejection class, error_message carries the
        //    short reason. payload_match_count is recorded so the admin UI
        //    can show "incoming N rows, rejected because reason".
        const ledgerUpdateRes = await service
          .from('provider_sync_runs')
          .update({
            outcome: 'aborted',
            finished_at: new Date().toISOString(),
            error_class: sanity.outcome,
            error_message: sanity.reason,
            payload_match_count: fixtures.length,
          })
          .eq('id', runId);
        if (ledgerUpdateRes.error) {
          console.error('provider_sync_runs rejection update failed', ledgerUpdateRes.error);
          // Continue — we still want to write the audit row + return 422.
          // The ledger row will be stranded at 'in_progress' but the lock
          // release in `finally` prevents it from blocking further runs.
        }

        // 2. INSERT audit_log row (D-011: source='api_guard'). entity_id is
        //    NULL because provider_sync_runs.id is bigserial, not uuid, and
        //    audit_log.entity_id is a uuid column. The runId is captured in
        //    new_value.run_id alongside the structured diagnostic for
        //    forensic correlation.
        const auditInsertRes = await service.from('audit_log').insert({
          actor: null,
          action: sanity.audit_action,
          source: 'api_guard',
          entity_type: 'provider_sync_run',
          entity_id: null,
          new_value: {
            ...sanity.diagnostic,
            run_id: runId,
            correlation_id: body.run_id,
            provider: body.provider,
          },
          reason: sanity.reason,
        });
        if (auditInsertRes.error) {
          console.error('audit_log rejection insert failed', auditInsertRes.error);
          // Non-fatal — proceed to return 422 to the caller. Slice 007's
          // audit retention sweeps will surface the gap if it recurs.
        }

        // 3. T041 — run the R-008 state machine on the rejection path so
        //    payload-sanity failures count toward the sustained-outage
        //    threshold (consistent failure attribution: a provider that
        //    repeatedly ships empty/duplicate payloads is just as broken
        //    as one returning 5xx). outcome='aborted' matches the ledger
        //    value we just wrote above (D-010).
        await runOutageStateMachine(
          service,
          body.provider,
          'aborted',
          runId,
          body.run_id,
        );

        // 4. Return 422 with the contract-shaped error envelope. The
        //    advisory lock will release via the outer `finally`.
        const rejectionResponse: SyncResponse = {
          run_id: body.run_id,
          outcome: sanity.outcome,
          provider: body.provider,
          trigger: body.trigger,
          error: {
            code: 'PROVIDER_PAYLOAD_INVALID',
            message: sanity.reason,
          },
        };
        return jsonResponse(422, rejectionResponse);
      }
    }

    // ----- 7. UPSERT teams -------------------------------------------------
    // UPSERT by short_code (the UNIQUE key on public.teams from migration
    // 0019). The supabase-js .upsert returns rows on conflict-do-update;
    // we count successes from non-error returns.
    let teamsUpserted = 0;
    for (const t of teams) {
      const { error } = await service
        .from('teams')
        .upsert(
          {
            name: t.name,
            short_code: t.shortCode,
            flag_url: t.flagUrl,
          },
          { onConflict: 'short_code' },
        );
      if (!error) teamsUpserted++;
    }

    // Resolve team UUIDs by short_code so the matches UPSERT can populate
    // home_team_id / away_team_id. This is a single read covering every
    // team the slice cares about (at most 32).
    const { data: teamRows, error: teamReadErr } = await service
      .from('teams')
      .select('id, short_code');
    if (teamReadErr) {
      console.error('teams read failed', teamReadErr);
      throw teamReadErr;
    }
    const teamByCode = new Map<string, string>(
      (teamRows ?? []).map((r: { id: string; short_code: string }) => [
        r.short_code,
        r.id,
      ]),
    );

    // Provider team mappings (team_provider_external_ids). UNIQUE on
    // (provider_name, provider_team_id) makes this idempotent (R-003).
    for (const t of teams) {
      const teamId = teamByCode.get(t.shortCode);
      if (!teamId) continue;
      await service
        .from('team_provider_external_ids')
        .upsert(
          {
            team_id: teamId,
            provider_name: body.provider,
            provider_team_id: t.providerTeamId,
          },
          { onConflict: 'provider_name,provider_team_id' },
        );
    }

    // ----- 7b-pre. Read kickoff tolerance from tournament_config ---------
    // T040 needs this for the kickoff_change_after_lock classifier. The
    // key is provider_sync.kickoff_tolerance_minutes (T010 default 5).
    // If absent / unreadable we fall back to 5 — the research.md default.
    let kickoffToleranceMinutes = 5;
    {
      const { data: kRows, error: kErr } = await service
        .from('tournament_config')
        .select('value')
        .eq('key', 'provider_sync.kickoff_tolerance_minutes')
        .maybeSingle();
      if (!kErr && kRows?.value !== undefined && kRows.value !== null) {
        const n = Number(kRows.value);
        if (Number.isFinite(n) && n > 0) kickoffToleranceMinutes = n;
      }
    }
    // Lock-window minutes — TODO(slice-003): replace with a read from
    // tournament_config once Slice 003 ships the lock-window envelope. The
    // 60-minute value comes from research.md § R-005.
    const LOCK_WINDOW_MINUTES = 60;

    // Track per-row quarantines so we can compute the terminal outcome,
    // refresh provider_sync_runs.quarantined_count, and (if any quarantined)
    // emit the per-run audit_log summary row.
    let quarantinedCount = 0;
    const quarantinedProviderIds: string[] = [];

    // ----- 7b. UPSERT matches (with per-row conflict-quarantine) ----------
    // Idempotency key: natural triple (home_team_id, away_team_id,
    // kickoff_utc). Slice 002 ships no UNIQUE constraint on that triple, so
    // we cannot use ON CONFLICT. Pattern: SELECT existing row, UPDATE or
    // INSERT accordingly. Safe under the per-provider advisory lock — no
    // two concurrent same-provider syncs can race here (R-006).
    //
    // T040: BEFORE the natural-triple lookup, we look up the canonical
    // existing match via match_provider_external_ids (provider_name,
    // provider_match_id) — the R-003 idempotency anchor — and run the
    // pure-function classifier to detect cross-run conflicts. On quarantine
    // we INSERT a match_pending_review row and skip this fixture; sibling
    // fixtures continue to UPSERT normally (Clarifications Q2 hybrid policy).
    let matchesUpserted = 0;
    for (const f of fixtures) {
      const homeId = teamByCode.get(f.homeTeam.shortCode) ?? null;
      const awayId = teamByCode.get(f.awayTeam.shortCode) ?? null;

      // T040 — lookup existing canonical row via the provider mapping. This
      // is the R-003 idempotency anchor; it survives kickoff / team
      // rescheduling because the provider's native ID does not change.
      const { data: mappingRow, error: mappingLookupErr } = await service
        .from('match_provider_external_ids')
        .select(
          'match_id, matches:matches!inner(id, home_team_id, away_team_id, status, kickoff_utc)',
        )
        .eq('provider_name', body.provider)
        .eq('provider_match_id', f.providerMatchId)
        .maybeSingle();
      if (mappingLookupErr) {
        console.error('match mapping lookup failed', mappingLookupErr);
        // Treat as a coordinator-level error; skip this fixture rather
        // than blindly UPSERTing without conflict-checking.
        continue;
      }
      const linkedMatch = (mappingRow as
        | { match_id: string; matches: ExistingMatchSnapshot | ExistingMatchSnapshot[] | null }
        | null) ?? null;
      const linkedMatchRow = Array.isArray(linkedMatch?.matches)
        ? (linkedMatch?.matches[0] ?? null)
        : (linkedMatch?.matches ?? null);
      const existingSnapshot: ExistingMatchSnapshot | null = linkedMatchRow
        ? {
            id: linkedMatchRow.id,
            home_team_id: linkedMatchRow.home_team_id,
            away_team_id: linkedMatchRow.away_team_id,
            status: linkedMatchRow.status,
            kickoff_utc: linkedMatchRow.kickoff_utc,
          }
        : null;

      // T040 — pure-function classifier. Returns either 'ok' (proceed to
      // UPSERT) or 'quarantine' with the specific conflict_class.
      const verdict = classifyMatch({
        fixture: f,
        existing: existingSnapshot,
        homeTeamId: homeId,
        awayTeamId: awayId,
        lockWindowMinutes: LOCK_WINDOW_MINUTES,
        kickoffToleranceMinutes,
      });

      if (verdict.kind === 'quarantine') {
        const { error: pendingErr } = await service
          .from('match_pending_review')
          .insert({
            match_id: existingSnapshot?.id ?? null,
            provider: body.provider,
            provider_external_id: f.providerMatchId,
            sync_run_id: runId,
            conflict_class: verdict.conflict_class,
            // proposed_payload is the as-received provider row (jsonb).
            proposed_payload: f as unknown as Record<string, unknown>,
            // current_value snapshots the existing matches row at the
            // moment of detection; NULL when there was no existing row.
            current_value: existingSnapshot as unknown as Record<string, unknown> | null,
          });
        if (pendingErr) {
          console.error('match_pending_review insert failed', pendingErr);
          // Do NOT fall through to UPSERT — the conflict still exists,
          // and silently applying it would violate Clarifications Q2.
          continue;
        }
        quarantinedCount++;
        quarantinedProviderIds.push(f.providerMatchId);
        continue;
      }

      // No mapping for an unknown_team / team_assignment_change is
      // unreachable here (the classifier already short-circuited). At this
      // point homeId and awayId are guaranteed non-null.
      if (!homeId || !awayId) continue;

      const nowIso = new Date().toISOString();
      const matchPayload = {
        home_team_id: homeId,
        away_team_id: awayId,
        stage: f.stage,
        group_id: f.groupId,
        kickoff_utc: f.kickoffUtc,
        venue: f.venue,
        status: f.status,
        last_synced_at: nowIso,
      };

      // Try to find an existing row by the natural triple. PostgREST
      // doesn't support multi-column equality in a single chained filter as
      // ergonomically as we'd like; .eq() chains compose with AND. Prefer
      // the mapping-resolved id when available (it's the canonical row even
      // if the natural triple drifted slightly within the tolerance).
      let existingMatchId: string | null = existingSnapshot?.id ?? null;
      if (!existingMatchId) {
        const { data: existingByTriple, error: lookupErr } = await service
          .from('matches')
          .select('id')
          .eq('home_team_id', homeId)
          .eq('away_team_id', awayId)
          .eq('kickoff_utc', f.kickoffUtc)
          .maybeSingle();
        if (lookupErr) {
          console.error('match lookup failed', lookupErr);
          continue;
        }
        existingMatchId = existingByTriple?.id ?? null;
      }

      let matchId: string | null = null;
      if (existingMatchId) {
        const { error: updErr } = await service
          .from('matches')
          .update(matchPayload)
          .eq('id', existingMatchId);
        if (!updErr) {
          matchId = existingMatchId;
          matchesUpserted++;
        }
      } else {
        const { data: inserted, error: insErr } = await service
          .from('matches')
          .insert(matchPayload)
          .select('id')
          .single();
        if (!insErr && inserted) {
          matchId = inserted.id as string;
          matchesUpserted++;
        }
      }

      // Provider match mapping (R-003 idempotency anchor). UNIQUE on
      // (provider_name, provider_match_id) keeps this safe across retries.
      if (matchId) {
        await service
          .from('match_provider_external_ids')
          .upsert(
            {
              match_id: matchId,
              provider_name: body.provider,
              provider_match_id: f.providerMatchId,
            },
            { onConflict: 'provider_name,provider_match_id' },
          );
      }
    }

    // ----- 7c. Match results via record_match_result SP -------------------
    // The SP (T029 / migration 0024) enforces the contract's invariants:
    //   - match must exist + status='finished'
    //   - for_scoring <= official
    //   - shootout level-tie before penalties
    // SP runs SECURITY DEFINER so the service-role client can invoke it.
    //
    // T040: if the catalog says the match is not 'finished' but the provider
    // is shipping a score for it, that is the R-005 'score_before_finished'
    // anomaly. Quarantine the result row into match_pending_review rather
    // than silently dropping it (the silent skip in the T032 happy path
    // would leak the premature score into the next run's diff).
    let resultsUpserted = 0;
    for (const r of results) {
      // Resolve internal match_id via the provider mapping we just upserted.
      const { data: mapping } = await service
        .from('match_provider_external_ids')
        .select('match_id')
        .eq('provider_name', body.provider)
        .eq('provider_match_id', r.providerMatchId)
        .maybeSingle();
      if (!mapping?.match_id) continue;

      // Read the catalog status; the classifier decides whether to apply
      // the result or quarantine it.
      const { data: matchRow } = await service
        .from('matches')
        .select('status')
        .eq('id', mapping.match_id)
        .maybeSingle();

      const resultVerdict = classifyResult({
        matchStatus:
          (matchRow?.status as ExistingMatchSnapshot['status'] | undefined) ??
          null,
      });

      if (resultVerdict.kind === 'quarantine') {
        const { error: pendingErr } = await service
          .from('match_pending_review')
          .insert({
            match_id: mapping.match_id,
            provider: body.provider,
            provider_external_id: r.providerMatchId,
            sync_run_id: runId,
            conflict_class: resultVerdict.conflict_class,
            proposed_payload: r as unknown as Record<string, unknown>,
            // current_value is NULL — there is no existing match_results
            // row to snapshot (Slice 002's record_match_result SP enforces
            // the matches.status='finished' precondition, so an existing
            // match_results row here would be an invariant violation, not
            // a conflict).
            current_value: null,
          });
        if (pendingErr) {
          console.error('match_pending_review insert (result) failed', pendingErr);
          continue;
        }
        quarantinedCount++;
        quarantinedProviderIds.push(r.providerMatchId);
        continue;
      }

      const { error: spErr } = await service.rpc('record_match_result', {
        p_match_id: mapping.match_id,
        p_home_score_official: r.homeScoreOfficial,
        p_away_score_official: r.awayScoreOfficial,
        p_home_score_for_scoring: r.homeScoreForScoring,
        p_away_score_for_scoring: r.awayScoreForScoring,
        p_result_status: r.resultStatus,
        p_source: 'sync',
        p_approved_by: null,
      });
      if (!spErr) resultsUpserted++;
    }

    // ----- 7d. Players branch (Slice 004 / T031) -------------------------
    // Per contracts/players-ingest.md § Producer: AFTER the matches +
    // results loops, if the adapter exposes the optional fetchPlayers?()
    // method (slice 002 reserved the signature), invoke it and UPSERT the
    // results into `players` + `player_provider_external_ids`. The whole
    // block is best-effort vs the matches outcome — any error here is
    // logged + swallowed so an incidental players-branch failure cannot
    // poison a healthy matches sync.
    //
    // Same `runId` (the matches-branch ledger row id) is passed so the
    // audit envelopes correlate to one invocation. Slice 005 / Slice 006
    // forensic queries read the matching run_id from new_value.run_id.
    //
    // The 50% undersized safety net lives INSIDE upsertPlayers — when it
    // trips, the helper writes its own audit row and returns
    // { quarantined: true } without mutating `players`. The caller surfaces
    // the flag in the response counts only (no separate response shape —
    // the matches outcome remains the terminal outcome for the wire
    // contract; the players branch is observability).
    let playersUpsertResult: UpsertPlayersResult | null = null;
    if (typeof adapter.fetchPlayers === 'function') {
      try {
        const incomingPlayers = await adapter.fetchPlayers();
        playersUpsertResult = await upsertPlayers(
          service,
          incomingPlayers,
          runId,
          body.provider,
        );
      } catch (e) {
        console.error('players branch failed (swallowed)', e);
        // playersUpsertResult stays null — wire counts will omit
        // players_upserted, matches outcome stands.
      }
    }

    // ----- 8. Terminal UPDATE + provider_sync_state refresh ---------------
    // Outcome rules (T040 — Clarifications 2026-05-15 Q2 hybrid policy):
    //   quarantinedCount === 0                              → 'success'
    //   quarantinedCount > 0  AND any rows applied          → 'partial'
    //   quarantinedCount > 0  AND no rows applied           → 'conflict_quarantined'
    // T035's two Deno tests + T037's Playwright test accept BOTH 'partial'
    // and 'conflict_quarantined' on the wire when quarantine occurred; the
    // distinction matters for downstream alerting.
    //
    // Schema CHECK on outcome forbids 'success_no_changes' as a stored
    // value (migration 0022's enum); we record 'success' on the ledger
    // either way but surface 'success_no_changes' on the JSON response when
    // nothing changed, per the contract response shape.
    const anyApplied =
      teamsUpserted > 0 || matchesUpserted > 0 || resultsUpserted > 0;
    const nothingChanged = !anyApplied && quarantinedCount === 0;

    let ledgerOutcome: 'success' | 'partial' | 'conflict_quarantined' = 'success';
    let responseOutcome: string;
    if (quarantinedCount === 0) {
      ledgerOutcome = 'success';
      responseOutcome = nothingChanged ? 'success_no_changes' : 'success';
    } else if (anyApplied) {
      ledgerOutcome = 'partial';
      responseOutcome = 'partial';
    } else {
      ledgerOutcome = 'conflict_quarantined';
      responseOutcome = 'conflict_quarantined';
    }

    await service
      .from('provider_sync_runs')
      .update({
        outcome: ledgerOutcome,
        finished_at: new Date().toISOString(),
        payload_match_count: fixtures.length,
        applied_match_count: matchesUpserted,
        quarantined_count: quarantinedCount,
      })
      .eq('id', runId);

    // ----- 8b. Audit summary on quarantine --------------------------------
    // One row per run that produced ANY quarantine, action=
    // 'provider.conflict_quarantined', source='api_guard' (D-011 — least-bad
    // fit for the audit_log.source CHECK whitelist {auth_hook, rls,
    // api_guard, ui, trigger}; Slice 007 will add a 'sync' source). Non-fatal
    // on error — the quarantine rows themselves are the load-bearing record,
    // the audit summary is forensic glue. entity_id is NULL because
    // provider_sync_runs.id is bigserial, not uuid; the run identifier rides
    // in new_value.run_id alongside the list of quarantined provider IDs.
    if (quarantinedCount > 0) {
      const auditRes = await service.from('audit_log').insert({
        actor: null,
        action: 'provider.conflict_quarantined',
        source: 'api_guard',
        entity_type: 'provider_sync_run',
        entity_id: null,
        new_value: {
          run_id: runId,
          correlation_id: body.run_id,
          provider: body.provider,
          quarantined_count: quarantinedCount,
          quarantined_provider_ids: quarantinedProviderIds,
          outcome: ledgerOutcome,
        },
        reason: 'per_row_conflict_quarantined',
      });
      if (auditRes.error) {
        console.error('audit_log conflict_quarantined insert failed', auditRes.error);
      }
    }

    // ----- 9. provider_sync_state via R-008 state machine (T041) ---------
    // Replaces the T032 stub upsert. The state machine handles:
    //   - clearing the outage ledger on success (the "currently healthy"
    //     reset that T032 used to do inline), AND
    //   - emitting `provider.recovered` audit + recovery webhook when the
    //     run closes a previously-alerted outage (R-008 + Clarifications
    //     Q3 symmetry — the recovery half of the dedup ledger).
    //
    // Outcome mapping: `success_no_changes` is a wire-only label; from the
    // state machine's perspective any non-failure terminal outcome is a
    // healthy run. We pass `ledgerOutcome` directly because T040 already
    // narrowed it to the three healthy outcomes.
    const outageOutcome: OutageOutcome =
      ledgerOutcome === 'success' && nothingChanged
        ? 'success_no_changes'
        : ledgerOutcome;
    await runOutageStateMachine(
      service,
      body.provider,
      outageOutcome,
      runId,
      body.run_id,
    );

    const response: SyncResponse = {
      run_id: body.run_id,
      outcome: responseOutcome,
      provider: body.provider,
      trigger: body.trigger,
      counts: {
        teams_upserted: teamsUpserted,
        matches_upserted: matchesUpserted,
        results_upserted: resultsUpserted,
        // Slice 004 / T031 — surface the players-branch counts on the wire
        // when fetchPlayers ran. Absent when the adapter does NOT implement
        // the optional method (backwards-compatible with slice-002 tests
        // that assert only on the matches counts).
        ...(playersUpsertResult !== null
          ? {
              players_upserted: playersUpsertResult.upserted,
              players_soft_deleted: playersUpsertResult.softDeleted,
            }
          : {}),
      },
    };
    return jsonResponse(200, response);
  } catch (e) {
    // Defense in depth: any unhandled exception inside the UPSERT loop
    // marks the run as 'failure' so the ledger doesn't strand a row at
    // 'in_progress' forever. Lock release happens in `finally`.
    console.error('coordinator unhandled error', e);
    await service
      .from('provider_sync_runs')
      .update({
        outcome: 'failure',
        finished_at: new Date().toISOString(),
        error_class: 'unknown',
        error_message: (e as Error).message ?? String(e),
      })
      .eq('id', runId);
    // T041 — even the catch-all path must run the R-008 state machine so
    // a coordinator-level bug that surfaces as an exception still counts
    // toward sustained-outage detection (it would be misleading to alert
    // ops about "provider down" only for adapter errors when our own code
    // could just as well be the culprit; the alert says "this provider's
    // sync is broken", not "the provider's API is broken").
    await runOutageStateMachine(service, body.provider, 'failure', runId, body.run_id);
    return err(500, 'INTERNAL', `sync failed: ${(e as Error).message ?? e}`);
  } finally {
    // Always release the advisory lock, even on assertion failure / thrown
    // error in the try block. The helper is idempotent — calling unlock on
    // a session that doesn't hold the lock returns false but does not
    // raise (pg_advisory_unlock semantics).
    try {
      await service.rpc('unlock_sync', { p_provider: body.provider });
    } catch (e) {
      console.error('unlock_sync error (swallowed)', e);
    }
  }

  // Unreachable: every branch above returns. The explicit no-op keeps the
  // TypeScript exhaustiveness checker happy. Note _authPath is currently
  // unused beyond the auth gate; future tasks (T040 audit) may surface it
  // into the audit_log payload.
  // deno-lint-ignore no-unused-vars
  const _authPath = authPath;
});
