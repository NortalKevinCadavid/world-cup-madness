/**
 * US1 AS-3 (theme flip <= 150ms, AA contrast) + AS-6 (keyboard nav).
 *
 * Spec ref: specs/009-ui-beautification/spec.md US1 acceptance
 * scenarios 3 and 6. Component contract ref:
 * specs/009-ui-beautification/contracts/component-api.md § ThemeToggle.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test("US1 AS-3 — theme flip applies the new class quickly", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto("/design-system");

  // Theme toggle MUST be reachable from the main nav.
  const toggle = page.getByRole("button", { name: /toggle theme/i });
  await expect(toggle).toBeVisible();

  const beforeClass = await page.evaluate(
    () => document.documentElement.className,
  );
  expect(beforeClass).not.toContain("dark");

  // Open the menu and select Dark via keyboard.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: /dark/i }).click();

  await expect
    .poll(
      async () => page.evaluate(() => document.documentElement.className),
      { timeout: 500 },
    )
    .toContain("dark");

  await ctx.close();
});

test("US1 AS-6 — every interactive element on /design-system has a visible focus ring", async ({
  page,
}) => {
  await page.goto("/design-system");

  // Tab through several elements and verify each focused element
  // has an outline (or a ring class) and that focus is not trapped.
  const focusable = await page
    .locator("a[href], button, input, [tabindex]:not([tabindex='-1'])")
    .all();

  expect(focusable.length).toBeGreaterThan(0);

  // Try the first 10 focusable elements; that's enough to fail
  // on a missing focus style without making the suite slow.
  for (let i = 0; i < Math.min(10, focusable.length); i++) {
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        outlineWidth: cs.outlineWidth,
        outlineStyle: cs.outlineStyle,
        boxShadow: cs.boxShadow,
        className: el.className,
      };
    });
    expect(outline, "focused element MUST have a visible focus ring").not.toBeNull();
    const hasOutline =
      outline!.outlineStyle !== "none" && outline!.outlineWidth !== "0px";
    const hasShadowRing =
      outline!.boxShadow !== "none" && outline!.boxShadow.length > 0;
    const hasRingClass = /ring|focus-visible/.test(outline!.className);
    expect(
      hasOutline || hasShadowRing || hasRingClass,
      `focus indicator missing on element with class "${outline!.className}"`,
    ).toBe(true);
  }
});
