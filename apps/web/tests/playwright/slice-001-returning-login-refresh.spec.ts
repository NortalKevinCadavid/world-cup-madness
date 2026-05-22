// --------------------------------------------------------------------------
// Slice 001 / T036 — US3 Acceptance Scenario 1
//   "Returning user with changed display_name refreshes in place."
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 AS-1 of
// `specs/001-eligibility-login/spec.md`:
//
//   Given an existing participant whose corporate display name has changed
//   at the identity provider, When they sign in again, Then the participant
//   record MUST be updated in place (same participants.id), and any
//   historical prediction or audit record MUST remain linked to that
//   participant.
//
// Then-clauses asserted in this file:
//   1. Sign-in succeeds; the page lands on `/dashboard`.
//   2. The dashboard renders the NEW display name ("Alpha Tester Updated").
//   3. Exactly ONE `participants` row exists for alpha's auth_user_id —
//      i.e. no duplicate was created (FR-004, SC-005).
//   4. `last_login_at > first_login_at` — the returning hook advanced the
//      last-login timestamp (US1 AS-2 / FR-004 lock).
//   5. An `audit_log` row with `action='participant.updated'`,
//      `source='trigger'`, `previous_value->>'display_name'='Alpha Tester'`,
//      `new_value->>'display_name'='Alpha Tester Updated'` exists for this
//      sign-in (R-010 / contracts/auth-hook.sql.md § Decision matrix row
//      "Approved + returning").
//
// --------------------------------------------------------------------------
// Spec deviations
// --------------------------------------------------------------------------
// D-T036-A: The brief for T036 specifies the seed-fixture pre-state as
//   `display_name='Alpha Tester'`, but the actual seed in
//   `supabase/seed/slice-001-fixture.sql` stores alpha as `display_name='Alpha'`.
//   To match the brief's audit-row assertion (`previous_value->>'display_name'
//   ='Alpha Tester'`) the test ARRANGES the pre-state explicitly via the
//   service-role client so the assertion is robust regardless of seed drift.
//   The afterEach restores the seed's actual stored value so sibling tests
//   in other files see a clean fixture state.
//
// D-T036-B: The auth hook (`handle_auth_user_signed_in`) is NOT yet
//   implemented (T040 ships it). This test is RED until T040 and the
//   `participant.updated` trigger (migration 0008) are both live.
//
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import {
  getServiceClient,
  readAuditLog,
} from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  region: "EE-North",
  // Pre-state value the audit row will reference as `previous_value`.
  storedDisplayName: "Alpha Tester",
  // IdP-supplied value for THIS sign-in — drives the refresh.
  idpDisplayName: "Alpha Tester Updated",
  // Seed-canonical value (used by the afterEach to restore the fixture).
  seedDisplayName: "Alpha",
} as const;

test.describe(
  "US3 — returning login refreshes display_name in place @slice-001 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();

      // Pin the pre-state display_name + region so the audit row assertion
      // has a deterministic `previous_value`. Bypasses RLS via service-role.
      const client = getServiceClient();
      const { error } = await client
        .from("participants")
        .update({
          display_name: ALPHA.storedDisplayName,
          region: ALPHA.region,
        })
        .eq("auth_user_id", ALPHA.sub);
      if (error) {
        throw new Error(
          `beforeEach: failed to pin alpha's display_name — ${error.message}`,
        );
      }
    });

    test.afterEach(async () => {
      await resetStub();

      // Restore seed-canonical values so other tests / files see a clean
      // fixture state regardless of pass/fail of this test.
      const client = getServiceClient();
      await client
        .from("participants")
        .update({
          display_name: ALPHA.seedDisplayName,
          region: ALPHA.region,
        })
        .eq("auth_user_id", ALPHA.sub);
    });

    test(
      "AS-1 — display_name change in IdP updates the existing row, no duplicate, audit captures the diff @slice-001 @us3",
      async ({ page }) => {
        // Wall-clock floor for the audit-row query so we filter out any
        // historical rows produced by earlier tests in the same run.
        const testStartedAt = new Date(Date.now() - 1_000);

        // Step 1 — sign in as alpha with an updated display_name claim.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.idpDisplayName,
            region: ALPHA.region,
          },
        });

        // Then 1 — landed on /dashboard.
        expect(page.url()).toMatch(/\/dashboard(\?|$|#|\/)/);

        // Then 2 — dashboard renders the NEW display name.
        await expect(
          page.getByText(ALPHA.idpDisplayName),
        ).toBeVisible();

        // Then 3 — exactly one participants row for alpha's auth_user_id.
        const client = getServiceClient();
        const { count: rowCount, error: countErr } = await client
          .from("participants")
          .select("id", { count: "exact", head: true })
          .eq("auth_user_id", ALPHA.sub);
        if (countErr) {
          throw new Error(
            `participants count query failed: ${countErr.message}`,
          );
        }
        expect(
          rowCount,
          "FR-004 / SC-005: returning login MUST NOT create a duplicate row",
        ).toBe(1);

        // Then 4 — last_login_at strictly greater than first_login_at, and
        // the stored display_name reflects the refresh.
        const { data: row, error: rowErr } = await client
          .from("participants")
          .select("id, display_name, first_login_at, last_login_at")
          .eq("auth_user_id", ALPHA.sub)
          .single();
        if (rowErr) {
          throw new Error(`participants read failed: ${rowErr.message}`);
        }
        expect(row.id).toBe(ALPHA.participantId);
        expect(row.display_name).toBe(ALPHA.idpDisplayName);

        const first = Date.parse(row.first_login_at as string);
        const last = Date.parse(row.last_login_at as string);
        expect(Number.isNaN(first), "first_login_at must be ISO-8601 parsable").toBe(false);
        expect(Number.isNaN(last), "last_login_at must be ISO-8601 parsable").toBe(false);
        expect(
          last,
          "FR-004: returning hook MUST advance last_login_at past first_login_at",
        ).toBeGreaterThan(first);

        // Then 5 — audit_log row from the participants UPDATE trigger
        // captures the display_name diff.
        const rows = await readAuditLog({
          action: "participant.updated",
          source: "trigger",
          since: testStartedAt,
        });
        expect(
          rows.length,
          "R-010: participants UPDATE trigger MUST emit a participant.updated audit row",
        ).toBeGreaterThanOrEqual(1);

        // Find the row that captures THIS alpha refresh — match on the
        // previous_value/new_value display_name pair.
        const matching = rows.find((r) => {
          const prev = (r.previous_value as { display_name?: string } | null);
          const next = (r.new_value as { display_name?: string } | null);
          return (
            prev?.display_name === ALPHA.storedDisplayName &&
            next?.display_name === ALPHA.idpDisplayName
          );
        });
        expect(
          matching,
          `R-010: expected an audit row with previous.display_name='${ALPHA.storedDisplayName}' and new.display_name='${ALPHA.idpDisplayName}'`,
        ).toBeDefined();

        // The actor on a trigger-emitted row should be either the participant
        // id or the auth user id (R-010 leaves this to migration 0008's
        // discretion; both are forensically equivalent).
        const expectedActors: readonly string[] = [
          ALPHA.sub,
          ALPHA.participantId,
        ];
        const actorValue = matching!.actor ?? "";
        expect(
          expectedActors.includes(actorValue),
          `expected actor in {auth.users.id, participants.id}, got ${matching!.actor}`,
        ).toBe(true);
      },
    );
  },
);
