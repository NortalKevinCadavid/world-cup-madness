import { test, expect } from "@playwright/test";

// Harness probe (Slice 001 / T003). Confirms Playwright boots, the Next.js
// dev server starts via the config's webServer block, and the landing page
// renders with the canonical title. This file is NOT a slice-001 acceptance
// scenario — those live in `slice-001-*.spec.ts` and are authored RED-first
// in tasks T016+.
test("landing page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/World Cup Madness/i);
  await expect(page.getByRole("heading", { level: 1, name: /World Cup Madness/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
});
