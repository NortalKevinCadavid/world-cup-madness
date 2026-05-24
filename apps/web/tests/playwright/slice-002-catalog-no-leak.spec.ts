// --------------------------------------------------------------------------
// Slice 002 / T014 — `/api/matches` no-info-leak on the 403 body.
// --------------------------------------------------------------------------
// RED acceptance test for the no-info-leak posture of the 403 response
// shape in `specs/002-match-catalog/contracts/match-catalog.read.md`
// § Security invariants ("403 body NEVER reveals participant existence
// or admin state").
//
// This file shares its setup with
// `slice-002-catalog-403-domain-removed.spec.ts`: sign in as alpha, flip
// approved_domains to [], call /api/matches, capture the 403 body. The
// assertions here focus on what the body MUST NOT contain, complementing
// the structural assertions in the 403-domain-removed spec.
//
// Forbidden-token taxonomy (any one of these failing is a security
// regression — DO NOT relax these assertions to make them GREEN):
//   1. Other participants — no participant emails, no fixture UUIDs
//      (alpha / bravo / charlie / zulu), no display names from the
//      fixture set.
//   2. Provider info — no "football-data", "stub", "sync" tokens
//      (slice-006 sync provider must not leak into the catalog body).
//   3. Admin info — no "admin", "is_admin" tokens (admin actor state is
//      slice-007 surface, never the catalog).
//   4. Approved-domain list — no "nortal.com", "example.com",
//      "approved", "approved_domains", "eligibility.approved_domains".
//   5. Stack trace — no `at name (file:line:col)` Node frame, no
//      "Error:" prefix.
//   6. Debug headers — no `X-Debug-*` response header.
//
// The full forbidden-token list is built into a single regex that scans
// the response text plus headers, mirroring slice-001
// `slice-001-api-me-no-leak.spec.ts` but extended with the slice-002
// provider/admin tokens that the catalog surface must additionally
// shield.
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

// Participant IDs from the slice-001 fixture. NONE of these UUIDs may
// appear in the 403 body. Listed explicitly here so a future audit can
// grep this constant to confirm coverage.
const FORBIDDEN_PARTICIPANT_IDS = [
  "11111111-1111-1111-1111-111111111111", // alpha
  "22222222-2222-2222-2222-222222222222", // bravo
  "33333333-3333-3333-3333-333333333333", // charlie
  "99999999-9999-9999-9999-999999999999", // zulu
] as const;

// Tokens the 403 body must not contain. Split into named buckets so the
// failure message in the catch can point at the offending category.
// Matched case-insensitively against the full response text.
const FORBIDDEN_TOKENS: ReadonlyArray<{
  category: string;
  token: string;
}> = [
  // 1. Other participants — emails + display names from the slice-001 seed.
  { category: "participant-email", token: "@nortal.com" },
  { category: "participant-email", token: "@example.com" },
  { category: "participant-name", token: "alpha tester" },
  { category: "participant-name", token: "bravo" },
  { category: "participant-name", token: "charlie" },
  { category: "participant-name", token: "zulu" },

  // 2. Provider info (slice-006 catalog sync source).
  { category: "provider", token: "football-data" },
  { category: "provider", token: "stub" },
  { category: "provider", token: "sync" },

  // 3. Admin info (slice-007 surface).
  { category: "admin", token: "admin" },
  { category: "admin", token: "is_admin" },

  // 4. Approved-domain list (slice-001 eligibility config).
  { category: "approved-domains", token: "nortal.com" },
  { category: "approved-domains", token: "example.com" },
  { category: "approved-domains", token: "approved" },
  { category: "approved-domains", token: "approved_domains" },
  { category: "approved-domains", token: "eligibility.approved_domains" },
];

test.describe(
  "US1 — /api/matches 403 body has no information leak @slice-002 @us1 @edge",
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
      "403 body MUST NOT leak participants, provider, admin info, domains, debug headers, or stack traces @slice-002 @us1 @edge",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await request.get("/api/matches", {
              headers: { Cookie: cookieHeader },
            });
            expect(response.status()).toBe(403);

            const bodyJson = (await response.json()) as unknown;
            const bodyText = JSON.stringify(bodyJson);
            const headers = response.headers();

            // -------------------------------------------------------------
            // Structural envelope — the only allowed top-level key is
            // `error`, and its only sub-keys are `code` + `message`. Any
            // additional key is a potential leak vector even if its value
            // is benign today.
            // -------------------------------------------------------------
            expect(Object.keys(bodyJson as object)).toEqual(["error"]);
            expect(
              Object.keys((bodyJson as { error: object }).error).sort(),
            ).toEqual(["code", "message"]);

            // -------------------------------------------------------------
            // 1. Other participants — UUIDs from any persona in the
            // fixture set, including alpha's own id. The 403 body must
            // be persona-agnostic.
            // -------------------------------------------------------------
            for (const id of FORBIDDEN_PARTICIPANT_IDS) {
              expect(
                bodyText.toLowerCase(),
                `403 body must not contain participant id ${id}`,
              ).not.toContain(id.toLowerCase());
            }

            // -------------------------------------------------------------
            // 2-4. Token taxonomy — scan the full response text for any
            // forbidden token. The match is case-insensitive. Each
            // category contributes its own assertion so a failure points
            // at the offending bucket rather than the union regex.
            // -------------------------------------------------------------
            const lowerBody = bodyText.toLowerCase();
            for (const { category, token } of FORBIDDEN_TOKENS) {
              expect(
                lowerBody,
                `403 body must not echo ${category} token "${token}"`,
              ).not.toContain(token.toLowerCase());
            }

            // -------------------------------------------------------------
            // Belt-and-braces — also scan with a single union regex
            // built from the forbidden tokens. This catches token
            // splits across keys (e.g. a "admin" substring buried in a
            // longer string that an exact-equality check might miss).
            // -------------------------------------------------------------
            const escaped = FORBIDDEN_TOKENS.map(({ token }) =>
              token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            );
            const unionRegex = new RegExp(`(${escaped.join("|")})`, "i");
            expect(
              bodyText,
              "403 body must not match any forbidden-token regex",
            ).not.toMatch(unionRegex);

            // -------------------------------------------------------------
            // 5. Stack trace shapes.
            // -------------------------------------------------------------
            expect(
              bodyText,
              "403 body must not contain a Node stack frame",
            ).not.toMatch(/at\s+\S+\s+\([^)]+:\d+:\d+\)/);
            expect(bodyText).not.toMatch(/Error:\s/);

            // -------------------------------------------------------------
            // 6. Debug headers.
            // -------------------------------------------------------------
            for (const headerName of Object.keys(headers)) {
              expect(
                headerName.toLowerCase(),
                `response header "${headerName}" must not start with x-debug`,
              ).not.toMatch(/^x-debug/i);
            }
          },
        );
      },
    );
  },
);
