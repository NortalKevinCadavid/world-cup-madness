/**
 * Slice 002 / T039 — payload-sanity guards for the sync-catalog coordinator.
 *
 * Pure-function module: takes the fetched payload + DB state + tournament_config
 * thresholds and decides whether the payload is structurally sound enough to
 * apply. The three guards live here (R-004 + the in-payload duplicate strand of
 * R-005) so the coordinator file stays readable; the coordinator owns the I/O
 * (config read, existing-count read, ledger UPDATE, audit INSERT, 422 wire
 * response). This module owns ONLY the decision.
 *
 * Why split it out
 *   - The coordinator file is already ~600 lines (T032 happy path). T040
 *     (conflict quarantine) and T041 (outage state machine) will both add
 *     branches into the same UPSERT loop. Pulling the sanity guards into a
 *     pure-function module keeps the coordinator's payload-rejection branch
 *     small (read config + call evaluate + on rejection: ledger / audit / 422).
 *   - Pure functions are trivially Deno-test-able without a Postgres harness.
 *
 * Outcome string vocabulary (D-010 reconciliation)
 *   The DB CHECK on provider_sync_runs.outcome accepts:
 *     success | failure | partial | conflict_quarantined | aborted | in_progress
 *   It does NOT accept rejected_empty / rejected_undersized /
 *   rejected_duplicate_in_payload. The contract (sync-runner.scheduled.md
 *   § 422) requires the JSON response carry one of those specific strings so
 *   the client / admin UI can distinguish the rejection class.
 *   Resolution: store outcome='aborted' on the ledger row with the specific
 *   rejected_* string in error_class; return the specific rejected_* on the
 *   wire. Caller does both.
 */

import type { NormalizedFixture } from '../_shared/providers/types.ts';

/**
 * The three rejection classes this slice cares about. These are the strings
 * the JSON response surfaces back to the caller (per contract § 422) AND the
 * value the coordinator writes into provider_sync_runs.error_class. The
 * outcome stored in provider_sync_runs.outcome is always 'aborted' (D-010).
 */
export type PayloadSanityOutcome =
  | 'rejected_empty'
  | 'rejected_undersized'
  | 'rejected_duplicate_in_payload';

/**
 * Result discriminator. ok === true is the happy path (coordinator continues
 * to UPSERT). ok === false carries everything the coordinator needs to record
 * the rejection and return 422 without re-deriving any of it.
 */
export type PayloadSanityResult =
  | { ok: true }
  | {
      ok: false;
      /** Specific rejection class; goes on the wire AND into error_class. */
      outcome: PayloadSanityOutcome;
      /** audit_log.action value the coordinator INSERTs on rejection. */
      audit_action: string;
      /** Short machine-readable reason; goes into error_message + audit.reason. */
      reason: string;
      /** Structured diagnostic; goes into audit_log.new_value as jsonb. */
      diagnostic: Record<string, unknown>;
    };

/**
 * Inputs the coordinator passes in. Reading these from the DB / config is
 * the coordinator's job; this module never touches Postgres.
 */
export interface PayloadSanityInputs {
  /** Normalized fixtures the adapter returned for this run. */
  fixtures: NormalizedFixture[];
  /** SELECT count(*) FROM matches at the moment the guard runs. */
  existingMatchCount: number;
  /**
   * tournament_config.provider_sync.payload.min_count_ratio (default 0.5).
   * If incoming count < this fraction of existing → undersized.
   */
  minCountRatio: number;
  /**
   * tournament_config.provider_sync.payload.reject_on_empty_replacement
   * (default true). When false, an empty payload against a populated
   * catalog is NOT rejected — useful for tournaments that legitimately
   * start with zero scheduled matches and pull them in mid-run.
   */
  rejectOnEmpty: boolean;
  /**
   * tournament_config.provider_sync.payload.reject_on_duplicate_external_ids
   * (default true). When false, duplicate provider_match_id rows in the
   * incoming payload are allowed (the per-row UPSERT will collapse them).
   */
  rejectOnDuplicate: boolean;
}

