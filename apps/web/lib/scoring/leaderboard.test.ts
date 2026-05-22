/**
 * Unit tests for `getLeaderboard`. Uses `node:test` (built-in) to match the
 * convention established by `apps/web/lib/final-predictions/countdown.test.ts`
 * (Slice 004) — no extra runner dependency. Run with:
 *
 *   pnpm -F web exec node --test --import tsx \
 *     apps/web/lib/scoring/leaderboard.test.ts
 *
 * (A workspace-level `test` script will be wired up in a later infra task;
 * until then `pnpm -F web exec tsc --noEmit` exercises this file for typing.)
 *
 * The four cases below cover:
 *   1. Happy path — rows returned, envelope `calculation_version` is taken
 *      from the first row.
 *   2. Empty-table case — `calculation_version` falls back to 0.
 *   3. Supabase error surface — wrapper throws with the underlying message.
 *   4. Ordering wiring — `from().select().order().order()` is invoked with
 *      `rank asc` then `display_name asc` (matches the view's default order
 *      and the contract).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { getLeaderboard, type LeaderboardRow } from './leaderboard';

interface CapturedOrder {
  col: string;
  opts: { ascending: boolean };
}

interface MockClient {
  from: (table: string) => unknown;
  _captured: () => { lastSelectArg: string | undefined; orderArgs: CapturedOrder[] };
}

/**
 * Minimal Supabase-shaped mock that records the `select` projection and the
 * `order` call sequence, then resolves to the `data` / `error` pair the test
 * configures. PostgREST builder is thenable, so we expose `then` directly on
 * the leaf object to await the chain.
 */
function mockClient(
  rows: LeaderboardRow[],
  error?: { message: string },
): MockClient {
  let lastSelectArg: string | undefined;
  const orderArgs: CapturedOrder[] = [];
  return {
    from: (table: string) => {
      assert.equal(
        table,
        'leaderboard_v',
        'wrapper must read from leaderboard_v (T029 view)',
      );
      return {
        select: (cols: string) => {
          lastSelectArg = cols;
          return {
            order(col: string, opts: { ascending: boolean }) {
              orderArgs.push({ col, opts });
              return this;
            },
            then(resolve: (value: { data: LeaderboardRow[] | null; error: { message: string } | null }) => unknown) {
              return resolve({ data: rows, error: error ?? null });
            },
          };
        },
      };
    },
    _captured: () => ({ lastSelectArg, orderArgs }),
  };
}

test('getLeaderboard returns parsed rows + calculation_version from first row', async () => {
  const rows: LeaderboardRow[] = [
    {
      participant_id: 'p1',
      display_name: 'Alpha',
      total_points: 90,
      exact_count: 3,
      outcome_count: 0,
      final_points: 60,
      last_valid_prediction_at: null,
      rank: 1,
      calculation_version: 5,
    },
    {
      participant_id: 'p2',
      display_name: 'Bravo',
      total_points: 40,
      exact_count: 0,
      outcome_count: 2,
      final_points: 20,
      last_valid_prediction_at: null,
      rank: 2,
      calculation_version: 5,
    },
  ];
  const client = mockClient(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getLeaderboard(client as any);
  assert.equal(result.leaderboard.length, 2);
  assert.equal(result.calculation_version, 5);
  assert.equal(result.leaderboard[0].display_name, 'Alpha');
});

test('getLeaderboard returns empty + calculation_version=0 when no rows', async () => {
  const client = mockClient([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await getLeaderboard(client as any);
  assert.equal(result.leaderboard.length, 0);
  assert.equal(result.calculation_version, 0);
});

test('getLeaderboard throws on Supabase error', async () => {
  const client = mockClient([], { message: 'permission denied' });
  await assert.rejects(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => getLeaderboard(client as any),
    /permission denied/,
  );
});

test('getLeaderboard orders by rank then display_name', async () => {
  const client = mockClient([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await getLeaderboard(client as any);
  const captured = client._captured();
  assert.equal(captured.orderArgs.length, 2);
  assert.deepEqual(captured.orderArgs[0], {
    col: 'rank',
    opts: { ascending: true },
  });
  assert.deepEqual(captured.orderArgs[1], {
    col: 'display_name',
    opts: { ascending: true },
  });
});
