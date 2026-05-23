# ADR-009: UI Component Library — shadcn/ui (Radix UI primitives + Tailwind)

**Status**: Proposed by slice 009; ratifiable on slice close.
**Date**: 2026-05-22
**Slice**: [009-ui-beautification](../../specs/009-ui-beautification/plan.md)
**Supersedes**: none
**Related**: [stack-decision.md](stack-decision.md) (frontend stack ADR, status Proposed)

## Context

Slice 009 introduces a cross-cutting UI redesign of the World Cup Madness app — a festive, "March Madness for soccer" aesthetic with mandatory dark mode, mobile-first responsive layouts, and a `/design-system` reference page. The redesign must:

- Achieve **Lighthouse / axe-core accessibility ≥ 95** on every main flow (SC-001), including dark mode (SC-002).
- Preserve **100% of the functional behavior** shipped by slices 001–008 (FR-UI-017, Constitution Principle XI).
- Stay on the **existing Next.js 14 App Router + Tailwind 3.4 stack** (no swap to a new framework or styling engine).
- Honor **Constitution Principle I (Technology Neutrality)** — concrete library choices must remain replaceable, ideally without changing import sites at consumer code.

The team needs an interactive-primitive library to compose Buttons, Dialogs, Popovers, Dropdowns, Tabs, Toasts, Tooltips, Selects, etc., with WAI-ARIA semantics correctly implemented, keyboard navigation, and focus management.

## Decision

**Use [shadcn/ui](https://ui.shadcn.com/) as the primary component-primitive library, vendored as source into `apps/web/app/components/ui/` via the shadcn CLI.** shadcn/ui is built on top of [Radix UI](https://www.radix-ui.com/) primitives for behavior and uses Tailwind for styling.

Supporting dependencies:
- `@radix-ui/react-*` (pulled transitively by the shadcn CLI per primitive).
- `class-variance-authority` for typed variant APIs.
- `clsx` + `tailwind-merge`, exposed via a `cn()` helper in `apps/web/lib/utils.ts`.
- `lucide-react` for the icon set.

## Rationale

1. **WAI-ARIA correctness out of the box**. Radix's primitive implementations (Dialog, Popover, DropdownMenu, Tabs, Toast, Tooltip, Select, etc.) implement the established WAI-ARIA Authoring Patterns with keyboard nav, focus trapping, escape handling, and screen-reader semantics built in. This is the cheapest path to meeting SC-001 (a11y ≥ 95) and SC-004 (full keyboard reachability).

2. **Source-vendored, not depended-on as a package** — directly satisfying Constitution Principle I (Technology Neutrality). The shadcn CLI writes plain `.tsx` files into our repo; we own them. Replacing the primitive layer in the future is a refactor inside `apps/web/app/components/ui/`, not a dependency rip-out.

3. **Tailwind-native**. The existing `tailwindcss@3.4.19` install is reused; no new styling engine, no CSS-in-JS runtime, no PostCSS plugin chain change. Tokens are expressed as CSS custom properties (see [contracts/design-tokens.md](../../specs/009-ui-beautification/contracts/design-tokens.md)) and consumed via Tailwind utilities.

4. **Playful aesthetic compatible**. shadcn's defaults are intentionally minimal; the festive World Cup theme is layered on top via design tokens and per-component class overrides. The library does not impose a corporate look.

5. **Ecosystem fit**. Well-documented copy-paste components for every widget the spec needs (data tables, command menu, sheet for mobile sub-nav, drawer, calendar/date display). Active community, regular updates.

## Alternatives considered

- **Raw Radix UI without shadcn/ui**: rejected. shadcn IS Radix plus a styling/variant convention; rejecting shadcn means re-inventing the convention. Cost without benefit.
- **Headless UI (Tailwind Labs)**: rejected. Smaller primitive set, weaker keyboard/focus story for complex widgets (date pickers, command menus), and Tailwind Labs is gradually shifting to Catalyst (paid).
- **Ariakit**: rejected. Strong a11y but smaller ecosystem and less idiomatic with Tailwind / shadcn variant conventions. The marginal a11y advantage over Radix does not justify the ramp cost.
- **Mantine / MUI / Chakra**: rejected. Full opinionated component libraries with their own styling engines — would duplicate Tailwind and add a second runtime style system. Bundle and theming complexity grows; the playful aesthetic fights their defaults.
- **Build from scratch**: rejected. WAI-ARIA correctness is too easy to get wrong; cost is high and the resulting primitives would lack Radix's audit track record.

## Consequences

### Positive

- The slice can hit SC-001/SC-002/SC-004 without authoring keyboard/focus/ARIA logic from scratch.
- Every primitive lives in our repo as reviewable source; future security audits, theming changes, or behavior tweaks happen in-tree.
- Bundle impact stays within the slice's revised **+60 KB** gzipped budget (research.md R-010 — revised mid-slice from the original +30 KB planning estimate after the real cost of the primitive set was measured at ~+42 KB post-US2, projected to ~+52–55 KB post-slice).
- Future slices get a documented, frozen primitive surface at `apps/web/app/components/ui/` — visual consistency across slices becomes the default, not an emergent property.

### Negative / mitigations

- **Source vendoring means no "upgrade primitive library" command** — each primitive is forked at the moment of `npx shadcn@latest add <name>`. Mitigation: shadcn's primitives are small and stable; security-relevant Radix updates are tracked via `@radix-ui/react-*` transitive deps, which DO upgrade normally.
- **shadcn defaults reference Tailwind primitive colors (`bg-slate-*`)** that we do not want in our token system. Mitigation: T027/T028/T029 audit each generated file and rewrite to use our semantic tokens.
- **Radix transitive footprint** — adding many primitives can grow the dependency tree. Mitigation: bundle budget assertion (T039 / T063 / T108) and dynamic-import as a last resort per research.md R-010.

## Cross-slice contract implications

- `apps/web/app/components/ui/` becomes a **frozen surface** going forward: new primitives are added via `npx shadcn@latest add <name>` in the slice that needs them. The primitive's public API (props, slots) is now part of our cross-slice contract per [contracts/component-api.md](../../specs/009-ui-beautification/contracts/component-api.md).
- The semantic token names in [contracts/design-tokens.md](../../specs/009-ui-beautification/contracts/design-tokens.md) are locked after slice 009 closes — future slices may change token values (re-skin) but MUST NOT rename them.

## Status timeline

- **2026-05-22** — Proposed in slice 009 planning.
- _Ratifiable on slice close_, after US1 ships and the primitive set has been exercised in US2 / US3 / US4 / US5.
