# Contract: Theme Toggle (SSR + Hydration)

**Feature**: 009-ui-beautification
**Status**: Normative — the localStorage key + DOM contract is locked after slice close

This file documents the precise SSR + hydration behavior of the theme system so that future surfaces (new pages, new layouts, embedded views) preserve no-flash, no-mismatch behavior.

---

## Storage contract

- **Key**: `wcm.theme`
- **Value space**: `"light" | "dark" | "system"`
- **Default (when absent)**: `"system"`
- **Write surface**: only the `ThemeToggle` component (via `next-themes`' `setTheme()`).

Future slices MUST NOT introduce additional writers for this key.

---

## DOM contract

- `<html>` carries a `class` attribute. The presence of the class `dark` indicates dark theme is active; its absence indicates light theme.
- `<html>` carries `suppressHydrationWarning` on its React element so that the pre-hydration script's edits to `class` are not treated as a hydration mismatch.
- `<html>` MAY also carry a `style="color-scheme: dark"` or `light` attribute set by the pre-hydration script to coordinate UA-rendered widgets (form controls, scrollbars) with the active theme.

```html
<html lang="en" suppressHydrationWarning class="dark" style="color-scheme: dark">
  ...
</html>
```

---

## Pre-hydration script

`next-themes` injects an inline `<script>` in the document `<head>` BEFORE the React tree. The script is small (sub-KB) and runs synchronously. Its responsibilities:

1. Read `localStorage.getItem('wcm.theme')`.
2. Resolve the effective theme:
   - If value is `"light"` → effective `light`.
   - If value is `"dark"` → effective `dark`.
   - If value is `"system"` OR missing OR unknown → query `window.matchMedia('(prefers-color-scheme: dark)').matches` → effective `dark` if true, else `light`.
3. Set `<html>`'s `class` (`dark` or remove the class) and `style.colorScheme` accordingly.

Because this script runs before paint, the first painted frame already has the correct theme — no flash of incorrect theme.

---

## React-side contract

- The root layout (`apps/web/app/layout.tsx`) wraps the app in `<ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="wcm.theme">` from `next-themes`.
- The `attribute="class"` setting matches the DOM contract above.
- The `storageKey="wcm.theme"` setting matches the storage contract above.
- The `defaultTheme="system"` and `enableSystem` settings preserve the OS-follow default.

Any consumer that needs to *read* the active theme uses `useTheme()` from `next-themes`. Consumers that need to *write* the theme call `useTheme().setTheme(...)`. No other path mutates the theme.

---

## Cross-tab synchronization

`next-themes` listens to the `storage` event so a theme change in tab A propagates to tab B without a reload. This is desirable behavior; consumers MUST NOT add competing listeners.

---

## OS preference change

When the user is on `theme === "system"` (the default) and changes their OS color-scheme preference (e.g., flips macOS dark mode at sunset), the `matchMedia` listener inside `next-themes` updates the DOM class without a reload. The persisted value remains `"system"` — the OS is the source of truth.

When the user is on `theme === "light"` or `"dark"`, OS changes are ignored (the explicit override wins).

---

## SSR rendering

- Server components render with **no** `class="dark"` on `<html>` (they cannot read the client's `localStorage`).
- The pre-hydration script sets the class before the first paint.
- React's `suppressHydrationWarning` tells React not to flag the mismatch on `<html>` when hydration runs.

If a Server Component conditionally renders based on theme, that conditional MUST be moved to CSS or to a Client Component — Server Components do not know the theme.

---

## Streaming / Partial Pre-rendering compatibility

The contract above is compatible with Next.js streaming rendering and Partial Prerendering: the pre-hydration script runs once at document head, before any streamed chunk paints. No additional coordination is required for streamed pages.

---

## Failure modes

| Failure | Behavior | Notes |
|---------|----------|-------|
| `localStorage` is unavailable (private browsing, disabled) | Effective theme falls back to `system`; user's toggle silently no-ops persistence | Acceptable — degrades to OS-following |
| `localStorage` is full | Same as above | Acceptable |
| `localStorage` contains an unknown value | Treated as `system`; overwritten on next legitimate write | Defensive |
| The pre-hydration script is blocked by CSP | First paint may flash (FOUC) | CSP MUST allow inline scripts in `<head>` (Next.js manages this; no app-level CSP changes in this slice) |
| `matchMedia` is unavailable (SSR or very old browsers) | Effective theme falls back to `light` | Mobile Safari 16+ and Chrome Android 110+ support — within target |

---

## Forward compatibility

A third theme (e.g., `"high-contrast"`) can be added by:
1. Adding the class name to the `attribute` mapping in `<ThemeProvider>`.
2. Defining a `:root.high-contrast` selector in `globals.css` that re-binds the semantic tokens.
3. Adding an entry to the `ThemeToggle` menu.

The storage key, the DOM contract (presence of a class on `<html>`), and the writer surface DO NOT change. Consumers continue to reference only semantic CSS tokens.

---

## Test contract

The following are part of the US1 red-gate (`tests/e2e/009-ui-beautification/us1/`):

1. **First-visit-with-OS-dark**: clear storage, mock `matchMedia` to dark → first painted frame is dark, no class flash captured by Playwright tracing.
2. **First-visit-with-OS-light**: same with light.
3. **Override-persists**: toggle to dark, reload → dark; toggle to light, reload → light; toggle to system, reload + flip OS → follows OS.
4. **Cross-tab**: open tab A in dark, open tab B fresh → tab B is dark; toggle tab A to light → tab B becomes light within 1s.
5. **suppressHydrationWarning**: navigate the entire app while toggling theme each route → no console hydration warnings.
6. **CSP smoke**: load the production build → no CSP report for the inline script.
