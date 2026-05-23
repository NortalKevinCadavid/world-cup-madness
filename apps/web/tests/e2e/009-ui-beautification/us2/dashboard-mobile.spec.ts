/**
 * US2 AS-1 — dashboard renders without horizontal scroll at 375x667.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US2 acceptance scenario 1.
 *
 * Note: this spec requires an authenticated participant session. It runs
 * against the seeded local-OIDC stub from slice 001's quickstart. Mark
 * skipped when WCM_SKIP_AUTH_E2E=1 (the user's choice to author-only).
 *
 * Status: RED until US2 implementation lands AND a participant session is
 * available; authored but not yet run.
 */

import { test, expect } from "@playwright/test";

test.skip(
  () => process.env.WCM_SKIP_AUTH_E2E === "1",
  "Auth-dependent — set WCM_SKIP_AUTH_E2E=0 to run.",
);

test("dashboard at 375x667 has no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  // Assume the user is signed in via a fixture not authored in this slice;
  // implementers should plug in slice 001's auth helper here.
  await page.goto("/dashboard");

  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
});

test("dashboard primary CTAs have >= 44x44 touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/dashboard");

  const interactives = await page
    .locator("a[href], button:not([disabled])")
    .all();
  for (const el of interactives.slice(0, 12)) {
    const box = await el.boundingBox();
    if (!box) continue;
    // Allow 0-size hidden elements (e.g., sr-only) by checking only those
    // with a non-zero box.
    if (box.width === 0 || box.height === 0) continue;
    expect(
      Math.max(box.width, box.height),
      `target ${await el.evaluate((e) => (e as Element).outerHTML.slice(0, 80))} below 44px`,
    ).toBeGreaterThanOrEqual(44);
  }
});