/**
 * Evaluate the three payload-sanity guards in order. The first guard that
 * trips wins; the caller stops the run on the first { ok: false } it sees.
 *
 * Guard order (matters):
 *   1. Empty replacement — fixtures.length === 0 against a populated
 *      catalog is the cheapest check and the most catastrophic anomaly
 *      (would silently wipe the read path's data if we allowed it). Per
 *      spec Clarifications 2026-05-15 Q2: structural anomalies abort the
 *      whole run (not per-row quarantine).
 *   2. Undersized — fixtures.length < minCountRatio * existing. The
 *      configurable threshold (default 50%) catches provider responses
 *      that returned a partial result due to upstream filtering, without
 *      false-positiving on legitimate small windows.
 *   3. In-payload duplicates — two fixtures sharing the same
 *      providerMatchId in a single payload is a provider bug. We reject
 *      rather than UPSERT-collapsing because the second row could carry
 *      a different team / kickoff than the first and the silent collapse
 *      would erase the inconsistency.
 *
 * Note: cross-run conflicts (existing match row says team A vs B, incoming
 * says team A vs C for the same provider_match_id) are R-005 and live in
 * T040's per-row quarantine logic — NOT here. This module never reads
 * matches state beyond the count.
 */
export function evaluatePayloadSanity(input: PayloadSanityInputs): PayloadSanityResult {
  const {
    fixtures,
    existingMatchCount,
    minCountRatio,
    rejectOnEmpty,
    rejectOnDuplicate,
  } = input;

  // ----- Guard 1: empty replacement ----------------------------------------
  // Only trips when the catalog is already populated. A first-time sync
  // against an empty matches table legitimately gets zero rows back if the
  // provider has none yet — that's NOT an anomaly.
  if (rejectOnEmpty && fixtures.length === 0 && existingMatchCount > 0) {
    return {
      ok: false,
      outcome: 'rejected_empty',
      audit_action: 'provider.sync_rejected_empty',
      reason: 'empty_payload_replacing_populated_catalog',
      diagnostic: {
        incoming: 0,
        existing: existingMatchCount,
      },
    };
  }

  // ----- Guard 2: undersized payload ---------------------------------------
  // Only meaningful when the catalog is populated; if existing === 0 then
  // ANY incoming count >= 0 satisfies the ratio trivially and we'd just be
  // dividing by zero in spirit. Skip the guard for a fresh catalog.
  if (
    existingMatchCount > 0 &&
    fixtures.length < minCountRatio * existingMatchCount
  ) {
    return {
      ok: false,
      outcome: 'rejected_undersized',
      audit_action: 'provider.sync_rejected_undersized',
      reason: 'payload_undersized_below_threshold',
      diagnostic: {
        incoming: fixtures.length,
        existing: existingMatchCount,
        threshold_ratio: minCountRatio,
        required_minimum: Math.ceil(minCountRatio * existingMatchCount),
      },
    };
  }

  // ----- Guard 3: in-payload duplicate provider_match_id -------------------
  // Count occurrences in a single pass; emit the full list of dup ids in
  // the diagnostic so the admin alert can pinpoint which rows the provider
  // double-sent. We do NOT reveal the conflicting team / kickoff pairs
  // here — that's a forensics step the admin runs against the raw payload
  // captured by Slice 007.
  if (rejectOnDuplicate) {
    const seen = new Map<string, number>();
    for (const f of fixtures) {
      seen.set(f.providerMatchId, (seen.get(f.providerMatchId) ?? 0) + 1);
    }
    const duplicateIds: string[] = [];
    for (const [id, count] of seen.entries()) {
      if (count > 1) duplicateIds.push(id);
    }
    if (duplicateIds.length > 0) {
      return {
        ok: false,
        outcome: 'rejected_duplicate_in_payload',
        audit_action: 'provider.sync_rejected_duplicate',
        reason: 'duplicate_provider_match_ids',
        diagnostic: {
          duplicate_ids: duplicateIds,
          incoming: fixtures.length,
        },
      };
    }
  }

  return { ok: true };
}
