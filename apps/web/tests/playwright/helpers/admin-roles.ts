// no-emit
// --------------------------------------------------------------------------
// DEV-ONLY: not used in any production environment.
// --------------------------------------------------------------------------
// Slice 006 / T008 — defensive admin_roles seeding helper.
//
// Background
// ----------
// After Slice 006's T007 (real `public.is_admin(uuid)` body) and T009
// (bootstrap migration that seeds admin1's `admin_roles` row) ship together,
// cross-slice tests that previously synthesized admin authority via JWT
// claim alone now require an active `admin_roles` row for the test
// participant.
//
// T002's audit (`specs/006-admin-overrides/is-admin-test-migration.md`)
// concluded that EVERY Type 1 test in the codebase uses admin1@nortal.com
// and is auto-covered by T009's bootstrap (slot 0074). T008 therefore
// reduces to verification — but this helper exists as defensive
// belt-and-suspenders so a test file can guarantee its admin authority
// regardless of whether T009 has been replayed (e.g. partial migration
// replay, fixture-only DB resets, or future fixture drift).
//
// Contract
// --------
// `ensureAdminRole(participantId)` is idempotent. It guarantees the
// post-condition: "an active `admin_roles` row exists for `participantId`
// (revoked_at IS NULL) at the moment the promise resolves." It does NOT
// create duplicate rows on repeated calls — multiple active rows are
// blocked by the partial unique index `admin_roles_active_uk`
// (`participant_id WHERE revoked_at IS NULL`), so the helper relies on a
// SELECT-then-INSERT pattern rather than ON CONFLICT (because supabase-js
// does not support the partial-index conflict-target syntax
// `ON CONFLICT (participant_id) WHERE revoked_at IS NULL`).
//
// Race-condition note
// -------------------
// In the (unlikely) event of two concurrent workers racing the SELECT/INSERT,
// the partial unique index will reject the second INSERT with code 23505.
// The helper catches that specific case and treats it as success — the
// post-condition still holds.
// --------------------------------------------------------------------------

import { getServiceClient } from "./service-role";

interface AdminRoleRow {
  id: string;
  participant_id: string;
  granted_at: string;
  granted_by: string | null;
  revoked_at: string | null;
}

/**
 * Guarantees that an ACTIVE `admin_roles` row exists for `participantId`.
 *
 * Resolution semantics:
 *   1. If an active row already exists → returns it unchanged.
 *   2. Otherwise → INSERTs a fresh row (granted_by=NULL, granted_at=now())
 *      and returns the new row.
 *   3. If a concurrent caller wins the race and our INSERT trips the
 *      partial unique index, we re-SELECT the now-existing row and return
 *      it (the post-condition is still satisfied).
 *
 * Cleanup: the inserted row is NOT removed by this helper. Test fixtures
 * that need a clean slate must explicitly revoke or delete via service-role.
 * In practice the Slice 006 bootstrap (T009 slot 0074) will already have
 * seeded admin1's row, so this helper's INSERT branch is a no-op in CI.
 */
export async function ensureAdminRole(
  participantId: string,
): Promise<AdminRoleRow> {
  const client = getServiceClient();

  // 1) Look for an existing active row.
  const { data: existing, error: selErr } = await client
    .from("admin_roles")
    .select("id,participant_id,granted_at,granted_by,revoked_at")
    .eq("participant_id", participantId)
    .is("revoked_at", null)
    .maybeSingle();
  if (selErr) {
    throw new Error(
      `ensureAdminRole(${participantId}) select: ${selErr.message}`,
    );
  }
  if (existing) return existing as AdminRoleRow;

  // 2) Insert a fresh active row. granted_by=NULL mirrors the T009
  // bootstrap row (which is also granted_by NULL because no granting admin
  // exists at bootstrap time).
  const { data: inserted, error: insErr } = await client
    .from("admin_roles")
    .insert({ participant_id: participantId, granted_by: null })
    .select("id,participant_id,granted_at,granted_by,revoked_at")
    .maybeSingle();
  if (!insErr && inserted) {
    return inserted as AdminRoleRow;
  }

  // 3) Race recovery: a concurrent worker won. Re-SELECT.
  // Postgres unique-violation = SQLSTATE 23505. supabase-js surfaces this
  // as PostgrestError with code "23505".
  const isUniqueViolation =
    insErr &&
    ((insErr as { code?: string }).code === "23505" ||
      /duplicate key/i.test(insErr.message));

  if (isUniqueViolation) {
    const { data: raced, error: raceErr } = await client
      .from("admin_roles")
      .select("id,participant_id,granted_at,granted_by,revoked_at")
      .eq("participant_id", participantId)
      .is("revoked_at", null)
      .maybeSingle();
    if (raceErr) {
      throw new Error(
        `ensureAdminRole(${participantId}) race re-select: ${raceErr.message}`,
      );
    }
    if (raced) return raced as AdminRoleRow;
  }

  throw new Error(
    `ensureAdminRole(${participantId}) insert failed: ${insErr?.message ?? "unknown error"}`,
  );
}
