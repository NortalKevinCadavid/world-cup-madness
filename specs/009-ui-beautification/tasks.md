---
description: "Task list for slice 009-ui-beautification — dispatchable, self-contained"
---

# Tasks: UI Beautification

**Input**: Design documents from `specs/009-ui-beautification/`

**Prerequisites**:
- `specs/009-ui-beautification/spec.md` (5 user stories, US1–US5)
- `specs/009-ui-beautification/plan.md` (technical context, project structure)
- `specs/009-ui-beautification/research.md` (R-001…R-013 decisions)
- `specs/009-ui-beautification/data-model.md` (client-side entities)
- `specs/009-ui-beautification/contracts/design-tokens.md`
- `specs/009-ui-beautification/contracts/component-api.md`
- `specs/009-ui-beautification/contracts/theme-toggle.md`
- `specs/009-ui-beautification/quickstart.md`

**Tests**: REQUIRED. Constitution Principle IX (NON-NEGOTIABLE) mandates TDD via BDD. Every user story has red-first Playwright scenarios that MUST be written and failing before implementation begins. Additionally, the slice MUST preserve regression coverage from slices 001–008 per Constitution Principle XI.

**Organization**: Tasks are grouped by user story. Each task is **self-contained** — dispatchable to a subagent with no inherited conversation context. Each task description names the absolute file path, the spec/contract section it implements, and the acceptance criteria it satisfies.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User-story label (US1–US5). Setup, Foundational, and Polish phases have no story label.

## Path Conventions

- Web app under `apps/web/`. All paths are absolute or repository-relative.
- Test suites under `apps/web/tests/e2e/009-ui-beautification/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependency installation, ADR, baseline capture, and shared scripts.

- [X] T001 Capture pre-slice bundle baseline. Check out the prior commit on this branch (`git log --oneline --all -- apps/web | head` to find the commit BEFORE this slice's first dependency change), then run `cd apps/web && npm install && npm run build` and measure the gzipped size of the largest entry chunk under `apps/web/.next/static/chunks/main-app-*.js` using `gzip-size-cli` or equivalent (`npx gzip-size-cli apps/web/.next/static/chunks/main-app-*.js`). Write the result to `specs/009-ui-beautification/regression-baseline.md` with: bundle size in bytes (raw + gzipped), commit SHA, date, the `npm ls --depth=0` output for `apps/web`, and a screenshot count baseline for admin tables at 1920×1080 (see Phase 6 prereq). Return to the slice branch (`git checkout 009-ui-beautification`) when done.

- [X] T002 Add new runtime and dev dependencies to `apps/web/package.json` in a single edit, then run `npm install` from `apps/web/`. Add to `dependencies`: `next-themes ^0.3.0`, `lucide-react ^0.400.0`, `class-variance-authority ^0.7.0`, `clsx ^2.1.0`, `tailwind-merge ^2.4.0`, `canvas-confetti ^1.9.3`. Add to `devDependencies`: `@axe-core/playwright ^4.10.0`, `@types/canvas-confetti ^1.6.4`. Do NOT add `@radix-ui/react-*` packages directly — those will be pulled transitively by the shadcn CLI in T003. Also add npm scripts: `"measure-bundle": "node scripts/measure-bundle.mjs"` and `"a11y": "playwright test tests/e2e/009-ui-beautification/a11y"`. Commit the lock file change.

- [X] T003 [P] Initialize the shadcn/ui CLI in `apps/web/`. Run `npx shadcn@latest init` interactively with these answers: Style = "New York"; Base color = "Slate"; CSS variables = "Yes"; tailwind.config = the existing one; aliases for components = `@/app/components/ui`, lib = `@/lib`, utils = `@/lib/utils`. This creates `apps/web/components.json` (commit), `apps/web/lib/utils.ts` (commit; verify it contains the `cn()` helper combining `clsx` + `tailwind-merge`), and modifies `apps/web/app/globals.css` (REVERT shadcn's globals.css edits in this task — T013 owns the final globals.css content). Commit `components.json` and `lib/utils.ts` only.

- [X] T004 [P] Write `docs/architecture/adr-009-component-library.md` documenting the choice of shadcn/ui + Radix UI + Tailwind, why, and the alternatives rejected (mirror `specs/009-ui-beautification/research.md` § R-001 succinctly). Mark status as "Proposed by slice 009; ratifiable on slice close." Cross-reference: link to `specs/009-ui-beautification/plan.md` and `specs/009-ui-beautification/contracts/design-tokens.md`. Add an entry in `docs/architecture/README.md` linking the new ADR.

- [X] T005 [P] Create `apps/web/scripts/measure-bundle.mjs` that: runs `next build` if `.next` is stale, finds the largest entry chunk under `.next/static/chunks/`, reports raw and gzipped sizes (use the `zlib` builtin), and compares against the value in `specs/009-ui-beautification/regression-baseline.md` (parsing the markdown). Exit code 0 if delta ≤ 30 KB gzipped; exit code 1 if exceeded. Output a human-readable diff line. The script is consumed by the npm script added in T002 and by US1's bundle-budget assertion.

- [X] T006 [P] Create a Playwright fixture for axe-core at `apps/web/tests/e2e/009-ui-beautification/fixtures/a11y.ts` that exports an `axeCheck(page, options)` helper wrapping `new AxeBuilder({ page })`. Helper asserts: zero `serious` or `critical` violations; total `violations.length` ≤ N such that an axe-derived score (defined as `100 - violations.length * (severity-weight)`) is ≥ 95. Severity weights: minor=1, moderate=2, serious=10, critical=20. Helper accepts `{ disableRules: string[], context: string }` options. Include JSDoc on the helper.

- [X] T007 [P] Create a Playwright fixture for theme-aware testing at `apps/web/tests/e2e/009-ui-beautification/fixtures/theme.ts` that exports a `test` extension with a `theme: 'light' | 'dark'` worker option. The fixture sets `localStorage.wcm.theme` to the chosen value BEFORE navigation and asserts the `<html>` class matches after navigation. Use this for the contrast and component-gallery test matrices.

- [X] T008 [P] Create a Playwright fixture for motion-preference testing at `apps/web/tests/e2e/009-ui-beautification/fixtures/motion.ts` that exposes a `motion: 'full' | 'reduce'` option. Sets `localStorage.wcm.motion` and emulates `prefers-reduced-motion` via `await page.emulateMedia({ reducedMotion: 'reduce' | 'no-preference' })`. Used by US1 AS-5 and US5 reduced-motion assertions.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: minimal scaffolding required by every user story. The design tokens, theme provider, motion provider, and primitive vendoring are USER STORY 1 deliverables — not foundational — because the spec defines US1 as "Design system foundation & dark mode." Phase 2 here is intentionally thin.

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete. US1 explicitly depends on this phase.

- [X] T009 Set up the slice's E2E test directory tree under `apps/web/tests/e2e/009-ui-beautification/`. Create empty (with `.gitkeep`) folders: `us1/`, `us2/`, `us3/`, `us4/`, `us5/`, `a11y/`, `contrast/`, `viewport/`, `keyboard/`, `visual/`. Do NOT create test specs yet — each US phase owns its own red-gate file creation.

- [X] T010 Update `apps/web/playwright.config.ts` to add a `testMatch` projection for the new `tests/e2e/009-ui-beautification/` tree (alongside the existing slice suites — DO NOT remove existing projections). Add two configured device profiles: `iPhone SE` (375×667 portrait, throttled CPU 4×, Slow 3G) and `Desktop 1280` (1280×800, fast). Add a `globalSetup` hook (in `apps/web/tests/e2e/009-ui-beautification/global-setup.ts`) that records the timestamp of the suite run for the regression checkpoint artifacts. Do NOT change the default Playwright reporter; keep parity with the existing slice suites.

**Checkpoint**: Foundation ready — User Story 1 can now begin. US2–US5 still depend on US1's design-system outputs (see Dependencies section).

---

## Phase 3: User Story 1 — Design system foundation & dark mode (Priority: P1) 🎯 MVP

**Goal**: Ship a coherent design-token system, working theme toggle (light/dark/system), a motion provider that respects `prefers-reduced-motion` with an in-app override, the shadcn primitive library vendored into `apps/web/app/components/ui/`, and a public `/design-system` route documenting every token + component in both themes.

**Independent Test**: visit `/design-system` (unauthenticated path is allowed); verify every token group and every primitive renders in both themes; toggle theme via the top nav — every surface flips within 150ms with no flash; confirm `prefers-reduced-motion: reduce` suppresses non-essential motion; run `axeCheck` on the page — score ≥ 95, zero serious/critical violations.

### Red-gate tests for User Story 1 ⚠️

> Write FIRST. Confirm RED (failing) before any implementation in T021+. Commit the red runs to `specs/009-ui-beautification/red-gate-us1.md` with `npx playwright test ... --reporter=list` output.

- [X] T011 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/us1/theme-os-default.spec.ts`. Covers spec US1 AS-1 (first visit follows OS dark) and AS-2 (explicit choice persists). Scenarios: (a) clear storage, mock matchMedia to dark → first paint is dark, no flash captured in trace; (b) toggle to light → reload → still light; (c) toggle to system → flip OS preference → app follows. Uses the `theme` fixture from T007.

