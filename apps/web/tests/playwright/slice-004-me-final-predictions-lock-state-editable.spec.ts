// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/me/final-predictions returns lock_state='editable'
// when tournament_config.first_kickoff_utc is in the future.
// --------------------------------------------------------------------------
// RED acceptance test for the editable branch of the global final-prediction
// lock predicate `public.is_final_prediction_locked()` (slot 0041,
// fail-CLOSED on missing config, strict `>=` boundary).
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Test surface — lock-state-editable: first_kickoff_utc far in
//     future; GET → lock_state='editable'.
//   - migrations/0041_is_final_prediction_locked.sql.
//
// Scenario:
//   The slice-004 fixture seeds first_kickoff_utc='2026-06-16T20:00:00Z'.
//   The current test-clock (2026-05-20) is BEFORE that anchor, so the
//   predicate returns FALSE (editable) without any test mutation.
//
//   Sign in as alpha and GET /api/me/final-predictions. Assert
//   lock_state='editable' AND first_kickoff_utc round-trips to the fixture
//   value.
//
// RED until T018's GET handler computes `lock_state` from the predicate.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

interface MeFinalPredictionsResponse {
  final_predictions: unknown[];
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

test.describe(
  "US1 — GET /api/me/final-predictions lock_state='editable' (first_kickoff_utc in future) @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "alpha GET /api/me/final-predictions with fixture first_kickoff_utc=2026-06-16Z (future) returns lock_state='editable' @slice-004 @us1",
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
          "first_kickoff_utc is in the future relative to test-clock; predicate MUST return false → 'editable'",
        ).toBe("editable");

        expect(body.first_kickoff_utc).not.toBeNull();
        expect(
          new Date(body.first_kickoff_utc as string).toISOString(),
          "first_kickoff_utc MUST round-trip to fixture value 2026-06-16T20:00:00Z",
        ).toBe("2026-06-16T20:00:00.000Z");
      },
    );
  },
);
