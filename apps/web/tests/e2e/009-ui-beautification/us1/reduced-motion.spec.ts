/**
 * US1 AS-5 — prefers-reduced-motion is respected.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US1 AS-5.
 * Implementation: data-motion="reduce" attribute on <html>
 * + Tailwind motion-safe variants on decorative elements.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test("with prefers-reduced-motion: reduce, decorative elements have no transitions or animations", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/design-system");

  // Page must propagate the reduced motion preference to <html>
  // via data-motion="reduce" so CSS can react.
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.motion))
    .toBe("reduce");

  // Every element tagged data-motion-decorative MUST resolve
  // animation-duration ~ 0 and transition-duration ~ 0.
  const decorative = await page.locator("[data-motion-decorative]").all();
  expect(decorative.length, "design-system MUST mark at least one decorative motion sample").toBeGreaterThan(0);

  for (const el of decorative) {
    const styles = await el.evaluate((node) => {
      const cs = getComputedStyle(node as Element);
      return {
        animation: cs.animationDuration,
        transition: cs.transitionDuration,
      };
    });
    expect(styles.animation).toMatch(/^(0s|0\.0+s|0\.01ms)/);
    expect(styles.transition).toMatch(/^(0s|0\.0+s|0\.01ms)/);
  }

  await ctx.close();
});

test("without prefers-reduced-motion, decorative elements have non-zero motion", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  await page.goto("/design-system");

  const decorative = await page.locator("[data-motion-decorative]").first();
  await expect(decorative).toBeVisible();
  const styles = await decorative.evaluate((node) => {
    const cs = getComputedStyle(node as Element);
    return {
      animation: cs.animationDuration,
      transition: cs.transitionDuration,
    };
  });
  // At least one of the two must be non-zero so the sample
  // demonstrates motion in full-motion mode.
  const animMs = parseFloat(styles.animation) || 0;
  const transMs = parseFloat(styles.transition) || 0;
  expect(animMs + transMs).toBeGreaterThan(0);

  await ctx.close();
});