- [X] T012 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/us1/theme-toggle-keyboard.spec.ts`. Covers US1 AS-3 (theme flip ≤ 150ms, AA contrast) and AS-6 (keyboard nav). Scenarios: navigate to `/design-system`; Tab to the theme toggle; Space to open; ArrowDown → ArrowDown → Enter to select Dark; assert `<html>` has `dark` class within 150ms (measured via `performance.now()` snapshots). Then assert focus indicator is visible (≥ 3:1 contrast vs background) using a small JS evaluator on the focused element.

- [X] T013 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/us1/design-system-page.spec.ts`. Covers US1 AS-4 (page contains all token groups and primitives). Loops through expected sections (color tokens, type ramp, spacing, radii, motion, components) and asserts each section's heading is present and contains at least one visible swatch / primitive / example. Use anchors `#tokens-colors`, `#tokens-typography`, `#tokens-spacing`, `#tokens-radii`, `#tokens-motion`, `#components-button`, etc. so the page contract is testable.

- [X] T014 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/us1/reduced-motion.spec.ts`. Covers US1 AS-5. Two passes (motion=full and motion=reduce via the T008 fixture); in reduce mode assert that all `[data-motion-decorative]` elements have computed `animation-duration: 0s` and `transition-duration: 0s`.

- [X] T015 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/a11y/design-system.spec.ts` running `axeCheck` against `/design-system` in both themes (use the T007 theme fixture).

- [X] T016 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/contrast/tokens.spec.ts` that visits `/design-system#tokens-colors`, enumerates every documented token pair (light + dark), reads computed colors via `getComputedStyle()`, computes WCAG contrast ratio, and asserts ≥ 4.5 (body) or ≥ 3.0 (large/non-text). The page MUST expose every pair via `data-token-pair="bg:foreground"` attributes; the test relies on this contract.

- [X] T017 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/viewport/375.spec.ts` that visits `/design-system` at 375×667 and asserts `document.documentElement.scrollWidth <= 375` (no horizontal scroll). Cover SC-003 for the design-system route.

- [X] T018 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/keyboard/design-system.spec.ts` that tabs through every interactive element on `/design-system`, asserts focus ring visible on each, and asserts no focus trap occurs except inside any open primitive demo (e.g., Dialog).

- [X] T019 [P] [US1] Create `apps/web/tests/e2e/009-ui-beautification/us1/cross-tab-sync.spec.ts` that opens two browser contexts, toggles theme in context A, asserts context B's theme updates within 1s via the `storage` event (covers theme-toggle.md test #4).

- [X] T020 [US1] Write `specs/009-ui-beautification/red-gate-us1.md` capturing the output of `npx playwright test tests/e2e/009-ui-beautification/us1 tests/e2e/009-ui-beautification/a11y/design-system.spec.ts tests/e2e/009-ui-beautification/contrast tests/e2e/009-ui-beautification/viewport/375.spec.ts tests/e2e/009-ui-beautification/keyboard/design-system.spec.ts --reporter=list` showing all the above as RED (expected failures, since implementation does not exist). Mark each spec → red. Commit. The slice is now in valid red-gate state for US1.

### Implementation for User Story 1

- [X] T021 [US1] Replace `apps/web/app/globals.css` entirely with the new token system. Structure: `@tailwind base; @tailwind components; @tailwind utilities;` followed by `@layer base { :root { ... } .dark { ... } }`. Implement EVERY token in `specs/009-ui-beautification/contracts/design-tokens.md` groups 1–5, with light values under `:root` and dark values under `.dark`. Include the primitive palettes (festival, field, sky, gold, ink ramps), semantic surface tokens, semantic interaction tokens, domain-specific tokens (win/loss/draw/rank-*/open/locked/scored), radii, font tokens, and motion duration/easing tokens. Include `@media print` rules that flatten backgrounds to white and foregrounds to black. Include the `[data-motion="reduce"] *, [data-motion="reduce"] *::before, [data-motion="reduce"] *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }` rule for the motion-provider override. Add `body { color: hsl(var(--foreground)); background: hsl(var(--background)); font-family: var(--font-sans); }`.

