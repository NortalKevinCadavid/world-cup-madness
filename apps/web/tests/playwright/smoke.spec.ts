import { test, expect } from "@playwright/test";

// Harness probe (Slice 001 / T003). Confirms Playwright boots, the Next.js
// dev server starts via the config's webServer block, and the landing page
// renders with the canonical title. This file is NOT a slice-001 acceptance
// scenario — those live in `slice-001-*.spec.ts` and are authored RED-first
// in tasks T016+.
test("landing page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/World Cup Madness/i);
  // Slice 009 wrapped the title in a shadcn <Card>, where CardTitle renders
  // as <h3>. Drop the level: 1 constraint — the smoke test only cares that
  // the canonical name is recognizably present on the landing page.
  await expect(page.getByRole("heading", { name: /World Cup Madness/i })).toBeVisible();
  // Slice 009 also swapped the Sign in <a href> for a <button> that calls
  // supabase.auth.signInWithOAuth via PKCE (see app/SignInButton.tsx). The
  // smoke test only cares that a "Sign in" affordance is present.
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});
