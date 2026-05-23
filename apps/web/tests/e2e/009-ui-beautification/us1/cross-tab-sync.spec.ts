/**
 * US1 — cross-tab theme synchronization via storage event.
 *
 * Contract ref: specs/009-ui-beautification/contracts/theme-toggle.md
 * § Cross-tab synchronization.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test("toggling theme in tab A propagates to tab B via storage event", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: "light" });
  const pageA = await ctx.newPage();
  await pageA.goto("/design-system");

  const pageB = await ctx.newPage();
  await pageB.goto("/design-system");

  const beforeB = await pageB.evaluate(
    () => document.documentElement.className,
  );
  expect(beforeB).not.toContain("dark");

  // Trigger an explicit set in tab A so the storage event fires for tab B.
  await pageA.evaluate(() => {
    window.localStorage.setItem("wcm.theme", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "wcm.theme",
        newValue: "dark",
      }),
    );
  });

  await expect
    .poll(
      async () => pageB.evaluate(() => document.documentElement.className),
      { timeout: 2000 },
    )
    .toContain("dark");

  await ctx.close();
});
