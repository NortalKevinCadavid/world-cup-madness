// --------------------------------------------------------------------------
// Slice 001 / T016 — US1 "Eligible employee signs in" Playwright scenarios.
// --------------------------------------------------------------------------
// RED-first acceptance suite for User Story 1 (P1):
//
//   Acceptance Scenario 1 — first-login provisioning
//     A freshly-eligible identity ("freshie") authenticates through the
//     OIDC stub; the auth hook (T024) must create a `participants` row,
//     redirect lands on `/dashboard`, and `GET /api/me` returns the new
//     profile with `participation_status='active'`, `first_login_at` set to
//     within the last 60 seconds, and the IdP-provided email + display name.
//     Bound by SC-002 (≤ 10 s from callback to dashboard).
//
//   Acceptance Scenario 2 — returning-login reuse + last_login_at update
//     The fixture's `alpha@nortal.com` (participants.id =
//     11111111-1111-1111-1111-111111111111) signs in twice; the second
//     sign-in MUST reuse the same `participants.id` and MUST advance
//     `last_login_at` past the value captured before sign-out.
//
//   Acceptance Scenario 3 — server-side re-verification on subsequent
//   requests (FR-002 / Clarifications 2026-05-15 mid-session removal).
//     A full toggle of `participants.participation_status` to
//     `deactivated` from inside a Playwright test requires the per-request
//     eligibility guard that lands in T034. To keep this file's surface
//     focused on US1's happy-path Then-clauses, the deactivation half of
//     this scenario is encoded as `test.fixme` and points at T034 for the
//     full assertion. The happy-path 200 on `/api/me` for an eligible alpha
//     is still asserted here as Scenario 3a.
//
// Spec deviation (D-T016-001): the tasks.md agent prompt for T016 sketched
// the first-login persona as `newuser@nortal.com / "New User"`. The user
// brief that drove the authoring of this file pinned the synthesized fresh
// persona to:
//   - sub          = 00000000-0000-0000-0000-000000000099
//   - email        = freshie@nortal.com
//   - display_name = "Freshie"
// Both satisfy FR-003's "fresh @nortal.com identity not present in the
// fixture" requirement; this file uses the brief's values so the assertions
// reference exactly the same sub/email/name the brief specifies.
//
// Spec deviation (D-T016-002): the tasks.md prompt also asks Scenario 3 to
// flip `tournament_config.eligibility.approved_domains` to `[]` via psql to
// drive the 403 path. That is out of reach from inside a Playwright runner
// without a service-role helper that this slice has not yet shipped. We
// follow the brief's PREFER guidance and mark the deactivation assertion
// `test.fixme` with a TODO referencing T034 (the per-request eligibility
// guard task that owns this scenario end-to-end).
//
// This file MUST be RED until T022 / T023 / T024 / T026 / T027 land:
//   - `/auth/callback` page (T022)
//   - `/dashboard` page (T023)
//   - `before_user_created` / `custom_access_token` auth hook (T024)
//   - `/api/me` route handler (T026)
//   - `requireEligible()` server helper (T027)
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext } from "@playwright/test";

import {
  signInWithIdentity,
  resetStub,
  assertOidcStubReachable,
} from "./fixtures/oidc";

// --------------------------------------------------------------------------
// Persona table (kept in sync with `supabase/seed/slice-001-fixture.sql`)
// --------------------------------------------------------------------------
//
// Synthesized "freshie" — NOT in the fixture; the auth hook (T024) MUST
// provision the auth.users + participants rows on first login. Pre-seeding
// here would mask the provisioning code path and break SC-003.
const FRESHIE = {
  sub: "00000000-0000-0000-0000-000000000099",
  email: "freshie@nortal.com",
  email_verified: true,
  name: "Freshie",
} as const;

