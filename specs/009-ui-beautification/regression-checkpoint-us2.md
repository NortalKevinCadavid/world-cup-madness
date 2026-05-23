# Regression Checkpoint: User Story 2

**Slice**: 009-ui-beautification
**User story**: US2 — Participant core flows redesigned (P1, MVP-2)
**Date**: 2026-05-23
**Commit at checkpoint**: _to be filled when this commit lands_

## Scope shipped vs deferred

US2 in `tasks.md` lists 24 tasks. This checkpoint reflects a **partial implementation** of the highest-impact surfaces; some sub-tasks are deferred for the user to choose follow-up scope.

### Shipped

| Task | Surface |
|------|---------|
| T054 | `app/components/MatchCard.tsx` — presentation-only, consumes existing Match + Prediction shapes from slices 002/003 unchanged |
| T056 | `/dashboard` redesigned with festive Card grid, Trophy + gold badge, motion-aware hover lifts, status badges |
| T061 | `/auth/denied` restyled with the new design system (`Card`, `Button`, semantic tokens) — reason-code mapping preserved bit-for-bit per slice 001 contract |
| T061 (cont'd) | `/` (landing) restyled with Trophy hero card + festive radial backdrop + `Badge variant="gold"` |
| T061 (cont'd) | `SignInButton.tsx` uses the new `Button` primitive with `LogIn` icon |
| T041 | `tests/.../us2/dashboard-mobile.spec.ts` — viewport + touch-target sweep |
| T042 | `tests/.../us2/match-card.spec.ts` — placeholder against design-system demo |
| (extra) | `tests/.../us2/landing.spec.ts` — landing + auth/denied happy paths |

### Deferred (to user — pick scope in follow-up)

| Task | Reason |
|------|--------|
| T055 Confetti.tsx | Better authored alongside US5's celebration polish where the trigger semantics live |
| T057 Matches list redesign | Slice 002's `/matches` is intricate (PredictionForm, MatchListFilters, PaginationControls). A safe restyle requires careful coordination with slice 002 — too risky for an autonomous push |
| T058 Bracket page | Would require a new "all 48 teams" data fetch that no existing API provides; either new API work or scope reduction needed |
| T059 `/me` redesign | Two sub-pages (`me/breakdown`, `me/finals`) each with their own data shape — restyle deferred to follow-up |
| T060 participant layout | Already inherits the new TopNav transitively; no further edits required |
| T043–T053 remaining red-gate tests | Most require Supabase + seeded data; minimum auth fixtures need authoring first |
| T062 green-gate run | Deferred per user's earlier choice to author-only |

## Build

| Check | Result |
|-------|--------|
| `next build` | ✅ Compiled successfully |
| `next lint` | ✅ No errors |
| TypeScript type check | ✅ |

## Bundle delta (T063 result)

| Metric | Bytes (gzipped) |
|--------|-----------------|
| Pre-slice baseline | 307,648 |
| Post-US1 measurement | 343,299 (+35,651) |
| Post-US2 measurement | **349,524** |
| Δ vs baseline | **+41,876** |
| Budget ceiling (baseline + 30 KB) | 338,368 |
| **Headroom remaining** | **−11,156** |

### Per-route First Load JS comparison

| Route | Pre-slice | Post-US1 | Post-US2 | Δ baseline → US2 |
|-------|-----------|----------|----------|------------------|
| `/` (landing) | _new_ in slice 009 (was a tiny route pre-slice; restyled) | — | (built into shared chunks now) | new festive card cost |
| `/auth/denied` | 87.5 kB | 87.5 kB | **96.2 kB** | +8.7 kB |
| `/dashboard` | 96.2 kB | 96.2 kB | **105 kB** | +8.8 kB |
| `/design-system` | n/a | 154 kB | 154 kB | — (no change since US1) |
| `/leaderboard` | 151 kB | 151 kB | 151 kB | 0 |
| `/matches` | 90.1 kB | 90.1 kB | 90.1 kB | 0 (untouched) |
| `/me/breakdown` | 87.5 kB | 87.5 kB | 87.5 kB | 0 (untouched) |
| `/me/finals` | 106 kB | 107 kB | 108 kB | +2 kB |

The +9 kB per-route increase on dashboard + auth/denied reflects the Card / Badge / Button / icon set used by the new pages, plus the new TopNav code pulled in by `/dashboard` (which sits under the participant layout). `/matches` and `/me/breakdown` are still at baseline because US2 did NOT redesign them this session (deferred).

### Path A vs Path B revisited (decision still pending from US1)

US1's checkpoint surfaced two paths to resolve the overage:
- **Path A**: dynamic-import design-system demo sections (one-shot remediation).
- **Path B**: revise budget to ~+50 KB and document the real cost.

US2's +11 KB overage makes Path A less effective — the participant routes themselves now contribute. The realistic options are:

- **Path A+**: dynamic-import the participant-layout's TopNav / MobileNavSheet / UserMenu so the Sheet/Popover/DropdownMenu code only loads when the user opens those affordances. Expected savings: ~5–8 kB shared across all participant routes. Adds first-interaction latency to those affordances.
- **Path B+**: revise budget to **+60 KB**. The participant routes are net larger but well within reasonable bounds (105 kB First Load is still acceptable for a mobile-first SPA). Document in `research.md` R-010 + ADR-009 that the planning estimate was low by ~2x.
- **Path C** (new): defer the remaining US2/US3/US4/US5 surfaces until A+/B+ is decided.

## Red-gate test status

| Task | Status |
|------|--------|
| T011–T020 (US1) | Authored, not run |
| T041–T053 (US2) | Authored: 3 (dashboard-mobile, match-card, landing). Deferred: 10 (auth-dependent or need fixtures) |

The slice's overall test-authoring posture remains "authored-only" per user's earlier directive. Running them requires:
- A local Supabase env (slice 001 quickstart).
- Auth fixtures for participant-only tests (not authored in this slice).

## Regression suite (slices 001–008)

Not yet run. Same caveats as the US1 checkpoint.

## Summary

| Gate | Status |
|------|--------|
| Build + lint + typecheck | ✅ PASS |
| US2 implementation (shipped scope) | ✅ Complete |
| US2 implementation (deferred scope) | ⏸️ T055, T057, T058, T059 |
| Red-gate tests authored (US2) | ⚠️ Partial — 3 of 13 spec files |
| Red-gate tests run | ⏸️ Deferred to user (env required) |
| Bundle budget (T063) | ❌ **OVER by 11.2 KB** — Path A+/B+/C decision needed |
| Regression suite | ⏸️ Deferred to user |
| User-story merge ready | ⏸️ **NO** — pending budget decision and remaining surface scope |

US2 has delivered the highest-impact visible redesigns (landing, dashboard, denied page, MatchCard primitive). The matches list, bracket, and `/me` pages are untouched. The session is paused for user budget + scope decisions before pressing further.
