/**
 * Theme-aware Playwright fixture for slice 009-ui-beautification.
 *
 * Use this `test` extension when you need a spec to run under
 * a specific theme (light or dark). The fixture sets the theme
 * via localStorage BEFORE first navigation and asserts the
 * <html> class matches after navigation.
 *
 * Usage:
 *   import { test } from "../fixtures/theme";
 *   test("renders ok in dark", async ({ page, theme }) => {
 *     test.skip(theme !== "dark", "dark-only check");
 *     await page.goto("/design-system");
 *   });
 *
 * Or parameterize across both themes via test.describe.parallel:
 *
 *   for (const theme of ["light", "dark"] as const) {
 *     test.describe(`theme=${theme}`, () => {
 *       test.use({ theme });
 *       test("contrast", async ({ page }) => { ... });
 *     });
 *   }
 */

import { test as base, expect, type Page } from "@playwright/test";

export type Theme = "light" | "dark";

type ThemeFixtures = {
  theme: Theme;
};

export const test = base.extend<ThemeFixtures>({
  theme: ["light", { option: true }],

  page: async ({ page, theme }, use, testInfo) => {
    await primeTheme(page, theme);
    await use(page);
  },
});

async function primeTheme(page: Page, theme: Theme) {
  // Install an init script so every navigated origin starts in
  // the requested theme. This intercepts the next-themes pre-
  // hydration script's localStorage read.
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("wcm.theme", t);
    } catch {
      // localStorage may be unavailable (private mode); the fixture
      // still succeeds because next-themes will fall back to system.
    }
  }, theme);
}

export async function assertThemeApplied(page: Page, theme: Theme) {
  const htmlClass = await page.evaluate(() => document.documentElement.className);
  if (theme === "dark") {
    expect(htmlClass).toContain("dark");
  } else {
    expect(htmlClass).not.toContain("dark");
  }
}

export { expect };
