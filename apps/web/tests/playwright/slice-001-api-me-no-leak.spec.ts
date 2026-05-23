// --------------------------------------------------------------------------
// Slice 001 / T029 — `/api/me` no-info-leak on the 403 body.
// --------------------------------------------------------------------------
// RED acceptance test for the no-info-leak posture of the 403 response
// shape in `contracts/participant-me.read.md` § 403 + § Security
// invariants ("The 403 body NEVER reveals the existence of other
// participants, other domains, or the approved-domain list").
//
// This file shares its setup with `slice-001-api-me-403-domain-removed`:
// sign in as alpha, flip approved_domains to [], call /api/me, capture
// the 403 body. The assertions here focus on what the body MUST NOT
// contain, complementing the structural assertions in the 403-domain-
// removed spec.
//
// Then-clauses (any one of these failing is a security regression — DO NOT
// relax these assertions to make them GREEN):
//   1. No `email` substring in the body — no participant emails.
//   2. No `domain` field — no domain string ("nortal.com", "example.com",
//      "approved", etc.) returned in the body.
//   3. No `participants.id` UUID anywhere in the body — not alpha's,
//      not any other participant's.
//   4. No `X-Debug-*` headers in the response.
//   5. No stack-trace-shaped substrings in the body.
//   6. No list of approved domains echoed back.
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

// Participant IDs from the fixture. NONE of these UUIDs may appear in
// the 403 body. Listed explicitly here so a future audit can grep this
// constant to confirm coverage.
const FORBIDDEN_PARTICIPANT_IDS = [
  "11111111-1111-1111-1111-111111111111", // alpha
  "22222222-2222-2222-2222-222222222222", // bravo
  "33333333-3333-3333-3333-333333333333", // charlie
  "99999999-9999-9999-9999-999999999999", // zulu
] as const;

const FORBIDDEN_DOMAIN_SUBSTRINGS = [
  "nortal.com",
  "example.com",
  "approved",
  "approved_domains",
  "eligibility.approved_domains",
] as const;

test.describe(
  "US2 — /api/me 403 body has no information leak @slice-001 @us2",
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
      "403 body MUST NOT leak email, domain, participants.id, debug headers, or stack traces @slice-001 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        await withTemporaryConfig(
          "eligibility.approved_domains",
          [],
          async () => {
            const response = await page.request.get("/api/me");
            expect(response.status()).toBe(403);

            const bodyJson = (await response.json()) as unknown;
            const bodyText = JSON.stringify(bodyJson);
            const headers = response.headers();

            // Then 1 — no participant emails.
            expect(bodyText, "403 body must not contain any participant email").not.toMatch(
              /@nortal\.com/i,
            );
            expect(bodyText).not.toMatch(/@example\.com/i);

            // Then 2 — no `domain` field surfaced.
            expect(bodyJson).not.toHaveProperty("participant");
            expect(bodyJson).not.toHaveProperty("domain");
            expect(bodyJson).not.toHaveProperty("region");
            // The body has the canonical shape — no extra debug keys.
            expect(Object.keys(bodyJson as object)).toEqual(["error"]);
            expect(
              Object.keys((bodyJson as { error: object }).error).sort(),
            ).toEqual(["code", "message"]);

            // Then 3 — no participant UUIDs of any persona, including the
            // signed-in alpha. Even leaking the caller's own id is a
            // regression because the 403 body must be identical to the
            // auth-hook denial body (contract § 403 last sentence).
            for (const id of FORBIDDEN_PARTICIPANT_IDS) {
              expect(
                bodyText.toLowerCase(),
                `403 body must not contain participant id ${id}`,
              ).not.toContain(id.toLowerCase());
            }

            // Then 4 — no debug headers.
            for (const headerName of Object.keys(headers)) {
              expect(
                headerName.toLowerCase(),
                `response header "${headerName}" must not start with x-debug`,
              ).not.toMatch(/^x-debug/i);
            }

            // Then 5 — no stack-trace substring.
            expect(
              bodyText,
              "403 body must not contain a Node stack frame",
            ).not.toMatch(/at\s+\S+\s+\([^)]+:\d+:\d+\)/);
            expect(bodyText).not.toMatch(/Error:\s/);

            // Then 6 — no approved-domain list echoed back.
            for (const sub of FORBIDDEN_DOMAIN_SUBSTRINGS) {
              expect(
                bodyText.toLowerCase(),
                `403 body must not echo "${sub}"`,
              ).not.toContain(sub.toLowerCase());
            }
          },
        );
      },
    );
  },
);
