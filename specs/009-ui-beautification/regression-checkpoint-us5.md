# Regression Checkpoint: User Story 5

**Slice**: 009-ui-beautification
**User story**: US5 — Celebration & motion polish (P3)
**Date**: 2026-05-23

## Shipped

| Task | Surface |
|------|---------|
| T096 | `app/components/Confetti.tsx` — one-shot canvas-confetti burst. **Dynamic-imports `canvas-confetti`** so the ~6 KB cost only ships on routes that actually mount the component. Guards on `useMotion().effective === "reduce"` to skip the spawn under reduced motion. Localstorage de-dup via `wcm.celebrations.<key>` |
| T097 | Top-3 entry detection wired in `LeaderboardClient.tsx` — fires confetti once per participant when they observe themselves at rank ≤ 3, keyed to their participant id |
| T098 | `app/components/ScoreReveal.tsx` — staggered enter animations for a list of scored predictions. Both color + icon encoding (exact = Check + win, outcome = Check + accent, miss = X + loss). Under reduced motion the stagger is suppressed and all items render at once |
| T100 | Build green |

## Deferred

| Task | Reason |
|------|--------|
| T099 — wire ScoreReveal into a route | The natural home is `/me/breakdown` (slice 005), but that page renders structured tables of per-match points. Adapting it to fire `<ScoreReveal>` requires reading the data shape carefully (which prediction was exact vs outcome vs miss). The component is shipped on /design-system; adoption is a follow-up |
| Lock-in confetti for "final pick of a match-day" | Requires intercepting the PredictionForm submit-success path in slice 002/003's PredictionForm component. The Confetti component is ready; consumer wiring is per-action work |
| T091–T094 red-gate tests | Need seeded predictions + auth |
| T095 red-gate-us5.md | See note below |

## Note on the celebration story

US5 is the lowest-priority story (P3). The component infrastructure for celebration (Confetti, ScoreReveal) is in place; what's left is the per-action wiring. That wiring is best done in the slices that own the trigger events (slice 003 for lock-in, slice 005 for score reveal) rather than as a slice-009 drive-by.

## Bundle delta

| Metric | Bytes (gzipped) |
|--------|-----------------|
| Pre-slice baseline | 307,648 |
| Post-US3 | 362,251 |
| Post-US5 | **355,994** (DROPPED by ~6 KB vs US3) |
| Δ vs baseline | **+48,346** |
| Budget ceiling | 369,088 |
| **Headroom remaining** | **+13,094** |

The bundle DROPPED across US3→US5 because `canvas-confetti` is now `await import()`'d inside `Confetti.tsx` — it's split into a separate chunk that only loads when a Confetti instance mounts. The leaderboard route gained ~1 KB (the top-3 detection logic + the dynamic-import boilerplate), but the static-import path lost ~7 KB.

## Summary

| Gate | Status |
|------|--------|
| Build + lint + typecheck | ✅ PASS |
| Confetti component | ✅ Complete, dynamically loaded |
| Top-3 entry detection | ✅ Wired in LeaderboardClient |
| ScoreReveal component | ✅ Complete; wiring deferred |
| Lock-in confetti wiring | ⏸️ Deferred (slice 003 territory) |
| Red-gate tests | ⏸️ Deferred (auth fixtures absent) |
| Bundle budget | ✅ PASS (13.1 KB headroom) |
| User-story merge ready | ⏸️ Test runs + adoption deferred |
