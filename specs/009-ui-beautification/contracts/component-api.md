# Contract: Component API

**Feature**: 009-ui-beautification
**Status**: Normative — locked surface for components this slice introduces

This file documents the public API of the higher-order, domain-aware components this slice introduces. The shadcn-vendored primitives in `apps/web/app/components/ui/` are documented by shadcn's upstream contracts; only the *project-level* components that compose them are documented here.

For each component:
- **Props**: the named, typed properties.
- **Slots / children**: where consumers can compose.
- **Accessibility contract**: ARIA semantics + keyboard contract.
- **States rendered**: loading / empty / error / data — what must exist visually.

---

## ThemeToggle

`apps/web/app/components/ThemeToggle.tsx`

**Purpose**: lets the user choose `light | dark | system` from the top nav.

**Props**: none. Reads/writes via `next-themes`' `useTheme()`.

**Rendering shape**: a `<DropdownMenu>` triggered by an icon button. Three menu items: "Light" (sun icon), "Dark" (moon icon), "System" (laptop icon).

**Accessibility contract**:
- Trigger button has `aria-label="Toggle theme"` and `aria-haspopup="menu"`.
- Menu items use Radix DropdownMenuItem semantics (`role="menuitem"`, arrow-key nav, Enter/Space activation).
- Active selection is announced via a check icon and `aria-checked="true"`.
- Keyboard-only path: Tab → focuses trigger; Space/Enter → opens; ↑/↓ → cycles items; Enter → selects; Esc → closes.

**Lifecycle invariant**: never causes a full-document reload. State change updates the `.dark` class on `<html>` synchronously and persists `wcm.theme`.

---

## MotionToggle

`apps/web/app/components/MotionToggle.tsx`

**Purpose**: lets the user override `prefers-reduced-motion` from the user menu.

**Props**: none. Reads/writes via the `MotionProvider` context.

**Rendering shape**: a labelled `<Switch>` (Radix) inside the user-menu popover, with text "Reduce motion" and a descriptive sub-line.

**Accessibility contract**: Radix Switch semantics — focusable, Space/Enter to toggle, `aria-checked` reflects state.

**Effective-value contract**: writes update both `localStorage.wcm.motion` and the `data-motion` attribute on `<html>` so CSS reflects immediately.

---

## Flag

`apps/web/app/components/Flag.tsx`

**Purpose**: render a country flag for a participating nation.

**Props**:
- `code: string` — ISO 3166-1 alpha-3 country code (e.g., `"ARG"`, `"FRA"`, `"USA"`). Case-insensitive.
- `size?: "sm" | "md" | "lg"` (default `"md"`) — 16px / 24px / 32px height.
- `aria-label?: string` — overrides the default accessible name; defaults to the English country name resolved from `code`.
- `className?: string` — passthrough for layout/styling.

**Rendering shape**: an inline SVG element with `role="img"` and an accessible name.

**Fallback** (FR-UI-009): when `code` is unknown OR the asset import fails, render a 3-letter chip with the code in the `--muted` background and `--muted-foreground` foreground. Dimensions of the chip MUST match the requested `size` so layout does not shift.

**Accessibility contract**: `role="img"` + `aria-label`. Decorative usage (e.g., next to a redundant text label) MAY set `aria-hidden="true"` instead.

**Lifecycle invariant**: pure render, no side effects, no network requests.

---

## MatchCard

`apps/web/app/components/MatchCard.tsx`

**Purpose**: render a single match in any consumer surface (dashboard, predictions list, bracket, admin).

**Props**:
- `match: MatchView` — the match data shape from the existing server contract (slice 002). Includes both team codes, names, kickoff `timestamptz`, group, status (`scheduled | in_progress | final`).
- `prediction?: PredictionView` — the current participant's prediction for the match, if any. Includes the predicted scores and lock state (`open | locked | scored`).
- `mode: "view" | "edit" | "admin"` — controls which controls are rendered.
- `onSubmit?: (scoreHome: number, scoreAway: number) => Promise<void>` — submit handler. Only consumed in `mode === "edit"`.
- `onLock?: () => Promise<void>` — lock handler. Only consumed in `mode === "edit"`.

**Rendering shape**: a `<Card>` with:
- Both `<Flag>`s + team names + score predictions, laid out symmetrically.
- Kickoff time in the user's IANA timezone (via `Intl.DateTimeFormat`).
- A status badge (`Open` / `Locked` / `Scored` / `Final`) with both color and text/icon — never color-only.
- In `mode="edit"` with `status === "scheduled"` and prediction `state === "open"`: number inputs (or +/- steppers) + a primary "Lock prediction" button.

**States rendered**:
- **Data**: full card with prediction values.
- **Loading**: `<Skeleton>` with the same layout footprint to prevent shift.
- **Empty** (no prediction yet, mode="view"): a clear "No pick yet" affordance with a CTA.
- **Error** (prediction submit failed): inline error with retry button. Card stays interactive.

**Accessibility contract**:
- Card has `role="article"` and `aria-labelledby` pointing to a heading containing both team names.
- Score inputs are `<input type="number">` with explicit `<label>` and min/max attrs.
- Lock button has `aria-describedby` pointing to a help line that explains lock semantics.
- Touch targets ≥ 44×44px (FR-UI-008).

