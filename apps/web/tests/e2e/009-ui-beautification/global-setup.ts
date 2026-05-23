/**
 * Playwright global-setup hook for slice 009-ui-beautification.
 *
 * Records the timestamp of the suite run so the regression-
 * checkpoint artifacts (regression-checkpoint-us<N>.md) can
 * cite the same run.
 *
 * Wire this into playwright.config.ts via `globalSetup` if
 * the slice's checkpoint tasks want a single canonical
 * timestamp per suite invocation.
 */

import type { FullConfig } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export default async function globalSetup(_config: FullConfig) {
  const timestamp = new Date().toISOString();
  const runDir = resolve(__dirname, "..", "..", "..", ".playwright-run");
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "slice-009.last-run.txt"), `${timestamp}\n`);
  } catch {
    // best-effort; the timestamp file is a convenience, not a gate.
  }
}
