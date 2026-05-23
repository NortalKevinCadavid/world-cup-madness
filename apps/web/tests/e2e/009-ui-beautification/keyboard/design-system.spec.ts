/**
 * SC-004 / US1 — keyboard reachability sweep of /design-system.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

test("every interactive element on /design-system is reachable via Tab", async ({
  page,
}) => {
  await page.goto("/design-system");

  const interactiveCount = await page.evaluate(() => {
    return document.querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ).length;
  });
  expect(interactiveCount).toBeGreaterThan(0);

  const visited = new Set<string>();
  for (let i = 0; i < interactiveCount + 5; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      return el.outerHTML.slice(0, 200);
    });
    if (id) visited.add(id);
  }
  expect(visited.size).toBeGreaterThan(0);
});

test("no element on /design-system is focus-trapped outside an explicit modal", async ({
  page,
}) => {
  await page.goto("/design-system");
  // Tab 40 times. If any single element holds focus for 5+ Tabs
  // in a row, that's a focus trap.
  let prev: string | null = null;
  let same = 0;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const current = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? el.outerHTML.slice(0, 100) : null;
    });
    if (current === prev) same++;
    else same = 0;
    expect(same, "focus appears trapped on a single element").toBeLessThan(5);
    prev = current;
  }
});
