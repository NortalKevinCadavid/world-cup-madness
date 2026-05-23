# Quickstart: UI Beautification — local verification

**Feature**: 009-ui-beautification
**Audience**: a developer who has just checked out this branch and wants to verify the slice locally.

This guide walks the end-to-end local verification of US1 through US5. It is intentionally executable: every code block is a real command that should run as-is on Windows PowerShell, macOS, or Linux (commands are noted per-platform where they differ).

---

## Prerequisites

1. Node 20.x and a working install of the repo's existing dev environment (see `CLAUDE_START.md`).
2. Supabase local environment up — the existing slice 001 setup works unchanged for this slice.
3. Branch checked out:
   ```sh
   git checkout 009-ui-beautification
   ```
4. Dependencies installed (the slice adds new dependencies; see step 1 below).

---

## 1. Install new dependencies (one time per fresh checkout)

From `apps/web/`:

```sh
npm install
```

This installs the slice's added dependencies. The expected additions in `package.json` are:

- `next-themes`
- `lucide-react`
- `class-variance-authority`
- `clsx`
- `tailwind-merge`
- `canvas-confetti` + `@types/canvas-confetti`
- A subset of `@radix-ui/react-*` packages corresponding to the shadcn primitives vendored under `app/components/ui/`.

If the install fails on `node-canvas` or another native dep, re-run with `npm install --include=dev` once. (`canvas-confetti` is pure-JS — if you see a native build, the wrong package was installed.)

---

## 2. Re-vendor a shadcn primitive (only if you are extending the design system)

The shadcn primitives live in `apps/web/app/components/ui/`. To add a new one (e.g., `tooltip`):

```sh
cd apps/web
npx shadcn@latest add tooltip
```

This writes a file like `app/components/ui/tooltip.tsx`. **Commit the generated file** — it is treated as first-party source.

If `components.json` is missing, run `npx shadcn@latest init` once and commit it.

---

## 3. Run the dev server

```sh
cd apps/web
npm run dev
```

Open <http://localhost:3000>.

---

## 4. Walk the verification path

### 4a. Design system (US1)

1. Navigate to <http://localhost:3000/design-system> — should render even when logged out.
2. Verify the page sections render:
   - Color tokens (groups 2, 3, 4 from `contracts/design-tokens.md`).
   - Typography ramp.
   - Spacing scale.
   - Radii.
   - Motion samples.
   - Component gallery (every primitive in both light and dark themes).
3. Toggle the theme via the top nav toggle. Every surface should flip within ~150ms. No flash of incorrect theme.
4. Open DevTools → Application → Local Storage → `http://localhost:3000`. You should see `wcm.theme` written when you toggle.
5. Reload the page. Theme persists.
6. Change the toggle to `System`. Flip your OS color-scheme preference (macOS: System Settings → Appearance; Windows: Settings → Personalization → Colors). The app should follow the OS.
7. In DevTools → Rendering, enable "Emulate CSS media feature `prefers-reduced-motion`: reduce". Reload `/design-system`. Motion samples should now be static.

### 4b. Participant flows (US2)

