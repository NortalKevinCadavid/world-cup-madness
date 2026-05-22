// --------------------------------------------------------------------------
// Slice 001 / T036 — US3 Acceptance Scenario 3 + Clarifications 2026-05-15 Q4
//   "Missing optional claim on returning login does NOT clear stored value."
// --------------------------------------------------------------------------
// RED acceptance test for US3 AS-3 of
// `specs/001-eligibility-login/spec.md`:
//
//   Given a participant whose region attribute was previously populated
//   but is no longer present in the IdP's payload on a subsequent sign-in,
//   When they sign in again, Then the stored region value MUST remain
//   unchanged (missing claim is NOT a delete signal — see Clarifications
//   2026-05-15), and no other refreshable attribute MUST be inadvertently
//   modified.
//
// Then-clauses asserted in this file:
//   1. Sign-in succeeds — page lands on `/dashboard`.
//   2. Stored `participants.region` for alpha is STILL `'EE-North'`
//      (UNCHANGED — missing claim is a "no signal", not a delete).
//   3. NO `audit_log` row records a region "deletion" for alpha — i.e.
//      no `participant.updated` row exists in the test window whose
//      `previous_value->>'region' = 'EE-North'` and `new_value` lacks
//      that region (which would indicate the hook misread the missing
//      claim as a clear signal).
//
// --------------------------------------------------------------------------
// Spec deviations
// --------------------------------------------------------------------------
// D-T036-F: The auth hook (`handle_auth_user_signed_in`) is NOT yet
//   implemented (T040 ships it). This test is RED until T040 lands. The
//   "refresh whitelist" step (contracts/auth-hook.sql.md § Step 3 + R-010)
//   MUST only update those refreshable attributes present in the event;
//   `region` falling out of the payload MUST be a no-op for the stored
//   value.
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
  name: "Alpha Tester",
  storedRegion: "EE-North",
} as const;

test.describe(
  "US3 — missing optional claim retains stored value @slice-001 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();

      // Pin alpha's region to the canonical pre-state value so the
      // assertion is robust to any prior test that may have nulled it.
      const client = getServiceClient();
      const { error } = await client
        .from("participants")
        .update({ region: ALPHA.storedRegion })
        .eq("auth_user_id", ALPHA.sub);
      if (error) {
        throw new Error(
          `beforeEach: failed to pin alpha's region — ${error.message}`,
        );
      }
    });

    test.afterEach(async () => {
      await resetStub();

      // Restore the canonical region in case a (broken) hook implementation
      // mutated it.
      const client = getServiceClient();
      await client
        .from("participants")
        .update({ region: ALPHA.storedRegion })
        .eq("auth_user_id", ALPHA.sub);
    });

    test(
      "AS-3 — IdP omits region claim; stored region remains 'EE-North'; no region-delete audit row @slice-001 @us3",
      async ({ page }) => {
        const testStartedAt = new Date(Date.now() - 1_000);

        // Step 1 — sign in WITHOUT a region claim. Note: `region` is
        // intentionally omitted from the claims object.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
            // intentionally NO `region` field
          },
        });

        // Then 1 — sign-in succeeded; landed on /dashboard.
        expect(page.url()).toMatch(/\/dashboard(\?|$|#|\/)/);

        // Then 2 — stored region is STILL 'EE-North'.
        const client = getServiceClient();
        const { data: row, error: rowErr } = await client
          .from("participants")
          .select("id, region")
          .eq("auth_user_id", ALPHA.sub)
          .single();
        if (rowErr) {
          throw new Error(`participants read failed: ${rowErr.message}`);
        }
        expect(row.id).toBe(ALPHA.participantId);
        expect(
          row.region,
          "Clarifications 2026-05-15 Q4: missing claim MUST NOT clear the stored region",
        ).toBe(ALPHA.storedRegion);

        // Then 3 — no `participant.updated` audit row records a region
        // deletion for alpha. We allow OTHER `participant.updated` rows
        // (e.g. last_login_at touch) but we reject any whose
        // previous_value captured 'EE-North' as the region (which would
        // imply the hook detected a region change and wrote it to audit).
        const rows = await readAuditLog({
          action: "participant.updated",
          since: testStartedAt,
        });
        const offenders = rows.filter((r) => {
          const prev = (r.previous_value as { region?: string | null } | null);
          const next = (r.new_value as { region?: string | null } | null);
          // A "region deletion" audit row would have:
          //   previous.region == 'EE-North' AND (next.region == null OR
          //   next does not contain 'region' AND the prev did).
          if (!prev || prev.region !== ALPHA.storedRegion) return false;
          const nextRegion = next?.region;
          return nextRegion === null || nextRegion === undefined;
        });
        expect(
          offenders.length,
          "Clarifications 2026-05-15 Q4: hook MUST NOT emit an audit row implying a region delete on missing claim",
        ).toBe(0);
      },
    );
  },
);
