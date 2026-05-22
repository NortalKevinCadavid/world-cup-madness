/**
 * Slice 002 / T041 — Outage-alert dedup + recovery state machine.
 *
 * Pure-function module: takes the current `provider_sync_state` row plus the
 * terminal outcome of the just-finished sync run and decides which side of
 * the R-008 state machine fires next. The coordinator (sync-catalog/index.ts)
 * owns the I/O — SELECT current state, read tournament_config thresholds,
 * UPSERT the new state, INSERT audit_log row, POST the optional webhook.
 * This module owns ONLY the decision + payload shapes.
 *
 * Why split it out
 *   - The coordinator file already routes T032 happy path, T039 payload-sanity
 *     guards, and T040 per-row conflict-quarantine. Adding the outage-dedup
 *     state machine in-line would make the terminal branches unreviewable.
 *   - Pure functions are trivially Deno-test-able without a Postgres harness;
 *     the threshold / dedup / recovery transitions are all unit-checkable
 *     here while the integration tests in `tests/outage_alert_dedup.test.ts`
 *     and `tests/recovery_clears_outage_state.test.ts` cover the wire shape.
 *
 * R-008 state machine (research.md):
 *
 *   Failure outcomes ('failure' | 'aborted'):
 *     - first_failure_after_success_at ← COALESCE(existing, now())
 *     - consecutive_failures ← existing + 1
 *     - If now() - first_failure > threshold AND outage_alert_emitted_at IS NULL:
 *         outage_alert_emitted_at ← now()
 *         recovery_alert_pending  ← true
 *         emit 'provider.outage_alert_emitted' audit + webhook
 *
 *   Success outcomes ('success' | 'success_no_changes' | 'partial' |
 *                     'conflict_quarantined'):
 *     - If recovery_alert_pending AND outage_recovery_alert_enabled:
 *         emit 'provider.recovered' audit + webhook
 *     - last_success_at ← now()
 *     - consecutive_failures ← 0
 *     - first_failure_after_success_at ← NULL
 *     - outage_alert_emitted_at ← NULL
 *     - recovery_alert_pending ← false
 *
 * Outcome string vocabulary (D-010 reconciliation, mirrors payload_sanity.ts)
 *   The wire outcome `success_no_changes` is a coordinator-side label; on the
 *   ledger we still store `success`. Both map to the recovery branch here —
 *   any non-failure terminal outcome is a healthy run. The wire string
 *   `aborted` (payload-sanity rejection) is treated as a failure for outage
 *   purposes because the provider did deliver a structurally broken payload
 *   we refused to apply (consistent failure attribution per T041 prompt).
 */

/**
 * Mirror of the public.provider_sync_state row shape this module touches.
 * `provider` and `updated_at` columns are managed by the coordinator's UPSERT
 * and are not part of the state-machine decision surface (they don't change
 * the action this module returns).
 */
export interface OutageStateRow {
  provider: string;
  last_success_at: string | null;
  consecutive_failures: number;
  first_failure_after_success_at: string | null;
  outage_alert_emitted_at: string | null;
  recovery_alert_pending: boolean;
}

/**
 * Outcome strings the evaluator accepts. The first two are happy-path strings
 * from the coordinator (`success` is what the ledger stores; the wire may
 * surface `success_no_changes` when nothing changed — both are "healthy" from
 * the outage-state perspective). `partial` and `conflict_quarantined` are
 * R-005 quarantine outcomes (T040): the sync still applied at least one row
 * or refused everything for catalog-level reasons; either way the provider
 * is talking to us, so it counts as a non-outage outcome.
 *
 * `failure` and `aborted` are the only outcomes that bump the outage ledger.
 * `failure` covers adapter-fetch errors (network/auth/rate-limit) and the
 * defensive outer catch. `aborted` covers T039 payload-sanity rejections —
 * we refused to apply because the provider sent an empty / undersized /
 * duplicate-laden payload. Treating both as failures preserves consistent
 * failure attribution (T041 prompt).
 */
export type Outcome =
  | 'success'
  | 'success_no_changes'
  | 'partial'
  | 'conflict_quarantined'
  | 'failure'
  | 'aborted';

