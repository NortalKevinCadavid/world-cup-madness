/**
 * Motion-preference Playwright fixture for slice 009-ui-beautification.
 *
 * Sets the `wcm.motion` localStorage override (per
 * data-model.md Entity 2) AND emulates the
 * `prefers-reduced-motion` media feature so that BOTH the
 * in-app override and the OS-level preference align with the
 * requested mode.
 *
 * Usage:
 *   import { test } from "../fixtures/motion";
 *   test.use({ motion: "reduce" });
 *   test("no decorative motion", async ({ page }) => {
 *     await page.goto("/design-system");
 *     // assertions
 *   });
 */

import { test as base, type Page } from "@playwright/test";

export type MotionMode = "full" | "reduce";

type MotionFixtures = {
  motion: MotionMode;
};

export const test = base.extend<MotionFixtures>({
  motion: ["full", { option: true }],

  page: async ({ page, motion }, use) => {
    await primeMotion(page, motion);
    await page.emulateMedia({
      reducedMotion: motion === "reduce" ? "reduce" : "no-preference",
    });
    await use(page);
  },
});

async function primeMotion(page: Page, motion: MotionMode) {
  await page.addInitScript((m) => {
    try {
      window.localStorage.setItem("wcm.motion", m === "reduce" ? "reduce" : "full");
    } catch {
      // ignore
    }
  }, motion);
}

export { expect } from "@playwright/test";
