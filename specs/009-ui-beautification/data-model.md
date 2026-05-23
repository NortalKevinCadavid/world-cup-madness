# Phase 1 Data Model: UI Beautification

**Feature**: 009-ui-beautification
**Date**: 2026-05-22
**Status**: Phase 1 complete

This slice introduces **no server-side persisted data** and **no schema changes**. Every entity below is client-only state held in the browser's `localStorage` and reflected into the DOM at runtime.

The shapes below are normative — implementations across the slice MUST use these exact key names and value sets so that the design-system page, the theme toggle, the motion provider, and the celebration components agree.

---

## Entity 1 — ThemePreference

**Purpose**: stores the user's chosen visual theme.

**Storage**: `localStorage` key `wcm.theme`.

**Value space**: `"light" | "dark" | "system"`.

**Default**: `"system"` (follow the operating system's `prefers-color-scheme`).

**Write surface**: the `ThemeToggle` component in the top nav. Writes via `next-themes`' `setTheme()`.

**Read surface**:
- `next-themes`'s pre-hydration inline script (DOM contract in [contracts/theme-toggle.md](./contracts/theme-toggle.md)).
- The `ThemeProvider` React context for component code that needs to branch on theme (rare — components SHOULD style via CSS tokens, not theme branching).

**Lifecycle**:
- Created on first explicit user toggle (before that, the value is absent and `"system"` is the effective default).
- Mutated only by `ThemeToggle`.
- Cleared by the user (browser settings); cannot be cleared from app UI in this slice.

**Transitions**: no state machine — any value can transition to any other via the toggle.

---

## Entity 2 — MotionPreference

**Purpose**: stores the user's override for `prefers-reduced-motion`.

**Storage**: `localStorage` key `wcm.motion`.

**Value space**: `"auto" | "reduce" | "full"`.

**Default**: `"auto"` (follow the OS `prefers-reduced-motion` media query).

**Write surface**: a `MotionToggle` component in the user-settings menu (location: top-nav user dropdown). Writes via the `MotionProvider`'s `setMotion()`.

**Read surface**:
- The `MotionProvider` React context (`useReducedMotion()` returns `'reduce' | 'full'`).
- A `data-motion="reduce"` or `data-motion="full"` attribute on `<html>` so CSS can react to the *effective* preference (post-override).

**Resolution**:
```
effectiveMotion =
  motionPref === 'auto'   ? (prefersReducedMotionMedia.matches ? 'reduce' : 'full')
: motionPref === 'reduce' ? 'reduce'
:                           'full'
```

**Transitions**: any value to any other via the toggle.

---

## Entity 3 — CelebrationSeenMarker

**Purpose**: records that a one-time celebration has already been shown to the user, so it does not replay.

**Storage**: `localStorage` keys under the namespace `wcm.celebrations.<key>`. Value is the ISO-8601 timestamp of first display.

**Defined celebration keys** (this slice; extend in future slices):
- `wcm.celebrations.match-day-locked-<tournamentId>-<matchDayId>` — fired when the user locks the final pick of a match-day.
- `wcm.celebrations.top3-entry-<tournamentId>` — fired the first time the user's leaderboard rank crosses into the top 3 in a given tournament.
- `wcm.celebrations.first-correct-pick-<tournamentId>` — fired the first time a user has a fully-correct prediction scored.

`<tournamentId>` namespacing ensures markers reset for the next tournament without manual clearing.

**Write surface**: any component that triggers a celebration MUST mark the key BEFORE spawning the affordance, to prevent double-fire on rapid re-renders.

**Read surface**: the `Confetti` and `CelebrationReveal` components check the key before triggering.

**Lifecycle**:
- Created when a qualifying event first fires for the user.
- Never updated or deleted by the app. The user can clear them via browser settings.
- Acceptable to lose on cache clear — the affordance is delight, not data. This is documented in the spec's "Key Entities" section.

---

## Entity 4 — DesignToken (descriptive only)

This is **not** a runtime entity but the normative cross-slice shape of the token system. Source of truth is [contracts/design-tokens.md](./contracts/design-tokens.md).

Each token has:
- **Name**: a kebab-case identifier scoped to a CSS custom property (`--background`, `--primary`, `--rank-up`, etc.).
- **Role**: a semantic description ("primary background of the app", "color used for upward rank movement", etc.).
- **Light value**: the value when `<html>` has no `.dark` class.
- **Dark value**: the value when `<html>` has the `.dark` class.
- **Tailwind mapping**: the utility Tailwind exposes for this token (e.g., `bg-background`, `text-primary`).

Tokens are organized into:
1. **Primitive palette** (`--festival-50…900`, `--field-50…900`, `--gold`, etc.) — the raw color ramps. NOT referenced by components.
2. **Semantic surface tokens** (`--background`, `--card`, `--popover`, `--border`, `--input`, `--ring`, …) — referenced by every component.
3. **Semantic interaction tokens** (`--primary`, `--secondary`, `--accent`, `--destructive`, `--muted`) — referenced by interactive components.
4. **Domain-specific tokens** (`--win`, `--loss`, `--draw`, `--rank-up`, `--rank-down`, `--rank-same`, `--locked`, `--open`, `--scored`) — referenced by sport-context components.
5. **Spacing, radii, typography, motion duration & easing** — referenced by layout and motion utilities.

Components MUST reference only tokens from groups 2, 3, or 4 — never group 1 directly. This is enforced by code review (lint rule deferred to a future task).

---

## Validation rules

- `wcm.theme`: value MUST be one of `light | dark | system`. Unknown values MUST be treated as `system` (and overwritten on next legitimate write).
- `wcm.motion`: value MUST be one of `auto | reduce | full`. Unknown values MUST be treated as `auto`.
- `wcm.celebrations.<key>`: value MUST parse as an ISO-8601 timestamp. Unparsable values MUST be treated as "marker present" (do not re-fire) — defensive against future shape changes.
- localStorage write failures (private browsing, quota) MUST be silently swallowed; the affordance degrades to "always treated as default", which is the correct conservative behavior.

---

## Storage scope and clearing

- All keys are scoped to the browser-origin.
- A user using two browsers gets two independent preference sets — this is acceptable (R-013 defers cross-device sync).
- A "clear preferences" affordance is **out of scope** for this slice. If a user wants to reset, they clear site data via the browser UI.

---

## Why no server-side schema

Adding server-side persistence for theme/motion preferences would require:
- A new `participant_preferences` table.
- A new RLS policy for self-read/self-write.
- A new write endpoint or RPC.
- New audit semantics (or explicit non-audit policy).

This is meaningful product surface that does not pull its weight in v1: most users do not switch theme across devices, and the localStorage round-trip is zero-latency. If cross-device sync becomes a documented need, a future slice introduces it without disturbing this slice's shapes (the localStorage values become the *cache* layer).
