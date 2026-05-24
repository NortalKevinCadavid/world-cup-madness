// --------------------------------------------------------------------------
// Slice 002 / T014 — `/api/matches` 403 path on mid-session domain removal.
// --------------------------------------------------------------------------
// RED acceptance test for the eligibility-gate denial path on the match
// catalog route documented in
// `specs/002-match-catalog/contracts/match-catalog.read.md` § 403.
//
// The /api/matches route reuses slice-001's `requireEligible()` predicate
// (Clarifications 2026-05-15 Q3 — mid-session deny). The 403 body shape
// is identical to `/api/me`'s 403 body, and the audit row is written by
// requireEligible() with `source='api_guard'`.
//
// Setup (mirrors slice-001 `slice-001-api-me-403-domain-removed.spec.ts`):
//   1. Sign in as alpha@nortal.com (fixture row, ACTIVE).
//   2. Flip `tournament_config.eligibility.approved_domains` to `[]` via
//      the service-role helper (`withTemporaryConfig`).
//   3. GET /api/matches from the same authenticated session.
//
// Then-clauses:
//   1. Status code 403 (contract § 403).
//   2. Body `{ error: { code: 'DOMAIN_NOT_APPROVED', message: <string> } }`
//      — identical envelope to /api/me § 403.
//   3. `Cache-Control: private, max-age=0, must-revalidate` — eligibility
//      denials are never cached, regardless of the 200-path's max-age=10.
//
// The config is restored via `withTemporaryConfig`'s finally block; the
// afterEach is belt-and-braces for the case where the test body throws
// BEFORE entering the helper (e.g. sign-in failure).
//
// RED until T020+ wires the requireEligible() call into
// `apps/web/app/api/matches/route.ts`.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { withTemporaryConfig } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

test.describe(
  "US1 — /api/matches 403 on mid-session domain removal @slice-002 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
      // `withTemporaryConfig` already restores on the happy + crash paths.
      // The afterEach here is belt-and-braces for the case where the test
      // body throws BEFORE entering withTemporaryConfig (e.g. sign-in
      // failure). That branch leaves the config untouched, so no extra
      // work is required here.
    });

    test(
      "mid-session domain removal flips /api/matches to 403 + DOMAIN_NOT_APPROVED body @slice-002 @us1",
      async ({ page, request, context }) => {
        // Step 1 — sign in as an eligible participant.
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward signed-in cookies to the bare `request` fixture — see
        // specs/001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md.
        const cookies = await context.cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const authHeaders = { Cookie: cookieHeader };

        // Sanity — the session can fetch /api/matches successfully BEFORE
        // the domain is removed. Asserts the test setup is correctly wired
        // (any non-403 status proves the 403 branch is the actual cause).
        const sanity = await request.get("/api/matches", { headers: authHeaders });
        expect(
          sanity.status(),
          "alpha's pre-removal /api/matches call must be 200 (sanity check)",
        ).toBe(200);

        // Step 2 + 3 — flip the approved-domain list to [] and re-call
        // /api/matches INSIDE the withTemporaryConfig block so the
        // snapshot/restore brackets the assertion regardless of
        // pass / fail / crash.
        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await request.get("/api/matches", { headers: authHeaders });

            // Then 1 — status 403.
            expect(
              response.status(),
              "Clarifications 2026-05-15 Q3: post-removal /api/matches MUST be 403",
            ).toBe(403);

            // Then 2 — body shape (identical envelope to /api/me § 403).
            const body = (await response.json()) as unknown;
            expect(body).toMatchObject({
              error: {
                code: "DOMAIN_NOT_APPROVED",
                message: expect.any(String),
              },
            });
            expect(
              (body as { error: { message: string } }).error.message,
            ).toBe(
              "This application is restricted to approved Nortal corporate identities.",
            );

            // Then 3 — cache-control: eligibility denials never cached.
            expect(response.headers()["cache-control"]).toBe(
              "private, max-age=0, must-revalidate",
            );
          },
        );

        // After the helper restores the config, /api/matches should
        // recover. This is not a contract assertion per se; it's a
        // self-check that the test cleanup actually restored eligibility.
        // If it fails the helper restore is broken and CI will catch it
        // before this poisons sibling tests.
        const recovered = await request.get("/api/matches", { headers: authHeaders });
        expect(
          recovered.status(),
          "post-restore /api/matches must return 200 again (helper sanity)",
        ).toBe(200);
      },
    );
  },
);
