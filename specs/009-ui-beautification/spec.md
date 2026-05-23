# Feature Specification: UI Beautification

**Feature Branch**: `009-ui-beautification`

**Created**: 2026-05-22

**Status**: Draft

**Input**: User description: "Beautiful, festive, March-Madness-for-soccer UI across the entire app — playful aesthetic, dark mode required, mobile-first responsive, an accessible component-primitive library, and a design-system reference page. Stay on the existing web stack and preserve all current functional behavior."

**Architecture anchors**:

- **Cross-cutting presentation slice** — does NOT introduce new functional requirements (FR-001…FR-020); enhances the presentation layer of every existing slice (001–008).
- Touches the UI surface for every §15.x acceptance scenario in `docs/architecture/acceptance-criteria.md`. Functional behavior MUST remain bit-for-bit equivalent; only presentation changes.
- Constitution principles in force:
  - **I. Technology Neutrality** — concrete library choices (component primitives, styling approach, theming engine) are recorded in this slice's `plan.md` and a new ADR, NOT in this spec.
  - **VII. Operational Resilience** — the redesign MUST NOT introduce client-side regressions that block the app on slow networks or older mobile browsers.
  - **IX. TDD via BDD (NON-NEGOTIABLE)** — every user story below has Acceptance Scenarios that drive Gherkin-style tests at the UI layer.
  - **X. Vertical Slice Delivery** — each user story below is independently shippable; the design-system foundation (US1) ships first and unblocks the rest.
  - **XI. Regression-Gated Progress (NON-NEGOTIABLE)** — every prior slice's acceptance scenarios MUST continue to pass after each US lands. A regression checkpoint is part of each story's exit criteria.
- Closes no Open Decisions on its own; surfaces a new decision point (component-library choice) to be resolved during planning and recorded as a new ADR.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Design system foundation & dark mode (Priority: P1)

A developer (or designer) opens the app and navigates to a public `/design-system` route. They see the full visual language of World Cup Madness — color tokens (light + dark), typography ramp, spacing scale, radii, elevation/shadows, the playful palette, the celebration motion samples, and every reusable component (buttons, inputs, dialogs, cards, badges, flag chips, tabs, tables, toasts, skeletons) in both light and dark themes. They flip the theme toggle in the main nav and every surface flips with no flash of unstyled content and no contrast regressions. Their OS-level "prefers reduced motion" setting is respected automatically; they can also override theme and motion preferences from a settings affordance.

**Why this priority**: Nothing else in this slice can ship coherently without a defined token set, a working theme switcher, and the primitive components every other story will compose. This is the foundation; if only this ships, the team still has a documented design system and a working theme — a real, demonstrable artifact.

**Independent Test**: Visit `/design-system`. Verify every documented token and component renders correctly in light and dark themes, that the theme toggle (a) persists the user's choice across reloads, (b) follows OS preference on first visit, and (c) flips every visible surface without unstyled flashes. Verify `prefers-reduced-motion: reduce` disables non-essential motion. Run an automated accessibility audit on the page and confirm score ≥ 95 with zero serious/critical violations.

**Acceptance Scenarios**:

1. **Given** a user visits the app for the first time with no theme preference stored, **When** their operating system advertises dark mode preference, **Then** the app MUST render in dark theme without a flash of light-theme content.
2. **Given** a user has explicitly chosen a theme via the in-app toggle, **When** they reload the page or visit a different route, **Then** the chosen theme MUST persist for that browser, overriding the OS preference, until they clear it.
3. **Given** a user toggles the theme on any page, **When** the toggle is activated, **Then** every visible surface (background, foreground, borders, icons, focus rings, data-viz colors) MUST transition to the new theme within 150ms, and every text/background pair MUST satisfy WCAG AA contrast (4.5:1 for body text, 3:1 for large text and non-text UI components).
4. **Given** a developer visits `/design-system`, **When** the page loads, **Then** it MUST show, at minimum: color tokens with WCAG-AA pairings called out, type ramp with named roles, spacing scale, the primary interactive components (button, input, select, dialog, dropdown, tabs, card, badge, flag chip, toast, skeleton, table row), motion examples, and a copy-paste reference for each.
5. **Given** a user has `prefers-reduced-motion: reduce` set at the OS level OR has selected "reduce motion" in the in-app settings, **When** they interact with elements that would normally animate (hover lifts, page transitions, confetti, score reveals), **Then** non-essential motion MUST be suppressed and replaced with instant state changes or static visual cues.
6. **Given** a keyboard-only user is on any page, **When** they press Tab repeatedly, **Then** focus MUST traverse interactive elements in a logical reading order, the active element MUST display a visible focus indicator with ≥ 3:1 contrast against its background, and no element MUST be focus-trapped except inside an open modal.

