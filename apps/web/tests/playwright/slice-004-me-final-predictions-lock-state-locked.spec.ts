// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/me/final-predictions returns lock_state='locked'
// when tournament_config.first_kickoff_utc is in the past.
// --------------------------------------------------------------------------
// RED acceptance test for the locked branch of the global final-prediction
// lock predicate `public.is_final_prediction_locked()` (slot 0041, strict
// `>=` boundary). BR-LOCK-005 semantics.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Test surface — lock-state-locked: first_kickoff_utc in past;
//     GET → lock_state='locked'.
//   - migrations/0041_is_final_prediction_locked.sql:
//       RETURN now() >= v_first_kickoff   (strict >=).
//
// Scenario:
//   Service-role mutates tournament_config.first_kickoff_utc to a value
//   in the past (e.g. 2026-05-01T00:00:00Z, before today's test-clock).
//   Sign in as alpha and GET /api/me/final-predictions. Assert
//   lock_state='locked'.
//
// Cleanup: afterEach restores the fixture value (2026-06-16T20:00:00Z)
// regardless of pass/fail/crash. Implemented inline rather than via
// withTemporaryConfig because the latter wraps an async function — for a
// stand-alone test the snapshot/restore pattern is clearer inline.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const FIXTURE_FIRST_KICKOFF = "2026-06-16T20:00:00Z";
const PAST_FIRST_KICKOFF = "2026-05-01T00:00:00Z"; // well before test-clock 2026-05-20

interface MeFinalPredictionsResponse {
  final_predictions: unknown[];
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

async function setFirstKickoffUtc(isoValue: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_config")
    .update({ value: isoValue })
    .eq("key", "first_kickoff_utc");
  if (error) {
    throw new Error(`setFirstKickoffUtc(${isoValue}) failed — ${error.message}`);
  }
}

test.describe(
  "US1 — GET /api/me/final-predictions lock_state='locked' (first_kickoff_utc in past) @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await setFirstKickoffUtc(PAST_FIRST_KICKOFF);
    });

    test.afterEach(async () => {
      // Restore the fixture value so sibling tests start from the canonical
      // state regardless of pass/fail/crash.
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await resetStub();
    });

    test(
      "alpha GET with first_kickoff_utc in the past returns lock_state='locked' @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const response = await request.get("/api/me/final-predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(response.status(), "GET MUST be 200").toBe(200);

        const body = (await response.json()) as MeFinalPredictionsResponse;
        expect(
          body.lock_state,
          "first_kickoff_utc is in the past; predicate MUST return true → 'locked'",
        ).toBe("locked");

        // The response still exposes first_kickoff_utc for UI countdowns.
        expect(body.first_kickoff_utc).not.toBeNull();
        expect(
          new Date(body.first_kickoff_utc as string).toISOString(),
          "first_kickoff_utc MUST round-trip to the mutated past value",
        ).toBe("2026-05-01T00:00:00.000Z");
      },
    );
  },
);
