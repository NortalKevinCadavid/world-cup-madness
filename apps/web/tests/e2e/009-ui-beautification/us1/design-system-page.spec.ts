/**
 * US1 AS-4 — /design-system page contains every documented
 * token group and component.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US1 AS-4.
 * Page contract: anchors #tokens-colors, #tokens-typography,
 *   #tokens-spacing, #tokens-radii, #tokens-motion,
 *   #components-* (one anchor per shadcn primitive).
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

const REQUIRED_TOKEN_ANCHORS = [
  "tokens-colors",
  "tokens-typography",
  "tokens-spacing",
  "tokens-radii",
  "tokens-motion",
];

const REQUIRED_COMPONENT_ANCHORS = [
  "components-button",
  "components-card",
  "components-dialog",
  "components-dropdown-menu",
  "components-input",
  "components-popover",
  "components-tooltip",
  "components-tabs",
  "components-toast",
  "components-table",
  "components-badge",
  "components-skeleton",
  "components-domain",
];

test("US1 AS-4 — every documented token-group anchor is present", async ({
  page,
}) => {
  await page.goto("/design-system");
  for (const anchor of REQUIRED_TOKEN_ANCHORS) {
    const target = page.locator(`#${anchor}`);
    await expect(target, `missing anchor #${anchor}`).toBeVisible();
  }
});

test("US1 AS-4 — every documented component anchor is present", async ({
  page,
}) => {
  await page.goto("/design-system");
  for (const anchor of REQUIRED_COMPONENT_ANCHORS) {
    const target = page.locator(`#${anchor}`);
    await expect(target, `missing anchor #${anchor}`).toBeVisible();
  }
});

test("US1 AS-4 — page renders with a heading per section", async ({ page }) => {
  await page.goto("/design-system");

  // Top-level title
  await expect(
    page.getByRole("heading", { level: 1, name: /design system/i }),
  ).toBeVisible();

  // Verify each anchored section has at least one h2 or h3
  for (const anchor of [...REQUIRED_TOKEN_ANCHORS, ...REQUIRED_COMPONENT_ANCHORS]) {
    const section = page.locator(`#${anchor}`);
    const heading = section.locator(
      "h1, h2, h3, [role='heading']",
    );
    await expect(
      heading.first(),
      `section #${anchor} MUST contain a heading`,
    ).toBeVisible();
  }
});
