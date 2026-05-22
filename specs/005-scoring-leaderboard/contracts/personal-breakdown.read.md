# Contract: Personal Breakdown Read

**Feature**: 005-scoring-leaderboard
**Direction**: Server → Client (read)
**Anchor**: spec FR-006; architecture FR-014; §7.2, §7.3

## Capability

Return the requesting participant's own decomposition of points by match and by final-prediction item. Self-only; this contract does NOT expose any other participant's breakdown (peer breakdowns flow through `peer-pick.read.md`).

## Access

| Surface | Path / mechanism | Notes |
|---|---|---|
| Web UI | `GET /me/breakdown` (Next.js server component) | renders the breakdown page |
| Supabase REST | `GET /rest/v1/personal_breakdown_v?select=*&order=target_kind.asc,target_label.asc` | RLS limits results to `participant_id = auth.uid()` |

Authentication required. RLS filters automatically: a participant only ever sees their own rows.

## Request

No parameters required. Optional sorts/filters on `target_kind` and `calculation_version` are supported via PostgREST.

## Response (one row per scored target)

The view returns one row per finished match the participant could have predicted, plus one row per final-prediction item that has been scored (i.e. its `tournament_award.*_status='confirmed'`). Items with `pending` status return `reason_code='final_pending'` and `official_display=null` so the UI can show "scoring pending" rather than implying 0.

| Field | Type | Notes |
|---|---|---|
| `participant_id` | UUID | always equals `auth.uid()` (RLS) |
| `target_kind` | enum | `match` \| `final` |
| `target_id` | UUID | matches(id) or final-item id |
| `target_label` | string | `'<Home> vs <Away> · <Stage>'` or `'Champion'`/`'Runner-up'`/`'Top Scorer'`/`'Best Player'` |
| `predicted_display` | string | `'<H>-<A>'` for matches; team or player name for finals; empty string `''` if no valid prediction was submitted |
| `official_display` | string \| null | `'<H>-<A>'` for matches; team or player name for finals; `null` if `final_pending` |
| `points` | int | |
| `reason_code` | enum | `exact` \| `outcome` \| `incorrect` \| `none` \| `final_correct` \| `final_incorrect` \| `final_pending` |
| `calculation_version` | int | |

## Consistency with the leaderboard

For any given `calculation_version`, the sum of a participant's `points` across all rows in `personal_breakdown_v` MUST equal their `total_points` in `leaderboard_v` (Acceptance Scenario US4.3 + SC-002). This is enforced structurally because both views aggregate the same underlying `score_records`.

## Error responses

| Cause | HTTP | Detail |
|---|---|---|
| Unauthenticated | 401 | |
| Non-Nortal domain | 403 | RLS denies |

## Test surface

| Test | Lives in | Validates |
|---|---|---|
| Playwright `slice-005-breakdown.spec.ts` — *Row-per-match* | `apps/web/tests/playwright/` | US4 Acceptance Scenario 1 |
| Playwright — *Row-per-final-item* | same | US4 Acceptance Scenario 2 |
| Playwright — *Sum equals leaderboard* | same | US4 Acceptance Scenario 3 + SC-002 |
| Playwright — *`final_pending` displays correctly* | same | best-player delay edge case |
| pgTAP — *self-only RLS* | `supabase/tests/pgtap/` | attempting to read another participant's breakdown returns zero rows |
| pgTAP — *no-prediction match shows 0/none* | same | US1 Acceptance Scenario 4 |
