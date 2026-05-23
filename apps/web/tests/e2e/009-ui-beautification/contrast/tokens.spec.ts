/**
 * SC-002 — WCAG AA contrast on every token pair (light + dark).
 *
 * Spec ref: specs/009-ui-beautification/spec.md SC-002.
 * Page contract: every documented token pair MUST be exposed on
 * /design-system via a [data-token-pair="bgVar:fgVar"] element.
 * The test reads computed colors, derives WCAG contrast, and
 * asserts >= 4.5 (body) or >= 3.0 (large/non-text).
 *
 * Tokens with a body-text role default to 4.5; tokens whose
 * data-token-role attribute is "large" or "non-text" use 3.0.
 *
 * Status: RED until US1 implementation lands.
 */

import { test, expect } from "@playwright/test";

type Rgb = { r: number; g: number; b: number };

function parseRgb(input: string): Rgb {
  const m = input.match(
    /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/,
  );
  if (!m) throw new Error(`could not parse rgb from "${input}"`);
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) };
}

function relLuminance({ r, g, b }: Rgb): number {
  const norm = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`token contrast (theme=${theme})`, () => {
    test(`every [data-token-pair] satisfies WCAG AA in ${theme}`, async ({
      page,
    }) => {
      await page.addInitScript((t) => {
        try {
          window.localStorage.setItem("wcm.theme", t);
        } catch {}
      }, theme);
      await page.goto("/design-system#tokens-colors");

      const pairs = await page
        .locator("[data-token-pair]")
        .all();
      expect(pairs.length, "design-system MUST expose [data-token-pair] swatches").toBeGreaterThan(0);

      const failures: string[] = [];
      for (const el of pairs) {
        const info = await el.evaluate((node) => {
          const cs = getComputedStyle(node as Element);
          return {
            pair: (node as HTMLElement).dataset.tokenPair,
            role: (node as HTMLElement).dataset.tokenRole ?? "body",
            bg: cs.backgroundColor,
            fg: cs.color,
          };
        });
        const minRatio =
          info.role === "large" || info.role === "non-text" ? 3.0 : 4.5;
        const ratio = contrastRatio(parseRgb(info.bg), parseRgb(info.fg));
        if (ratio < minRatio) {
          failures.push(
            `pair="${info.pair}" role="${info.role}" ratio=${ratio.toFixed(2)} (need >= ${minRatio})`,
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  });
}
