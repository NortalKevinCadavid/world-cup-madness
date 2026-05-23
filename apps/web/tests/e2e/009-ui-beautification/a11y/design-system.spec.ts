/**
 * SC-001 / US1 — axe-core a11y sweep of /design-system in both themes.
 *
 * Spec ref: specs/009-ui-beautification/spec.md SC-001 + US1 AS-3
 * (contrast on every token pair). Helper:
 * specs/009-ui-beautification/../apps/web/tests/e2e/009-ui-beautification/fixtures/a11y.ts.
 *
 * Status: RED until US1 implementation lands.
 */

import { test as base } from "@playwright/test";
import { axeCheck } from "../fixtures/a11y";

for (const theme of ["light", "dark"] as const) {
  base.describe(`design-system a11y (theme=${theme})`, () => {
    base(`axeCheck on /design-system in ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          window.localStorage.setItem("wcm.theme", t);
        } catch {}
      }, theme);
      await page.goto("/design-system");

      await axeCheck(page, { context: `/design-system [${theme}]` });
    });
  });
}
