# Regression Checkpoint: User Story 1

**Slice**: 009-ui-beautification
**User story**: US1 — Design system foundation & dark mode (P1, 🎯 MVP-1)
**Date**: 2026-05-23
**Commit at checkpoint**: _to be filled when this commit lands_

## Build

| Check | Result |
|-------|--------|
| `pnpm build` | ✅ Compiled successfully |
| `next lint` | ✅ No errors |
| TypeScript type check | ✅ (via `next build`) |

## Bundle delta (T039 result)

| Metric | Bytes (gzipped) |
|--------|-----------------|
| Pre-slice baseline (from `regression-baseline.md`) | 307,648 |
| Post-US1 measurement | **343,299** |
| Delta | **+35,651** |
| Budget ceiling (baseline + 30 KB) | 338,368 |
| **Headroom remaining** | **−4,931** |

**Status**: ⚠️ **Over budget by 4,931 bytes gzipped** (~4.8 KB).

### Where the growth came from

Three new chunks appear post-US1 that did not exist in the baseline:
- `234-b68d7a9b27446162.js` — 27,966 gz (Radix-heavy: Dialog, DropdownMenu, Popover, Tooltip, Tabs, Toast, Switch, Sheet)
- `429-7bd09898f4933120.js` — 12,031 gz
- `817-cb82778b8f08bf05.js` — 7,462 gz

These primarily back the `/design-system` route and the redesigned TopNav (which uses Sheet, Popover, DropdownMenu, Tooltip via MobileNavSheet/UserMenu/ThemeToggle). The participant route chunks (`/dashboard`, `/matches`, etc.) report unchanged First Load JS sizes (96.2 kB, 90.1 kB), so the regression is concentrated where the new primitives live.

Per-route First Load JS comparison:

| Route | Pre-slice First Load | Post-US1 First Load | Δ |
|-------|----------------------|---------------------|---|
| `/auth/denied` | 87.5 kB | 87.5 kB | 0 |
| `/dashboard` | 96.2 kB | 96.2 kB | 0 |
| `/leaderboard` | 151 kB | 151 kB | 0 |
| `/matches` | 90.1 kB | 90.1 kB | 0 |
| `/me/breakdown` | 87.5 kB | 87.5 kB | 0 |
| `/me/finals` | 106 kB | 107 kB | +1 kB |
| `/design-system` (new) | n/a | 154 kB | +154 kB (new route) |

The +35 KB total-chunk gzipped growth is therefore primarily attributable to the **new `/design-system` route**, not to user-facing route shared chunks. The end-user impact on participant flows is essentially zero.

### Decision

The +30 KB budget defined in research.md R-010 was a *planning estimate* assembled before measurement. The real cost of the chosen primitive set (Radix Dialog + DropdownMenu + Popover + Tooltip + Tabs + Toast + Switch + Sheet + Separator + Label) plus `next-themes` + the dozen `lucide-react` icons used by US1 is **~36 KB gzipped**. Two paths forward:

**Path A — Remediate before US2 lands.** Dynamic-import the heaviest demo sections from `/design-system` (Dialog, Toast, Tabs, DropdownMenu, Popover) so they fetch only when scrolled near. Expected savings: ~10–15 KB on the design-system route's initial chunks. Effort: ~1 task. **Recommended if the team holds the strict +30 KB line.**

**Path B — Revise the budget to +50 KB and document why.** The participant routes do not regress on First Load JS (verified above); the overage is concentrated on a documentation-only route that is not in the critical UX path. Effort: amend `research.md` R-010 + ADR-009. **Recommended if the team prioritizes velocity over the strict ceiling, given the zero-impact on user routes.**

This checkpoint **does NOT block US1's other deliverables**, but the user-story merge gate per Constitution Principle XI requires choosing a path. Surfacing to the user.

## Red-gate test status

**Authored, not yet run** (per user's explicit choice — see `red-gate-us1.md`). The full US1 red-gate suite (T011–T019, 9 spec files) is committed and will be runnable as soon as the user runs:

```sh
cd apps/web
pnpm exec playwright test \
  tests/e2e/009-ui-beautification/us1 \
  tests/e2e/009-ui-beautification/a11y/design-system.spec.ts \
  tests/e2e/009-ui-beautification/contrast \
  tests/e2e/009-ui-beautification/viewport/375.spec.ts \
  tests/e2e/009-ui-beautification/keyboard/design-system.spec.ts \
  --project=chromium \
  --reporter=list
```

Until the user runs this, US1 cannot be declared green per Constitution Principle IX. The implementation **should** turn the suite green (every spec was authored against the implementation's contract) but this needs verification.

## Regression suite (slices 001–008)

**Not yet run** (same reason — requires Supabase env and was deferred per user's earlier choice on test execution). When the user runs:

```sh
cd apps/web
pnpm run e2e
```

…the existing slice 001–008 Playwright + pgTAP suites should pass unchanged on this branch. The slice introduced **no API changes, no schema changes, and no SQL function changes**, so functional regressions are not expected. UI behavior changes (TopNav redesign, layout changes) MAY trip selector-based existing tests if those tests select elements by class names that changed; if so, those test selectors need updating to be role/text-based — that is a regression-relevant fix.

## Summary

| Gate | Status |
|------|--------|
| Build + lint + typecheck | ✅ PASS |
| Red-gate tests authored | ✅ PASS (T011–T020 done) |
| Red-gate tests run | ⏸️ Deferred to user (Supabase env) |
| Bundle budget (T039) | ⚠️ **OVER by 4.9 KB** — needs decision (Path A or B) |
| Regression suite (slices 001–008) | ⏸️ Deferred to user |
| User-story merge ready | ⏸️ **NO** — pending bundle decision + test runs |

US1 implementation is functionally complete. The merge gate is held by the bundle-budget decision (above) and the deferred test runs.
