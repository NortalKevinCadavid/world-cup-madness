# Contract: Leaderboard Read

**Feature**: 005-scoring-leaderboard
**Direction**: Server → Client (read)
**Anchor**: spec FR-003, FR-004, FR-011, FR-012, FR-014; architecture FR-013; §7.4

## Capability

Return the global leaderboard, ranked with §7.4 tie-breakers, for an eligible Nortal participant. Every reader sees the same ordering for the same `calculation_version` (FR-012). Visibility is governed by `tournament_config.leaderboard_visibility` (FR-014).

## Access

| Surface | Path / mechanism | Notes |
|---|---|---|
| Web UI | `GET /leaderboard` (Next.js server component) | renders the page; calls the Supabase view server-side using the participant's JWT |
| Supabase REST | `GET /rest/v1/leaderboard_v?select=*&order=rank.asc` | direct read; RLS-gated |
| Realtime hint | `postgres_changes` on `tournament_config.current_calculation_version` | client subscribes to this single row; on change, refetches the view |

Authentication is required (Supabase Auth JWT). The RLS policy on `leaderboard_v` rejects requests from non-Nortal-domain identities (reusing Slice 001's `is_eligible_nortal_participant(auth.uid())`).

## Request

No parameters required. Optional Supabase REST query params (standard PostgREST): `limit`, `offset`, `order`. Default order is `rank.asc, display_name.asc`.

## Response (one row per eligible participant)

| Field | Type | Notes |
|---|---|---|
| `participant_id` | UUID | |
| `display_name` | string | full name OR `'Participant N'` when `leaderboard_visibility='anonymized'` |
| `total_points` | int | |
| `exact_count` | int | tie-breaker tier 2 |
| `outcome_count` | int | tie-breaker tier 3 |
| `final_points` | int | tie-breaker tier 4 |
| `last_valid_prediction_at` | timestamptz \| null | populated only if `tier5_enabled=true` |
| `rank` | int | RANK() — shared rank when tied across all configured tiers |
| `calculation_version` | int | identical across all rows of one response |

## Error responses

| Cause | HTTP | Detail |
|---|---|---|
| Unauthenticated | 401 | Supabase Auth missing JWT |
| Non-Nortal domain | 403 | RLS denies; no rows returned, but the response should be a 403 from the API surface for clarity |
| Database degraded | 503 | last-known-good behavior is NOT applicable here — leaderboard reads must reflect committed state; client falls back to a "leaderboard unavailable" notice. Catalog reads remain available because they are a separate slice. |

## Consistency guarantees

- Per FR-012 / SC-008: a single response represents one `calculation_version` exactly; readers MUST NOT see partial updates. Postgres MVCC provides this: the view's `WHERE calculation_version = current_calculation_version` is evaluated once per query against a stable snapshot of `tournament_config`.
- Per FR-011 / SC-005: after a recalculation completes, the next read returns the new version within ~1 second (Realtime push) or whenever the client polls.

## Test surface

| Test | Lives in | Validates |
|---|---|---|
| Playwright `slice-005-leaderboard.spec.ts` — *Strict-descending* | `apps/web/tests/playwright/` | US3 Acceptance Scenario 1 |
| Playwright — *Tier 2 ordering* | same | US3 Acceptance Scenario 2 |
| Playwright — *Tier 3 ordering* | same | US3 Acceptance Scenario 3 |
| Playwright — *Tier 4 ordering* | same | US3 Acceptance Scenario 4 |
| Playwright — *Shared rank pattern* | same | US3 Acceptance Scenario 5 |
| Playwright — *Concurrent-read consistency* | same | US3 Acceptance Scenario 6 + SC-003 + SC-008 |
| pgTAP `leaderboard_tie_breakers.sql` | `supabase/tests/pgtap/` | tier ordering at the SQL layer |
| pgTAP `leaderboard_shared_rank.sql` | same | `1, 2, 2, 4` pattern |
| pgTAP `leaderboard_calc_version_consistency.sql` | same | no partial-update visibility under in-flight `score_match` |
| pgTAP RLS deny test | `supabase/tests/pgtap/` | non-Nortal JWT returns zero rows |
