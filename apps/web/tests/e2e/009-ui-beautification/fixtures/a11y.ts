/**
 * axe-core accessibility helper for slice 009-ui-beautification.
 *
 * Per spec SC-001 every main-flow page must score >= 95 on the
 * automated accessibility audit with zero serious or critical
 * violations.
 *
 * Scoring model (slice-local): 100 - sum(weight per violation)
 *   minor:    weight 1
 *   moderate: weight 2
 *   serious:  weight 10
 *   critical: weight 20
 *
 * The serious/critical assertions short-circuit before scoring,
 * so any of those auto-fail regardless of score arithmetic.
 *
 * Usage:
 *   import { axeCheck } from "../fixtures/a11y";
 *   await axeCheck(page, { context: "/design-system [dark]" });
 */

import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export type AxeCheckOptions = {
  disableRules?: string[];
  context?: string;
  minScore?: number;
};

const SEVERITY_WEIGHTS = {
  minor: 1,
  moderate: 2,
  serious: 10,
  critical: 20,
} as const;

export async function axeCheck(page: Page, options: AxeCheckOptions = {}) {
  const { disableRules = [], context = "", minScore = 95 } = options;

  let builder = new AxeBuilder({ page });
  if (disableRules.length > 0) {
    builder = builder.disableRules(disableRules);
  }

  const results = await builder.analyze();
  const violations = results.violations;

  const serious = violations.filter((v) => v.impact === "serious");
  const critical = violations.filter((v) => v.impact === "critical");

  if (serious.length > 0 || critical.length > 0) {
    const summary = [...critical, ...serious]
      .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join("\n");
    expect.soft(
      serious.length + critical.length,
      `axeCheck${context ? ` (${context})` : ""}: serious/critical violations present\n${summary}`,
    ).toBe(0);
  }

  const score =
    100 -
    violations.reduce((acc, v) => {
      const impact = (v.impact ?? "minor") as keyof typeof SEVERITY_WEIGHTS;
      return acc + SEVERITY_WEIGHTS[impact] * v.nodes.length;
    }, 0);

  expect(
    score,
    `axeCheck${context ? ` (${context})` : ""}: a11y score ${score} below minimum ${minScore}\n${violations
      .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
      .join("\n")}`,
  ).toBeGreaterThanOrEqual(minScore);

  return { score, violations };
}
