# Regression Checkpoint: User Story 3

**Slice**: 009-ui-beautification
**User story**: US3 — Leaderboard with movement and ties (P2)
**Date**: 2026-05-23

## Shipped

| Task | Surface |
|------|---------|
| T070 | `app/components/RankDelta.tsx` — built per contract; documented on /design-system |
| T071 | `app/(participant)/leaderboard/LeaderboardClient.tsx` — client island with tie detection, my-row highlight, jump-to-me, tie-breaker disclosure |
| T072 | `app/(participant)/leaderboard/page.tsx` redesigned festive header, empty state, passes current participant id to client |
| T073 | `TieBreakerChain` (inline in LeaderboardClient) — Popover renders the §7.4 chain per `docs/architecture/scoring-model.md` |
| T074 | Build green; bundle within revised +60 KB ceiling (delta +54.6 KB, 6.8 KB headroom) |

## Deferred

| Task | Reason |
|------|--------|
| **Movement indicator wiring** (RankDelta on rows) | `leaderboard_v` does NOT expose `previous_rank`. Component is built and documented on `/design-system`; wiring requires a slice 005 (or follow-up) read-contract extension. Documented inline in `app/components/RankDelta.tsx`. |
| T065–T069 red-gate tests | Auth + seeded scoring runs required. Deferred per user's earlier choice to author-only and the practical limit that auth fixtures aren't authored in this slice. |

## Slice-005 read-contract preservation

The new client preserves every test-load-bearing contract from slice 005:
- `data-testid="leaderboard-row"` ✅
- `data-rank` ✅
- `data-participant-id` ✅
- `data-field="..."` cell attributes ✅ (rank, display_name, total_points, exact_count, outcome_count, final_points)
- `data-testid="leaderboard-page"` ✅
- `data-testid="leaderboard-empty"` ✅
- `data-testid="calculation-version-indicator"` ✅

The Playwright suite from slice 005 (`apps/web/tests/playwright/slice-005-leaderboard.spec.ts` per the original code's comment) should pass unchanged on this branch — pending the user running it to verify.

## Bundle delta

| Metric | Bytes (gzipped) |
|--------|-----------------|
| Pre-slice baseline | 307,648 |
| Post-US3 | **362,251** |
| Δ vs baseline | **+54,603** |
| Budget ceiling (baseline + 60 KB revised) | 369,088 |
| **Headroom remaining** | **+6,837** |

`/leaderboard` First Load JS went from 151 kB → 184 kB (+33 kB) because the route now pulls Popover + Button + Badge for the tie-breaker UI. Headroom is tight; **US4/US5 must avoid adding new heavy primitives** unless they're loaded only on-demand. Per research.md R-010 the remediation paths (dynamic-import, tree-shake) remain available if US4/US5 push us over.

## Summary

| Gate | Status |
|------|--------|
| Build + lint + typecheck | ✅ PASS |
| US3 implementation (shipped scope) | ✅ Complete |
| US3 implementation (movement indicator) | ⏸️ Blocked on slice 005 data shape |
| Red-gate tests authored | ⏸️ Deferred (auth fixtures absent) |
| Red-gate tests run | ⏸️ Deferred to user |
| Bundle budget | ✅ PASS (6.8 KB headroom) |
| Regression suite (slices 001–008) | ⏸️ Deferred to user |
| User-story merge ready | ⏸️ Test runs deferred |
