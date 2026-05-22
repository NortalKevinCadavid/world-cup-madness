// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` direct-API rejection on locked match.
// --------------------------------------------------------------------------
// RED acceptance test proving Constitution Principle III ("Rules Outside
// the UI"): a direct API call MUST be rejected when the match is locked,
// even though no UI form gated the request. The locking decision is
// authoritative at the API layer, not at the UI.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.write.md § 409
//     "PREDICTION_LOCKED" with `reason` discriminator.
//   - specs/003-match-predictions/spec.md § US3 Acceptance Scenario 3:
//     "the API MUST reject the request with the same denial reason — UI-
//     only gating MUST NOT be the gate."
//
// Scenario:
//   Sign in as alpha (eligible). POST /api/predictions for M1 (ARG vs MEX,
//   status='finished' per slice-002 fixture) — the SP raises WCM02
//   (match_status_locked), and the route handler maps to 409 with body
//   { error: { code: 'PREDICTION_LOCKED', reason: 'match_status_locked',
//   message: ... } }.
//
// Note on match selection: the user prompt referenced "M-BOUNDARY"; in
// practice any non-scheduled match exercises the WCM02 branch. M1
// (finished) is unambiguously locked regardless of clock and is the most
// stable choice for this RED-first test.
//
// RED until T015 ships the route handler that maps SP ERRCODE WCM02 →
// 409 with reason='match_status_locked'.
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

// M1 ARG vs MEX — status='finished' per the slice-002 fixture.
const M1_ARG_MEX_ID = "bbbb0000-0000-0000-0000-000000000001";

test.describe(
  "US1 / US3 — POST /api/predictions direct API rejected on locked match @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "direct POST for a locked (finished) match MUST be 409 PREDICTION_LOCKED — UI gating is not the gate @slice-003 @us1",
      async ({ request }) => {
        // No UI traversal — fire the POST directly against the route.
        const response = await request.post("/api/predictions", {
          data: { match_id: M1_ARG_MEX_ID, home: 1, away: 1 },
        });

        expect(
          response.status(),
          "direct POST for a non-scheduled match MUST be 409 (contract § 409 / SP WCM02)",
        ).toBe(409);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "PREDICTION_LOCKED",
            message: expect.any(String),
            reason: "match_status_locked",
          },
        });
      },
    );
  },
);
