// --------------------------------------------------------------------------
// Slice 004 / T014 — `GET /api/me/final-predictions` empty-array path.
// --------------------------------------------------------------------------
// RED acceptance test for the "newly-signed-in participant with no final
// predictions" branch of GET /api/me/final-predictions.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/me/final-predictions — returns
//     { final_predictions: [], lock_state, first_kickoff_utc } when no
//     active rows exist for the caller.
//
// Setup:
//   1. Synthesize a fresh identity via the OIDC stub (a brand-new
//      newcomer-04@nortal.com, eligible, never seen before). The Supabase
//      auth-hook from Slice 001 will provision a participants row on
//      first sign-in.
//   2. GET /api/me/final-predictions. Assert 200 + body matches the
//      empty-array shape with lock_state='editable' (fixture sets
//      tournament_config.first_kickoff_utc = 2026-06-16T20:00Z, which is
//      in the future as of the current test-clock).
//
// Cleanup:
//   afterEach uses the service-role client to DELETE the synthesized
//   participants row (and any audit rows linked to it) so sibling tests
//   start from the canonical fixture state.
//
// RED until T018's `/api/me/final-predictions` GET handler lands.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// Brand-new identity not present in any fixture file. Hex nibble '4'
// distinguishes slice-004 newcomers from slice-003's 'f'.
const NEWCOMER = {
  sub: "00000000-0000-0000-0000-000000000040",
  email: "newcomer-04@nortal.com",
  email_verified: true,
  name: "Newcomer Tester (Slice 004)",
} as const;

interface MeFinalPredictionsResponse {
  final_predictions: unknown[];
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

test.describe(
  "US1 — GET /api/me/final-predictions returns empty array for a newly-signed-in participant @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();

      // Service-role cleanup — remove the synthesized participant and any
      // dependent rows so the next worker test starts from the canonical
      // fixture state.
      const client = getServiceClient();

      const { data: row } = await client
        .from("participants")
        .select("id")
        .eq("auth_user_id", NEWCOMER.sub)
        .maybeSingle();

      if (row?.id) {
        await client
          .from("final_predictions")
          .delete()
          .eq("participant_id", row.id);
        await client.from("predictions").delete().eq("participant_id", row.id);
        await client.from("audit_log").delete().eq("actor", row.id);
        await client.from("participants").delete().eq("id", row.id);
      }
    });

    test(
      "newly-signed-in participant with no final predictions sees GET /api/me/final-predictions = { final_predictions: [], lock_state, first_kickoff_utc } @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: NEWCOMER.sub,
            email: NEWCOMER.email,
            email_verified: NEWCOMER.email_verified,
            name: NEWCOMER.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/me/final-predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(
          response.status(),
          "GET /api/me/final-predictions for an eligible session MUST be 200 (contract § 200)",
        ).toBe(200);

        const body = (await response.json()) as MeFinalPredictionsResponse;
        expect(body).toMatchObject({
          final_predictions: expect.any(Array),
          lock_state: expect.any(String),
        });
        expect(
          body.final_predictions.length,
          "a brand-new participant with no final-prediction submissions MUST see an empty array",
        ).toBe(0);

        expect(
          ["editable", "locked"].includes(body.lock_state),
          `lock_state must be one of 'editable' | 'locked'; got ${body.lock_state}`,
        ).toBe(true);
        expect(
          body.lock_state,
          "fixture seeds first_kickoff_utc=2026-06-16T20:00Z; current test-clock is 2026-05-20 so lock_state MUST be 'editable'",
        ).toBe("editable");

        // first_kickoff_utc is exposed for UI countdowns (contract § 200).
        // Compare via Date.parse() to be tolerant of ISO formatting
        // variations (Z vs +00:00, ms vs no-ms).
        expect(body.first_kickoff_utc).not.toBeNull();
        expect(
          new Date(body.first_kickoff_utc as string).toISOString(),
          "first_kickoff_utc MUST round-trip to the fixture value 2026-06-16T20:00:00Z",
        ).toBe("2026-06-16T20:00:00.000Z");
      },
    );
  },
);
