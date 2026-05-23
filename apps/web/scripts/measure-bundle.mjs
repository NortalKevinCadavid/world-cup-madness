#!/usr/bin/env node
// Bundle budget gate for slice 009-ui-beautification.
//
// Reads pre-slice baseline from
// `specs/009-ui-beautification/regression-baseline.md`
// (Total chunk gzipped row), measures current build's
// total chunk gzipped, and compares against the
// budget ceiling: baseline + 30 KB gzipped.
//
// Exit code 0 if delta <= 30 KB gzipped.
// Exit code 1 if exceeded.
//
// Run from apps/web/ via `pnpm run measure-bundle`
// (or `npm run measure-bundle`).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appWebDir = resolve(__dirname, '..');
const repoRoot = resolve(appWebDir, '..', '..');
const chunksDir = join(appWebDir, '.next', 'static', 'chunks');
const baselinePath = join(
  repoRoot,
  'specs',
  '009-ui-beautification',
  'regression-baseline.md',
);

const BUDGET_BYTES = 30 * 1024; // 30 KB gzipped

function ensureBuild() {
  if (!existsSync(chunksDir)) {
    console.log('[measure-bundle] .next/static/chunks not present — running next build...');
    execSync('npx next build', { cwd: appWebDir, stdio: 'inherit' });
  }
}

function listChunkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) continue;
    if (!entry.endsWith('.js')) continue;
    out.push(full);
  }
  return out;
}

function measureTotalGzipped() {
  const files = listChunkFiles(chunksDir);
  let total = 0;
  for (const f of files) {
    total += gzipSync(readFileSync(f)).length;
  }
  return total;
}

function parseBaseline() {
  if (!existsSync(baselinePath)) {
    throw new Error(`Baseline file not found: ${baselinePath}`);
  }
  const text = readFileSync(baselinePath, 'utf8');
  // Find the "TOTAL" row in the bundle-size table: "| **TOTAL** | ... | **N,NNN** | ..."
  const row = text
    .split('\n')
    .find((line) => /\|\s*\*\*TOTAL\*\*\s*\|/i.test(line));
  if (!row) {
    throw new Error('Could not find TOTAL row in regression-baseline.md');
  }
  // Expected layout: | **TOTAL** | rawN | gzN | |
  const cells = row
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (cells.length < 3) {
    throw new Error(`TOTAL row has unexpected shape: ${row}`);
  }
  const gzText = cells[2].replace(/[*,\s]/g, '');
  const gz = Number.parseInt(gzText, 10);
  if (!Number.isFinite(gz)) {
    throw new Error(`Could not parse TOTAL gzipped value from "${cells[2]}"`);
  }
  return gz;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function main() {
  ensureBuild();
  const baseline = parseBaseline();
  const current = measureTotalGzipped();
  const delta = current - baseline;
  const ceiling = baseline + BUDGET_BYTES;

  console.log('');
  console.log('[measure-bundle] Bundle budget check (slice 009-ui-beautification)');
  console.log('[measure-bundle] ----------------------------------------------');
  console.log(`[measure-bundle] Baseline (gzipped):    ${fmt(baseline)} bytes`);
  console.log(`[measure-bundle] Current  (gzipped):    ${fmt(current)} bytes`);
  console.log(`[measure-bundle] Delta:                 ${delta >= 0 ? '+' : ''}${fmt(delta)} bytes`);
  console.log(`[measure-bundle] Budget ceiling:        ${fmt(ceiling)} bytes (baseline + 30 KB)`);
  console.log(`[measure-bundle] Headroom remaining:    ${fmt(ceiling - current)} bytes`);
  console.log('');

  if (current > ceiling) {
    console.error(
      `[measure-bundle] FAIL — current bundle exceeds budget by ${fmt(current - ceiling)} bytes gzipped.`,
    );
    console.error('[measure-bundle] Remediation per research.md R-010:');
    console.error('[measure-bundle]   1. Audit lucide-react imports — named-only, no namespace imports.');
    console.error('[measure-bundle]   2. Dynamic-import canvas-confetti and large Radix primitives.');
    console.error('[measure-bundle]   3. Tree-shake Radix exports per primitive.');
    process.exit(1);
  }

  console.log('[measure-bundle] OK — within budget.');
  process.exit(0);
}

main();
