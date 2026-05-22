/**
 * Shared TypeScript types for the slice 006 admin surface.
 *
 * No runtime code — pure type declarations. Safe to import from both server
 * and client modules (no `'server-only'` boundary).
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md
 */

/**
 * Locked label set of admin-emitted `audit_log.action` values. Slice 006's
 * admin RPCs and the `requireAdmin` guard emit rows tagged with one of these
 * action labels.
 *
 * Cross-slice contract: the label set is **locked** per
 * `admin-rpcs.write.md § Audit emission pattern` — slice 008 may extend the
 * set, but existing labels MUST NOT change.
 */
export type AdminAction =
  | 'admin.match_result_corrected'
  | 'admin.match_updated'
  | 'admin.tournament_award_updated'
  | 'admin.prediction_submitted'
  | 'admin.final_prediction_submitted'
  | 'admin.recalc_triggered'
  | 'admin.role_granted'
  | 'admin.role_revoked'
  | 'admin.access_denied'
  | 'admin.match_pending_review_resolved';

/**
 * Postgres ERRCODE values raised by the admin RPC family (slot 0049+).
 * Locked per `admin-rpcs.write.md § ERRCODE values`.
 *
 *  - `WAR01` — admin role required (403)
 *  - `WAR02` — reason missing or empty (400)
 *  - `WAR03` — source citation missing or empty (400)
 *  - `WAR04` — target not found / shape validation failure (route handlers map
 *             to 404 by default, but may remap to 400 based on the underlying
 *             SP's MESSAGE — admin_update_tournament_award uses WAR04 for
 *             item_kind/status/shape validation failures which are 400-shaped)
 *  - `WAR05` — invariant violation propagated from underlying SP
 *  - `WAR06` — concurrent admin action / advisory lock contention (409)
 *  - `WAR07` — no-op (admin call did not change any tracked column) (409)
 */
export type AdminERRCODE =
  | 'WAR01'
  | 'WAR02'
  | 'WAR03'
  | 'WAR04'
  | 'WAR05'
  | 'WAR06'
  | 'WAR07';

/**
 * Uniform envelope returned by admin RPC wrappers in `rpcs.ts`. Route handlers
 * map `error.code` → HTTP status using `ERRCODE_HTTP_MAP`.
 */
export interface AdminRPCResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code:
      | AdminERRCODE
      | 'BAD_REQUEST'
      | 'UNAUTHENTICATED'
      | 'FORBIDDEN'
      | 'INTERNAL';
    reason?: string;
    message?: string;
    field?: string;
  };
}

/**
 * Row shape of `public.audit_log` as visible to admin readers. Mirrors the
 * slot 0003 stub plus the slot 0061 `source_citation` additive column. The
 * `previous_value` / `new_value` columns are typed `unknown` because their
 * jsonb payloads vary per action label.
 */
export interface AdminAuditRow {
  id: string;
  actor: string | null;
  action: AdminAction | string;
  entity_type: string | null;
  entity_id: string | null;
  previous_value: unknown | null;
  new_value: unknown | null;
  reason: string | null;
  source: string;
  source_citation: string | null;
  occurred_at: string;
}

/**
 * Input shape for `admin_record_match_result(...)` (US1 manual score
 * correction). Locked per `admin-rpcs.write.md`.
 */
export interface AdminMatchCorrection {
  match_id: string;
  home_score_official: number;
  away_score_official: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  /** 'regulation' | 'extra_time' | 'penalties_shootout' */
  result_status: string;
  reason: string;
  source_citation: string;
}

/**
 * Input shape for `admin_trigger_recalc(...)` (US2 manual recalc). The
 * `target_id` field is required when `scope === 'match'` and ignored
 * otherwise.
 */
export interface AdminRecalcRequest {
  scope: 'match' | 'finals' | 'all';
  target_id?: string;
  reason: string;
}