**Lifecycle invariant**: on lock-in success, the card updates in-place — no `router.refresh()`, no `window.location` mutation. The optimistic update displays the locked state within 500ms of server ack (FR-UI-010, SC-007).

---

## LeaderboardRow

`apps/web/app/components/LeaderboardRow.tsx`

**Purpose**: a single row in the leaderboard with movement indicator and tie marking.

**Props**:
- `entry: LeaderboardEntry` — shape from the existing scoring slice (005). Includes `rank`, `participantName`, `score`, `previousRank`, `tiedWith?: number[]`.
- `isMe: boolean` — highlights the row as the current user's.
- `onExpand?: () => void` — opens tie-breaker disclosure if the row is part of a tie.

**Rendering shape**: a `<TableRow>` with cells:
1. Rank + `<RankDelta>` indicator.
2. Participant display name (truncate with tooltip on overflow).
3. Score (tabular figures via `font-display`).
4. Tie indicator (badge "Tie — N way") if `tiedWith.length > 0`.

**Accessibility contract**:
- Row has `aria-current="true"` when `isMe`.
- Tie badge is a button (`role="button"`) when `tiedWith` is non-empty; activating it opens the tie-breaker disclosure (Popover) describing the chain per `docs/architecture/scoring-model.md`.
- Movement indicator carries text + icon + color (`↑ 3`, `↓ 1`, `−`) — never color-only.

**Highlight rendering**: when `isMe`, the row uses `--accent` as a subtle row tint and is anchored as the scroll target for "jump to my row".

---

## RankDelta

`apps/web/app/components/RankDelta.tsx`

**Purpose**: encode rank movement with text + icon + color.

**Props**:
- `current: number` — current rank.
- `previous: number | null` — previous rank, or `null` if this is the first scoring run.

**Rendering shape**:
- If `previous == null` → "New" badge.
- If `current < previous` → `↑ (previous − current)` in `--rank-up`.
- If `current > previous` → `↓ (current − previous)` in `--rank-down`.
- If `current === previous` → `−` in `--rank-same`.

**Accessibility contract**: `aria-label` reads as "Up 3 ranks", "Down 1 rank", "Unchanged", or "New entry".

---

## Confetti

`apps/web/app/components/Confetti.tsx`

**Purpose**: one-shot celebration affordance gated on reduced motion + de-duplicated by key.

**Props**:
- `celebrationKey: string` — the `wcm.celebrations.<key>` to dedupe against. If the key already has a marker, the spawn is skipped.
- `palette?: string[]` — color override; defaults to reading `--primary`, `--secondary`, `--accent`, `--gold` from CSS at runtime.
- `origin?: { x: number; y: number }` — burst origin in viewport coords; defaults to centered.

**Behavior**:
- On mount: checks `useReducedMotion()` — if `"reduce"`, sets the marker and returns `null` (no canvas).
- Otherwise: spawns a confetti burst via `canvas-confetti`, sets the marker, cleans up the canvas after ~2 s.
- NEVER blocks input (canvas has `pointer-events: none`).

**Accessibility contract**: confetti carries no information; it is decorative. Pages MUST also display a textual confirmation of whatever was celebrated (e.g., "All picks locked").

---

## EmptyState

`apps/web/app/components/EmptyState.tsx`

**Purpose**: shared empty-state component used by every data surface.

**Props**:
- `title: string`
- `description: string`
- `icon?: React.ReactNode` — a `lucide-react` icon
- `action?: { label: string; onClick: () => void } | { label: string; href: string }`

**Rendering shape**: centered icon + title + description + optional CTA inside a `<Card>` or borderless wrapper.

**Accessibility**: title rendered as `<h2>` or `<h3>` depending on the consuming page's heading level (consumer passes via composition; default `<h2>`).

---

## ErrorState

`apps/web/app/components/ErrorState.tsx`

**Purpose**: shared error state. Replaces blank pages on data-fetch failure (FR-UI-013).

**Props**:
- `title: string` — default "Something went wrong".
- `description: string` — user-friendly message; MUST NOT leak server error details.
- `onRetry?: () => void` — when present, renders a retry button.
- `correlationId?: string` — optional opaque code for support; rendered small.

**Accessibility**: rendered inside a region with `role="alert"` so screen readers announce on appearance.

---

## Skeleton

`apps/web/app/components/Skeleton.tsx` (re-export of the shadcn primitive)

**Purpose**: tokenized placeholder during data load.

**Props**:
- `className?: string`

**Behavior**: animated pulse on `motion-safe`; static `--muted` background on `motion-reduce`.

---

## Top-level constraints on all components in this slice

1. **No `dangerouslySetInnerHTML`**.
2. **No inline styles** for layout or color (escape hatch only for runtime-computed positions, e.g., confetti origin).
3. **No theme-conditional branching in JSX** — branch via CSS tokens. (Exception: text labels that genuinely differ.)
4. **All numeric / score / time displays use `font-display` with `tabular-nums`** so they do not jiggle on update.
5. **All interactive elements MUST set a visible focus indicator** — Tailwind utility `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background`.
6. **All clickable targets MUST be ≥ 44×44 CSS pixels on touch viewports** (verified via the viewport test).
7. **Every async action MUST surface a loading state** (button spinner, in-place skeleton, or full-section skeleton) — no silent waiting.