// `alpha@nortal.com` — fixture row, ACTIVE, region='EE-North'.
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// --------------------------------------------------------------------------
// Response shape (mirrors contracts/participant-me.read.md § Response shape)
// --------------------------------------------------------------------------
//
// Declared locally to keep this RED test independent of any not-yet-shipped
// type module (`apps/web/lib/types/participant.ts` lands in a later task).
interface ParticipantMeResponse {
  participant: {
    id: string;
    display_name: string;
    email: string;
    domain: string;
    region: string | null;
    status: "active" | "deactivated";
    first_login_at: string;
    last_login_at: string;
  };
}

/**
 * Helper — fetches `/api/me` via the page's authenticated session and
 * returns the parsed body. Throws (failing the test) on any non-200.
 */
async function fetchMe(request: APIRequestContext): Promise<ParticipantMeResponse> {
  const response = await request.get("/api/me");
  expect(response.status(), "GET /api/me should be 200 for an eligible session").toBe(200);
  return (await response.json()) as ParticipantMeResponse;
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — eligible employee signs in", () => {
  test.beforeAll(async () => {
    // Fail fast (with a useful message) if the OIDC sidecar is down. Without
    // it none of these tests can mint identities.
    await assertOidcStubReachable();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  // ------------------------------------------------------------------------
  // Scenario 1 — first-login provisioning (US1 AS-1, FR-003, SC-002, SC-003)
  // ------------------------------------------------------------------------
  test(
    "Scenario 1 — first-login provisioning creates a participant and lands on /dashboard @slice-001 @us1",
    async ({ page, request }) => {
      // Capture wall-clock just BEFORE the sign-in so we can bound
      // `first_login_at` from below (60-second window per the brief).
      const signInStartedAt = Date.now();

      const landedOn = await signInWithIdentity(page, {
        claims: {
          sub: FRESHIE.sub,
          email: FRESHIE.email,
          email_verified: FRESHIE.email_verified,
          name: FRESHIE.name,
        },
      });

      // SC-002 — must reach dashboard within 10 s of callback. The
      // signInWithIdentity helper already enforces a 15 s URL-settle
      // timeout; here we additionally guard the total elapsed time.
      const elapsedMs = Date.now() - signInStartedAt;
      expect(elapsedMs, "first-login must complete within 10 s (SC-002)").toBeLessThanOrEqual(10_000);

      // Then — landing URL is /dashboard.
      expect(landedOn).toMatch(/\/dashboard(\?|$|#|\/)/);

      // Then — /api/me returns the freshly-created participant.
      const body = await fetchMe(page.request);
      const p = body.participant;

      expect(p.email).toBe(FRESHIE.email);
      expect(p.display_name).toBe(FRESHIE.name);
      expect(p.domain).toBe("nortal.com");
      expect(p.status).toBe("active");

      // `first_login_at` MUST be set and MUST fall inside the [start, now+60s]
      // window (the brief: "within the last 60 seconds").
      const firstLoginMs = Date.parse(p.first_login_at);
      expect(Number.isNaN(firstLoginMs), "first_login_at must be ISO-8601 parsable").toBe(false);
      expect(firstLoginMs).toBeGreaterThanOrEqual(signInStartedAt - 1_000);
      expect(firstLoginMs).toBeLessThanOrEqual(signInStartedAt + 60_000);

      // On a first-login the auth hook (T024) MUST set last_login_at = first_login_at
      // (single timestamp at provisioning). Asserting they match prevents a future
      // regression where a /api/me read accidentally advances last_login_at.
      expect(p.last_login_at).toBe(p.first_login_at);
    },
  );

  // ------------------------------------------------------------------------
  // Scenario 2 — returning login reuses the row, advances last_login_at
  // (US1 AS-2, FR-004, SC-005)
  // ------------------------------------------------------------------------
  test(
    "Scenario 2 — returning login reuses the same participants.id and updates last_login_at @slice-001 @us1",
    async ({ page, request }) => {
      // First sign-in — alpha. Capture id + last_login_at.
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });

      const firstRead = await fetchMe(page.request);
      const idBefore = firstRead.participant.id;
      const lastLoginBefore = Date.parse(firstRead.participant.last_login_at);

      expect(idBefore, "alpha's participants.id must match the fixture").toBe(ALPHA.participantId);
      expect(Number.isNaN(lastLoginBefore), "last_login_at must be ISO-8601 parsable").toBe(false);

      // Sign out — clear Supabase auth cookies/storage so the next sign-in
      // genuinely round-trips through the OIDC stub. We do NOT rely on a
      // not-yet-shipped sign-out UI; clearing storage is sufficient for
      // Playwright's per-test session model.
      await page.context().clearCookies();
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });

      // Force the server clock to advance past the captured timestamp so
      // last_login_at strictly increases. 1.1 s exceeds the auth hook's
      // expected ms-resolution timestamp granularity.
      await page.waitForTimeout(1_100);

      // Second sign-in — same sub, same email. The hook MUST find the
      // existing row (by auth_user_id linkage) and UPDATE last_login_at.
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });

      const secondRead = await fetchMe(page.request);
      const idAfter = secondRead.participant.id;
      const lastLoginAfter = Date.parse(secondRead.participant.last_login_at);

      // Then — same participant row reused (FR-004, SC-005).
      expect(idAfter, "returning login MUST reuse the existing participants.id").toBe(idBefore);

      // Then — last_login_at strictly advanced.
      expect(lastLoginAfter, "last_login_at MUST advance on returning login").toBeGreaterThan(lastLoginBefore);

      // Then — first_login_at is unchanged across sign-ins (FR-004
      // explicitly excludes first_login_at from the refreshable set).
      expect(secondRead.participant.first_login_at).toBe(firstRead.participant.first_login_at);

      // Then — status is still 'active'; the returning path MUST NOT
      // accidentally touch participation_status (FR-004 lock).
      expect(secondRead.participant.status).toBe("active");
    },
  );

  // ------------------------------------------------------------------------
  // Scenario 3a — server returns 200 on /api/me for an eligible alpha
  // (US1 AS-3 happy-path; FR-002 re-verification step).
  // ------------------------------------------------------------------------
  test(
    "Scenario 3a — /api/me returns 200 for an eligible session (happy-path re-verification) @slice-001 @us1",
    async ({ page, request }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA.sub,
          email: ALPHA.email,
          email_verified: ALPHA.email_verified,
          name: ALPHA.name,
        },
      });

      // First call — eligible. Use page.request so the session cookies
      // set by signInWithIdentity above are carried; the standalone
      // `request` fixture has no session.
      const r1 = await page.request.get("/api/me");
      expect(r1.status(), "first /api/me call must be 200 for eligible alpha").toBe(200);

      // Second call — eligibility MUST be re-verified server-side and
      // MUST also return 200 (no caching that would short-circuit the
      // per-request predicate call — FR-002).
      const r2 = await page.request.get("/api/me");
      expect(r2.status(), "second /api/me call must independently re-verify and return 200").toBe(200);

      const body2 = (await r2.json()) as ParticipantMeResponse;
      expect(body2.participant.id).toBe(ALPHA.participantId);
      expect(body2.participant.status).toBe("active");
    },
  );

  // ------------------------------------------------------------------------
  // Scenario 3b — server denies a previously-eligible session after the
  // participant is deactivated mid-session (Clarifications 2026-05-15).
  // ------------------------------------------------------------------------
  // Marked `fixme` per the brief's PREFER guidance: this assertion needs
  // (a) the per-request eligibility guard wired into /api/me (T034 / T027),
  // and (b) a service-role helper to flip participation_status from inside
  // the test runner. Neither has shipped in this slice yet. The
  // corresponding negative test for the API-guard 403 path lives in
  // slice-001-api-me-403-domain-removed.spec.ts (authored under T020).
  test.fixme(
    "Scenario 3b — /api/me returns 403 after mid-session deactivation (covered end-to-end by T034) @slice-001 @us1",
    async () => {
      // Intentionally empty — T034 (per-request eligibility guard) owns the
      // full implementation of this scenario. Tracking ref: tasks.md T034.
    },
  );
});
