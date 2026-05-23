/**
 * US1 AS-1 / AS-2: first-visit follows OS dark; explicit choice
 * persists across reloads.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US1 acceptance
 * scenarios 1 and 2. Contract ref:
 * specs/009-ui-beautification/contracts/theme-toggle.md.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test.describe("US1 AS-1 — first visit follows OS preference", () => {
  test("OS dark + no stored preference → dark theme on first paint", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/design-system");

    const htmlClass = await page.evaluate(() => document.documentElement.className);
    expect(htmlClass).toContain("dark");
    await ctx.close();
  });

  test("OS light + no stored preference → light theme on first paint", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.goto("/design-system");

    const htmlClass = await page.evaluate(() => document.documentElement.className);
    expect(htmlClass).not.toContain("dark");
    await ctx.close();
  });
});

test.describe("US1 AS-2 — explicit choice persists across reload", () => {
  test("toggle to dark, reload → still dark", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("wcm.theme", "dark");
      } catch {}
    });
    await page.goto("/design-system");
    await page.reload();

    const htmlClass = await page.evaluate(() => document.documentElement.className);
    expect(htmlClass).toContain("dark");
    await ctx.close();
  });

  test("toggle to light, reload → still light (overrides OS dark)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("wcm.theme", "light");
      } catch {}
    });
    await page.goto("/design-system");
    await page.reload();

    const htmlClass = await page.evaluate(() => document.documentElement.className);
    expect(htmlClass).not.toContain("dark");
    await ctx.close();
  });

  test("system preference + OS flip → app follows OS", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("wcm.theme", "system");
      } catch {}
    });
    await page.goto("/design-system");
    // Flip the OS preference
    await ctx.close();

    const ctxDark = await browser.newContext({ colorScheme: "dark" });
    const pageDark = await ctxDark.newPage();
    await pageDark.addInitScript(() => {
      try {
        window.localStorage.setItem("wcm.theme", "system");
      } catch {}
    });
    await pageDark.goto("/design-system");

    const htmlClass = await pageDark.evaluate(
      () => document.documentElement.className,
    );
    expect(htmlClass).toContain("dark");
    await ctxDark.close();
  });
});