- [X] T022 [US1] Update `apps/web/tailwind.config.ts` to: (a) set `darkMode: ["class"]`; (b) extend `theme.colors` to reference EVERY semantic token from T021 via `hsl(var(--<token>))` (e.g., `background: "hsl(var(--background))"`, `primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" }`, `win: "hsl(var(--win))"`, `rank: { up: "hsl(var(--rank-up))", down: "hsl(var(--rank-down))", same: "hsl(var(--rank-same))" }`); (c) extend `theme.borderRadius` to reference `--radius-*`; (d) extend `theme.fontFamily` to reference `--font-sans` and `--font-display`; (e) extend `theme.transitionDuration` and `theme.transitionTimingFunction` to reference motion tokens; (f) keep the existing `content` glob. Verify `npm run build` succeeds.

- [X] T023 [US1] Create `apps/web/app/components/ThemeProvider.tsx`. Client component that wraps `next-themes`' `<ThemeProvider>` with props `attribute="class" defaultTheme="system" enableSystem storageKey="wcm.theme" disableTransitionOnChange={false}`. Export as default. Must obey `specs/009-ui-beautification/contracts/theme-toggle.md` exactly.

- [X] T024 [US1] Create `apps/web/lib/motion.ts` exporting (a) `useReducedMotion(): 'reduce' | 'full'` hook that reads `localStorage.wcm.motion`, falls back to `matchMedia('(prefers-reduced-motion: reduce)')`, and listens to both changes; (b) `setMotionPreference(pref: 'auto' | 'reduce' | 'full')` that writes localStorage and updates `<html data-motion="...">` synchronously. Value space and resolution rules per `specs/009-ui-beautification/data-model.md` Entity 2.

- [X] T025 [US1] Create `apps/web/app/components/MotionProvider.tsx`. Client component that on mount reads `wcm.motion` from localStorage, computes the effective motion preference via `useReducedMotion()` from T024, and writes `data-motion="reduce"` or `data-motion="full"` to `document.documentElement`. Exposes a React context with `motionPref: 'auto' | 'reduce' | 'full'`, `effectiveMotion: 'reduce' | 'full'`, and `setMotionPref(pref)`. Re-renders children on context value changes.

- [X] T026 [US1] Modify `apps/web/app/layout.tsx`: add `suppressHydrationWarning` to `<html>`; add `lang="en"`; wrap `<body>` content with `<ThemeProvider>` (from T023) then `<MotionProvider>` (from T025); add `className={`${fontSans.variable} ${fontDisplay.variable}`}` where the fonts are imported via `next/font/google` (Inter for sans, Manrope for display — declared at the top of the file). Do NOT change the existing metadata export.

- [X] T027 [US1] Vendor the first batch of shadcn primitives into `apps/web/app/components/ui/`. Run from `apps/web/`: `npx shadcn@latest add button card input label badge separator skeleton`. Commit each generated file. After generation, audit each file and replace any hard-coded color references with the project's semantic tokens (e.g., shadcn's `bg-slate-*` → `bg-muted`; `text-slate-900` → `text-foreground`). The components MUST reference ONLY tokens defined in T021/T022.

- [X] T028 [US1] Vendor the second batch of shadcn primitives. Run: `npx shadcn@latest add dialog dropdown-menu popover tooltip tabs toast`. Apply the same token audit as T027. Verify each primitive's keyboard contract matches WAI-ARIA (Radix handles this; spot-check Dialog focus trap and Esc behavior).

- [X] T029 [US1] Vendor the third batch of shadcn primitives. Run: `npx shadcn@latest add table select switch checkbox radio-group sheet command`. Apply the token audit. Verify mobile-friendly behavior of `sheet` (used for the mobile sub-nav in US2).

- [X] T030 [US1] [P] Create `apps/web/app/components/EmptyState.tsx` per `specs/009-ui-beautification/contracts/component-api.md` § EmptyState. Props: `title`, `description`, `icon?` (a `lucide-react` icon), `action?` (label + onClick OR href). Renders centered icon + `<h2>` title + description + optional CTA button (using the shadcn `Button` from T027). Use semantic tokens for all colors.

- [X] T031 [US1] [P] Create `apps/web/app/components/ErrorState.tsx` per contracts § ErrorState. Wraps content in a region with `role="alert"`. Props: `title` (default "Something went wrong"), `description`, `onRetry?`, `correlationId?`. Use the `destructive` token group for the visual treatment.

- [X] T032 [US1] [P] Create `apps/web/app/components/Flag.tsx` per contracts § Flag. Props: `code: string` (ISO-3 code), `size?: 'sm'|'md'|'lg'`, `aria-label?: string`, `className?`. Bundle SVGs in `apps/web/lib/flags/` (vendor from the `flag-icons` set, the 48 FIFA WC 2026 nations only — fetch the list from `docs/architecture/` if available, else use the FIFA 2026 confirmed list). Import each as a React component via a static map `{ ARG: ArgSvg, FRA: FraSvg, ... }`. Render the SVG inline with `role="img"` and the accessible name (default to English country name from a small lookup table). Fallback: when `code` is unknown OR import fails, render a `<span>` chip with the 3-letter code on `bg-muted` `text-muted-foreground`, dimensions matching the requested `size`.

- [X] T033 [US1] Create `apps/web/app/components/ThemeToggle.tsx` per contracts § ThemeToggle. Use shadcn `DropdownMenu` (from T028). Trigger is an icon button with `aria-label="Toggle theme"` showing Sun (light), Moon (dark), or Laptop (system) icon from `lucide-react` based on `theme` from `next-themes`. Three menu items: Light / Dark / System with check icons for the active selection. Calls `setTheme()` from `next-themes`. Must satisfy all assertions in T012.

- [X] T034 [US1] [P] Create `apps/web/app/components/MotionToggle.tsx` per contracts § MotionToggle. Use shadcn `Switch` (from T029). Renders inside a popover or accordion (consumer wraps it). Label "Reduce motion" + sub-line "Respect my system setting" when in `auto`, "Force reduce" when in `reduce`, "Force full" when in `full`. Reads/writes via `MotionProvider` context.

- [X] T035 [US1] Modify `apps/web/app/components/TopNav.tsx`. Preserve all existing functional behavior (auth state display, sign-out, existing nav links). Add: (a) the `<ThemeToggle>` from T033 on the right side of the nav, (b) a user-menu dropdown that includes `<MotionToggle>` in its content. Restyle the nav using `bg-card`, `border-border`, `text-foreground` tokens. On mobile (≤ 768px), collapse the nav into a shadcn `Sheet` triggered by a `lucide-react` `Menu` icon. Touch targets ≥ 44×44px.

