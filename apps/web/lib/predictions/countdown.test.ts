/**
 * Unit tests for `formatRemainingUntilLock`. Uses `node:test` (built-in)
 * so no extra runner dependency is needed; run with:
 *
 *   pnpm -F web exec node --test --import tsx \
 *     apps/web/lib/predictions/countdown.test.ts
 *
 * (A `test` script will be wired up in a later infra task; until then the
 * value is in `pnpm -F web typecheck` exercising the file.)
 *
 * The five cases below trace the lock transition at the
 * `kickoff - lock_window` boundary documented in Slice 003 § R-005.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { formatRemainingUntilLock } from './countdown';

const KICKOFF = '2026-06-11T20:00:00Z';
const LOCK_WINDOW_MIN = 60;

test('well before lock — 24h out renders hours', () => {
  // Lock boundary = 2026-06-11T19:00:00Z; now is exactly 23h before that.
  const now = new Date('2026-06-10T20:00:00Z');
  assert.match(
    formatRemainingUntilLock(KICKOFF, LOCK_WINDOW_MIN, now),
    /locks in 23h/,
  );
});

test('just before lock — 5 min before lock boundary', () => {
  const now = new Date('2026-06-11T18:55:00Z');
  assert.equal(
    formatRemainingUntilLock(KICKOFF, LOCK_WINDOW_MIN, now),
    'locks in 5 min',
  );
});

test('at lock boundary — boundary is inclusive on locked side', () => {
  // BR-LOCK-003: exactly AT the boundary the match is already locked.
  const now = new Date('2026-06-11T19:00:00Z');
  assert.equal(
    formatRemainingUntilLock(KICKOFF, LOCK_WINDOW_MIN, now),
    'locked',
  );
});

test('just inside lock — 1 sec past boundary', () => {
  const now = new Date('2026-06-11T19:00:01Z');
  assert.equal(
    formatRemainingUntilLock(KICKOFF, LOCK_WINDOW_MIN, now),
    'locked',
  );
});

test('well past lock — after kickoff', () => {
  const now = new Date('2026-06-11T22:00:00Z');
  assert.equal(
    formatRemainingUntilLock(KICKOFF, LOCK_WINDOW_MIN, now),
    'locked',
  );
});
