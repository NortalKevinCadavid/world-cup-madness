/**
 * Unit tests for slice 002's catalog formatting helpers. Uses Node's
 * built-in `node:test` runner so no dev-dependency churn is required —
 * see `apps/web/package.json` (no vitest installed).
 *
 * Run with:
 *   pnpm -F web exec node --test --import tsx lib/catalog/format.test.ts
 *
 * (Or via the project test script once it lands in package.json.)
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md
 * @see specs/002-match-catalog/research.md (R-009)
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { formatKickoff, formatScore } from './format';
import type { MatchResult } from '../types/match';

const KICKOFF = '2026-06-11T20:00:00Z';

test('formatKickoff en-US renders 12-hour AM/PM marker', () => {
  const out = formatKickoff(KICKOFF, 'en-US');
  // 20:00 UTC → "8:00 PM" in en-US 12-hour clock.
  assert.match(out, /PM|AM/);
});

test('formatKickoff es-ES renders Spanish month abbreviation', () => {
  const out = formatKickoff(KICKOFF, 'es-ES');
  // June → "jun" in es-ES medium date style.
  assert.ok(
    out.toLowerCase().includes('jun'),
    `expected es-ES output to contain "jun" — got: ${out}`,
  );
});

test('formatKickoff ja-JP renders YYYY/MM/DD date', () => {
  const out = formatKickoff(KICKOFF, 'ja-JP');
  assert.ok(
    out.includes('2026/06/11'),
    `expected ja-JP output to contain "2026/06/11" — got: ${out}`,
  );
});

test('formatScore regulation renders "H-A"', () => {
  const r: MatchResult = {
    home_score_official: 2,
    away_score_official: 0,
    home_score_for_scoring: 2,
    away_score_for_scoring: 0,
    result_status: 'regulation',
  };
  assert.equal(formatScore(r), '2-0');
});

test('formatScore extra_time renders "H-A" using official scores', () => {
  // Match ended 3-3 in regulation, away pulled ahead in ET: 4-3 final.
  // For non-shootout statuses `_official` and `_for_scoring` are equal.
  const r: MatchResult = {
    home_score_official: 4,
    away_score_official: 3,
    home_score_for_scoring: 4,
    away_score_for_scoring: 3,
    result_status: 'extra_time',
  };
  assert.equal(formatScore(r), '4-3');
});

test('formatScore penalties_shootout annotates the level score', () => {
  // 3-3 level after ET, home wins shootout — official 4-3.
  const r: MatchResult = {
    home_score_official: 4,
    away_score_official: 3,
    home_score_for_scoring: 3,
    away_score_for_scoring: 3,
    result_status: 'penalties_shootout',
  };
  assert.equal(formatScore(r), '4-3 (3-3 on penalties)');
});

test('formatScore penalties_shootout handles asymmetric level scores', () => {
  // Defensive: level scores need not be equal in synthetic fixtures.
  const r: MatchResult = {
    home_score_official: 5,
    away_score_official: 4,
    home_score_for_scoring: 2,
    away_score_for_scoring: 2,
    result_status: 'penalties_shootout',
  };
  assert.equal(formatScore(r), '5-4 (2-2 on penalties)');
});
