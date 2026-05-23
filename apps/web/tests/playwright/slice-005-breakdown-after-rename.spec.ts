/**
 * Slice 005 regression — verifies that the personal-breakdown migration
 * (originally drafted at slot 0054b, renamed to 0078 on 2026-05-23) is
 * actually picked up by the Supabase CLI and applied during
 * `supabase db reset`, so that `/me/breakdown` renders without the
 * "Could not find the table 'public.personal_breakdown_v' in the schema
 * cache" PostgREST error.
 *
 * Why this test exists: the original filename `0054b_*.sql` was silently
 * skipped by the CLI's migration runner because the runner parses the
 * version from the leading run of digits only ("0054b" → "0054"), which
 * collided with `0054_leaderboard_views.sql`. The view never got created
 * on fresh local installs, and `/me/breakdown` 500'd. The follow-up at
 * `specs/005-scoring-leaderboard/follow-up-migration-rename.md`
 * documents the fix; this spec is the regression gate that catches a
 * future regression of the same kind (e.g. someone adding another
 * `NNNNa_*.sql` or `NNNNb_*.sql` migration).
 *
 * What this spec exercises end-to-end:
 *   1. The Keycloak interactive login flow (against the local realm
 *      with the seeded "alpha@nortal.com" identity).
 *   2. The Supabase Auth PKCE callback that exchanges the Keycloak code
 *      for a Supabase session.
 *   3. The participant-layout eligibility gate (slice 001).
 *   4. The `/me/breakdown` page rendering — exercising
 *      `getPersonalBreakdown` and therefore the `personal_breakdown_v`
 *      view that the renamed migration creates.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/playwright/slice-005-breakdown-after-rename.spec.ts \
 *     --project=chromium --reporter=list
 */

import { test, expect } from "@playwright/test";

const ALPHA_EMAIL = "alpha@nortal.com";
const ALPHA_PASSWORD = "dev-password";

test("sign in as alpha and visit /me/breakdown — no schema-cache error", async ({
  page,
}) => {
  // 1. Landing page → click Sign in.
  // The slice 009 redesign renders the title inside a shadcn <CardTitle>
  // (which is an h3), so we drop the level filter.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /world cup madness/i }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /sign in/i }).click();

  // 2. Keycloak interactive login. Waiting for the username field to be
  // visible is more robust than waiting on a URL pattern because the
  // redirect chain goes:
  //   localhost:3000  →  localhost:54321 (Supabase Auth)  →  localhost:8090 (Keycloak)
  // and Playwright's waitForURL can race with the in-flight redirect.
  const usernameField = page.getByRole("textbox", { name: /username or email/i });
  await expect(usernameField).toBeVisible({ timeout: 15_000 });
  await usernameField.fill(ALPHA_EMAIL);
  await page.getByRole("textbox", { name: /^password$/i }).fill(ALPHA_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // 3. Wait to land back on the dashboard
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
  await expect(
    page.getByRole("heading", { level: 1, name: /welcome/i }),
  ).toBeVisible();

  // 4. Navigate to /me/breakdown and verify a clean 200 (no 500 with the
  //    "Could not find the table 'public.personal_breakdown_v'" schema-cache error)
  const response = await page.goto("/me/breakdown");
  expect(response?.status(), "GET /me/breakdown should not 500").toBe(200);

  // 5. Defensive: explicit check that the page DID NOT render Next.js's
  //    error-boundary fallback for the breakdown view.
  const body = await page.locator("body").innerText();
  expect(
    body.toLowerCase(),
    "page body must not contain the schema-cache error",
  ).not.toContain("could not find the table");
  expect(
    body.toLowerCase(),
    "page body must not contain a generic Next.js dev-error",
  ).not.toContain("internal server error");
});
