# Contract: Design Tokens

**Feature**: 009-ui-beautification
**Status**: Normative — locked cross-slice surface after this slice ships

This file documents the design-token names this slice introduces and their semantics. Token **names** are locked after slice close: future slices MUST NOT rename them. Token **values** (specific colors, durations) are mutable — a future re-skin can change values without touching consumer code.

Tokens are defined as CSS custom properties in `apps/web/app/globals.css` and mapped to Tailwind utilities in `apps/web/tailwind.config.ts`.

---

## Token groups

1. **Primitive palette** — raw color ramps. NOT consumed by components.
2. **Semantic surface tokens** — backgrounds, foregrounds, borders, inputs.
3. **Semantic interaction tokens** — primary, secondary, accent, destructive, muted, ring.
4. **Domain-specific tokens** — sport-context: win/loss/draw, rank movement, prediction states.
5. **Spacing, radii, typography, motion** — geometric and temporal tokens.

---

## 1 — Primitive palette (illustrative, exact values tuned in implementation)

These are the source ramps from which semantic tokens derive. They are documented here for reference; **components MUST NOT reference these names directly**.

| Family | Light/dark agnostic | Notes |
|--------|----------------------|-------|
| `--festival-50` … `--festival-900` | 10-step OKLCH ramp, vibrant primary hue (festival red/orange) | The "World Cup energy" hue |
| `--field-50` … `--field-900` | 10-step OKLCH ramp, deep green ("field" reference) | Pitch / secondary action |
| `--sky-50` … `--sky-900` | 10-step ramp, accent blue | Cool secondary |
| `--gold` | Single value, accent metal | Top-3 / trophy highlights |
| `--ink-50` … `--ink-900` | 10-step ramp, neutral grays (warm undertone) | Text / surfaces |

Implementation note: prefer OKLCH where the browser supports it (`@supports (color: oklch(0% 0 0))`) with sRGB fallback. This is internal to the token file — consumers see only the semantic layer.

---

## 2 — Semantic surface tokens

Every token has a light value (when `<html>` has no `.dark` class) and a dark value (when `<html>` has `.dark`). All text/background pairings MUST satisfy WCAG AA (≥ 4.5:1 body, ≥ 3:1 large/non-text).

| Token | Role | Tailwind utility | Light → Dark mapping |
|-------|------|------------------|----------------------|
| `--background` | App-level background | `bg-background` | `ink-50` → `ink-900` |
| `--foreground` | App-level body text | `text-foreground` | `ink-900` → `ink-50` |
| `--card` | Card / panel background | `bg-card` | `white` → `ink-800` |
| `--card-foreground` | Text on cards | `text-card-foreground` | `ink-900` → `ink-50` |
| `--popover` | Popover / dropdown background | `bg-popover` | `white` → `ink-800` |
| `--popover-foreground` | Text in popovers | `text-popover-foreground` | `ink-900` → `ink-50` |
| `--border` | Standard border color | `border-border` | `ink-200` → `ink-700` |
| `--input` | Form input border | `border-input` | `ink-300` → `ink-600` |
| `--ring` | Focus ring (≥ 3:1 contrast vs both backgrounds) | `ring-ring` | `festival-500` → `festival-400` |

---

## 3 — Semantic interaction tokens

| Token | Role | Tailwind utility | Light → Dark mapping |
|-------|------|------------------|----------------------|
| `--primary` | Primary CTA background (the festive accent) | `bg-primary` | `festival-600` → `festival-500` |
| `--primary-foreground` | Text on primary | `text-primary-foreground` | `white` → `ink-50` |
| `--secondary` | Secondary CTA background | `bg-secondary` | `field-600` → `field-500` |
| `--secondary-foreground` | Text on secondary | `text-secondary-foreground` | `white` → `ink-50` |
| `--accent` | Tertiary highlight (badges, "new", etc.) | `bg-accent` | `sky-500` → `sky-400` |
| `--accent-foreground` | Text on accent | `text-accent-foreground` | `ink-900` → `ink-50` |
| `--muted` | Subdued surface (skeletons, disabled) | `bg-muted` | `ink-100` → `ink-700` |
| `--muted-foreground` | Subdued text | `text-muted-foreground` | `ink-600` → `ink-300` |
| `--destructive` | Destructive action background | `bg-destructive` | `red-600` → `red-500` |
| `--destructive-foreground` | Text on destructive | `text-destructive-foreground` | `white` → `ink-50` |

---

## 4 — Domain-specific tokens