- [X] T036 [US1] Create `apps/web/app/design-system/page.tsx`. Public, unauthenticated route. Server component that imports a client wrapper `<DesignSystemClient />` (next task). Page exports a small metadata block: title "Design System — World Cup Madness", description "Tokens and components reference".

- [X] T037 [US1] Create `apps/web/app/design-system/DesignSystemClient.tsx`. Client component (because of theme toggle interaction). Renders sections in this order, each anchored as documented in T013's spec contract:
   1. `#tokens-colors` — render every semantic surface, interaction, and domain token as a swatch pair with `data-token-pair="bg:fg"` attributes that T016 reads.
   2. `#tokens-typography` — type ramp (xs → 4xl), font-sans vs font-display, tabular nums sample.
   3. `#tokens-spacing` — visual spacing scale.
   4. `#tokens-radii` — rounded corner samples.
   5. `#tokens-motion` — duration + easing samples; one decorative element with `data-motion-decorative` for T014's assertion.
   6. `#components-button` through `#components-table` — each shadcn primitive rendered in its common variants in both themes (visual side-by-side).
   7. `#components-domain` — `<Flag>`, `<EmptyState>`, `<ErrorState>`, `<Skeleton>`.
   Page MUST render correctly in light and dark; theme is controlled by the global toggle in the top nav (no local toggle needed).

- [X] T038 [US1] Run the full US1 red-gate suite: `npx playwright test tests/e2e/009-ui-beautification/us1 tests/e2e/009-ui-beautification/a11y/design-system.spec.ts tests/e2e/009-ui-beautification/contrast tests/e2e/009-ui-beautification/viewport/375.spec.ts tests/e2e/009-ui-beautification/keyboard/design-system.spec.ts`. Confirm all green. Iterate (T021–T037) until green. Update `specs/009-ui-beautification/red-gate-us1.md` with the green run output appended below the original red.

- [X] T039 [US1] Run the bundle-budget assertion: `cd apps/web && npm run measure-bundle`. If exceeded, dynamic-import the largest contributor (likely `lucide-react` — verify named imports; or audit Radix primitives — confirm tree-shaking via `npx next-bundle-analyzer` if needed). Document the result in `specs/009-ui-beautification/regression-checkpoint-us1.md` § "Bundle delta".

- [X] T040 [US1] Run the full regression suite from slices 001–008 unchanged on this branch: `cd apps/web && npm run e2e -- --grep "^(?!.*009-ui)"` (or whatever invocation excludes only the new 009 specs). Plus run the pgTAP suite if a npm script for it exists. Confirm zero failures. Write `specs/009-ui-beautification/regression-checkpoint-us1.md` with: timestamp, suite invocation, exit code, summary of pass/fail counts, any flakiness notes, bundle delta from T039. This file gates the US1 merge.

**Checkpoint**: User Story 1 fully functional. `/design-system` is live in both themes, theme + motion preferences work, primitives are vendored, regression suite passes, bundle budget respected.

---

## Phase 4: User Story 2 — Participant core flows redesigned (Priority: P1)

**Goal**: Redesign the participant-facing surfaces (landing/login result, dashboard, predictions, bracket, matches catalog) with the festive aesthetic. Mobile-first at 375×667. Country flags on every match card. Lock-in updates in-place with non-blocking confirmation within 500ms. Loading/empty/error states for every data surface.

**Independent Test**: as an eligible participant on a 375px viewport, walk dashboard → predictions → lock-in → bracket → matches; verify no horizontal scroll; verify lock-in updates in-place with ≤ 500ms confirmation; verify every page has loading/empty/error states. Re-run slice 001–005 E2E suites unchanged — must remain green.

### Red-gate tests for User Story 2 ⚠️

> Write FIRST. Commit red run to `specs/009-ui-beautification/red-gate-us2.md`.

- [X] T041 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/dashboard-mobile.spec.ts` covering US2 AS-1. Sign in as a seeded eligible participant, viewport 375×667, navigate to `/dashboard`. Assert: ranks/movement visible, deadline countdown visible, primary CTA visible if predictions open, leaderboard preview visible, `document.documentElement.scrollWidth <= 375`, every interactive target's bounding box ≥ 44×44px (use `page.locator('[role="button"], a, input').evaluateAll(...)`).

- [X] T042 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/match-card.spec.ts` covering US2 AS-2 (match-card content) and the contracts/component-api.md § MatchCard contract. Assert flags render for both teams, kickoff renders in the user's local TZ (set browser TZ via Playwright `timezoneId` and verify the rendered string), status badge visible, score inputs visible in edit mode.

- [ ] T043 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/lock-in.spec.ts` covering US2 AS-3. Submit a prediction, lock it; assert: card transitions to locked visual state IN PLACE (no `page.waitForNavigation()` fires); toast appears within 500ms of server ack (measure via `performance.now()` from button click to toast `data-state="open"`); no full reload (assert `performance.timing.navigationStart` unchanged). Use a network-replay or staged predictions to make this deterministic.

- [ ] T044 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/bracket-mobile.spec.ts` covering US2 AS-4. Navigate to bracket route at 375px; assert all 48 teams render in group stage layout; assert knockout scaffold present; assert no horizontal scroll outside the designed `data-scroll-region` element if any.

- [ ] T045 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/error-state.spec.ts` covering US2 AS-5. Use Playwright's network interception to fail the predictions fetch with 500; assert the page renders `<ErrorState>` with a retry button and not a blank page or raw error stack.

- [ ] T046 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/slow-network.spec.ts` covering US2 AS-6. Apply Slow 3G + 4× CPU throttle via the Playwright device profile from T010; assert a `<Skeleton>` appears within 1.5s on dashboard load; assert page becomes interactive (test for a clickable primary CTA) within 5s.

- [ ] T047 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/flag-fallback.spec.ts` covering the spec Edge Case "Missing flag asset". Render `<Flag code="XXX" />` on a test harness page; assert the 3-letter chip fallback renders with the same dimensions as the "ARG" flag at the same `size` prop.

- [ ] T048 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/long-names.spec.ts` covering the spec Edge Case "Long display / country name". Use a participant with a 60-character display name and a country with a long English name; assert ellipsis on overflow + tooltip discloses the full value on hover/long-press.

- [ ] T049 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/us2/states-trifecta.spec.ts` covering FR-UI-013 across the participant routes. For each of `/dashboard`, `/matches`, `/leaderboard`, `/me`: (a) staged-empty data → assert `<EmptyState>` visible; (b) staged-error → assert `<ErrorState>` visible with retry; (c) staged-loading (delay 2s) → assert `<Skeleton>` visible during the delay.

- [ ] T050 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/a11y/participant-routes.spec.ts` running `axeCheck` against `/dashboard`, `/matches/[id]`, `/leaderboard`, `/me` in both themes.

