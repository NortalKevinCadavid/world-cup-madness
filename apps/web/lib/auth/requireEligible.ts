import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import type { Participant } from '../types/participant';

type SessionBoundClient = ReturnType<typeof createSessionBoundClient>;

/**
 * Reasons `requireEligible` can fail. Callers use these to decide between
 * a 401 (no session) and a 403 (session present but caller is not eligible
 * or no participant row exists).
 *
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 */
export type EligibilityFailureReason =
  | 'no_session'
  | 'not_eligible'
  | 'participant_not_provisioned'
  | 'internal';

/**
 * Typed error thrown by `requireEligible` on every non-success path.
 *
 * Callers (route handlers, server components) inspect `reason` and translate
 * to the appropriate HTTP status / redirect:
 *  - `no_session` → 401 / redirect to `/`
 *  - `not_eligible` → 403 with `code: DOMAIN_NOT_APPROVED`
 *  - `participant_not_provisioned` → 403 with `reason=participant_not_provisioned`
 *  - `internal` → 500
 *
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 */
export class EligibilityError extends Error {
  readonly reason: EligibilityFailureReason;

  constructor(reason: EligibilityFailureReason, message?: string) {
    super(message ?? reason);
    this.name = 'EligibilityError';
    this.reason = reason;
  }
}

/**
 * Server-only Supabase client bound to the caller's session cookies.
 *
 * Uses the anon key + the user's JWT (delivered via cookies). NEVER uses the
 * service-role key. Read-only cookie surface: this helper is intended for
 * server components and route handlers that only *read* the session; cookie
 * refresh is owned by the Next.js middleware (T031 will install it).
 */
function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new EligibilityError(
      'internal',
      'Supabase environment variables are not configured.',
    );
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // Read-only context: the Next.js middleware refreshes the session
      // cookies on every request. Server components and route handlers that
      // need to mutate cookies should configure `setAll` themselves.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // intentionally empty — see comment above
      },
    },
  });
}

/**
 * Server-side guard called by every participant-facing route handler and
 * server component before reading any participant-scoped resource.
 *
 * Behaviour (matches the API contract):
 *  1. Resolves the current Supabase session from cookies. If absent →
 *     throws `EligibilityError('no_session')` (caller responds 401 or
 *     redirects).
 *  2. Calls the locked cross-slice predicate
 *     `public.is_eligible_nortal_participant(p_uid)` via Supabase RPC. If
 *     the predicate returns FALSE → throws
 *     `EligibilityError('not_eligible')`.
 *  3. Fetches the caller's `participants` row (RLS guarantees self-only).
 *     If no row exists (race window with the auth hook — should be
 *     impossible per R-004) → throws
 *     `EligibilityError('participant_not_provisioned')`.
 *
 * On success, returns the `Participant` row.
 *
 * Audit on denial (T033): on the `not_eligible` and
 * `participant_not_provisioned` paths this helper writes a single
 * `access.denied` row to `public.audit_log` with `source='api_guard'`
 * BEFORE throwing. The write uses the caller's JWT (NOT the service-role
 * key — see `participant-me.read.md` § Security invariants) and relies on
 * migration `0010_audit_log_api_guard_insert.sql` for the narrow INSERT
 * policy. The write is best-effort: if the INSERT fails (RLS denial,
 * transient outage), we emit a single `console.warn` and continue with the
 * throw — the audit failure MUST NOT mask the denial response (R-009).
 *
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 * @see specs/001-eligibility-login/contracts/eligibility-predicate.sql.md
 * @see specs/001-eligibility-login/research.md (R-009 per-handler guard)
 * @see supabase/migrations/0010_audit_log_api_guard_insert.sql
 */
export async function requireEligible(): Promise<Participant> {
  const supabase = createSessionBoundClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new EligibilityError('no_session');
  }

  const { data: eligible, error: rpcError } = await supabase.rpc(
    'is_eligible_nortal_participant',
    { p_uid: user.id },
  );

  if (rpcError) {
    // Fail closed on infrastructure errors per R-007.
    throw new EligibilityError(
      'internal',
      `Eligibility predicate RPC failed: ${rpcError.message}`,
    );
  }

  if (eligible !== true) {
    await writeApiGuardDenial(supabase, {
      reason: 'not_eligible',
      auth_user_id: user.id,
      attempted_email: user.email ?? null,
    });
    throw new EligibilityError('not_eligible');
  }

  const { data: participant, error: selectError } = await supabase
    .from('participants')
    .select(
      'id, auth_user_id, email, display_name, domain, region, status, first_login_at, last_login_at, created_at, updated_at',
    )
    .eq('auth_user_id', user.id)
    .maybeSingle<Participant>();

  if (selectError) {
    throw new EligibilityError(
      'internal',
      `participants SELECT failed: ${selectError.message}`,
    );
  }

  if (!participant) {
    // Defensive: predicate said eligible but RLS-filtered SELECT returned
    // nothing. Should be impossible per R-004's same-transaction guarantee.
    await writeApiGuardDenial(supabase, {
      reason: 'participant_not_provisioned',
      auth_user_id: user.id,
      attempted_email: user.email ?? null,
    });
    throw new EligibilityError('participant_not_provisioned');
  }

  return participant;
}

/**
 * Best-effort audit write for an API-guard denial (T033).
 *
 * Writes EXACTLY one `access.denied` row that conforms to the
 * `audit_log_api_guard_self_insert` WITH CHECK predicate established by
 * migration 0010:
 *   - action = 'access.denied'
 *   - source = 'api_guard'
 *   - reason ∈ { 'not_eligible', 'participant_not_provisioned' }
 *   - actor  = the caller's own participants.id (or NULL if no row exists;
 *     the policy's IS NOT DISTINCT FROM accepts the NULL case).
 *
 * The `actor` column is left UNSET in the INSERT payload: Postgres treats
 * the omitted column as NULL, and the policy then resolves `IS NOT DISTINCT
 * FROM (SELECT p.id ...)` server-side against the caller's auth.uid().
 * Sending `actor` from the client would require a round-trip to fetch the
 * participants.id first and would just duplicate the work the policy
 * already does atomically.
 *
 * `new_value` carries only fields the caller is already authorized to
 * know about themselves: their auth.users.id and their attempted email.
 *
 * Errors are caught and logged once — never re-thrown — so a transient
 * audit-write failure cannot block the denial response.
 */
async function writeApiGuardDenial(
  supabase: SessionBoundClient,
  details: {
    reason: 'not_eligible' | 'participant_not_provisioned';
    auth_user_id: string;
    attempted_email: string | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_log').insert({
      action: 'access.denied',
      source: 'api_guard',
      reason: details.reason,
      entity_type: 'auth_attempt',
      new_value: {
        auth_user_id: details.auth_user_id,
        attempted_email: details.attempted_email,
      },
    });
    if (error) {
      console.warn(
        `[requireEligible] audit_log INSERT failed (reason=${details.reason}): ${error.message}`,
      );
    }
  } catch (writeErr) {
    const message =
      writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.warn(
      `[requireEligible] audit_log INSERT threw (reason=${details.reason}): ${message}`,
    );
  }
}
