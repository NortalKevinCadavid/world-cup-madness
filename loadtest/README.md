# Load tests

Tool: [k6](https://k6.io/) (TypeScript-flavored scripts; k6 transpiles TS via its built-in Babel pipeline).

## Prerequisites

- `k6` CLI installed (`brew install k6` / `winget install k6` / `choco install k6`).
- A reachable Supabase instance with the slice-005 migrations applied (slots 0049-0057) and a beefier load-test fixture loaded (see below).

## Slice 005 — leaderboard consistency (SC-003 + SC-008)

Script: [`slice-005-leaderboard-consistency.k6.ts`](./slice-005-leaderboard-consistency.k6.ts)

Two scenarios run in parallel:

| Scenario | Executor | Description |
|---|---|---|
| `readers` | `per-vu-iterations` | `K6_VUS` VUs each perform 10 consecutive GETs against `leaderboard_v` (the "10 consecutive reads" SC-003 names). |
| `writer`  | `constant-vus` (1 VU) | Fires `POST /functions/v1/score-trigger {scope:'all'}` every 10 s for `K6_DURATION` (the "result-update window" SC-008 names). |

### Pass criteria

1. **`mixed_version_responses` count == 0** — SC-008 invariant. A single response that mixes rows from two different `calculation_version` values fails the run.
2. **Reader `http_req_duration` p95 < 1000 ms** — plan.md § Performance Goals.
3. **Every distinct `calculation_version` written during the test is observed by at least one reader.** Verified post-run by joining `versions_observed{version=X}` (from the k6 JSON summary at `loadtest-results/slice-005-summary.json`) against `score_calculation_runs.calculation_version` rows produced during the same wall-clock window. CI typically performs this check with a small SQL+jq script after `k6 run`.

### Fixture

Load `supabase/seed/slice-005-loadtest-fixture.sql` against your target Supabase **in addition to** `slice-005-fixture.sql`. The load-test fixture seeds:

- 500 synthetic Nortal-domain participants (`loadtest0001…loadtest0500`).
- 4 final-prediction rows per participant (champion + runner_up + top_scorer + best_player) = 2,000 `final_predictions` rows.
- Reuses the matches + match_results from the base slice-005 fixture (3 finished + 1 scheduled).
- Reuses the existing team + player UUIDs (slice 002 + slice 004) — no new teams/players inserted.

The fixture deliberately does **not** seed match predictions (would be ~52,000 rows) because the load test focuses on read consistency, which `final_predictions` + the `score_records` written at runtime suffice for.

After loading the fixture, trigger one initial scoring pass so `leaderboard_v` has rows to serve:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/score-trigger" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Auth: $SCORE_TRIGGER_INTERNAL_AUTH_SECRET" \
  -d '{"scope":"all","reason":"loadtest warmup","run_id":"warmup-1"}'
```

### Run against local Supabase

```bash
K6_VUS=1000 \
K6_DURATION=60s \
SUPABASE_URL=http://localhost:54321 \
SUPABASE_ANON_KEY="$LOCAL_ANON_KEY" \
SCORE_TRIGGER_INTERNAL_AUTH_SECRET="$LOCAL_INTERNAL_AUTH" \
k6 run loadtest/slice-005-leaderboard-consistency.k6.ts
```

### Run against staging

```bash
K6_VUS=1000 \
K6_DURATION=60s \
SUPABASE_URL=https://<staging-project>.supabase.co \
SUPABASE_ANON_KEY="$STAGING_ANON_KEY" \
ADMIN_JWT="$STAGING_ADMIN_JWT" \
k6 run loadtest/slice-005-leaderboard-consistency.k6.ts
```

> Use `ADMIN_JWT` against staging if the score-trigger Edge Function is configured to accept admin bearer tokens; otherwise use `SCORE_TRIGGER_INTERNAL_AUTH_SECRET` (machine-to-machine path, preferred).

### CI smoke (fast feedback)

A reduced VU count + shortened duration is sufficient to catch consistency regressions on every PR:

```bash
K6_VUS=100 K6_DURATION=30s k6 run loadtest/slice-005-leaderboard-consistency.k6.ts
```

The full 1,000-VU run is reserved for nightly / pre-release pipelines.

### Required environment variables

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `K6_VUS` | no | `1000` | Reader VU count (CI smoke uses `100`). |
| `K6_DURATION` | no | `60s` | Writer scenario duration. |
| `SUPABASE_URL` | yes | `http://localhost:54321` | Supabase base URL. |
| `SUPABASE_ANON_KEY` | yes | _(empty)_ | Anon JWT for reader scenario. |
| `SCORE_TRIGGER_INTERNAL_AUTH_SECRET` | one of these | _(empty)_ | Machine-to-machine auth for writer scenario (preferred). |
| `ADMIN_JWT` | one of these | _(empty)_ | Admin bearer for writer scenario (fallback). |

### Output

k6 emits a structured summary to `./loadtest-results/slice-005-summary.json` (the directory is auto-created by k6 on write). Inspect `metrics.versions_observed.values` to confirm every written calculation_version was observed.