| Token | Role | Tailwind utility |
|-------|------|------------------|
| `--win` | A correct prediction / a winning team | `bg-win`, `text-win` |
| `--loss` | An incorrect prediction / a losing team | `bg-loss`, `text-loss` |
| `--draw` | A draw outcome | `bg-draw`, `text-draw` |
| `--rank-up` | Rank moved up since last scoring run | `text-rank-up`, `bg-rank-up` |
| `--rank-down` | Rank moved down | `text-rank-down`, `bg-rank-down` |
| `--rank-same` | Rank unchanged | `text-rank-same` |
| `--locked` | A locked prediction surface tint | `bg-locked`, `border-locked` |
| `--open` | An open prediction surface tint | `bg-open`, `border-open` |
| `--scored` | A scored prediction surface tint | `bg-scored`, `border-scored` |

Values must NOT rely on color alone — the corresponding components must also include an icon and/or text label so colorblind users can distinguish the state. (Verified by SC-001 axe sweep.)

---

## 5 — Spacing, radii, typography, motion

### Spacing scale

Uses Tailwind's default 4px-based scale (`1` = 0.25rem, `2` = 0.5rem, etc.). No additions in this slice. Layout components SHOULD prefer multiples of `2` (8px) for visual rhythm.

### Radii

| Token | Tailwind utility | Value |
|-------|------------------|-------|
| `--radius-sm` | `rounded-sm` | 0.25rem |
| `--radius` | `rounded` (default) | 0.5rem |
| `--radius-md` | `rounded-md` | 0.625rem |
| `--radius-lg` | `rounded-lg` | 0.75rem |
| `--radius-xl` | `rounded-xl` | 1rem |
| `--radius-full` | `rounded-full` | 9999px |

shadcn primitives default to `rounded-md`; this slice overrides to `rounded-lg` for a softer playful feel — change made in the token definition, not per-component.

### Typography ramp

| Token | Tailwind utility | Use |
|-------|------------------|-----|
| `--font-sans` | `font-sans` | Default body — system stack with a playful display fallback (Inter / Manrope / system) |
| `--font-display` | `font-display` | Numerics on the leaderboard / score reveals — tabular figures, slightly heavier weight |

| Tailwind size | Use |
|---------------|-----|
| `text-xs` | Microcopy, badge text |
| `text-sm` | Default body on mobile |
| `text-base` | Default body on desktop |
| `text-lg` | Card headings |
| `text-xl` | Section headings |
| `text-2xl` | Page headings on mobile |
| `text-3xl` | Page headings on desktop |
| `text-4xl` | Hero — landing + design system |

### Motion tokens

| Token | Use |
|-------|-----|
| `--motion-duration-fast` | 100ms — micro-interactions (button press, focus ring) |
| `--motion-duration-base` | 150ms — theme switch, hover, card lift, dropdown |
| `--motion-duration-slow` | 300ms — page transitions, dialog enter/exit |
| `--motion-duration-deliberate` | 600ms — score reveal |
| `--motion-easing-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` — most transitions |
| `--motion-easing-emphasis` | `cubic-bezier(0.2, 0, 0, 1)` — celebrations, reveals |
| `--motion-easing-exit` | `cubic-bezier(0.4, 0, 1, 1)` — exits |

Every motion utility MUST be gated on `motion-safe:` so it is suppressed under reduced motion.

---

## Theming contract

- The single switch between light and dark themes is the presence (or absence) of the `.dark` class on `<html>`.
- The pre-hydration inline script from `next-themes` sets this class before React hydrates.
- A token defined in `:root` is the light value; the same token redefined in `.dark` is the dark value.
- A third theme (e.g., `high-contrast`) can be added by introducing a third class without changing this contract — consumers continue to reference the semantic name only.

## Bundle and runtime guarantees

- Tokens are pure CSS — zero JS bundle cost.
- Switching themes resolves all tokens in < 150ms across the entire viewport (US1 AS-3).
- No component MAY hard-code a hex color, an RGB value, or a Tailwind primitive color utility (`bg-red-500`, etc.). Code review enforces.

## Cross-slice locked-name list

The following names are **locked** after slice 009 closes — future slices MUST NOT rename them:

`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`, `--muted`, `--muted-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, `--win`, `--loss`, `--draw`, `--rank-up`, `--rank-down`, `--rank-same`, `--locked`, `--open`, `--scored`, `--radius-sm`, `--radius`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full`, `--font-sans`, `--font-display`, `--motion-duration-fast`, `--motion-duration-base`, `--motion-duration-slow`, `--motion-duration-deliberate`, `--motion-easing-standard`, `--motion-easing-emphasis`, `--motion-easing-exit`.

Future slices MAY add new tokens; they MAY change the *values* of locked tokens (re-skin); they MUST NOT remove or rename them.