### User Story 2 - Participant core flows redesigned (Priority: P1)

A returning eligible Nortal employee opens the app on their phone (375px portrait), authenticates, and lands on a redesigned dashboard that feels festive and World-Cup-themed. They see their open matches, upcoming match cards with both teams' country flags front-and-center, their current standings position, and a clear next-action call to make their predictions. They tap into the prediction screen, pick scores for the next match-day's games, and lock their picks. They get an immediate, in-place visual confirmation of the lock-in (no full page reload) with a celebratory affordance. They navigate to the bracket screen and see all 48 teams, current group standings, and the knockout bracket scaffold. Every screen scales smoothly from 375px to desktop without horizontal scroll.

**Why this priority**: This is the surface every participant lives in. A festive, mobile-first dashboard + predictions + bracket is what makes the redesign visible to the people the product exists for. Ships independently on top of US1's design system.

**Independent Test**: As an eligible participant, sign in on a phone-sized viewport (375×667). Walk the entire participant journey: dashboard → predictions → lock-in → bracket → match catalog. Verify no horizontal scroll at any step, country flags render for every match card, lock-in feedback is in-place (no full reload), and that every existing functional acceptance scenario from slices 001–005 still passes through the new UI.

**Acceptance Scenarios**:

1. **Given** an eligible participant logs in on a 375px-wide viewport, **When** the dashboard renders, **Then** it MUST present (in this priority order): user's standings rank with movement indicator, next match-day deadline with countdown, a "Make your picks" primary CTA if predictions are open, and a leaderboard preview — all without horizontal scroll and with every interactive target ≥ 44×44px touch area.
2. **Given** the participant is on the predictions screen for an open match, **When** they view a match card, **Then** the card MUST display both competing teams with their official country flags, team names, kickoff time in the user's local timezone, the prediction status (open/locked/scored), and inline controls to enter a score prediction.
3. **Given** the participant submits and locks a prediction, **When** the lock action completes, **Then** the card MUST update in-place to the "locked" visual state, a non-blocking confirmation MUST appear (toast or inline cue) within 500ms, and the lock-in MUST trigger a celebratory micro-affordance (subject to the user's reduced-motion preference) — with NO full-page reload.
4. **Given** the participant opens the bracket view, **When** the page renders, **Then** it MUST show all 48 participating teams grouped by their group stage, current group standings (where matches have been played), and the knockout-round scaffold — and on mobile (≤ 768px) MUST adopt a layout that is navigable without zooming or horizontal scroll.
5. **Given** any participant screen, **When** a network or backend error occurs (e.g., scoring service unavailable), **Then** the UI MUST display a clear, friendly error state with a recovery action — never a blank screen, never a raw error stack — and MUST log the error per existing observability requirements.
6. **Given** a participant on a slow connection (Slow 3G profile, throttled CPU 4×), **When** they load the dashboard, **Then** the page MUST show a meaningful skeleton or progressive content within 1.5s and become fully interactive within 5s (excluding the initial JS bundle when uncached on first paint).

### User Story 3 - Leaderboard with movement and ties (Priority: P2)

A participant taps the leaderboard from the dashboard. They see the full standings, but the screen visibly communicates *change*: who climbed since the last scoring run, who fell, who is tied with whom, and where they themselves sit. Ties are visualized as such (not silently broken). When the user scrolls to their own row, the sticky header shows their immediate neighbors, and they can see the tie-breaker chain explained for any tied position when they tap it (per `docs/architecture/scoring-model.md`).

**Why this priority**: Engagement-critical and tightly tied to the "March Madness" feel of the product, but the dashboard preview in US2 already shows a minimum-viable leaderboard. This story upgrades the dedicated leaderboard surface; the product remains usable without it.

**Independent Test**: Trigger a scoring run that causes at least three participants to change rank (including a tie). Open the leaderboard. Verify every changed rank shows a movement indicator (delta + direction), tied positions are visually grouped and labeled as such, the current user's row is highlighted and reachable via a "jump to my row" affordance, and tapping a tied position discloses the tie-breaker chain.

**Acceptance Scenarios**:

1. **Given** the leaderboard has been scored at least twice, **When** a participant opens the leaderboard, **Then** every row MUST show its current rank, score, and a movement indicator (Δ since the previous scoring run) with direction (up/down/no-change) and explicit numeric magnitude.
2. **Given** two or more participants share the same score, **When** the leaderboard renders, **Then** their rows MUST be visually grouped or marked as tied (same rank number, tie indicator visible), AND tapping/clicking the tie MUST reveal the tie-breaker chain per `docs/architecture/scoring-model.md` (no silent tie-breaking).
3. **Given** a participant is viewing the leaderboard, **When** they activate "jump to my row", **Then** the view MUST scroll their row into the viewport with sufficient surrounding context (≥ 2 rows above and below) and visually highlight their row distinctly from all other rows.
4. **Given** the leaderboard is empty (no scoring run completed yet), **When** the participant opens it, **Then** an explanatory empty state MUST appear with the time until first scoring is expected — never a blank table.

### User Story 4 - Admin surfaces redesigned without losing density (Priority: P2)

An admin opens the admin dashboard. The screens are visually consistent with the rest of the app (same tokens, same dark mode, same component primitives) — but designed for power-user efficiency: dense tables, keyboard shortcuts where they existed, multi-row selection where applicable, and unambiguous destructive-action confirmation patterns. The override, audit, and configuration screens remain at least as fast to operate as before the redesign.

**Why this priority**: Admin tooling is internal-only and used by a small operator group, so it gets P2 rather than P1; but it MUST be in scope for "the whole app". Density and scannability are explicit constraints — the festive aesthetic of US2 MUST NOT bleed into admin tables in ways that reduce information density.

**Independent Test**: Walk an admin through the existing acceptance scenarios for slices 006 (overrides), 007 (audit), and 008 (configuration) in the redesigned UI. Time the completion of each scenario; verify each is no slower than the pre-redesign baseline. Verify destructive actions (override, deactivate participant, audit-trail purge if it exists) require explicit, clearly-labeled confirmation with a typed or two-step confirmation pattern.

**Acceptance Scenarios**:

1. **Given** an admin is on the overrides screen, **When** they perform any override action defined in slice 006, **Then** the action MUST complete in the same number of interactions (clicks/keypresses) as the pre-redesign baseline, ±1.
2. **Given** an admin is on any data table (audit log, overrides, participants), **When** the table renders, **Then** it MUST show at least the same information density per viewport-height as the pre-redesign baseline (rows-per-screen at 1080p MUST NOT decrease by more than 20%).
3. **Given** an admin triggers a destructive action, **When** the action is one that cannot be undone or has audit-trail consequences, **Then** the UI MUST present an explicit confirmation that names the action and the affected entity, and MUST require a deliberate confirmation gesture (e.g., explicit click on a clearly-labeled "Confirm" button or typed confirmation) — never a single-click destructive action.
4. **Given** an admin is on the admin dashboard, **When** they view the surface, **Then** it MUST use the same theme system (light/dark), same focus-indicator standard, and same accessibility baseline as the participant surfaces — admin screens are NOT exempt from the accessibility success criteria.

### User Story 5 - Celebration & motion polish (Priority: P3)

The product feels alive at the right moments and quiet the rest of the time. Locking in final picks triggers a confetti or equivalent celebration; entering the top 3 of the leaderboard for the first time triggers a "you broke into the top 3" affordance; a correct prediction reveal in the post-match scoring animation feels rewarding rather than abrupt. None of these moments cost performance: they degrade gracefully under reduced-motion and slow devices.

**Why this priority**: Pure delight layer. The product is fully usable without it; it lands last because it should be tuned on top of a stable design system, not while it's still moving.

**Independent Test**: With reduced-motion OFF: lock a full round of predictions; verify a confetti or equivalent celebration plays once, completes within 2s, and does not block input. Move into the top 3 on the leaderboard for the first time; verify the "broke into top 3" affordance fires once. Open a post-match score reveal; verify the reveal animates the correct/incorrect cues sequentially with a satisfying rhythm. Re-run the same flows with reduced-motion ON: verify that each celebration is replaced by an instantaneous static cue with the same informational content.

**Acceptance Scenarios**:

1. **Given** a participant locks the final pick of a match-day (transitioning from "incomplete" to "all picks in"), **When** the lock action completes, **Then** a celebration affordance MUST play once, MUST complete within 2 seconds, MUST NOT block keyboard or pointer input on the page, and MUST NOT replay on subsequent visits unless the participant locks a new round.
2. **Given** a participant's rank crosses into the top 3 for the first time in the tournament, **When** the next scoring run completes and they next view the leaderboard or dashboard, **Then** a one-time "broke into the top 3" affordance MUST be displayed and recorded so it does not replay.
3. **Given** a user with `prefers-reduced-motion: reduce` (OS or in-app), **When** any of the above celebrations would normally play, **Then** the motion MUST be suppressed and replaced by an equivalent static visual + textual cue carrying the same information.
4. **Given** a low-end device or slow network (Slow 3G + 4× CPU throttle profile), **When** a celebration would play, **Then** the celebration MUST either downgrade to a static cue automatically OR play without dropping the main thread for more than 200ms.

---

### Edge Cases

- **No flag asset for a participating nation**: If a country flag asset is missing, the match card MUST fall back to a stylized 3-letter country code chip with the same dimensions — never broken-image icons or empty space.
- **Long display names or country names**: Names MUST truncate with ellipsis and surface the full value on hover/long-press (tooltip), never wrap-shift the surrounding layout.
- **Right-to-left content**: Out of scope for v1 (English/Latin-script only per the project's existing scope) but the design system MUST NOT bake in left-to-right-only assumptions that would block future RTL support (e.g., hard-coded `margin-left`s where logical properties would do).
- **Print view**: When a user prints a page (Cmd/Ctrl+P), the output MUST be legible (high contrast, no dark backgrounds on paper, no clipped content). Pages need not be designed for print, but MUST NOT print as unreadable.
- **High-zoom (200%)**: At 200% browser zoom on a 1280×800 viewport, no content MUST be clipped, no horizontal scroll MUST appear except inside intentionally horizontal regions (e.g., the bracket), and no interactive element MUST become non-interactable.
- **JavaScript disabled**: Out of scope. The app already requires JS for authenticated functionality; the redesign does not change that posture.
- **Stale tokens between deploys**: If a participant has a tab open during a deploy that ships new design tokens, the worst case MUST be visual inconsistency for that session — never a broken layout.
- **Empty/loading/error states for every data surface**: Every screen that depends on backend data (dashboard, predictions, bracket, leaderboard, audit log, overrides, configuration) MUST have a designed loading state (skeleton), an empty state (with explanation + next action), and an error state (with recovery action). No "white page on slow request".

## Requirements *(mandatory)*

### Functional Requirements

> Numbering is local to this slice (FR-UI-…) to distinguish presentation-layer requirements from the architecture document's FR-001…FR-020.

- **FR-UI-001**: The application MUST provide a coherent visual design system — color tokens, typography ramp, spacing scale, radii, elevation, motion — that is referenced from a publicly reachable `/design-system` route documenting every token and reusable component in both light and dark themes.
- **FR-UI-002**: The application MUST support light and dark themes as first-class equals. Dark theme MUST satisfy WCAG AA contrast (≥ 4.5:1 for body text, ≥ 3:1 for large text and non-text UI components) on every text/background pair shipped to users.
- **FR-UI-003**: A theme toggle MUST be reachable from the main navigation on every authenticated route. The toggle MUST persist the user's chosen theme across sessions on the same browser.
- **FR-UI-004**: On a user's first visit (no stored preference), the application MUST follow the operating system's color-scheme preference and MUST render the chosen theme on first paint without a flash of incorrect theme.
- **FR-UI-005**: The application MUST respect the user's `prefers-reduced-motion` operating-system preference by default, and MUST also expose an in-app override that can independently force reduce-motion on or off.
- **FR-UI-006**: Every interactive element MUST be reachable and operable via keyboard alone, MUST expose an accessible name to assistive technologies, and MUST display a visible focus indicator with ≥ 3:1 contrast against its background when focused.
- **FR-UI-007**: Every screen MUST render usably at 375px wide portrait without horizontal scroll (the bracket is the sole exception, where a horizontal-pan region is permitted but MUST be discoverable and have a documented affordance).
- **FR-UI-008**: Every interactive target on touch viewports MUST be at least 44×44 CSS pixels (per WCAG 2.5.5 / Apple HIG guidance).
- **FR-UI-009**: Every match card and team-referencing UI MUST display the team's official national flag asset, with a documented fallback (3-letter country code chip) when an asset is unavailable.
- **FR-UI-010**: Prediction lock-in MUST update the affected card and any aggregate counters (e.g., "X/Y picks locked") in-place via client-side state update — no full-page navigation or full-document reload — and MUST display non-blocking confirmation feedback within 500ms of the server acknowledging the lock.
- **FR-UI-011**: The leaderboard MUST visualize rank movement (delta and direction) since the previous scoring run, MUST explicitly mark tied positions, and MUST disclose the tie-breaker chain on demand.
- **FR-UI-012**: The leaderboard MUST provide a "jump to my row" affordance that scrolls the current user's row into view with surrounding context.
- **FR-UI-013**: Every screen that depends on backend data MUST define and ship designed loading (skeleton), empty, and error states. No screen MUST display a blank viewport during a pending request or a raw error stack on failure.
- **FR-UI-014**: Destructive admin actions (overrides, participant deactivation, configuration changes with retention or audit consequences) MUST require an explicit confirmation step that names the action and the affected entity. Single-click destruction is prohibited.
- **FR-UI-015**: Admin data tables MUST preserve information density: rows-per-viewport at 1920×1080 MUST NOT decrease by more than 20% relative to the pre-redesign baseline measured before this slice begins.
- **FR-UI-016**: Celebration affordances (lock-in confetti, top-3 entry, score-reveal animations) MUST play at most once per qualifying event, MUST complete within 2 seconds, MUST NOT block input, and MUST downgrade to a static cue when reduced-motion is active or device performance is insufficient.
- **FR-UI-017**: The redesign MUST NOT change any HTTP API contract, database schema, scoring logic, or audit semantics. Every existing acceptance scenario in slices 001–008 MUST continue to pass through the new UI (regression-gated per Constitution Principle XI).
- **FR-UI-018**: The component primitives used for interactive widgets (menus, dialogs, dropdowns, tooltips, tabs, toggle groups, popovers, toasts) MUST follow established WAI-ARIA authoring patterns with keyboard navigation, focus management, and screen-reader announcements built in. (Specific library is a plan-phase decision per Constitution Principle I.)

### Key Entities

This slice introduces no new persisted domain entities. It introduces new client-side concepts that DO NOT require server storage in v1:

- **Theme preference**: A user's chosen visual theme (`light` | `dark` | `system`). Stored per browser. Defaults to `system`. NOT persisted server-side in this slice (deferred to a future slice if cross-device sync becomes a requirement).
- **Motion preference**: A user's motion override (`auto` | `reduce` | `full`). `auto` (default) follows `prefers-reduced-motion`. Stored per browser. NOT persisted server-side.
- **Celebration-seen marker**: Local record of which one-time celebrations a user has already seen (e.g., "broke into top 3 — fired once in tournament T"). Stored per browser. Acceptable to lose on cache clear — the affordance is delight, not data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every main-flow page (landing, login result, dashboard, predictions, bracket, leaderboard, admin dashboard, overrides, audit, configuration, design system) scores ≥ 95 on the automated accessibility audit used in CI, with zero serious or critical violations.
- **SC-002**: Every text/background pair shipped in either light or dark theme satisfies WCAG AA contrast (≥ 4.5:1 body / ≥ 3:1 large + non-text UI). Verified by an automated contrast audit run against the rendered `/design-system` page and every main-flow page.
- **SC-003**: Every main-flow page renders at 375×667 portrait without horizontal scroll. Verified by an automated viewport check across the route set in CI.
- **SC-004**: 100% of interactive elements on main-flow pages are reachable via keyboard tab order, with a visible focus indicator on the active element. Verified by an automated keyboard-traversal test plus manual spot-checks.
- **SC-005**: 100% of acceptance scenarios from slices 001–008 (per `docs/architecture/acceptance-criteria.md`) continue to pass after this slice's user stories land. Verified by re-running the existing acceptance suite at each story's regression checkpoint.
- **SC-006**: Time to first meaningful render on the participant dashboard at the Slow 3G + 4× CPU throttle profile is ≤ 1.5s; time to interactive is ≤ 5s. Measured on the route's CI performance budget.
- **SC-007**: Prediction lock-in confirmation appears in the UI within 500ms of server acknowledgement on a baseline-broadband connection. Measured via an automated end-to-end test.
- **SC-008**: Admin-screen rows-per-viewport at 1920×1080 do NOT decrease by more than 20% relative to the pre-redesign baseline captured at the start of US4. Measured by counting rendered rows in a screenshot comparison.
- **SC-009**: With reduced-motion ON, zero non-essential animations fire on the main flows. Verified by an automated test that toggles the preference and inspects motion-related state.
- **SC-010**: A coherent design-system page exists at `/design-system`, links from the footer of every authenticated page, and is current with every shipped component as of the slice's last user story. Verified by a documentation-completeness check that compares the page's documented components against the codebase's exported component list.

## Assumptions

- **Defaults the user did not explicitly choose, captured here for transparency**:
  - Theme follows OS preference on first visit, then persists the user's explicit choice in browser-local storage; per-user server-side sync is deferred.
  - Motion preference follows `prefers-reduced-motion` by default, with an in-app override stored in browser-local storage.
  - Celebration moments default to: (a) locking the final pick of a match-day, (b) first-time entry into the top 3, (c) post-match score reveal. Tuning the exact trigger set is in scope for US5 and can be adjusted without amending this spec.
  - Country flag assets are bundled locally for the 48 participating nations rather than fetched from a third-party CDN, prioritizing offline-friendly speed and predictable rendering. (Final asset source is a plan-phase decision.)
  - "Mobile-first" floor is 375px portrait (iPhone SE / contemporary low-end Android baseline). Below 375px is a graceful-degradation concern, not a designed target.
  - English/Latin-script only for v1; RTL and i18n are out of scope but MUST NOT be foreclosed by the design system's structure.
- **Stack and component-library choice**: The user has expressed a strong preference for an established, accessibility-first component-primitive library. Per Constitution Principle I, the specific library is recorded as an ADR in this slice's `plan.md`, not in this spec. The spec's requirements are written in capability terms (WAI-ARIA patterns, keyboard nav, focus management) so the library choice is replaceable without changing the spec.
- **Existing functional behavior is the contract**: This slice does not modify backend behavior, scoring logic, audit semantics, or API contracts. Any divergence found during implementation is a bug to be filed against the originating slice, not an in-scope change here.
- **Baseline measurements (for FR-UI-015 and SC-008) are captured before US4 begins**: The first task of US4's implementation must include a screenshot-based measurement of current admin-screen row density, recorded in the slice directory, against which the post-redesign density is compared.
- **Performance budget**: This slice MUST NOT regress the existing performance budget. If introducing the component library or theme system pushes the production JS bundle beyond the budget set in the existing slices' plans, the slice's plan.md MUST include a remediation step (code-splitting, dynamic import, asset pruning) before proceeding.
- **Out of scope (re-stated for clarity)**:
  - Backend logic, scoring algorithm, or API contract changes.
  - Internationalization beyond what already exists.
  - Native mobile apps; responsive web only.
  - Right-to-left support (must not be foreclosed; not designed for v1).
  - Cross-device theme/motion sync (server-side persistence of UI preferences).
  - Public marketing landing page beyond the authenticated app — if a styled public landing exists, it inherits the design system but is not a separate redesign objective.