1. Sign in as an eligible participant (use the existing local OIDC stub from slice 001's `quickstart.md`).
2. Open DevTools → Toggle device toolbar → 375 × 667 (iPhone SE).
3. Walk: dashboard → predictions → match card → submit a score → lock.
   - Verify: lock-in updates in-place (no page reload).
   - Verify: a confirmation toast appears within ~500ms.
   - Verify: with motion enabled, a confetti burst plays on locking the final pick of the match-day.
4. Navigate to the bracket. Verify no horizontal scroll on 375px (the bracket is allowed to pan horizontally but inside a designed scroll region).
5. Throttle the network to "Slow 3G" + CPU to 4× slowdown. Reload the dashboard. Verify a skeleton appears within 1.5s and the page becomes interactive within ~5s.
6. Disconnect the network. Try to lock a prediction. Verify the error state appears with a retry button — never a blank screen.

### 4c. Leaderboard (US3)

1. Trigger at least two scoring runs (use the existing admin recalc tool from slice 005).
2. Open the leaderboard.
3. Verify every row shows a `RankDelta` indicator (↑ N / ↓ N / − / New).
4. Find a tied position. Verify the tie badge is visible. Click it. Verify the tie-breaker chain is disclosed per `docs/architecture/scoring-model.md`.
5. Tap "Jump to my row". Verify the page scrolls your row into view with surrounding context.
6. As an admin, deliberately delete the only scoring run (or use a tournament with no scoring yet). Open the leaderboard. Verify the empty state appears (never a blank table).

### 4d. Admin flows (US4)

1. Sign in as an admin (use the existing admin grant from slice 006).
2. Walk the existing admin scenarios from slices 006/007/008 in the new UI. Each should complete in the same number of clicks as before.
3. On the audit log table, verify the row density is at least 80% of the pre-redesign baseline (informally: count rows visible at 1920×1080 fullscreen).
4. Trigger a destructive admin action (e.g., a participant deactivation). Verify the confirmation requires explicit two-step or typed confirmation — single-click should not trigger destruction.

### 4e. Celebration polish (US5)

1. With motion ENABLED:
   - Lock the final pick of a match-day. Confetti plays once, ≤ 2s, does not block input. Lock the same match-day again (after a recalc reset): confetti should NOT replay (marker is in `localStorage`).
   - Move into the leaderboard top 3 for the first time. The next dashboard view shows a "broke into top 3" affordance once.
   - View a post-match score reveal. Correct/incorrect picks animate sequentially.
2. With motion DISABLED (DevTools rendering pane → prefers-reduced-motion: reduce):
   - All of the above replay paths show STATIC textual/visual cues — no animation, no canvas spawn.

---

## 5. Run the test suite

From repo root:

```sh
cd apps/web
npm run typecheck
npm run lint
npm run e2e -- tests/e2e/009-ui-beautification
```

For the regression-gate (Constitution Principle XI):

```sh
npm run e2e          # entire suite, including 001-008
```

Expect:
- 0 failures from the entire suite (post-implementation).
- The slice's own a11y sweep reports ≥ 95 score and zero serious/critical violations on every main-flow route.
- The bundle-size check (`npm run measure-bundle`) reports a delta ≤ +30 KB gzipped vs the pre-slice baseline captured in `regression-baseline.md`.

---

## 6. Visual regression baselines

Visual baselines are committed for:
- `/design-system` (both themes)
- One representative screenshot per user story.

Re-baselining is **not** automatic — when a story intentionally changes a baseline, update via:

```sh
npx playwright test tests/e2e/009-ui-beautification/visual --update-snapshots
```

…then review and commit the changed PNGs. Visual diffs without intent are bugs.

---

## 7. Common pitfalls

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Flash of light theme on first paint when OS is dark | Pre-hydration script missing | Ensure `<ThemeProvider attribute="class" enableSystem>` wraps the root layout and `suppressHydrationWarning` is on `<html>` |
| Hydration warning on `<html>` | Missing `suppressHydrationWarning` | Add it to the `<html>` element in `app/layout.tsx` |
| Confetti spawns repeatedly on every visit | Marker not being written before spawn | The `Confetti` component MUST write `localStorage.wcm.celebrations.<key>` BEFORE the canvas spawn |
| Tailwind class for a token doesn't resolve | Token added to `globals.css` but not registered in `tailwind.config.ts` | Add the token to `theme.extend.colors` (or appropriate group) |
| Flag renders as broken image | Asset not vendored | The 3-letter chip fallback should kick in; if it doesn't, the `<Flag>` component is missing fallback logic |
| 200% zoom clips content | Hard-coded `width` in `px` on a text container | Replace with `min-content`, `max-content`, or a `max-w-*` Tailwind utility |
| Bundle exceeds budget | Likely a non-tree-shaken import (e.g., `import * as Icons from 'lucide-react'`) | Use named imports only; dynamic-import large rarely-used primitives |
| Theme switch is slow / janky | A surface has motion or transition on a *non-color* property that recomposites | Audit `transition: all`; restrict to `transition: background-color, color, border-color, fill, stroke` for theme-coupled animations |

---

## 8. Where to go next

- `tasks.md` — the dispatchable task list produced by `/speckit-tasks`. Each task is a self-contained agent prompt.
- `red-gate-us<N>.md` — the red-gate artifact for each user story (created by `/speckit-implement` when the red suite is committed).
- `regression-checkpoint-us<N>.md` — the per-story regression confirmation (created at story merge).
- `regression-final.md` — the slice-close regression confirmation.

When in doubt, the source of truth for any user-facing requirement is `spec.md`; the source of truth for implementation choices is `plan.md` + `research.md`; the source of truth for cross-slice surfaces (token names, component APIs, theme contract) is the `contracts/` folder in this slice.
