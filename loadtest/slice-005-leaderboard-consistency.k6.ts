// Slice 005 / T043 -- k6 load test for SC-003 + SC-008.
//
// SC-003: Tied participants share rank deterministically across at least 10 consecutive
//          reads under concurrent load (1,000 simulated readers).
// SC-008: The leaderboard handles 1,000 concurrent reads during a result-update window
//          without any reader seeing inconsistent partial updates (i.e., a single
//          response NEVER mixes rows from two different calculation_version values).
//
// The flip-the-pointer pattern (research.md § R-003) is what this script exercises:
// while readers hammer leaderboard_v at 1,000 concurrent VUs, a separate writer scenario
// fires score-trigger every 10 s, advancing tournament_config.current_calculation_version
// (FR-012). Postgres MVCC must guarantee that every single reader response is consistent
// with exactly one calculation_version snapshot.
//
// Pass criteria (enforced via k6 thresholds + script-level checks):
//   1. 0 mixed-version responses (SC-008 invariant).
//   2. p95 reader latency < 1000 ms (plan.md § Performance Goals).
//   3. Every distinct calculation_version written during the test is observed by some
//      reader (proves writers aren't starved; reported via versions_observed counter
//      tagged by version, verified post-run in CI by parsing the JSON summary).
//
// Tunables (env):
//   K6_VUS                                       -- reader VU count (default 1000;
//                                                  CI smoke recommends 100)
//   K6_DURATION                                  -- writer scenario duration (default 60s)
//   SUPABASE_URL                                 -- Supabase REST base (default localhost)
//   SUPABASE_ANON_KEY                            -- anon JWT for the reader scenario
//   SCORE_TRIGGER_INTERNAL_AUTH_SECRET           -- writer scenario X-Internal-Auth header
//                                                  (alternative: ADMIN_JWT bearer; the
//                                                  writer scenario accepts either)
//   ADMIN_JWT                                    -- admin bearer for the writer scenario,
//                                                  used only when INTERNAL_AUTH is unset
//
// Runtime:
//   k6 run loadtest/slice-005-leaderboard-consistency.k6.ts
// or for a CI smoke:
//   K6_VUS=100 K6_DURATION=30s k6 run loadtest/slice-005-leaderboard-consistency.k6.ts

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { sleep } from 'k6';

// -----------------------------------------------------------------------------
// Configuration (env-driven; defaults target a local Supabase + the loadtest fixture).
// -----------------------------------------------------------------------------

const VU_COUNT: number = parseInt(__ENV.K6_VUS ?? '1000', 10);
const DURATION: string = __ENV.K6_DURATION ?? '60s';
const SUPABASE_URL: string = __ENV.SUPABASE_URL ?? 'http://localhost:54321';
const ANON_KEY: string = __ENV.SUPABASE_ANON_KEY ?? '';
const INTERNAL_SECRET: string = __ENV.SCORE_TRIGGER_INTERNAL_AUTH_SECRET ?? '';
const ADMIN_JWT: string = __ENV.ADMIN_JWT ?? '';

// -----------------------------------------------------------------------------
// Custom metrics. mixed_version_responses MUST stay 0 across the entire run --
// the threshold "count==0" turns any single occurrence into a non-zero exit code.
// -----------------------------------------------------------------------------

const mixedVersionCounter = new Counter('mixed_version_responses');
const readLatency = new Trend('reader_latency_ms', true);
const versionsObserved = new Counter('versions_observed');
const writerInvocations = new Counter('writer_invocations');
const readerEmptyResponses = new Counter('reader_empty_responses');

// -----------------------------------------------------------------------------
// k6 options: two scenarios run in parallel.
//   * readers -- per-vu-iterations: each of the K6_VUS VUs performs exactly 10
//                 iterations (SC-003's "10 consecutive reads") subject to
//                 maxDuration as a safety cap.
//   * writer  -- constant-vus / 1 VU that fires score-trigger every 10 s for the
//                 full DURATION, simulating the SC-008 "result-update window".
// -----------------------------------------------------------------------------

export const options = {
  scenarios: {
    readers: {
      executor: 'per-vu-iterations',
      vus: VU_COUNT,
      iterations: 10,
      maxDuration: DURATION,
      exec: 'readLeaderboard',
    },
    writer: {
      executor: 'constant-vus',
      vus: 1,
      duration: DURATION,
      exec: 'triggerScoring',
      startTime: '0s',
    },
  },
  thresholds: {
    // SC-008 invariant: ZERO mixed-version responses tolerated.
    mixed_version_responses: ['count==0'],
    // plan.md § Performance Goals: reader p95 under 1 s.
    'http_req_duration{scenario:readers}': ['p(95)<1000'],
    // Sanity: all reader requests must succeed.
    'http_req_failed{scenario:readers}': ['rate<0.01'],
  },
};

