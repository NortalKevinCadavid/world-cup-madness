// no-emit
// --------------------------------------------------------------------------
// DEV-ONLY: not used in any production environment.
// --------------------------------------------------------------------------
// Service-role Supabase helpers for Playwright integration tests.
//
// Slice 001 tests need to:
//   1. Mutate `public.tournament_config` rows that RLS would otherwise hide
//      from an `authenticated` JWT (e.g. flipping
//      `eligibility.approved_domains` to `[]` mid-test to exercise the
//      mid-session deny clause in spec.md Clarifications 2026-05-15 and
//      contracts/participant-me.read.md § 403 path).
//   2. SELECT from `public.audit_log` to assert that an `access.denied`
//      row was written by the auth hook or the API guard. The audit_log
//      RLS posture (`audit_log_admin_read`) blocks the `authenticated`
//      role from reading rows for any non-admin actor.
//
// Both call sites require the Supabase service-role key. THAT KEY MUST
// NEVER LEAK INTO BROWSER OR PRODUCTION CODE. This helper lives under
// `tests/playwright/helpers/` exactly so a future `next build` cannot
// accidentally pick it up — the `no-emit` marker at the top of this file
// is a belt-and-braces signal to reviewers and to Spec Kit's later
// "no-service-role-in-app" audit task.
//
// Required environment:
//   - NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL  — local Supabase URL
//     (e.g. http://127.0.0.1:54321). Falls back to NEXT_PUBLIC_*.
//   - SUPABASE_SERVICE_ROLE_KEY — the service-role JWT from
//     `supabase status` output. Loaded via Playwright's process.env.
//
// If either is missing at call time, the helpers throw a clear error
// rather than silently proceeding with a useless anon client.
// --------------------------------------------------------------------------

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Returns a Supabase client bound to the service-role key. Cached for the
 * duration of a Playwright worker so repeated calls in `beforeEach` /
 * `afterEach` do not pay the createClient cost more than once.
 */
export function getServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!url) {
    throw new Error(
      "getServiceClient(): SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not set. " +
        "Set it in the Playwright env to the local Supabase URL (e.g. http://127.0.0.1:54321).",
    );
  }
  if (!key) {
    throw new Error(
      "getServiceClient(): SUPABASE_SERVICE_ROLE_KEY is not set. " +
        "Copy it from `supabase status` and export it before running playwright.",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Snapshots the current value of `tournament_config[key]`, replaces it
 * with `value`, runs `fn`, then restores the snapshot in a `finally`
 * block so a failed assertion inside `fn` cannot leave the database in
 * a poisoned state for sibling tests.
 *
 * Use case (slice 001 / T029):
 *   await withTemporaryConfig(
 *     "eligibility.approved_domains",
 *     [],
 *     async () => {
 *       const r = await request.get("/api/me");
 *       expect(r.status()).toBe(403);
 *     },
 *   );
 */
export async function withTemporaryConfig<T>(
  key: string,
  value: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const client = getServiceClient();

  // Snapshot.
  const { data: snapshotRow, error: readErr } = await client
    .from("tournament_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (readErr) {
    throw new Error(
      `withTemporaryConfig(${key}): failed to read snapshot — ${readErr.message}`,
    );
  }
  if (!snapshotRow) {
    throw new Error(
      `withTemporaryConfig(${key}): no existing row to snapshot. Aborting to avoid creating drift.`,
    );
  }

  const original = snapshotRow.value;

  // Mutate.
  const { error: writeErr } = await client
    .from("tournament_config")
    .update({ value })
    .eq("key", key);

  if (writeErr) {
    throw new Error(
      `withTemporaryConfig(${key}): failed to apply temporary value — ${writeErr.message}`,
    );
  }

  try {
    return await fn();
  } finally {
    // Restore. Use a fresh update; do NOT short-circuit on the in-test
    // error path — restoring is more important than reporting the
    // restore failure (which we still throw below if it happens).
    const { error: restoreErr } = await client
      .from("tournament_config")
      .update({ value: original })
      .eq("key", key);
    if (restoreErr) {
      throw new Error(
        `withTemporaryConfig(${key}): failed to restore snapshot after test — ${restoreErr.message}. ` +
          `Manual repair required.`,
      );
    }
  }
}

/**
 * Reads `audit_log` rows matching a coarse filter. Used by US2 tests to
 * verify the auth hook / API guard wrote the expected `access.denied`
 * row. `authenticated` cannot read audit_log under RLS, so this helper
 * runs as service-role.
 */
export async function readAuditLog(filter: {
  action?: string;
  reason?: string;
  source?: string;
  since?: Date;
}): Promise<
  Array<{
    id: string;
    actor: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    previous_value: unknown;
    new_value: unknown;
    reason: string | null;
    source: string;
    occurred_at: string;
  }>
> {
  const client = getServiceClient();
  let q = client.from("audit_log").select("*");

  if (filter.action) q = q.eq("action", filter.action);
  if (filter.reason) q = q.eq("reason", filter.reason);
  if (filter.source) q = q.eq("source", filter.source);
  if (filter.since) q = q.gte("occurred_at", filter.since.toISOString());

  const { data, error } = await q.order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readAuditLog: ${error.message}`);
  }
  return (data ?? []) as Array<{
    id: string;
    actor: string | null;
    action: string;
    entity_type: string | null;
    entity_id: string | null;
    previous_value: unknown;
    new_value: unknown;
    reason: string | null;
    source: string;
    occurred_at: string;
  }>;
}

/**
 * Counts `participants` rows matching an email. Used by US2 AS-1 to
 * assert that a denied sign-in did NOT provision a profile. Runs as
 * service-role because the denied identity has no JWT and thus could
 * never SELECT via RLS in the first place.
 */
export async function countParticipantsByEmail(email: string): Promise<number> {
  const client = getServiceClient();
  const { count, error } = await client
    .from("participants")
    .select("id", { count: "exact", head: true })
    .eq("email", email);
  if (error) {
    throw new Error(`countParticipantsByEmail(${email}): ${error.message}`);
  }
  return count ?? 0;
}
