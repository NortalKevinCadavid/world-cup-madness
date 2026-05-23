# Implementation Plan: UI Beautification

**Branch**: `009-ui-beautification` | **Date**: 2026-05-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/009-ui-beautification/spec.md`

## Summary

Deliver a cross-cutting **presentation-layer redesign** of the entire World Cup Madness app — playful, festive, March-Madness-for-soccer aesthetic — while preserving 100% of the functional behavior shipped by slices 001–008. The slice introduces:

1. A coherent **design-token system** (color, typography, spacing, radii, elevation, motion) expressed as CSS custom properties layered into the existing Tailwind 3.4 install, with first-class light + dark themes.
2. A **component-primitive library** based on **shadcn/ui** (Radix UI under the hood) — copied into the repo as source via the shadcn CLI rather than pulled as a dependency, so every primitive is reviewable, themeable, and replaceable per Constitution Principle I.
3. A **theme system** built on `next-themes` with `class` strategy, OS-preference following on first visit, persisted explicit override per browser, and SSR/streaming-safe FOUC suppression via a `suppressHydrationWarning` + inline color-scheme hint.
4. A **reduced-motion-respecting motion layer** (CSS `prefers-reduced-motion` queries + a React context that mirrors the OS preference and exposes an in-app override).
5. A redesigned **participant surface** (landing, dashboard, predictions, bracket, leaderboard) and a redesigned **admin surface** (dashboard, overrides, audit, configuration) that share the design system but tune density independently.
6. **Celebration affordances** (canvas-confetti for lock-in / top-3 entry; sequenced reveal for post-match scoring) that downgrade gracefully under reduced motion or device-perf constraints.
7. A publicly reachable **`/design-system` route** documenting every token and component in both themes — the single source of truth for cross-slice visual consistency going forward.
8. A **regression contract** (per Constitution Principle XI): every Playwright + pgTAP suite from slices 001–008 MUST continue to pass; this slice's `regression-checkpoint-*.md` artifacts record each pass.

This slice ships no new HTTP routes, no schema changes, no SQL functions, and no audit events. It changes the presentation layer of every existing slice.

## Technical Context

**Language/Version**: TypeScript 5.4 (Next.js App Router, React 18.3). CSS via Tailwind 3.4 + raw CSS custom properties for design tokens. No language-level changes.

**Primary Dependencies** (decisions documented in [research.md](./research.md)):
- **Component primitives**: **shadcn/ui** (R-001) — source-generated into `apps/web/app/components/ui/` via the shadcn CLI. Underlying primitive set: **Radix UI** (`@radix-ui/react-*`). Reasoning: established WAI-ARIA implementations, keyboard nav and focus management built-in, source-in-repo posture aligns with Constitution Principle I (replaceable, reviewable).
- **Theme switching**: `next-themes` (R-003) — class-strategy dark mode, SSR-safe, OS-preference default, persisted override.
- **Class-name composition**: `clsx` + `tailwind-merge` via `cn()` helper (R-001 supporting deps).
- **Variant API**: `class-variance-authority` (R-001 supporting dep) — for component variant typing.
- **Icons**: `lucide-react` (R-001 supporting dep) — shadcn's default icon set; tree-shakable.
- **Confetti / celebration**: `canvas-confetti` (R-006) — small (~6 KB gzipped), no React state, easy `prefers-reduced-motion` guard.
- **Country flag assets**: bundled locally as inline SVG from a vendored snapshot of the `flag-icons` set (R-005) — 48 nations × ~2 KB each; lazy-loaded per match card via a `<Flag code="ARG" />` component.
- **Animation primitives**: native CSS transitions + Radix's built-in animations + Tailwind's `motion-safe:`/`motion-reduce:` variants. No Framer Motion in v1 (R-004) — keep bundle small; revisit if a story demands physics-based motion.

Already in place (no change):
- Next.js 14.2 (App Router), React 18.3, Tailwind 3.4, PostCSS, Playwright 1.60, Supabase SSR helpers, Zod, `cmdk` (will be reused for the command-palette-style admin search if needed).

**Storage**: N/A — this slice persists no server-side data. Client-side state lives in `localStorage` for theme preference (`wcm.theme`), motion override (`wcm.motion`), and celebration-seen markers (`wcm.celebrations.<key>`). Keys are namespaced under `wcm.*` so a future slice can rename without collision.

**Testing** (Constitution Principle IX — NON-NEGOTIABLE):
- **E2E**: Playwright. Every Acceptance Scenario in `spec.md` (US1 × 6, US2 × 6, US3 × 4, US4 × 4, US5 × 4) authored Given/When/Then, red-first. Each user story's tests live in `tests/e2e/009-ui-beautification/us[1-5]/*.spec.ts`.
- **Accessibility**: `@axe-core/playwright` integrated into the E2E suite. Every main-flow page tested for ≥ 95 score, zero serious/critical violations (SC-001).
- **Visual regression**: Playwright's built-in screenshot comparison on the `/design-system` page + one representative screenshot per user story. Baselines committed to the repo.
- **Contrast audit**: a small CI script that walks the `/design-system` page in both themes and validates every named text/background token pairing satisfies WCAG AA (SC-002). Implemented as a Playwright test using `axe-core`'s contrast rule.
- **Viewport check**: Playwright matrix runs every main-flow E2E at 375×667 and at 1280×800 (SC-003).
- **Keyboard traversal**: Playwright tests that tab through the entire interactive surface of each main-flow page (SC-004).
- **Regression**: every existing E2E and pgTAP suite from slices 001–008 MUST be runnable from this branch with zero modifications and MUST pass. The CI workflow is unchanged; a `regression-final.md` artifact is written at slice close.
- **No new pgTAP**: this slice introduces no SQL; the existing DB suites remain the baseline.

**Target Platform**:
- Frontend: Vercel-hosted Next.js (same target as 001–008).
- Browsers: evergreen — last two majors of Chrome, Edge, Firefox, Safari. Mobile Safari iOS 16+, Chrome Android 110+.
- Floor viewport: 375px portrait (iPhone SE 2nd/3rd gen, contemporary mid-tier Android). Below 375px is best-effort graceful degradation, not a designed target.

**Project Type**: Web application — single Next.js app under `apps/web/`. No new packages; the shadcn CLI vendors its primitives into the existing `apps/web/app/components/ui/` folder (new) without introducing a new workspace.

**Performance Goals** (mapped to SC-006 + SC-007):
- First meaningful render on the redesigned participant dashboard at Slow 3G + 4× CPU throttle ≤ 1.5s.
- Time to interactive at the same profile ≤ 5s.
- Production JS bundle (`apps/web/.next/static/chunks/main-app-*.js`) MUST NOT exceed the current pre-slice baseline + **30 KB gzipped** (the budget Radix + shadcn primitives + `next-themes` + `canvas-confetti` should comfortably fit inside; if exceeded, the slice MUST remediate via dynamic imports before merge).
- Theme switch animation completes ≤ 150ms (US1 AS-3).
- Prediction lock-in confirmation visible ≤ 500ms after server ack (US2 AS-3, SC-007).
- Celebration affordance ≤ 2s total, ≤ 200ms main-thread block per frame (US5 AS-1, AS-4).

**Constraints**:
- **Zero functional change** (FR-UI-017). No edits to `apps/web/app/api/**`, no edits to migrations, no edits to SQL functions, no schema additions. If implementation reveals an API gap, file a defect against the originating slice — do not fix it here.
- **Zero new audit events** — the audit shape is locked by Slice 007.
- **Bundle budget** (above) is a hard gate, not a guideline.
- **Server-side eligibility gates** (Slice 001's RLS + auth-hook + `requireEligible()` API guard) remain untouched. The new UI MUST NOT introduce client-side gating that bypasses or duplicates the server gates.
- **Theme preference is per-browser** in this slice (not server-synced). The `wcm.theme` localStorage key is the only state. Cross-device sync is explicitly deferred.
- **English / Latin-script only**. Tokens and components MUST use CSS logical properties (`padding-inline`, `margin-block`, etc.) where Tailwind supports them so a future RTL slice is not blocked.

**Scale/Scope**:
- ~500 active participants; peak concurrent in-app ~150 during a match-day deadline.
- 48 country flag SVGs in the bundle (lazy-loaded per card).
- ~30 reusable shadcn/ui components in `app/components/ui/`.
- 12 main-flow routes redesigned (landing, login result, dashboard, predictions × N match views, bracket, leaderboard, me, admin dashboard, admin matches, admin overrides, admin audit, admin config, admin recalc, admin denied, admin pending-review, design system).
- 5 user stories × ~24 total acceptance scenarios.

## Constitution Check

*GATE: MUST pass before Phase 0 research. Re-evaluated at the end of Phase 1 (see "Post-Design Constitution Re-Check" below).*

The constitution under review is v1.1.0 (`.specify/memory/constitution.md`, last amended 2026-05-15). Each principle is evaluated against this slice's design.

| # | Principle | Evaluation | Status |
|---|-----------|------------|--------|
| I | Technology Neutrality | `spec.md` is vendor-neutral (requirements expressed in WAI-ARIA / capability terms). This plan picks shadcn/ui + Radix + `next-themes` + `canvas-confetti`; each is justified in `research.md` and recorded as a *replaceable* choice. shadcn/ui specifically is **vendored as source** rather than depended on as a package — primitives can be swapped/forked without breaking imports. A new ADR (`docs/architecture/stack-decision.md` addendum or a fresh file) is part of this slice's tasks. | ✅ |
| II | Security by Design | Pure presentation slice. No new authentication surface, no new authorization decisions, no new endpoints. Server-side gates from Slice 001 (Supabase Auth provider config, auth hook, RLS, `requireEligible()`) are untouched. Theme preference in localStorage is non-sensitive (no PII, no token, no eligibility signal). The slice **does** introduce a new client-side surface (`/design-system` route) which is explicitly public and contains no user data. | ✅ |
| III | Rules Outside the UI | No new rules introduced. The eligibility predicate, scoring function, lock predicate, audit policies — all in Postgres — are not touched. Locking semantics shown in the UI (open/locked/scored badges) read from server-supplied state; the client does not compute lock state independently. | ✅ |
| IV | Provider Abstraction | N/A — no provider integrations changed. The slice consumes Supabase via the existing client/server helpers from Slice 001 without modifying them. | ✅ |
| V | Auditability | No new audit events. Existing audit-emission paths (auth-hook, profile mutations, predictions, overrides, configuration changes) write the same rows after this slice as before. Re-verified by re-running Slices 001 + 003 + 006 + 008's audit-emission E2E tests in CI on this branch. | ✅ |
| VI | Time-Zone Correctness | UI presents `timestamptz` values from the server formatted in the user's IANA timezone via `Intl.DateTimeFormat`. No client-clock-derived value is ever sent to the server. Lock countdown displays a derived "time remaining" but the lock decision continues to be server-side via the existing predicate (Slice 003). | ✅ |
| VII | Operational Resilience | FR-UI-013 requires designed loading / empty / error states for every data surface — directly improving resilience over the current minimal UI. No new external dependency that can fail (everything is bundled). The new image fallback (3-letter code chip per FR-UI-009) means missing flag assets degrade gracefully. | ✅ |
| VIII | Extensibility & Configuration | Design tokens are CSS custom properties, replaceable per token without code change. A future slice can swap palettes by re-defining the `--brand-*` tokens. The component library is vendored as source — extensible without forking a package. The theme system is open to a third "high-contrast" theme without changing the toggle's data model. | ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Every Acceptance Scenario in `spec.md` is authored as a red-first Playwright scenario before the corresponding component lands. `tests/e2e/009-ui-beautification/us[1-5]/` holds the spec files. `red-gate-us[1-5].md` artifacts in this slice's directory record the red runs. Accessibility (axe), contrast, viewport, and keyboard tests are part of the same red-gate. Visual-regression baselines are written *after* a story goes green, never before. | ✅ |
| X | Vertical Slice Delivery | US1 (design system + dark mode) is independently shippable: even alone it delivers a real artifact (`/design-system`, theme toggle, primitives library). US2 (participant flows) ships on top of US1 and delivers the bulk of user value. US3 (leaderboard), US4 (admin), US5 (motion polish) each ship independently. Mid-slice, the team can pause after any green user story and have a deployable improvement. | ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | Every existing Playwright + pgTAP suite from slices 001–008 MUST pass on this branch before each user story is merged. A `regression-checkpoint-us<N>.md` artifact records the run for each story. A `regression-final.md` artifact at slice close summarizes the full re-run. The CI pipeline (configured in 001–008) is reused unmodified — no flag is added that would weaken its coverage. | ✅ |

**Eligibility / Privacy / Compliance constraints** (non-principle hard rules):
- **Domain-restricted access** ✅ — server-side gate untouched.
- **No gambling** ✅ — no monetary fields touched; the redesign is decorative only.
- **Data minimization** ✅ — no new client-side or server-side data collected. Theme/motion preferences are local-only.
- **Public API restriction** ✅ — no new API routes introduced. `/design-system` is intentionally public and contains no user data.

**Pre-design gate result**: ✅ All eleven principles pass. No complexity-tracking exceptions required. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/009-ui-beautification/
├── plan.md                     # This file
├── research.md                 # Phase 0 — R-001…R-013
├── data-model.md               # Phase 1 — client-side state shapes (no server data)
├── quickstart.md               # Phase 1 — local verification walkthrough
├── contracts/
│   ├── design-tokens.md        # Token names, semantic roles, light/dark values (cross-slice invariant)
│   ├── component-api.md        # Component prop contracts (Button, Card, Dialog, FlagChip, …)
│   └── theme-toggle.md         # localStorage key, DOM contract for SSR, FOUC suppression rule
├── checklists/
│   └── requirements.md         # /speckit-specify validation (already done)
├── red-gate-us1.md             # /speckit-implement — written when US1 red suite is committed
├── red-gate-us2.md
├── red-gate-us3.md
├── red-gate-us4.md
├── red-gate-us5.md
├── regression-checkpoint-us1.md
├── regression-checkpoint-us2.md
├── regression-checkpoint-us3.md
├── regression-checkpoint-us4.md
├── regression-checkpoint-us5.md
├── regression-final.md
└── tasks.md                    # Phase 2 — produced by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/
├── app/
│   ├── globals.css                       # MODIFIED — replaced with @layer base/components/utilities + token defs
│   ├── layout.tsx                        # MODIFIED — html lang attr; ThemeProvider + suppressHydrationWarning
│   ├── design-system/                    # NEW — public route documenting every token + component
│   │   └── page.tsx
│   ├── components/
│   │   ├── TopNav.tsx                    # MODIFIED — redesigned, includes ThemeToggle
│   │   ├── ThemeToggle.tsx               # NEW
│   │   ├── ThemeProvider.tsx             # NEW — wraps next-themes
│   │   ├── MotionProvider.tsx            # NEW — reduced-motion context + override
│   │   ├── Flag.tsx                      # NEW — <Flag code="ARG" /> with 3-letter chip fallback
│   │   ├── MatchCard.tsx                 # NEW — shared by predictions + bracket + dashboard
│   │   ├── LeaderboardRow.tsx            # NEW
│   │   ├── RankDelta.tsx                 # NEW — movement indicator
│   │   ├── Confetti.tsx                  # NEW — canvas-confetti wrapper, motion-aware, one-shot
│   │   ├── EmptyState.tsx                # NEW — shared empty-state component
│   │   ├── ErrorState.tsx                # NEW — shared error-state component
│   │   ├── Skeleton.tsx                  # NEW — generic skeleton primitive
│   │   └── ui/                           # NEW — shadcn/ui vendored primitives
│   │       ├── button.tsx
│   │       ├── card.tsx
│   │       ├── dialog.tsx
│   │       ├── dropdown-menu.tsx
│   │       ├── input.tsx
│   │       ├── label.tsx
│   │       ├── popover.tsx
│   │       ├── select.tsx
│   │       ├── table.tsx
│   │       ├── tabs.tsx
│   │       ├── toast.tsx
│   │       ├── tooltip.tsx
│   │       └── (~30 total)
│   ├── (participant)/                    # MODIFIED — all pages restyled, structure unchanged
│   │   ├── layout.tsx
│   │   ├── dashboard/
│   │   ├── matches/
│   │   ├── leaderboard/
│   │   └── me/
│   ├── admin/                            # MODIFIED — all pages restyled, density preserved
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── matches/
│   │   ├── predictions/
│   │   ├── finals/
│   │   ├── recalc/
│   │   ├── pending-review/
│   │   ├── audit/
│   │   ├── config/
│   │   └── denied/
│   └── auth/                             # MODIFIED — sign-in + denied pages restyled
├── lib/
│   ├── utils.ts                          # NEW — `cn()` helper (clsx + tailwind-merge)
│   ├── motion.ts                         # NEW — useReducedMotion() + override hook
│   ├── theme.ts                          # NEW — theme constants, localStorage key contract
│   └── flags/                            # NEW — vendored flag-icons SVGs (48 nations)
├── public/
│   └── flags/                            # alt location for static flag fetch if we prefer <img> over inline (R-005 final pick)
├── tailwind.config.ts                    # MODIFIED — extends tokens, registers darkMode: 'class'
├── postcss.config.mjs                    # unchanged
├── package.json                          # MODIFIED — adds: next-themes, lucide-react, class-variance-authority, clsx, tailwind-merge, canvas-confetti, @radix-ui/react-* (subset)
├── components.json                       # NEW — shadcn CLI config
└── tests/
    └── e2e/
        └── 009-ui-beautification/
            ├── us1/                      # Design system + dark mode (6 scenarios)
            ├── us2/                      # Participant flows (6 scenarios)
            ├── us3/                      # Leaderboard (4 scenarios)
            ├── us4/                      # Admin density (4 scenarios)
            ├── us5/                      # Celebration polish (4 scenarios)
            ├── a11y/                     # axe-core sweeps across every main-flow route
            ├── contrast/                 # token-pair contrast audit on /design-system
            ├── viewport/                 # 375px no-scroll matrix
            ├── keyboard/                 # tab-traversal across every main-flow route
            └── visual/                   # baseline screenshots

docs/architecture/
└── adr-009-component-library.md          # NEW — records shadcn/ui choice; flags it as replaceable
```

**Structure Decision**: Single existing Next.js app under `apps/web/`. The slice **modifies in place** (no new app, no new package) and **vendors** shadcn/ui primitives into `apps/web/app/components/ui/` via the shadcn CLI rather than introducing a new workspace. Token definitions live in `app/globals.css` (CSS custom properties under `:root` / `.dark`) and are referenced from `tailwind.config.ts` so Tailwind utilities resolve to the same tokens. The `/design-system` route is a public, authenticated-not-required page that documents every token and component — this is the cross-slice contract surface for future presentation work.

## Phase 0 Outline & Research

See [research.md](./research.md) for the consolidated R-001…R-013 decision record. Phase 0 resolved no `NEEDS CLARIFICATION` markers (none were introduced — see the spec's Assumptions section) but did record thirteen design decisions whose alternatives could plausibly have been chosen, so future readers understand why this stack was picked.

## Phase 1 Design & Contracts

See:
- [data-model.md](./data-model.md) — client-side state shapes (ThemePreference, MotionPreference, CelebrationSeenMarker) and design-token shape.
- [contracts/design-tokens.md](./contracts/design-tokens.md) — the cross-slice token names + their light/dark values.
- [contracts/component-api.md](./contracts/component-api.md) — public component API surface.
- [contracts/theme-toggle.md](./contracts/theme-toggle.md) — localStorage key + DOM contract for SSR.
- [quickstart.md](./quickstart.md) — local verification walkthrough.

## Post-Design Constitution Re-Check

Re-evaluated against `constitution.md` v1.1.0 after Phase 1 artifacts were written.

| # | Principle | Re-Check | Status |
|---|-----------|----------|--------|
| I | Technology Neutrality | Component-library decision is recorded as an ADR; primitives are vendored as source. Token names in `contracts/design-tokens.md` are framework-agnostic (CSS custom properties). | ✅ |
| II | Security by Design | No new endpoint, no new client-side decision that affects authorization. `/design-system` route confirmed to render zero user data. | ✅ |
| III | Rules Outside the UI | Confirmed: no client-side scoring, no client-side lock-state derivation, no client-side eligibility derivation. | ✅ |
| IV | Provider Abstraction | No provider integration touched. | ✅ |
| V | Auditability | No audit-emission code paths altered. Regression tests for audit emission re-run in CI per checkpoint. | ✅ |
| VI | Time-Zone Correctness | Confirmed: time rendering uses `Intl.DateTimeFormat` with the user's IANA timezone; the server's `timestamptz` remains source of truth. | ✅ |
| VII | Operational Resilience | Loading / empty / error states defined per route in `contracts/component-api.md`. Image fallback (FlagChip) covers missing assets. | ✅ |
| VIII | Extensibility & Configuration | Tokens are CSS variables; theme classes are extensible; a "high-contrast" theme can be added without changing the toggle's data shape. | ✅ |
| IX | TDD via BDD | Red-gate scenarios mapped 1:1 to spec Acceptance Scenarios in `tests/e2e/009-ui-beautification/`. | ✅ |
| X | Vertical Slice Delivery | Five independently-shippable user stories, each with its own red-gate + regression-checkpoint artifact. | ✅ |
| XI | Regression-Gated Progress | Every prior slice's suite runs unmodified on this branch; failure to pass blocks the user story's merge per `tasks.md`. | ✅ |

**Post-design gate result**: ✅ All eleven principles pass after Phase 1. Proceed to `/speckit-tasks`.

## Complexity Tracking

> No violations to track. The slice introduces no architectural complexity beyond a vendored component library and a theme provider, both standard for Next.js App Router applications.

## What's Next

- Run `/speckit-tasks` to generate the dispatchable task list. Each task MUST be self-contained per the user's auto-memory rule (no inherited conversation context).
- `/speckit-implement` consumes `tasks.md`, but the slice's `tasks.md` MUST observe the per-story sequence: red-gate → implement → green → regression-checkpoint → user-story merge. US1 is a hard prerequisite for US2–US5 (the design system unblocks every downstream story).
