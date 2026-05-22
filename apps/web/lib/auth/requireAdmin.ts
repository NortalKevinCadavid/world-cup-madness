import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireEligible, EligibilityError } from './requireEligible';
import type { Participant } from '../types/participant';

/**
 * Reasons `requireAdmin` can fail.
 *
 *  - `no_session`     — bubbled up from slice 001's `requireEligible` when the
 *                        caller has no Supabase session (HTTP 401 / redirect).
 *  - `not_eligible`   — bubbled up from `requireEligible` when the session is
 *                        present but the caller is not an eligible Nortal
 *                        participant or has no participant row (HTTP 403).
 *  - `not_admin`      — caller is an eligible participant but does NOT hold an
 *                        active `admin_roles` row (HTTP 403).
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § requireAdmin
 */
export type AdminAccessDeniedReason = 'no_session' | 'not_eligible' | 'not_admin';

/**
 * Typed error thrown by `requireAdmin` on every non-success path.
 *
 * Callers (admin route handlers, admin server components) inspect `reason` to
 * decide between 401 (no session) / 403 (everything else) / redirect. The
 * `not_admin` path additionally writes a best-effort `admin.access_denied`
 * audit row BEFORE this error is thrown (see slot 0073 narrow INSERT policy).
 *
 * `EligibilityError` thrown by the upstream `requireEligible` call is caught
 * and translated to this error class — admin callers should never need to
 * inspect both taxonomies.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see supabase/migrations/0073_audit_log_admin_access_denied_insert_policy.sql
 */
export class AdminAccessDeniedError extends Error {
  readonly reason: AdminAccessDeniedReason;

  constructor(reason: AdminAccessDeniedReason, message?: string) {
    super(message ?? `admin access denied: ${reason}`);
    this.name = 'AdminAccessDeniedError';
    this.reason = reason;
  }
}

/**
 * Server-side guard called by every admin-only route handler and admin
 * server component before reading or mutating any admin-scoped resource.
 *
 * Behaviour (mirrors the API contract in `admin-ui.surface.md`):
 *  1. Calls slice 001's `requireEligible()` to assert a session is present
 *     and the caller is an eligible Nortal participant. On `EligibilityError`
 *     this helper RE-THROWS as `AdminAccessDeniedError('no_session'|'not_eligible')`.
 *     (`requireEligible` already wrote its own `access.denied` audit row on
 *     denial — we do NOT double-emit here for those branches.)
 *  2. Calls `public.is_admin(p_user_id)` (slot 0062 real body) via RPC against
 *     the caller-supplied session-bound `client`. The contract pins parameter
 *     name `p_user_id` (slice 001 stub signature locked per Principle XI).
 *  3. If `is_admin` returns FALSE → writes a best-effort `admin.access_denied`
 *     audit row (slot 0073 narrow policy: action='admin.access_denied',
 *     source='api_guard', actor=caller's own participants.id) and throws
 *     `AdminAccessDeniedError('not_admin')`.
 *  4. On success, returns the admin's `Participant` row (same shape as
 *     `requireEligible`).
 *
 * Deviation note: the locked contract signature is `requireAdmin(client)`.
 * Slice 001's `requireEligible()` is parameterless (it creates its own
 * session-bound client internally). This helper composes both: it accepts a
 * caller-supplied `client` (used for the `is_admin` RPC + audit insert so
 * downstream RPC calls share the same session-bound client) and delegates the
 * eligibility check to `requireEligible()` without forwarding the client. The
 * two clients bind to the same cookies, so the eligibility / admin decisions
 * stay consistent within a single request.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § requireAdmin
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md § Pre-flight
 * @see supabase/migrations/0062_is_admin_real_body.sql
 * @see supabase/migrations/0073_audit_log_admin_access_denied_insert_policy.sql
 */
export async function requireAdmin(client: SupabaseClient): Promise<Participant> {
  // Step 1: eligibility (slice 001 helper writes its own access.denied audit
  // row on the not_eligible / participant_not_provisioned paths; we translate
  // its EligibilityError to our admin-shaped error class for clean callers).
  let participant: Participant;
  try {
    participant = await requireEligible();
  } catch (e) {
    if (e instanceof EligibilityError) {
      if (e.reason === 'no_session') {
        throw new AdminAccessDeniedError('no_session');
      }
      // Both 'not_eligible' and 'participant_not_provisioned' collapse to
      // 'not_eligible' from the admin caller's perspective: in either case
      // the caller is not an eligible Nortal participant.
      throw new AdminAccessDeniedError('not_eligible', e.message);
    }
    // Unexpected error — surface unchanged. Caller will respond 500.
    throw e;
  }

  // Step 2: admin role check via slot 0062's is_admin(p_user_id) RPC.
  const { data: isAdmin, error: rpcError } = await client.rpc('is_admin', {
    p_user_id: participant.auth_user_id,
  });

  if (rpcError) {
    // Fail closed on infrastructure error. Caller responds 500.
    throw new Error(`requireAdmin: is_admin RPC failed: ${rpcError.message}`);
  }

  if (isAdmin !== true) {
    await writeAdminAccessDeniedAudit(client, {
      participant_id: participant.id,
      reason: 'is_admin_returned_false',
    });
    throw new AdminAccessDeniedError('not_admin');
  }

  return participant;
}

/**
 * Best-effort `admin.access_denied` audit write (slot 0073 narrow policy).
 *
 * Writes EXACTLY one row that satisfies the
 * `audit_log_admin_access_denied_insert` WITH CHECK predicate:
 *   - action = 'admin.access_denied'
 *   - source = 'api_guard'
 *   - actor  = caller's own participants.id (pinned from `requireEligible`'s
 *              return value — no second round-trip required).
 *
 * Errors are caught and logged once — never re-thrown — so a transient audit
 * write failure cannot block the denial response (mirrors slice 001's
 * `writeApiGuardDenial` pattern).
 */
async function writeAdminAccessDeniedAudit(
  client: SupabaseClient,
  details: {
    participant_id: string;
    reason: string;
  },
): Promise<void> {
  try {
    const { error } = await client.from('audit_log').insert({
      actor: details.participant_id,
      action: 'admin.access_denied',
      entity_type: null,
      entity_id: null,
      previous_value: null,
      new_value: null,
      reason: details.reason,
      source: 'api_guard',
      source_citation: null,
    });
    if (error) {
      console.warn(
        `[requireAdmin] audit_log INSERT failed (reason=${details.reason}): ${error.message}`,
      );
    }
  } catch (writeErr) {
    const message =
      writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.warn(
      `[requireAdmin] audit_log INSERT threw (reason=${details.reason}): ${message}`,
    );
  }
}
