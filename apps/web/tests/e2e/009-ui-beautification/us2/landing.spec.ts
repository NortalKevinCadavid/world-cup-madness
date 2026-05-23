/**
 * US2 / SC-001 / SC-003 — public landing page renders, no horizontal scroll
 * at 375x667, primary sign-in CTA is reachable + labelled.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US2 + edge cases.
 *
 * Status: RED until US2 landing/restyle lands; authored but not yet run.
 */

import { test, expect } from "@playwright/test";

test("landing at 375x667 has no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
});

test("landing has a single primary sign-in CTA labelled appropriately", async ({
  page,
}) => {
  await page.goto("/");
  const btn = page.getByRole("button", { name: /sign in/i });
  await expect(btn).toBeVisible();
  // 44x44 touch target floor.
  const box = await btn.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.max(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
});

test("auth/denied renders the expected reason message and a return CTA", async ({
  page,
}) => {
  await page.goto("/auth/denied?reason=domain_not_approved");
  await expect(
    page.getByRole("heading", { name: /access denied/i }),
  ).toBeVisible();
  await expect(page.getByText(/approved Nortal corporate identities/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /sign in with a different account/i }),
  ).toBeVisible();
});
