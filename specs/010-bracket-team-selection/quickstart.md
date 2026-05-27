# Quickstart: World Cup Bracket Team Selection

End-to-end walkthrough to validate the slice locally once implemented. Assumes the local stack is up (`pnpm supabase start`, Keycloak sidecar, `pnpm dev`) and migrations 0084–0089 + `slice-010-fixture.sql` are applied.

## Prerequisites

- Local Supabase + Keycloak running; `supabase db reset --local` applied (loads slice-010 fixture: a seeded R32 field + a few participants' partial picks).
- Sign-in credentials (all `dev-password`): `alpha`, `bravo`, `admin1` (see `infra/keycloak/realm-export.json`).
- `tournament_config.first_kickoff_utc` set to a FUTURE time for the fill/submit flow; set to the PAST to exercise lock + peer viewing.

## Flow 1 — View teams (US1)

1. Sign in as `alpha`, navigate to `/bracket`.
2. Expect: all 16 R32 matchups render with both teams' names + flags; later rounds show pending placeholders. A missing flag shows the fallback with alt text "Flag unavailable for <team>".

## Flow 2 — Build the bracket (US2)

1. Pick a winner in an R32 matchup → it appears as a competitor in the dependent R16 matchup.
2. Fill forward to a champion.
3. Change an early R32 winner that the champion depended on → the champion (and other now-impossible picks) clear; the completion count drops. (SC-006)

## Flow 3 — Completion + submit (US3)

1. With < 31 picks: the submit control is disabled and shows e.g. "19 of 31 picks completed". (FR-010/FR-011)
2. Complete all 31 → submit control enables, status badge shows "Ready to submit".
3. Submit → status becomes "Bracket submitted"; exactly one `bracket.submitted` audit row is written. (FR-012, Principle V)
4. Attempt to submit at 30/31 via direct API → 422 `BRACKET_INCOMPLETE`. (SC-002)

## Flow 4 — Privacy before lock (US4)

1. With `first_kickoff_utc` in the future, as `alpha` GET `/api/bracket-peer/<bravo-id>` → `{ "bracket": null }`.
2. Direct `/rest/v1/bracket_peer_v?participant_id=eq.<bravo-id>` with alpha's JWT → `[]`. (SC-005)
3. Set `first_kickoff_utc` to the past; repeat (1) → bravo's read-only bracket returns (if public viewing enabled).

## Flow 5 — Consistent status (US5)

1. Change one pick; confirm the header count, mobile sticky footer, status badge, submit button label, and review screen all update to the same numbers simultaneously. (SC-004)

## Lock boundary (Principle VI)

1. With `first_kickoff_utc` in the past, attempt any pick → 409 `BRACKET_LOCKED` even with the browser clock pinned to last year. (mirror slice-003 clock-ignored)

## Regression gate (Principle XI)

- Run the full slice-001–009 Playwright + pgTAP suites; all must stay green. The slice-010 objects are additive (migrations 0084–0089, new `(participant)/bracket` routes) and touch no existing schema.