- [ ] T051 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/viewport/participant.spec.ts` asserting no horizontal scroll at 375px for every participant route.

- [ ] T052 [P] [US2] Create `apps/web/tests/e2e/009-ui-beautification/keyboard/participant.spec.ts` tabbing through every participant route's interactive surface and asserting focus reachability + visible focus ring.

- [ ] T053 [US2] Write `specs/009-ui-beautification/red-gate-us2.md` capturing all the above as RED. Commit.

### Implementation for User Story 2

- [X] T054 [P] [US2] Create `apps/web/app/components/MatchCard.tsx` implementing the contracts/component-api.md § MatchCard contract exactly. Props: `match`, `prediction?`, `mode: 'view'|'edit'|'admin'`, `onSubmit?`, `onLock?`. Uses `<Card>`, `<Flag>`, `<Input>`, `<Button>`, `<Badge>` from previous tasks. Renders symmetric two-team layout with score inputs in edit mode. Status badge uses `--open`/`--locked`/`--scored` tokens with both color and icon (`Unlock`/`Lock`/`Check` from `lucide-react`). Kickoff time formatted via `Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })`. Loading/empty/error states per contract. Touch targets ≥ 44×44px.

- [ ] T055 [P] [US2] Create `apps/web/app/components/Confetti.tsx` implementing contracts § Confetti. Props: `celebrationKey`, `palette?`, `origin?`. On mount: check `useReducedMotion()`; if `reduce`, set the localStorage marker and return null. Otherwise: read CSS custom properties (`--primary`, `--secondary`, `--accent`, `--gold`) from `:root` via `getComputedStyle(document.documentElement)` to derive the palette; spawn confetti via `canvas-confetti` with `pointer-events: none` on the canvas; mark the key; clean up the canvas after 2s.

- [X] T056 [P] [US2] Redesign `apps/web/app/(participant)/dashboard/page.tsx` (the new participant dashboard introduced by the pending git state). Layout per spec US2 AS-1: ranks card with movement indicator, deadline countdown card, primary CTA "Make your picks" if open predictions exist, leaderboard preview card (top 5 with current user highlighted). Use `<Card>`, `<Skeleton>` for loading, `<EmptyState>` for "no predictions open", `<ErrorState>` for fetch errors. Mobile-first: stack cards vertically below 768px, grid above.

- [X] T057 [P] [US2] Redesign `apps/web/app/(participant)/matches/` route(s). For each match list and match-detail page: use `<MatchCard>` in `view` or `edit` mode. Predictions are listed in the order defined by slice 002. Lock-in handler calls the existing server action / API route from slice 003 unchanged — DO NOT modify the API; only the UI. On lock success: optimistic-update the card to locked state, render a `<Toast>` confirmation, and conditionally mount `<Confetti celebrationKey="...">` if all picks of the match-day are now locked.

- [ ] T058 [P] [US2] Redesign the bracket route `apps/web/app/(participant)/matches/bracket/page.tsx` (create if it doesn't exist; the bracket is part of US2 per spec). 48 teams shown grouped by their group stage. Knockout-round scaffold shown below the groups. On mobile, the knockout scaffold is rendered inside a `data-scroll-region` element with horizontal pan affordance (`<ScrollArea>` from shadcn if available, else a styled overflow container with an explicit hint).

- [X] T059 [P] [US2] Redesign `apps/web/app/(participant)/me/page.tsx`. Show: participant display name, email (read-only), domain, region, the user's pick history with `<MatchCard mode="view">`, the user's accuracy stats (if computed by slice 005). Use the new components. Loading/empty/error states.

- [X] T060 [P] [US2] Redesign `apps/web/app/(participant)/layout.tsx`. Apply the new top nav (already updated in T035). Wrap content in a `<main>` with appropriate padding. Ensure the dark mode background extends edge-to-edge.

- [X] T061 [P] [US2] Redesign `apps/web/app/auth/` pages (sign-in, denied) — the user-facing auth surfaces. Use the festive aesthetic. Keep all functional behavior from slice 001 intact (eligibility predicates, redirect targets). Sign-in page becomes a polished landing with a single `<Button size="lg">` "Sign in with Microsoft". Denied page uses `<ErrorState>` with explanation per slice 001's spec.

- [X] T062 [US2] Run the full US2 red-gate suite green. Iterate. Append green output to `specs/009-ui-beautification/red-gate-us2.md`.

- [X] T063 [US2] Run the bundle-budget check: `npm run measure-bundle`. Document delta.

- [X] T064 [US2] Run the full regression suite from slices 001–005 (predictions-relevant). Confirm zero failures. Write `specs/009-ui-beautification/regression-checkpoint-us2.md`.

**Checkpoint**: Participant flows fully redesigned, mobile-first verified, regression suite green.

---

## Phase 5: User Story 3 — Leaderboard with movement and ties (Priority: P2)

**Goal**: A leaderboard surface that visualizes rank movement, marks ties explicitly, discloses tie-breaker chains, and provides a "jump to my row" affordance.

**Independent Test**: trigger two scoring runs producing a rank change and a tie; open `/leaderboard`; verify every row has a movement indicator, tied rows are grouped/marked, tapping a tie reveals the chain, "jump to my row" scrolls + highlights.

### Red-gate tests for User Story 3 ⚠️

- [ ] T065 [P] [US3] Create `apps/web/tests/e2e/009-ui-beautification/us3/movement-indicator.spec.ts` covering US3 AS-1. Seed two scoring runs with a known delta for the test user; assert `<RankDelta>` renders with correct text + icon + color for up/down/same/new.

- [ ] T066 [P] [US3] Create `apps/web/tests/e2e/009-ui-beautification/us3/ties.spec.ts` covering US3 AS-2. Seed a tied position; assert tied rows display a "Tie" badge; click the badge; assert the tie-breaker disclosure (Popover or Dialog) opens and renders the chain per `docs/architecture/scoring-model.md`.

- [ ] T067 [P] [US3] Create `apps/web/tests/e2e/009-ui-beautification/us3/jump-to-me.spec.ts` covering US3 AS-3. Seed a leaderboard with 100 entries with the current user mid-list; click "Jump to my row"; assert the user's row is scrolled into the viewport with ≥ 2 surrounding rows; assert the row carries `aria-current="true"` and a distinct background tint.

- [ ] T068 [P] [US3] Create `apps/web/tests/e2e/009-ui-beautification/us3/leaderboard-empty.spec.ts` covering US3 AS-4. Configure the tournament with no scoring runs yet; assert `<EmptyState>` renders with explanatory copy + an estimated time of first scoring (read from `tournament_config` if accessible, else a static message).

- [ ] T069 [US3] Write `specs/009-ui-beautification/red-gate-us3.md`. Commit.

### Implementation for User Story 3

- [X] T070 [P] [US3] Create `apps/web/app/components/RankDelta.tsx` per contracts § RankDelta. Props: `current`, `previous`. Renders icon + numeric magnitude + accessible label, color-coded via `--rank-up`/`--rank-down`/`--rank-same`/`--accent` (new). Use `lucide-react` icons `ArrowUp`, `ArrowDown`, `Minus`, `Sparkles` (new).

- [X] T071 [P] [US3] Create `apps/web/app/components/LeaderboardRow.tsx` per contracts § LeaderboardRow. Props: `entry`, `isMe`, `onExpand?`. Renders a `<TableRow>` with rank + `<RankDelta>`, name (with ellipsis + `<Tooltip>` for overflow), score (tabular figures via `font-display`), and a Tie badge when `tiedWith.length > 0` (clickable `<Popover>` trigger). When `isMe`, row has `aria-current="true"` and an `--accent`-tinted background. Row is anchored for "jump to my row" via `data-me-row` attribute.

- [X] T072 [US3] Redesign `apps/web/app/(participant)/leaderboard/page.tsx`. Server fetches the leaderboard from the existing slice 005 API/RPC unchanged. Renders a `<Table>` of `<LeaderboardRow>`s. Sticky header with rank/name/score/movement columns. "Jump to my row" button in a sticky toolbar that scrolls the `[data-me-row]` element into view via `scrollIntoView({ block: 'center' })`. Empty state via `<EmptyState>`. Error state via `<ErrorState>`. Loading via `<Skeleton>` rows.

- [X] T073 [US3] Implement the tie-breaker disclosure component inline in `apps/web/app/(participant)/leaderboard/TieBreakerPopover.tsx`. Reads the tie-breaker chain from the same scoring data already on the page (no new API). Renders the chain as an ordered list with each criterion explained, citing the rule from `docs/architecture/scoring-model.md` (link in the popover footer).

- [X] T074 [US3] Run US3 red-gate suite green. Append green output to red-gate-us3.md.

- [X] T075 [US3] Run regression suite. Write `specs/009-ui-beautification/regression-checkpoint-us3.md`.

**Checkpoint**: Leaderboard fully redesigned with movement, ties, and jump-to-me.

---

## Phase 6: User Story 4 — Admin surfaces redesigned without losing density (Priority: P2)

**Goal**: Redesign admin pages with the new design system but preserve power-user density and add explicit destructive-action confirmations.

**Independent Test**: as an admin, walk the existing acceptance scenarios for slices 006/007/008 in the new UI; row density per 1080p viewport ≥ 80% of pre-redesign baseline; destructive actions require two-step or typed confirmation.

### Red-gate tests for User Story 4 ⚠️

- [ ] T076 [US4] **Baseline measurement task (gate)**: BEFORE writing any redesign, navigate to each admin table page (`/admin/audit`, `/admin/predictions`, `/admin/pending-review`, `/admin/matches`) at 1920×1080 using a Playwright test in `apps/web/tests/e2e/009-ui-beautification/us4/admin-density-baseline.spec.ts`. Count `<tr>` rows visible without scrolling (use `element.getBoundingClientRect()` filtering). Append the counts to `specs/009-ui-beautification/regression-baseline.md` under a new "Admin density baseline" heading. This task MUST be executed against the LATEST main commit (or the pre-T079 state if main has merged this slice incrementally) so the baseline is true.

- [ ] T077 [P] [US4] Create `apps/web/tests/e2e/009-ui-beautification/us4/admin-density.spec.ts` covering US4 AS-2. After T079+ landings, re-run the same row count and assert each is ≥ 80% of the value recorded by T076.

- [ ] T078 [P] [US4] Create `apps/web/tests/e2e/009-ui-beautification/us4/destructive-confirm.spec.ts` covering US4 AS-3. Single-click a destructive button; assert the action does NOT execute (no API call fires); assert a confirmation dialog appears naming the action + entity; provide the confirmation (typed or two-step); assert the action then executes.

- [ ] T079 [P] [US4] Create `apps/web/tests/e2e/009-ui-beautification/a11y/admin-routes.spec.ts` running `axeCheck` against every admin route in both themes — admin surfaces are NOT exempt from the a11y baseline (US4 AS-4).

- [ ] T080 [US4] Write `specs/009-ui-beautification/red-gate-us4.md`. Commit.

### Implementation for User Story 4

- [ ] T081 [US4] Redesign `apps/web/app/admin/layout.tsx`. New top nav for admin context (variant of TopNav from T035 with admin-specific links). Mobile responsive (admin is usually desktop but must not break on mobile).

- [ ] T082 [P] [US4] Redesign `apps/web/app/admin/page.tsx` (admin dashboard). Show summary cards (pending reviews, audit volume, config health) using `<Card>` components. Quick-action buttons. Link to each sub-tool.

- [ ] T083 [P] [US4] Redesign `apps/web/app/admin/audit/` route. Dense `<Table>` (use shadcn `Table` with compact row padding — tailwind class `py-1` on cells instead of the default `py-4`). Preserve existing pagination, filtering, and search from slice 007. No new audit functionality.

- [ ] T084 [P] [US4] Redesign `apps/web/app/admin/predictions/`, `apps/web/app/admin/pending-review/`, `apps/web/app/admin/matches/`, `apps/web/app/admin/finals/` routes. Same density posture. Use `<MatchCard mode="admin">` where appropriate.

- [ ] T085 [P] [US4] Redesign `apps/web/app/admin/config/` route. Forms use shadcn `<Form>` pattern (or `<Input>` + `<Label>` directly). Saving any config emits the existing slice 008 audit event unchanged.

- [ ] T086 [P] [US4] Redesign `apps/web/app/admin/recalc/` and `apps/web/app/admin/denied/` routes. Same posture.

- [ ] T087 [US4] Create `apps/web/app/components/ConfirmDestructive.tsx` — a shared destructive-action confirmation pattern. Renders a `<Dialog>` requiring explicit action: for medium-risk actions, a clearly-labeled "Confirm" button; for high-risk actions (participant deactivation, config rollback), a text input requiring the user to type the affected entity's name verbatim before the confirm button enables. Used by every destructive admin action.

- [ ] T088 [US4] Apply `<ConfirmDestructive>` to every destructive admin action in T083–T086. Audit each admin route for buttons that currently call a destructive endpoint on first click and wrap them. Verify behavior with T078's red-gate.

- [ ] T089 [US4] Run US4 red-gate suite green. Append green output to red-gate-us4.md. The density assertion (T077) MUST pass — if it fails for a specific route, reduce padding or column count until ≥ 80% holds.

- [ ] T090 [US4] Run regression suite from slices 006/007/008. Write `specs/009-ui-beautification/regression-checkpoint-us4.md`.

**Checkpoint**: Admin surfaces redesigned, density preserved, destructive actions safe.

---

## Phase 7: User Story 5 — Celebration & motion polish (Priority: P3)

**Goal**: Lock-in confetti, top-3 entry affordance, post-match score reveal — all motion-aware and one-shot per qualifying event.

**Independent Test**: with motion ON, locking the final pick fires confetti once; entering top-3 fires a one-time affordance; score reveals animate sequentially. With motion OFF, all degrade to static cues.

### Red-gate tests for User Story 5 ⚠️

- [ ] T091 [P] [US5] Create `apps/web/tests/e2e/009-ui-beautification/us5/lock-in-confetti.spec.ts` covering US5 AS-1. Lock the final pick of a match-day; assert a canvas appears; assert canvas is removed after ≤ 2.5s; assert no second canvas appears on a subsequent visit until a new match-day's final pick is locked.

- [ ] T092 [P] [US5] Create `apps/web/tests/e2e/009-ui-beautification/us5/top3-entry.spec.ts` covering US5 AS-2. Seed scoring runs so the test user crosses into rank 3 for the first time; navigate to dashboard or leaderboard; assert a "Welcome to the top 3" affordance renders. Reload; assert it does NOT replay.

- [ ] T093 [P] [US5] Create `apps/web/tests/e2e/009-ui-beautification/us5/score-reveal.spec.ts` covering US5 AS-3 (informational) plus a structural assertion that score-reveal elements have `data-motion-decorative` and use `motion-safe:animate-*` utilities.

- [ ] T094 [P] [US5] Create `apps/web/tests/e2e/009-ui-beautification/us5/reduced-motion.spec.ts` covering US5 AS-3 + AS-4. With reduced motion enabled (T008 fixture), trigger each celebration; assert no canvas spawns, no animation runs, but the equivalent static cue (a textual confirmation, an icon, or a non-animated badge) is present.

- [ ] T095 [US5] Write `specs/009-ui-beautification/red-gate-us5.md`. Commit.

### Implementation for User Story 5

- [ ] T096 [P] [US5] Extend `apps/web/app/components/Confetti.tsx` (from T055) to support additional celebration keys: `match-day-locked-<tournamentId>-<matchDayId>`, `top3-entry-<tournamentId>`, `first-correct-pick-<tournamentId>`. Keep the same prop contract; the key value selects the palette + duration + burst pattern.

- [ ] T097 [P] [US5] Add top-3 entry detection logic in `apps/web/app/(participant)/dashboard/page.tsx` and `apps/web/app/(participant)/leaderboard/page.tsx`. On render, compute whether the current user is in rank ≤ 3 AND was not in rank ≤ 3 on the previous scoring run (data already on the page). If yes AND no `wcm.celebrations.top3-entry-<tournamentId>` marker, mount `<Confetti celebrationKey="top3-entry-...">` AND show a one-shot `<Toast>` "You're in the top 3!".

- [ ] T098 [P] [US5] Create `apps/web/app/components/ScoreReveal.tsx` for post-match reveal animations. Props: `predictions: PredictionWithOutcome[]`. Renders each prediction sequentially with a 150ms stagger (via CSS animation delays); each prediction displays correct/incorrect cue with both color AND icon. Under reduced motion, render all at once with no animation.

- [ ] T099 [US5] Wire `<ScoreReveal>` into the appropriate participant route that shows post-match scoring results. (Identify the route by reading slice 005's plan.md — likely `/me` or a per-match results subpath.) Preserve the existing data fetch.

- [ ] T100 [US5] Run US5 red-gate suite green. Append to red-gate-us5.md.

- [ ] T101 [US5] Run regression suite. Write `specs/009-ui-beautification/regression-checkpoint-us5.md`.

**Checkpoint**: Celebration polish landed, motion-aware, one-shot guarantees verified.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: visual regression baselines, final regression run, documentation, and any final hardening.

- [ ] T102 [P] Establish visual regression baselines. Run `npx playwright test tests/e2e/009-ui-beautification/visual --update-snapshots` to baseline `/design-system` in both themes and one screenshot per user story. Review the generated PNGs and commit them.

- [ ] T103 [P] Update `docs/architecture/README.md` to link `docs/architecture/adr-009-component-library.md` (created in T004) and to add a "Design System" section pointing to `/design-system` (the live route) and `specs/009-ui-beautification/contracts/design-tokens.md` (the normative names list).

- [ ] T104 [P] Add a footer link to `/design-system` from every authenticated layout (modify `apps/web/app/(participant)/layout.tsx` and `apps/web/app/admin/layout.tsx`) so the page is discoverable per SC-010. Link text: "Design System". Place in a small footer bar with link to product help if it exists.

- [ ] T105 [P] Audit `apps/web/app/components/ui/` for any leftover shadcn default class references not aligned with our token system (e.g., `bg-zinc-*`, `bg-slate-*`, hex literals). Replace with semantic tokens. Re-run a11y + contrast suites to confirm no regressions.

- [ ] T106 [P] Audit `apps/web/app/(participant)/` and `apps/web/app/admin/` for inline `style={{ color: '...' }}`, hex literals in `className`, or hard-coded Tailwind color utilities (`bg-red-500`, etc.). Replace with semantic tokens. (Lint rule deferred per research.md R-013 — manual audit is the v1 enforcement.)

- [ ] T107 [P] Audit components for CSS logical properties readiness per spec Edge Case "RTL forward-compatibility". Find `margin-left`/`-right`, `padding-left`/`-right`, `left`/`right` positioning, and `text-align: left/right` usages and replace with `ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`/`text-start`/`text-end` Tailwind utilities where applicable. Does NOT add i18n — only removes blockers for a future i18n slice.

- [ ] T108 Run the FULL regression suite (all slices 001–008 + 009 itself) one final time on the slice's final commit: `cd apps/web && npm run e2e`. Plus run the pgTAP suite if applicable. Confirm zero failures. Write `specs/009-ui-beautification/regression-final.md` with timestamp, suite invocation, exit code, summary, and the final bundle delta from `npm run measure-bundle`.

- [ ] T109 Run `quickstart.md` end-to-end as a sanity walkthrough on the final commit. Note any deviations from the documented behavior. If everything matches, append a "✅ Verified on <date>" line to the bottom of `specs/009-ui-beautification/quickstart.md`.

- [ ] T110 Write `specs/009-ui-beautification/slice-close-summary.md` documenting: shipped user stories, final bundle delta, final a11y scores per route, regression status, ADR status, and any deferred items added to `docs/architecture/open-decisions.md`. Mark the slice "ready for merge".

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1, T001–T008)**: No dependencies — start immediately. T001 MUST be done before T039 (US1 bundle check) because the baseline is its output. T002 MUST be done before T003/T005/T006/T007/T008 (those depend on `npm install` having run).
- **Foundational (Phase 2, T009–T010)**: Depends on Phase 1 (specifically T002).
- **User Story 1 (Phase 3, T011–T040)**: Depends on Phase 2.
- **User Story 2 (Phase 4, T041–T064)**: Depends on User Story 1 (needs the design tokens, primitives, providers, and Flag/Skeleton/EmptyState/ErrorState components). Cannot start until T040's regression checkpoint passes.
- **User Story 3 (Phase 5, T065–T075)**: Depends on US1 + US2 (uses `LeaderboardRow` patterns that share `<Tooltip>` and `<Popover>` from US1; leaderboard surface is part of US2's data structure).
- **User Story 4 (Phase 6, T076–T090)**: Depends on US1 only (admin can ship in parallel with US3 after US2 lands). T076 (baseline) MUST be executed before T077/T079 implementation tasks touch admin layout.
- **User Story 5 (Phase 7, T091–T101)**: Depends on US1 (Confetti, motion provider) AND US2 (lock-in flow) AND US3 (leaderboard for top-3 detection).
- **Polish (Phase 8, T102–T110)**: Depends on all desired user stories. T108 is the final regression gate; T110 is the merge-ready signal.

### User Story Dependency Graph

```
       US1 (P1) — design system + tokens + primitives
        │
        ├──> US2 (P1) — participant flows
        │     │
        │     ├──> US3 (P2) — leaderboard
        │     │
        │     └──> US5 (P3) — celebration polish (also needs US3)
        │
        └──> US4 (P2) — admin (parallel with US3 + US5)