/** Input bundle for the evaluator. `nowIso` is injected to keep the function pure. */
export interface EvaluateInput {
  outcome: Outcome;
  /** Existing row from public.provider_sync_state, or null if no row yet. */
  current: OutageStateRow | null;
  /** ISO-8601 timestamp to use for `now()`. Coordinator passes new Date().toISOString(). */
  nowIso: string;
  /** Minutes without success before the first outage alert may fire (R-008). */
  thresholdMinutes: number;
  /** Mirror of tournament_config.notifications.outage_recovery_alert_enabled. */
  recoveryAlertEnabled: boolean;
}

/**
 * Result discriminator. The coordinator branches on `kind`:
 *   - `no_change`: nothing to write (defensive — covers an unknown outcome).
 *   - `mark_failure`: write the new state, no audit, no webhook.
 *   - `mark_failure_with_alert`: write the new state, INSERT audit row with
 *      action='provider.outage_alert_emitted', POST outage webhook (if URL).
 *   - `mark_success_clean`: write the new state (cleared outage fields), no
 *      audit, no webhook. Happens when there was no active alerted outage.
 *   - `mark_recovery`: write the new state (cleared outage fields), INSERT
 *      audit row with action='provider.recovered', POST recovery webhook
 *      (if URL). Happens when recovery_alert_pending was true.
 */
export type EvaluateAction =
  | { kind: 'no_change' }
  | { kind: 'mark_failure'; new_state: OutageStateRow }
  | {
      kind: 'mark_failure_with_alert';
      new_state: OutageStateRow;
      alert_audit: 'provider.outage_alert_emitted';
    }
  | { kind: 'mark_success_clean'; new_state: OutageStateRow }
  | {
      kind: 'mark_recovery';
      new_state: OutageStateRow;
      alert_audit: 'provider.recovered';
      /**
       * Snapshot of the outage start (the value of
       * first_failure_after_success_at before this success cleared it).
       * The coordinator needs this for the recovery webhook payload —
       * the cleared `new_state` no longer carries it.
       */
      outage_started_at: string | null;
    };

function isFailureOutcome(o: Outcome): boolean {
  return o === 'failure' || o === 'aborted';
}

function isSuccessOutcome(o: Outcome): boolean {
  return (
    o === 'success' ||
    o === 'success_no_changes' ||
    o === 'partial' ||
    o === 'conflict_quarantined'
  );
}

/**
 * Evaluate the R-008 state machine for a single terminal outcome.
 *
 * Threshold semantics: the gate fires when the elapsed minutes since
 * `first_failure_after_success_at` strictly meet or exceed `thresholdMinutes`.
 * Equal-to fires (rounding edge — the test sets threshold=1 and backdates by
 * 2 minutes so the gate is unambiguously open). The pre-existing
 * `outage_alert_emitted_at IS NULL` precondition is the dedup invariant
 * (SC-003): once we've emitted for THIS outage, we do not re-emit until a
 * successful sync clears the ledger.
 *
 * Caller is responsible for atomicity: read current state, call this,
 * UPSERT the result. Safe under the per-provider advisory lock (R-006) — no
 * two same-provider syncs run concurrently.
 */
