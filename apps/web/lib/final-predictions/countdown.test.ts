/**
 * Unit tests for `formatRemainingUntilFirstKickoff`. Uses `node:test`
 * (built-in) so no extra runner dependency is needed; run with:
 *
 *   pnpm -F web exec node --test --import tsx \
 *     apps/web/lib/final-predictions/countdown.test.ts
 *
 * (A `test` script will be wired up in a later infra task; until then the
 * value is in `pnpm -F web typecheck` exercising the file.)
 *
 * The four cases below cover:
 *   1. The unscheduled state (`first_kickoff_utc` not yet set).
 *   2. The minutes-precision branch (< 1 hour remaining).
 *   3. The lock boundary (BR-LOCK-005 — inclusive on locked side).
 *   4. The days+hours branch (>= 1 day remaining).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { formatRemainingUntilFirstKickoff } from './countdown';

test('unscheduled — first_kickoff_utc is null', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(formatRemainingUntilFirstKickoff(null, now), 'unscheduled');
});

test('30 minutes future — renders "locks in 30 min"', () => {
  const kickoff = '2026-07-15T16:00:00Z';
  const now = new Date('2026-07-15T15:30:00Z');
  assert.equal(
    formatRemainingUntilFirstKickoff(kickoff, now),
    'locks in 30 min',
  );
});

test('exactly now — boundary is inclusive on locked side (BR-LOCK-005)', () => {
  const kickoff = '2026-07-15T16:00:00Z';
  const now = new Date('2026-07-15T16:00:00Z');
  assert.equal(formatRemainingUntilFirstKickoff(kickoff, now), 'locked');
});

test('25h future — renders days+hours', () => {
  const kickoff = '2026-07-15T16:00:00Z';
  const now = new Date('2026-07-14T15:00:00Z');
  assert.equal(
    formatRemainingUntilFirstKickoff(kickoff, now),
    'locks in 1d 1h',
  );
});
