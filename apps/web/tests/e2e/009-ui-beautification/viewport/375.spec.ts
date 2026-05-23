/**
 * SC-003 / US1 — /design-system has no horizontal scroll at 375x667.
 *
 * Spec ref: specs/009-ui-beautification/spec.md SC-003 + US1 AS-1
 * (mobile-first).
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test("no horizontal scroll at 375x667 on /design-system", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/design-system");
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
});
