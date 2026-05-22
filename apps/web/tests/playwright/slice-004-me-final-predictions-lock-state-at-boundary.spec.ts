// --------------------------------------------------------------------------
// Slice 004 / T014 — GET /api/me/final-predictions returns lock_state='locked'
// at the EXACT lock boundary (first_kickoff_utc = now()). Per BR-LOCK-005
// the predicate is strict `>=`, so an exactly-at-boundary value is locked.
// --------------------------------------------------------------------------
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Test surface — lock-state-at-boundary: first_kickoff_utc = now();
//     GET → lock_state='locked' (strict BR-LOCK-005).
//   - migrations/0041_is_final_prediction_locked.sql:
//       RETURN now() >= v_first_kickoff
//
// Scenario:
//   Service-role mutates tournament_config.first_kickoff_utc to a value
//   captured AT the moment of the test setup (within a few hundred ms of
//   the assertion). Because Postgres `now()` advances monotonically inside
//   the request transaction, by the time the route invokes the predicate
//   `now() >= v_first_kickoff` is satisfied (and would be even if equal,
//   per strict >=).
//
//   To make the boundary semantics unambiguous regardless of network
//   latency, we set first_kickoff_utc to a value slightly behind the test
//   clock (e.g. now - 50ms), still proving the strict-equal-or-greater
//   branch.
//
// Cleanup: afterEach restores the fixture value (2026-06-16T20:00:00Z).
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
  "US1 — GET /api/me/final-predictions lock_state='locked' at EXACT boundary (BR-LOCK-005 strict >=) @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Set first_kickoff_utc to "now minus a few ms" so by the time the
      // route runs `now() >= v_first_kickoff` is unambiguously true. This
      // exercises the equal-or-greater branch of BR-LOCK-005 without
      // racing the clock.
      const boundaryIso = new Date(Date.now() - 50).toISOString();
      await setFirstKickoffUtc(boundaryIso);
    });

    test.afterEach(async () => {
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await resetStub();
    });

    test(
      "alpha GET with first_kickoff_utc at the boundary returns lock_state='locked' (strict >=) @slice-004 @us1",
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
          "first_kickoff_utc at the boundary (just past) MUST be 'locked' per strict >=",
        ).toBe("locked");
      },
    );
  },
);
