// --------------------------------------------------------------------------
// Slice 003 / T011 — `POST /api/predictions` ignores client clock manipulation.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P1) Acceptance Scenario 4 (BR-LOCK-001):
//
//   "Given a client clock that disagrees with the server (drift,
//    manipulation, time-zone tricks), when the participant attempts an
//    edit at any time, then the lock decision MUST use trusted server
//    time only and the client clock MUST be ignored."
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US3 AS-4
//   - specs/003-match-predictions/contracts/predictions.write.md § 409
//     PREDICTION_LOCKED with reason='match_status_locked'
//
// Scenario:
//   Sign in as alpha. Stub the browser's Date.now() / new Date() to
//   return a year in the past (2020-01-01) — a value that, if the lock
//   decision were derived from the client clock, would falsely make M2
//   (status='in_progress') appear as "comfortably before kickoff".
//   Navigate to /matches with the clock stub active, then POST a
//   prediction for M2. The server MUST still return 409 with
//   reason='match_status_locked' because the lock predicate uses trusted
//   server time only.
//
// Implementation notes:
//   - `page.addInitScript` runs in EVERY frame BEFORE any page script, so
//     even SSR-hydrated client code sees the stubbed clock.
//   - The stub overrides Date.now AND the Date constructor's no-arg
//     behavior to make sure no JS path can reconstruct the "real" clock.
//   - The POST is fired through `page.request` so it inherits the page's
//     authenticated cookies; the route handler reads only the trusted
//     server clock so the manipulated browser clock has no effect on the
//     decision.
//
// RED until T015 ships the route handler that uses trusted server time.
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

// M2 CAN vs POL — status='in_progress' per the slice-002 fixture. The
// WCM02 / match_status_locked branch fires regardless of clock.
const M2_CAN_POL_ID = "bbbb0000-0000-0000-0000-000000000002";

test.describe(
  "US3 — POST /api/predictions ignores client clock manipulation @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();

      // Install the clock stub BEFORE any navigation. This script runs in
      // every frame on every page load, so SSR + hydration + any future
      // navigations all see the fake clock.
      await page.addInitScript(() => {
        const FAKE_NOW_MS = Date.parse("2020-01-01T00:00:00Z");
        const RealDate = Date;
        // Stub Date.now() — most common path.
        Date.now = () => FAKE_NOW_MS;
        // Stub `new Date()` (no-arg) to also return the fake epoch. Calls
        // with arguments still delegate to the real Date constructor so
        // server-supplied ISO strings parse correctly. The eslint
        // exemption is required: overwriting the global Date is the
        // entire point of the test.
        // eslint-disable-next-line no-global-assign
        (Date as unknown) = new Proxy(RealDate, {
          construct(target, args) {
            if (args.length === 0) {
              return new target(FAKE_NOW_MS);
            }
            return new (target as new (...a: unknown[]) => Date)(...args);
          },
        });
      });

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
      "POST for in_progress match with browser clock pinned to 2020 still returns 409 match_status_locked @slice-003 @us1",
      async ({ page }) => {
        // Navigate to /matches with the clock stub active. The page's
        // client-side code sees Date.now() = 2020-01-01 (a past kickoff
        // for every fixture match), but the server's lock decision is
        // based on trusted server time only.
        await page.goto("/matches");

        // Use the page's request context so the POST inherits the
        // authenticated session cookies.
        const response = await page.request.post("/api/predictions", {
          data: { match_id: M2_CAN_POL_ID, home: 1, away: 1 },
        });

        expect(
          response.status(),
          "client-clock manipulation MUST NOT bypass the lock — server must reject with 409",
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
