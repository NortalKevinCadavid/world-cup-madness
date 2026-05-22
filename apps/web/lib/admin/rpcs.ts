import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AdminERRCODE, AdminMatchCorrection, AdminRPCResponse } from './types';

/**
 * ERRCODE → HTTP status mapping for the admin RPC family. Locked per
 * `admin-rpcs.write.md § ERRCODE values`. Route handlers consult this table
 * to translate Postgres ERRCODE values raised by slot 0049+ SECURITY DEFINER
 * functions into appropriate HTTP responses.
 *
 *  - WAR01 → 403 (admin role required)
 *  - WAR02 → 400 (reason missing or empty)
 *  - WAR03 → 400 (source citation missing or empty)
 *  - WAR04 → 404 (target not found; route handlers MAY remap to 400 for
 *                 shape-validation failures whose underlying SP carries the
 *                 'invalid' / 'requires' substring in the MESSAGE — e.g.
 *                 admin_update_tournament_award's item_kind/status/shape
 *                 checks)
 *  - WAR05 → 409 (invariant violation; route handlers MAY further refine
 *                 based on the underlying SP's ERRCODE preserved in MESSAGE)
 *  - WAR06 → 409 (concurrent admin action / scoring-lock contention)
 *  - WAR07 → 409 (no-op; the admin call did not produce an observable change
 *                 — admin_update_match and admin_update_tournament_award)
 *
 * Note: WAR05's mapping to 409 is a default; per the contract, the route
 * handler MAY remap if it can introspect the underlying SP ERRCODE that was
 * preserved in the exception MESSAGE (e.g., a Slice 002 BAD_INPUT invariant
 * → 400).
 */
export const ERRCODE_HTTP_MAP: Record<AdminERRCODE, number> = {
  WAR01: 403,
  WAR02: 400,
  WAR03: 400,
  WAR04: 404,
  WAR05: 409,
  WAR06: 409,
  WAR07: 409,
};

/**
 * Type-guard that narrows an unknown string to an `AdminERRCODE`. Used by the
 * RPC wrappers below to safely tag a returned error envelope.
 */
function isAdminErrcode(code: string | undefined): code is AdminERRCODE {
  return (
    code === 'WAR01' ||
    code === 'WAR02' ||
    code === 'WAR03' ||
    code === 'WAR04' ||
    code === 'WAR05' ||
    code === 'WAR06' ||
    code === 'WAR07'
  );
}

/**
 * Typed wrapper around `admin_record_match_result(...)` (US1).
 *
 * Caller MUST have already passed `requireAdmin(client)` — this wrapper does
 * NOT re-check admin authority client-side (the underlying SP's WAR01
 * pre-flight is the source of truth). Reason + source_citation are required
 * non-empty per WAR02/WAR03; the wrapper does not pre-validate (the SP does).
 *
 * On success returns `{ ok: true, data: { match_id } }`. On error returns
 * `{ ok: false, error: { code, message } }` where `code` is one of WAR01–06
 * if the Postgres exception carried a known SQLSTATE, else `INTERNAL`.
 *
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md § admin_record_match_result
 */
export async function recordMatchResult(
  client: SupabaseClient,
  input: AdminMatchCorrection,
): Promise<AdminRPCResponse<{ match_id: string }>> {
  const { data, error } = await client.rpc('admin_record_match_result', {
    p_match_id: input.match_id,
    p_home_score_official: input.home_score_official,
    p_away_score_official: input.away_score_official,
    p_home_score_for_scoring: input.home_score_for_scoring,
    p_away_score_for_scoring: input.away_score_for_scoring,
    p_result_status: input.result_status,
    p_reason: input.reason,
    p_source_citation: input.source_citation,
  });

  if (error) {
    const code = isAdminErrcode(error.code) ? error.code : 'INTERNAL';
    return {
      ok: false,
      error: {
        code,
        message: error.message,
      },
    };
  }

  return { ok: true, data: { match_id: data as string } };
}