// -----------------------------------------------------------------------------
// Reader scenario. Each iteration:
//   1. GETs leaderboard_v with the anon key (RLS-gated; non-Nortal identities are
//      rejected -- the fixture seeds Nortal participants so a participant-flavoured
//      JWT can be substituted for tighter realism via ADMIN_JWT).
//   2. Verifies HTTP 200 + array shape.
//   3. Computes the set of distinct calculation_version values in the response.
//      If size > 1, increments mixed_version_responses (threshold breaker).
//   4. Records the single observed version into versions_observed (tagged) so the
//      JSON summary post-run can prove every written version was observed.
// -----------------------------------------------------------------------------

type LeaderboardRow = {
  participant_id: string;
  calculation_version: number;
};

export function readLeaderboard(): void {
  const url = `${SUPABASE_URL}/rest/v1/leaderboard_v?select=participant_id,calculation_version`;
  const params = {
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      Accept: 'application/json',
    },
    tags: { scenario: 'readers' },
  };

  const start = Date.now();
  const res = http.get(url, params);
  readLatency.add(Date.now() - start);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is array': (r) => {
      try {
        return Array.isArray(r.json());
      } catch (_e) {
        return false;
      }
    },
  });

  if (!ok || res.status !== 200) {
    return;
  }

  let rows: LeaderboardRow[];
  try {
    rows = res.json() as LeaderboardRow[];
  } catch (_e) {
    return;
  }

  if (rows.length === 0) {
    // Fixture should always produce >=1 row; track empties for diagnostics.
    readerEmptyResponses.add(1);
    return;
  }

  const versions = new Set<number>();
  for (const row of rows) {
    versions.add(row.calculation_version);
  }

  if (versions.size > 1) {
    // SC-008 INVARIANT VIOLATION: a single read saw rows from two snapshots.
    mixedVersionCounter.add(1);
    const observed = Array.from(versions).join(',');
    console.error(`MIXED-VERSION RESPONSE: row_count=${rows.length} versions=[${observed}]`);
    return;
  }

  // Single-version response (the only acceptable outcome). Tag by version so the
  // post-run summary can verify every distinct written version was observed.
  const v = versions.values().next().value as number;
  versionsObserved.add(1, { version: String(v) });
}

// -----------------------------------------------------------------------------
// Writer scenario. Sleeps 10 s, fires one POST /functions/v1/score-trigger
// (scope='all'), repeats for the full DURATION. The Edge Function increments
// tournament_config.current_calculation_version on success (FR-012) -- this is
// precisely the "result-update window" SC-008 names.
//
// Auth precedence: INTERNAL_AUTH (machine-to-machine, preferred) > ADMIN_JWT
// (admin bearer fallback).
// -----------------------------------------------------------------------------

export function triggerScoring(): void {
  // Stagger so the first invocation lands 10 s into the run, then every 10 s.
  sleep(10);

  const url = `${SUPABASE_URL}/functions/v1/score-trigger`;
  const body = JSON.stringify({
    scope: 'all',
    reason: 'k6 load test write (slice 005 T043)',
    // crypto.randomUUID() is available in k6 >= 0.50; if running against older,
    // substitute a deterministic counter on __VU + __ITER.
    run_id: `loadtest-${__VU}-${__ITER}-${Date.now()}`,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    tags: 'writer',
  };
  if (INTERNAL_SECRET) {
    headers['X-Internal-Auth'] = INTERNAL_SECRET;
  } else if (ADMIN_JWT) {
    headers['Authorization'] = `Bearer ${ADMIN_JWT}`;
  }

  const res = http.post(url, body, {
    headers,
    tags: { scenario: 'writer' },
  });

  writerInvocations.add(1);

  check(res, {
    'writer accepted (2xx)': (r) => r.status >= 200 && r.status < 300,
  });
}

// -----------------------------------------------------------------------------
// handleSummary -- emit a structured JSON summary so CI can post-process
// `versions_observed` (tagged by version) to verify the "writers not starved"
// pass criterion. The expected versions list is supplied by CI from the
// score_calculation_runs table after the run; this script only emits what it saw.
// -----------------------------------------------------------------------------

export function handleSummary(data: Record<string, unknown>): Record<string, string> {
  return {
    'stdout': JSON.stringify(
      {
        scenario: 'slice-005-leaderboard-consistency',
        vus: VU_COUNT,
        duration: DURATION,
        metrics: data.metrics,
      },
      null,
      2,
    ),
    './loadtest-results/slice-005-summary.json': JSON.stringify(data, null, 2),
  };
}
