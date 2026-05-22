/**
 * Unit tests for `getPersonalBreakdown`. Uses `node:test` (built-in) to match
 * the convention established by `apps/web/lib/scoring/leaderboard.test.ts`
 * (Slice 005 / T030) — no extra runner dependency. Run with:
 *
 *   pnpm -F web exec node --test --import tsx \
 *     apps/web/lib/scoring/breakdown.test.ts
 *
 * (A workspace-level `test` script will be wired up in a later infra task;
 * until then `pnpm -F web exec tsc --noEmit` exercises this file for typing.)
 *
 * The four cases below cover:
 *   1. Happy path — rows returned, envelope `calculation_version` is taken
 *      from the first row, `total_points` is SUM(points) across all rows.
 *   2. Empty-table case — `calculation_version` falls back to 0,
 *      `total_points` falls back to 0.
 *   3. Supabase error surface — wrapper throws with the underlying message.
 *   4. Ordering wiring — `from().select().order().order()` is invoked with
 *      `target_kind asc` then `target_label asc` (matches the contract
 *      § Access default order and the T035 view definition).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { getPersonalBreakdown, type BreakdownRow } from './breakdown';

interface CapturedOrder {
  col: string;
  opts: { ascending: boolean };
}

interface MockClient {
  from: (table: string) => unknown;
  _captured: () => {
    lastSelectArg: string | undefined;
    orderArgs: CapturedOrder[];
  };
}

/**
 * Minimal Supabase-shaped mock that records the `select` projection and the
 * `order` call sequence, then resolves to the `data` / `error` pair the test
 * configures. PostgREST builder is thenable, so we expose `then` directly on
 * the leaf object to await the chain. Mirrors the T030 mock byte-for-byte.
 */
function mockClient(
  rows: BreakdownRow[],
  error?: { message: string },
): MockClient {
  let lastSelectArg: string | undefined;
  const orderArgs: CapturedOrder[] = [];
  return {
    from: (table: string) => {
      assert.equal(
        table,
        'personal_breakdown_v',
        'wrapper must read from personal_breakdown_v (T035 view)',
      );
      return {
        select: (cols: string) => {
          lastSelectArg = cols;
          return {
            order(col: string, opts: { ascending: boolean }) {
              orderArgs.push({ col, opts });
              return this;
            },
            then(
              resolve: (value: {
                data: BreakdownRow[] | null;
                error: { message: string } | null;
              }) => unknown,
            ) {
              return resolve({ data: rows, error: error ?? null });
            },
          };
        },
      };
    },
    _captured: () => ({ lastSelectArg, orderArgs }),
  };
}

test('getPersonalBreakdown returns parsed rows + calculation_version from first row + total_points sum', async () => {
  const rows: BreakdownRow[] = [
    {
      participant_id: 'p1',
      target_kind: 'match',
      target_id: 'm1',
      final_item_kind: null,
      target_label: 'ARG vs MEX · Group A',
      predicted_display: '2-1',
      official_display: '2-1',
      points: 10,
      reason_code: 'exact',
      calculation_version: 7,
    },
    {
      participant_id: 'p1',
      target_kind: 'match',
      target_id: 'm2',
      final_item_kind: null,
      target_label: 'ESP vs BRA · Group B',
      predicted_display: '0-0',
      official_display: '0-0',
      points: 10,
      reason_code: 'exact',
      calculation_version: 7,
    },
    {
      participant_id: 'p1',
      target_kind: 'final',
      target_id: 'f1',
      final_item_kind: 'champion',
      target_label: 'Champion',
      predicted_display: 'ARG',
      official_display: 'ARG',
      points: 20,
      reason_code: 'final_correct',
      calculation_version: 7,
    },
    {
      participant_id: 'p1',
      target_kind: 'final',
      target_id: 'f2',
      final_item_kind: 'best_player',
      target_label: 'Best Player',
      predicted_display: 'Pedri',
      official_display: null,
      points: 0,
      reason_code: 'final_pending',
      calculation_version: 7,
    },
  ];
  const client = mockClient(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getPersonalBreakdown(client as any);
  assert.equal(result.breakdown.length, 4);
  assert.equal(result.calculation_version, 7);
  assert.equal(
    result.total_points,
    40,
    'total_points MUST equal SUM(points) across all rows (10+10+20+0)',
  );
  assert.equal(result.breakdown[0].reason_code, 'exact');
  assert.equal(result.breakdown[3].official_display, null);
});

test('getPersonalBreakdown returns empty + calculation_version=0 + total_points=0 when no rows', async () => {
  const client = mockClient([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getPersonalBreakdown(client as any);
  assert.equal(result.breakdown.length, 0);
  assert.equal(result.calculation_version, 0);
  assert.equal(result.total_points, 0);
});

test('getPersonalBreakdown throws on Supabase error', async () => {
  const client = mockClient([], { message: 'permission denied' });
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => getPersonalBreakdown(client as any),
    /permission denied/,
  );
});

test('getPersonalBreakdown orders by target_kind then target_label', async () => {
  const client = mockClient([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getPersonalBreakdown(client as any);
  const captured = client._captured();
  assert.equal(captured.orderArgs.length, 2);
  assert.deepEqual(captured.orderArgs[0], {
    col: 'target_kind',
    opts: { ascending: true },
  });
  assert.deepEqual(captured.orderArgs[1], {
    col: 'target_label',
    opts: { ascending: true },
  });
});
