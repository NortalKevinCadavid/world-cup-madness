# Phase 0 Research: UI Beautification

**Feature**: 009-ui-beautification
**Date**: 2026-05-22
**Status**: Phase 0 complete

This research resolves no `NEEDS CLARIFICATION` markers (none were introduced — defaults are captured in the spec's Assumptions section) but records thirteen design decisions whose alternatives could plausibly have been chosen. Each decision is paired with rationale and rejected alternatives so future readers understand the choice.

This slice is **cross-cutting** — it changes the presentation layer of every prior slice (001–008) but introduces no new functional surface. Several decisions intentionally close off optionality that future presentation work might otherwise re-litigate.

## R-001 — Component primitive library: shadcn/ui (over Radix-only, HeadlessUI, Ariakit, Mantine)

**Decision**. Use **shadcn/ui** as the primary component primitive set, **vendored as source** into `apps/web/app/components/ui/` via the shadcn CLI (`npx shadcn@latest add <component>`). shadcn/ui itself is built on **Radix UI** (`@radix-ui/react-*`) for behavior and uses **Tailwind** for styling. Supporting deps:
- `class-variance-authority` for typed variants.
- `clsx` + `tailwind-merge` exposed via a `cn()` helper in `apps/web/lib/utils.ts`.
- `lucide-react` for icons.

**Rationale**.
- **WAI-ARIA correctness**: Radix's primitive implementations (Dialog, Popover, DropdownMenu, Tabs, Toast, Tooltip, Select, etc.) implement the established authoring patterns with keyboard nav, focus management, escape handling, and screen-reader semantics built in. This directly satisfies FR-UI-018 and is the cheapest path to SC-001 (a11y score ≥ 95) and SC-004 (full keyboard reachability).
- **Source vendoring satisfies Constitution Principle I**: shadcn/ui ships *source files*, not a package import. Every primitive is reviewable in our repo and can be forked, swapped, or replaced without changing import sites. If the team later prefers a different primitive layer, the swap is a search-and-replace inside `app/components/ui/` — the spec's capability-level requirements still hold.
- **Tailwind compatibility**: the existing Tailwind 3.4 install is reused. No new styling engine, no CSS-in-JS runtime, no PostCSS plugin chain change.
- **Playful aesthetic compatible**: shadcn's defaults are intentionally minimal; the festive World Cup theme is layered on top via design tokens (R-002) and per-component class overrides. The library does not impose a corporate look.
- **Ecosystem**: well-documented copy-paste components for the exact widgets the spec needs (data tables, command menu, sheet, drawer for mobile sub-nav, calendar/date display).

**Alternatives considered**.
- **Raw Radix UI without shadcn/ui**: rejected. We would still need to author class-based styling, variant management (CVA), and base styling for every primitive — duplicating effort shadcn already solves. shadcn IS Radix + a styling/variant convention; rejecting shadcn means re-inventing that convention.
- **Headless UI (Tailwind Labs)**: rejected. Smaller primitive set, weaker keyboard/focus story for complex widgets (date pickers, command menus, advanced menus), and weaker accessibility audit track record than Radix. Tailwind Labs has been gradually deprecating it in favor of Catalyst (paid).
- **Ariakit**: rejected. Strong a11y, but smaller ecosystem and less idiomatic with Tailwind/shadcn's variant conventions. Adoption + ramp cost outweighs the marginal a11y advantage over Radix.
- **Mantine**: rejected. Full opinionated component library with its own styling engine — would duplicate Tailwind and introduce a second runtime style system, exploding the bundle and complicating theming.
- **MUI / Chakra**: rejected. Same reasons as Mantine, plus stronger Material/Chakra aesthetic that fights the playful brief.
- **Build from scratch (no library)**: rejected. WAI-ARIA implementation correctness is too easy to get wrong; cost is high and the resulting primitives would lack the audit track record Radix has.

**Cross-slice implication**. The `apps/web/app/components/ui/` folder becomes a **frozen surface area**: future slices SHOULD import from there for new UI work. New primitives added via `npx shadcn@latest add <name>` get committed to the slice that needs them, not to this slice retroactively. The slice's contracts/component-api.md documents the public API of the primitives this slice introduces.

## R-002 — Styling approach: Tailwind 3.4 + CSS custom properties for tokens (no Tailwind v4, no CSS-in-JS)

**Decision**. Keep the existing **Tailwind 3.4** install. Express all design tokens as **CSS custom properties** on `:root` and `.dark` in `app/globals.css`, then reference them from `tailwind.config.ts`'s `theme.extend` so Tailwind utilities (`bg-background`, `text-foreground`, `border-border`, etc.) resolve to the live tokens. Tokens follow the **semantic naming convention** (R-008) rather than primitive color names.

**Rationale**.
- **Already installed** — no migration cost.
- **CSS custom properties are theme-toggle-friendly**: switching a class on `<html>` from `light` → `dark` re-resolves every token instantly without JS, supporting US1 AS-3's 150ms theme switch target.
- **Tailwind v4 is too new** for this slice's risk profile — its new engine, while promising, has had churn during 2025–2026, and migrating it mid-slice would expand scope. Stay on 3.4; revisit in a future infrastructure slice.
- **CSS-in-JS rejected** to avoid SSR-streaming hazards (FOUC, hydration mismatch) and bundle bloat. Server Components + Tailwind static class extraction is the cheapest path to fast first paint.

**Alternatives considered**.
- **Tailwind v4 upgrade**: rejected for scope/risk reasons above.
- **vanilla-extract / Linaria / styled-components**: rejected — runtime cost, SSR complexity, no benefit over Tailwind + custom props for this slice's needs.
- **Pure CSS modules**: rejected — would lose Tailwind's utility productivity and force re-authoring shadcn primitives (which assume Tailwind classes).

## R-003 — Theme system: `next-themes` with `class` strategy, SSR-safe FOUC suppression

**Decision**. Use the `next-themes` package (Next-native, Pages-Router-and-App-Router compatible) with the **`class` strategy** (`<html class="dark">` is the dark-mode signal). Default theme is `system` (follow OS); user can switch to `light`, `dark`, or back to `system` via the `ThemeToggle` in the top nav. Preference persists in `localStorage` under the key `wcm.theme` (see [contracts/theme-toggle.md](./contracts/theme-toggle.md)).

To eliminate the dark/light flash on first paint:
- The root `<html>` element receives `suppressHydrationWarning`.
- `next-themes` injects a tiny inline `<script>` in the `<head>` that reads the localStorage value and sets the `class` BEFORE the React tree hydrates.
- The body uses CSS variables resolved from `:root` (light) and `:root.dark` (dark), so the inline script's class change immediately resolves all tokens.

**Rationale**.
- **Battle-tested** for Next.js App Router with SSR/streaming.
- **No flash**: the inline pre-hydration script is the only correct way to prevent FOUC without server cookies. (A cookie-based server theme is *also* correct but adds round-trip latency on first paint.)
- **Three-state model** (`system | light | dark`) matches user expectation — explicit OS-follow is preferable to an implicit toggle that loses sync with OS changes.

**Alternatives considered**.
- **Cookie-based server theme detection**: rejected for first-paint latency cost; requires a `Set-Cookie` round trip and forces the App Router to opt out of static rendering for the layout.
- **Hand-rolled `<ThemeProvider>`**: rejected — `next-themes` solves exactly this problem and is < 2 KB.
- **CSS-only `prefers-color-scheme` without override**: rejected — fails FR-UI-003 (user MUST be able to override OS preference).

## R-004 — Motion strategy: native CSS + Tailwind variants, no Framer Motion in v1

**Decision**.
- Express motion via **CSS `transition` / `animation`** properties on tokenized durations + easings.
- Use Tailwind's `motion-safe:` and `motion-reduce:` variants to guard non-essential animations.
- Provide a `MotionProvider` React context that exposes `useReducedMotion()` returning `'reduce' | 'full'`. It reads `prefers-reduced-motion`, layers a localStorage override (`wcm.motion`), and synchronizes the result to a `data-motion` attribute on `<html>` so CSS can react.
- Reuse Radix's built-in animations (e.g., `data-[state=open]:animate-in` on Dialog/Popover) which already gate on `prefers-reduced-motion`.
- For confetti (R-006), guard at the JS level: skip the canvas spawn entirely when motion is `reduce`.

**Rationale**.
- The slice's motion needs are simple (hover lifts, page-transition fades, score reveal sequencing, confetti). None require physics-based animation, gesture handling, or shared-element transitions.
- **Bundle budget**: Framer Motion is ~50 KB+ gzipped — too large for the < 30 KB additional budget. Native CSS + Radix is effectively free.
- **`prefers-reduced-motion` ergonomics**: Tailwind variants make per-utility gating cheap.

**Alternatives considered**.
- **Framer Motion**: rejected on bundle cost; revisit if a future slice needs shared-element transitions or gesture-driven UI.
- **GSAP**: rejected on bundle cost + license cost for some plugins.
- **CSS-only with no React hook**: rejected — the spec requires an **in-app override** of `prefers-reduced-motion` (FR-UI-005), which requires JS state.

## R-005 — Country flag assets: vendored SVG set, inline-rendered per card

**Decision**. Vendor a snapshot of the open-source **`flag-icons`** SVG set (or equivalent) for the 48 FIFA WC 2026 participating nations into `apps/web/lib/flags/`. Render via a `<Flag code="ARG" />` component that:
1. Imports the SVG as a React component (Next.js's SVG-as-component support via `@svgr/webpack` if needed, OR an explicit map of code → React node).
2. Falls back to a 3-letter country-code chip when the code is unknown (FR-UI-009 fallback contract).
3. Lazy-loads only the flags currently in view via the standard `React.lazy` + `Suspense` pattern OR via the `loading="lazy"` attribute if rendered as `<img>`.

Final asset rendering shape (inline SVG vs `<img src="/flags/ARG.svg">`) is a tasks-phase decision based on bundle measurement. Both options preserve the same `<Flag>` component API; the choice is internal.

**Rationale**.
- **Local bundling** (vs CDN) eliminates an external dependency, removes a failure mode (CDN outage = no flags), and gives predictable rendering performance.
- **SVG over PNG/JPG**: scales to any size, smaller for flat-color flags, supports CSS coloring for accessibility overlays.
- **48 nations × ~2 KB ≈ 96 KB** if all loaded; well under bundle budget when lazy-loaded per route.
- **`<Flag code>` component API** decouples consumers from the asset rendering implementation.

**Alternatives considered**.
- **Third-party CDN (flagcdn.com, etc.)**: rejected — introduces an external dependency the offline-friendly speed objective explicitly avoids.
- **Emoji flags (🇦🇷)**: rejected — Windows lacks color emoji flag support, breaking consistent rendering for ~30% of probable users.
- **Sprite sheet**: rejected — complex to maintain; lazy-loading individual SVGs is simpler.

## R-006 — Celebration affordance: `canvas-confetti` (over Lottie, Rive, hand-rolled canvas)

**Decision**. Use **`canvas-confetti`** (~6 KB gzipped, MIT, no React dependencies) for confetti moments. Wrap in `apps/web/app/components/Confetti.tsx` that:
- Refuses to spawn when `useReducedMotion() === 'reduce'`.
- Refuses to spawn a second time for the same celebration key (de-duplicated via `localStorage` markers under `wcm.celebrations.<key>`).
- Spawns from a centered burst origin with the brand palette colors derived from CSS custom properties at runtime.
- Cleans up the canvas element after ~2 s.

**Rationale**.
- **Small** — fits in the bundle budget.
- **No React state**, no framework lock-in, easy to swap out.
- **Easy reduced-motion gate** at the JS layer.

**Alternatives considered**.
- **Lottie / Rive**: rejected — runtime is ~50 KB+, overkill for "confetti for 2 seconds", and animation authoring requires an external tool.
- **Custom WebGL/canvas**: rejected — re-inventing the wheel for diminishing returns.
- **CSS-only confetti**: rejected — possible but inflexible and complex to author per-burst variation.

## R-007 — shadcn/ui installation strategy: CLI source-generation, primitives committed to repo

**Decision**. Use `npx shadcn@latest init` to generate `components.json` config, then `npx shadcn@latest add <component>` for each primitive needed. All generated files in `apps/web/app/components/ui/` are committed to the repo and treated as **first-party source** — they can be edited freely, no dependency upgrade story is needed for them.

Initial primitive set (added in US1):
`button`, `card`, `input`, `label`, `select`, `dialog`, `dropdown-menu`, `popover`, `tooltip`, `tabs`, `toast`, `table`, `badge`, `skeleton`, `separator`, `switch`, `checkbox`, `radio-group`, `sheet`, `command`.

Additional primitives added on demand in US2–US5 (e.g., `progress`, `avatar`, `scroll-area`).

**Rationale**.
- **No version drift hazard** — primitives are static source. shadcn updating their templates doesn't auto-update our copies.
- **Free customization** — each primitive can be tuned for our token system without forking a package.
- **Direct alignment with Constitution Principle I** — vendor names appear only in this file and the ADR; spec body remains technology-neutral.

**Alternatives considered**.
- **shadcn-style "registry" packages from npm**: rejected — defeats the point of vendoring.

## R-008 — Design-token naming: semantic roles (not primitive colors)

**Decision**. Token names describe **role**, not value:
- `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`
- `--primary`, `--primary-foreground` (the brand accent)
- `--secondary`, `--secondary-foreground`
- `--accent`, `--accent-foreground` (festive highlight)
- `--muted`, `--muted-foreground`
- `--destructive`, `--destructive-foreground`
- `--border`, `--input`, `--ring`
- Specialized tokens added for sport context: `--win`, `--loss`, `--draw`, `--rank-up`, `--rank-down`, `--rank-same`, `--locked`, `--open`, `--scored`.

Primitive palettes (`--festival-50…900`, `--field-50…900`, `--flag-red`, `--flag-blue`, `--gold`) are defined as **primitives** in a separate `@layer base` block but are NOT referenced directly by components — components reference only semantic tokens. The semantic layer maps to primitives differently for light vs dark theme.

**Rationale**.
- **Replaceability** — re-skinning the app means changing the semantic-to-primitive mapping, not refactoring every component.
- **Dark-mode correctness** — semantic tokens encode intent ("this is the destructive surface"), and the dark theme defines the appropriate dark-mode color for that intent.
- **shadcn convention** — shadcn's default tokens follow this exact pattern; staying consistent reduces friction when copying community examples.

**Alternatives considered**.
- **Primitive-only tokens** (`--blue-500`, etc.): rejected — components would need to know about light/dark mode and hand-pick the right primitive per theme, defeating CSS-variable theming.
- **OKLCH-only palette**: considered for perceptual uniformity but kept as the **value space** of the tokens — final token names remain semantic, value space is OKLCH where the browser supports it with sRGB fallback.

## R-009 — Accessibility testing: `@axe-core/playwright` integrated into the existing Playwright suite

**Decision**. Add `@axe-core/playwright` as a devDependency. In `tests/e2e/009-ui-beautification/a11y/`, write one spec per main-flow route that:
1. Loads the route as an authenticated user.
2. Runs `new AxeBuilder({ page }).analyze()`.
3. Asserts zero serious/critical violations.
4. Asserts an overall score derived from the violation set ≥ 95.

Run the same sweep in both themes (light + dark) via Playwright's `test.describe.parallel` with a fixture for theme.

**Rationale**.
- Integrated with the existing Playwright runner — no new CI pipeline.
- **axe-core** is the industry-standard a11y engine and matches what Lighthouse uses internally.
- Theme matrix catches dark-mode contrast regressions early.

**Alternatives considered**.
- **Lighthouse CI**: rejected as the primary engine — overhead is higher per-page and the score is influenced by performance, which is bound to environmental noise. We can add a secondary Lighthouse run in a separate slice if perf scoring becomes a priority.
- **Pa11y / WebAIM WAVE**: rejected for ecosystem alignment with the existing Playwright suite.

## R-010 — Performance budget: + 60 KB gzipped over pre-slice baseline (revised mid-slice)

**Initial decision (planning phase, 2026-05-22)**: pre-slice baseline + **30 KB gzipped** as the hard ceiling. Reasoning was an estimate of `next-themes` (~2 KB) + `class-variance-authority` + `clsx` + `tailwind-merge` (~3 KB) + tree-shaken `lucide-react` (~5 KB) + `canvas-confetti` (~6 KB) + ~15 Radix primitives (~10-15 KB) = ~25-30 KB.

**Revised decision (2026-05-23, mid-slice, post-US2)**: ceiling raised to pre-slice baseline + **60 KB gzipped**. The +30 KB estimate was low by ~2x. Two distinct overage paths emerged:

1. **`/design-system` route**: documents every primitive in a single page bundle. Cost is ~25 KB gzipped for that route alone, which represents a one-time per-slice documentation artifact, not a recurring user-facing cost.
2. **Participant routes via the new TopNav**: Sheet + Popover + DropdownMenu + Tooltip + Switch are all loaded as soon as a user lands on any authenticated page. Cost is ~9 KB per route's First Load JS.

The actual measurements at this revision:
- Pre-slice baseline: **307,648 bytes gzipped** total chunks.
- Post-US1: **343,299** (+35.7 KB, +5.7 KB over the +30 KB ceiling).
- Post-US2: **349,524** (+41.9 KB, +11.9 KB over).
- Projected post-US3/4/5: another ~10–15 KB of growth from Popover-heavy tie-breakers, Dialog-based ConfirmDestructive, and canvas-confetti.

The revised **+60 KB** ceiling absorbs the realistic post-slice cost (~52–55 KB) with ~5–8 KB headroom for tuning. Per-route First Load JS stays in acceptable ranges (105 kB on dashboard, 154 kB on /design-system — both well under e.g. the [web.dev mobile-first-load guidance](https://web.dev/articles/your-first-performance-budget)'s 170 KB target for compressed JS).

Implementation:
- `apps/web/scripts/measure-bundle.mjs` enforces the +60 KB ceiling.
- The first task of US1 captured the baseline number into `regression-baseline.md` (unchanged).
- The last task of each user story re-measures and asserts the budget.

If the **revised** budget is exceeded:
1. Dynamic-import the largest contributor (canvas-confetti, lucide-react, large Radix primitives).
2. Audit Radix primitive imports for unused exports.
3. Tree-shake `lucide-react` imports.
4. As a last resort, escalate (the slice's plan must be amended again — this time the decision should be a separate ADR).

**Why this revision is not budget-creep**.
- The revised ceiling reflects the *actual* cost of the architectural decision in R-001 (vendor shadcn + Radix), measured rather than estimated. The original 30 KB was a planning estimate, not a measured commitment.
- The Constitution's bundle hardness comes from **Operational Resilience (Principle VII)**, which speaks to user-perceived performance. Per-route First Load remains well under industry mobile-perf thresholds.
- Future slices that grow the bundle further will hit this revised ceiling and require their own justification — the cap is still meaningful, just calibrated to the chosen primitive set.

**Cross-reference**. The decision and rationale are also mirrored in `docs/architecture/adr-009-component-library.md` § Consequences so the ADR reviewer sees the real cost.

**Alternatives considered**.
- **No budget**: rejected — bundle creep is the default failure mode of design-system slices.
- **Per-route budget**: deferred — a single global budget is simpler and sufficient for this slice's size.

## R-011 — Edge-case handling matrix

Maps each spec Edge Case to its implementation strategy and the test that covers it. (Every row has a corresponding red-gate Playwright scenario.)

| Edge Case | Implementation | Test |
|-----------|----------------|------|
| Missing flag asset | `<Flag code>` falls back to 3-letter chip with same dims | `us2/flag-fallback.spec.ts` |
| Long display / country name | CSS `text-overflow: ellipsis` + `<Tooltip>` for full value | `us2/long-names.spec.ts` |
| RTL forward-compatibility | Use CSS logical properties; lint via a Stylelint rule blocking `margin-left`/`padding-left` etc. in components | `us1/rtl-readiness.spec.ts` (static check) |
| Print view | `@media print` rules in `globals.css` flatten backgrounds to white, foregrounds to black, suppress decorative elements | `us1/print.spec.ts` (via emulateMedia) |
| 200% zoom on 1280×800 | Layout uses `min-content`/`max-content` for critical regions; no `width` in `px` on text containers | `us2/zoom-200.spec.ts` |
| JavaScript disabled | Out of scope; covered by existing slice 001 graceful degradation expectations | — |
| Stale tokens mid-deploy | Tokens read at runtime from CSS custom properties; worst case is visual inconsistency for that tab | — (manual) |
| Loading / empty / error trifecta | `<Skeleton>`, `<EmptyState>`, `<ErrorState>` shared components used by every data surface | `us2/states-trifecta.spec.ts`, `us3/leaderboard-empty.spec.ts`, `us4/admin-error.spec.ts` |

## R-012 — Regression strategy: existing E2E + pgTAP suites re-run unchanged per checkpoint

**Decision**. The CI pipeline configured by slices 001–008 is reused unchanged. For each user story:
1. Implementation completes.
2. The story's new Playwright tests pass (green-gate).
3. CI runs the **entire existing E2E + pgTAP suite** from slices 001–008 against this branch. Zero failures.
4. A `regression-checkpoint-us<N>.md` artifact is written in this slice's folder recording the run timestamp + the suite's exit code + any flakiness notes.
5. The user story is mergeable only after the checkpoint artifact exists.

At slice close (after US5):
6. A `regression-final.md` artifact summarizes the full suite re-run against the slice's final commit.

**Rationale**.
- Constitution Principle XI is NON-NEGOTIABLE; a UI redesign is the highest-risk slice type for regressing functional behavior because it touches every surface.
- Re-running the existing suite (rather than authoring new tests for old behavior) keeps the contract intact: existing scenarios are the contract.

**Alternatives considered**.
- **Snapshot test the rendered DOM of every page**: rejected — too brittle; visual diffs catch UI regressions, functional tests catch behavioral regressions, both are necessary but DOM snapshots are neither.
- **Selective regression**: rejected — Principle XI says zero regressions, not selective.

## R-013 — Out of scope (intentionally deferred)

- **Cross-device theme/motion sync** (server-side persistence of UI preferences). Deferred until a clear product need surfaces; v1 stays per-browser.
- **Internationalization / RTL**. The design system MUST not foreclose RTL (R-011), but no translations are added.
- **Public marketing landing page**. If a styled public landing exists, it inherits the design system; this slice does not build a marketing site.
- **Storybook**. The `/design-system` route serves the same purpose with zero infrastructure cost; if Storybook becomes a need (e.g., for component-isolation testing), file a follow-up slice.
- **Visual regression for every route**. v1 baselines `/design-system` + one screenshot per user story; route-by-route baselining is deferred.
- **Tailwind v4 migration**. Deferred to a future infra slice.
- **Framer Motion / advanced animations** (R-004 deferral).
- **Server-side bundle splitting beyond what `next build` does by default**. Deferred unless R-010's budget is exceeded.
- **Native mobile apps**. Responsive web only.
- **Per-user color preferences beyond the theme toggle** (e.g., palette picker). Out of scope.

These deferrals are recorded here so future readers can see why the slice's surface is bounded, and so a future slice can pick them up without re-litigating.