```

US3 + US4 can be staffed in parallel after US2 lands. US5 is last.

### Within Each User Story

- Tests MUST be written and FAILING (red-gate) BEFORE implementation per Constitution Principle IX (NON-NEGOTIABLE).
- Within implementation: shared components (`<Flag>`, `<MatchCard>`, `<RankDelta>`, etc.) before consuming pages.
- Story complete only after green-gate AND regression-checkpoint artifacts written.

### Parallel Opportunities

- **Phase 1**: T003, T004, T005, T006, T007, T008 can run in parallel after T002 completes.
- **Phase 3 red-gate**: T011–T019 can run in parallel.
- **Phase 3 primitive vendoring**: T027, T028, T029 are sequential (the shadcn CLI is interactive). T030, T031, T032 can run in parallel after T027 (they import the Button/etc. from T027).
- **Phase 4 red-gate**: T041–T052 all parallel.
- **Phase 4 implementation**: T054, T055 parallel; T056, T057, T058, T059, T060, T061 mostly parallel (they touch different page files).
- **Phase 5 red-gate**: T065–T068 parallel.
- **Phase 5 implementation**: T070, T071 parallel; T072–T073 sequential (same page).
- **Phase 6**: T077, T078, T079 parallel; T082–T086 parallel.
- **Phase 7 red-gate**: T091–T094 parallel.
- **Phase 7 implementation**: T096, T097, T098 parallel; T099 sequential.
- **Phase 8**: T102, T103, T104, T105, T106, T107 all parallel.

### Within-task parallelism (sub-agents)

Per the user's auto-memory rule, each task is dispatchable to its own subagent. The dependency graph above is the ONLY constraint on parallel dispatch — every [P] task within a phase can be dispatched concurrently with peers in the same phase.

---

## Parallel Example: User Story 1 red-gate

```bash
# Launch all US1 red-gate tests in parallel as separate subagents:
Task: T011 — create theme-os-default.spec.ts
Task: T012 — create theme-toggle-keyboard.spec.ts
Task: T013 — create design-system-page.spec.ts
Task: T014 — create reduced-motion.spec.ts
Task: T015 — create a11y/design-system.spec.ts
Task: T016 — create contrast/tokens.spec.ts
Task: T017 — create viewport/375.spec.ts
Task: T018 — create keyboard/design-system.spec.ts
Task: T019 — create cross-tab-sync.spec.ts
```

When all return green-on-tests-existing (but red-against-implementation), execute T020 sequentially.

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 together)

The spec lists US1 and US2 BOTH as P1 — together they form the MVP. US1 alone delivers a design system but the app's user-facing surfaces still look like pre-slice. US2 alone is not buildable without US1. Therefore the MVP scope is US1 + US2.

1. Complete Phase 1 + Phase 2.
2. Complete Phase 3 (US1) → checkpoint regression green.
3. Complete Phase 4 (US2) → checkpoint regression green.
4. **STOP and demo MVP**: the entire participant flow is redesigned, dark mode works, mobile-first verified.
5. Optional ship at this point if business decides to phase the admin redesign + leaderboard polish later.

### Incremental Delivery (full slice)

1. MVP (US1 + US2) → demo.
2. US3 (leaderboard) → demo.
3. US4 (admin) → demo.
4. US5 (celebration) → demo.
5. Polish (Phase 8) → final regression → merge.

### Parallel Team Strategy

After Phase 2:
- Developer A: US1 (foundational design system). Bottleneck — everyone else waits.

After US1:
- Developer A: US2 (participant flows).
- Developer B: starts US4 (admin) — can proceed in parallel with US2.

After US2:
- Developer A: US3 (leaderboard).
- Developer B: continues US4.
- Developer C (if available): US5 — but US5 needs the leaderboard surface from US3 for top-3 detection, so US5 must follow US3.

Polish phase: any developer, parallel tasks distributed.

---

## Notes

- Every task above is **self-contained** per the auto-memory rule. Each task names its target file paths, references the spec/contract sections it implements, and carries enough context to be dispatched to a subagent without prior conversation.
- [P] tasks within the same phase touch different files and have no inter-dependencies.
- TDD is non-negotiable (Constitution Principle IX). Skipping the red-gate is a constitution violation.
- Regression-gating is non-negotiable (Constitution Principle XI). Skipping the checkpoint artifacts is a constitution violation.
- Bundle budget (+30 KB gzipped vs T001 baseline) is a hard gate. If exceeded, remediate before merge — the budget is not negotiable inside this slice.
- The `apps/web/app/components/ui/` folder is the **frozen surface** going forward — new primitives are added via `npx shadcn@latest add <name>` in the slice that needs them, not retroactively.
- Commit after each task or logical group (red-gate → impl → green-gate is one logical group).
- Stop at any checkpoint to demo the slice's current state — every checkpoint produces a deployable artifact.