export function evaluateOutageState(input: EvaluateInput): EvaluateAction {
  const { outcome, current, nowIso, thresholdMinutes, recoveryAlertEnabled } =
    input;

  // Coalesce nulls to a defensible default so we don't have to repeat the
  // ?? null pattern below. The coordinator passes either the row it read
  // OR null when no row exists yet — either way we build a baseline that
  // the failure / success branches treat uniformly.
  const baseline: OutageStateRow = {
    provider: current?.provider ?? '',
    last_success_at: current?.last_success_at ?? null,
    consecutive_failures: current?.consecutive_failures ?? 0,
    first_failure_after_success_at:
      current?.first_failure_after_success_at ?? null,
    outage_alert_emitted_at: current?.outage_alert_emitted_at ?? null,
    recovery_alert_pending: current?.recovery_alert_pending ?? false,
  };

  if (isFailureOutcome(outcome)) {
    // First-failure-after-success: anchor the outage start at the FIRST
    // failure's wall-clock. Subsequent failures must NOT overwrite the
    // anchor — the dedup test's "Failure #1" depends on the coordinator
    // preserving the seeded backdated value (test comment, lines 270-276
    // in outage_alert_dedup.test.ts).
    const firstFailure = baseline.first_failure_after_success_at ?? nowIso;
    const failureCount = baseline.consecutive_failures + 1;

    // Threshold check is gated on:
    //   (a) elapsed minutes since outage start >= threshold, AND
    //   (b) we have NOT already emitted an alert for this outage.
    // (b) is the SC-003 dedup invariant — flap-spam prevention.
    const elapsedMs =
      new Date(nowIso).getTime() - new Date(firstFailure).getTime();
    const elapsedMin = elapsedMs / 1000 / 60;
    const shouldAlert =
      elapsedMin >= thresholdMinutes && !baseline.outage_alert_emitted_at;

    if (shouldAlert) {
      return {
        kind: 'mark_failure_with_alert',
        new_state: {
          ...baseline,
          consecutive_failures: failureCount,
          first_failure_after_success_at: firstFailure,
          outage_alert_emitted_at: nowIso,
          // Arm the recovery side: the next successful sync MUST emit
          // 'provider.recovered' (R-008 symmetry, Clarifications Q3).
          recovery_alert_pending: true,
        },
        alert_audit: 'provider.outage_alert_emitted',
      };
    }

    return {
      kind: 'mark_failure',
      new_state: {
        ...baseline,
        consecutive_failures: failureCount,
        first_failure_after_success_at: firstFailure,
      },
    };
  }

  if (isSuccessOutcome(outcome)) {
    // Recovery branch: were we in an alerted outage AND is recovery
    // signalling enabled? The config gate (recoveryAlertEnabled) lets ops
    // suppress the recovery channel without disabling outage alerts —
    // useful if a webhook destination has its own auto-resolve.
    if (baseline.recovery_alert_pending && recoveryAlertEnabled) {
      return {
        kind: 'mark_recovery',
        new_state: {
          ...baseline,
          last_success_at: nowIso,
          consecutive_failures: 0,
          first_failure_after_success_at: null,
          outage_alert_emitted_at: null,
          recovery_alert_pending: false,
        },
        alert_audit: 'provider.recovered',
        outage_started_at: baseline.first_failure_after_success_at,
      };
    }

    // Clean-success path: clear any in-flight outage tracking (perhaps a
    // short blip that never crossed the threshold) without emitting a
    // recovery signal — there was nothing to recover from operationally.
    return {
      kind: 'mark_success_clean',
      new_state: {
        ...baseline,
        last_success_at: nowIso,
        consecutive_failures: 0,
        first_failure_after_success_at: null,
        outage_alert_emitted_at: null,
        recovery_alert_pending: false,
      },
    };
  }

  // Defensive fall-through: an unknown outcome string. Don't write state.
  // The coordinator caller would have to pass an invented Outcome literal
  // for this branch to hit; recorded as no_change for forward compatibility.
  return { kind: 'no_change' };
}

/**
 * Build the outage-alert webhook payload (Clarifications Q3 shape).
 * `recentRuns` is the operator-facing forensic glue — last few ledger rows
 * for the provider so the on-call doesn't have to query the DB to triage.
 */
export function buildOutageWebhookPayload(input: {
  provider: string;
  current: OutageStateRow;
  recentRuns: Array<{
    id: number | string;
    outcome: string;
    finished_at: string | null;
    error_class: string | null;
  }>;
  nowIso: string;
}): Record<string, unknown> {
  const outageStart = input.current.first_failure_after_success_at;
  return {
    event: 'outage_alert',
    provider: input.provider,
    first_failure_after_success_at: outageStart,
    outage_alert_emitted_at: input.current.outage_alert_emitted_at,
    consecutive_failures: input.current.consecutive_failures,
    minutes_in_outage: outageStart
      ? Math.floor(
          (new Date(input.nowIso).getTime() -
            new Date(outageStart).getTime()) /
            1000 /
            60,
        )
      : 0,
    recent_runs: input.recentRuns,
  };
}

/** Build the recovery webhook payload (Clarifications Q3 symmetric shape). */
export function buildRecoveryWebhookPayload(input: {
  provider: string;
  outageStartedAt: string | null;
  recoveredAt: string;
}): Record<string, unknown> {
  return {
    event: 'provider_recovered',
    provider: input.provider,
    outage_started_at: input.outageStartedAt,
    recovered_at: input.recoveredAt,
    minutes_in_outage: input.outageStartedAt
      ? Math.floor(
          (new Date(input.recoveredAt).getTime() -
            new Date(input.outageStartedAt).getTime()) /
            1000 /
            60,
        )
      : 0,
  };
}
