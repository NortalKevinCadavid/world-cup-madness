# Regression Baseline: 009-ui-beautification

**Captured at**: 2026-05-22
**Commit SHA**: `088a52ef750d20402bf03a8fab448d7b6d03e43e`
**Branch**: `009-ui-beautification`
**Captured by**: T001 (Phase 1 setup)

This file is the **pre-slice baseline** that subsequent budget checks (T039, T063, T108) compare against. It is **append-only** — augment with admin-density measurements (T076) but do NOT rewrite the pre-slice numbers.

---

## Build environment

| Item | Value |
|------|-------|
| Node | v24.15.0 |
| Package manager | **pnpm** (workspace; `node_modules/.pnpm/` layout detected) |
| Next.js | 14.2.35 |
| React | 18.3.1 |
| Tailwind | 3.4.19 |
| TypeScript | 5.9.3 |
| Build command | `npm run build` (inside `apps/web/`) |
| Build outcome | ✅ Success — all routes compiled |

### Top-level dependencies (`apps/web/`, pre-slice)

- `@playwright/test@1.60.0`
- `@supabase/ssr@0.5.2`
- `@supabase/supabase-js@2.105.4`
- `cmdk@1.1.1`
- `eslint-config-next@14.2.35`
- `eslint@8.57.1`
- `next@14.2.35`
- `postcss@8.5.14`
- `react-dom@18.3.1`
- `react@18.3.1`
- `tailwindcss@3.4.19`
- `typescript@5.9.3`
- `zod@3.25.76`
- `@types/node@20.19.41`, `@types/react@18.3.28`, `@types/react-dom@18.3.7`

---

## Bundle size baseline (pre-slice)

Measured via `node`+`zlib` on every file under `apps/web/.next/static/chunks/`.

| Chunk | Raw (bytes) | Gzipped (bytes) | Role |
|-------|-------------|-----------------|------|
| `1e752f09-efe5fcd7c8c47737.js` | 172,834 | **53,742** | Shared chunk (Supabase + helpers) |
| `642-925a9de48e000af6.js` | 183,404 | 50,546 | Route chunk |
| `framework-bef83a85c94ff7de.js` | 139,981 | 44,947 | Next.js framework |
| `polyfills-42372ed130431b0a.js` | 112,594 | 39,627 | Polyfills |
| `main-0a6905ac2a75755e.js` | 118,917 | 34,629 | Pages router main |
| `507-6a0cc80a0432933e.js` | 124,345 | 31,831 | Shared chunk |
| `451-799751d5b085918a.js` | 46,694 | 15,227 | Route chunk |
| `808-692e2ef1e3de2aee.js` | 58,979 | 13,731 | Route chunk |
| `43938ccf-fda67a2d4a037ce9.js` | 60,226 | 12,722 | Route chunk |
| `913-644ab9ff11c58357.js` | 26,049 | 8,693 | Route chunk |
| `webpack-f72737708a70af8b.js` | 3,729 | 1,737 | Webpack runtime |
| `main-app-a01b7486fcd82bd6.js` | 463 | 216 | App-router bootstrap (tiny) |
| **TOTAL** | **1,048,215** | **307,648** | |

### First Load JS (per the Next.js build output)

```
+ First Load JS shared by all                             87.3 kB (raw)
  ├ chunks/1e752f09-efe5fcd7c8c47737.js                   53.6 kB (raw)
  ├ chunks/507-6a0cc80a0432933e.js                        31.7 kB (raw)
  └ other shared chunks (total)                           1.95 kB (raw)
```

In gzipped terms, "First Load JS shared by all" is approximately **31.8 kB gzipped** (the 1e752 chunk has plenty of unused Supabase code that gzips well).

### Per-route raw page sizes (from Next.js build output)

| Route | Raw | First Load JS |
|-------|-----|---------------|
| `/auth/denied` | 157 B | 87.5 kB |
| `/dashboard` | 181 B | 96.2 kB |
| `/leaderboard` | 647 B | 151 kB |
| `/matches` | 2.79 kB | 90.1 kB |
| `/me/breakdown` | 157 B | 87.5 kB |
| `/me/finals` | 18.8 kB | 106 kB |

The slice's hard budget assertion: **total chunk gzipped size MUST NOT exceed baseline + 30,720 bytes (30 KB)** = **338,368 bytes gzipped** ceiling.

---

## Pre-slice route inventory

Pre-existing routes that the redesign will retheme without changing behavior:
- `/` (root — landing/sign-in)
- `/dashboard` (now lives at `/(participant)/dashboard` after the slice-001 follow-up commit `6c91383`)
- `/leaderboard`
- `/matches`, `/matches/[id]` (if any)
- `/me`, `/me/breakdown`, `/me/finals`
- `/auth/denied`, `/auth/callback`
- `/admin`, `/admin/audit`, `/admin/config`, `/admin/denied`, `/admin/finals`, `/admin/matches`, `/admin/pending-review`, `/admin/predictions`, `/admin/recalc`
- `/api/me`, `/api/me/predictions`, `/api/me/final-predictions`, `/api/peer-pick/[match_id]`, `/api/peer-final-pick/[participant_id]`, `/api/players`, `/api/predictions`, `/api/teams`, `/api/auth/signout`

Slice 009 will ADD: `/design-system` (new public route).

---

## Admin density baseline (placeholder — populated by T076)

> T076 (Phase 6 prerequisite) will append admin-table row-count measurements at 1920×1080 here. The post-redesign measurements (T077) must be ≥ 80% of these values.

| Route | Visible `<tr>` rows at 1920×1080 (pre-slice) | To be measured by T076 |
|-------|----------------------------------------------|-------------------------|
| `/admin/audit` | _TBD_ | T076 |
| `/admin/predictions` | _TBD_ | T076 |
| `/admin/pending-review` | _TBD_ | T076 |
| `/admin/matches` | _TBD_ | T076 |

---

## Notes for future budget checks

- **Track total chunk gzipped**, not just the `main-app-*` chunk (which is a 216-byte bootstrap and not representative). The original T001/T005 framing of "main-app-* chunk" was wrong; the meaningful budget is the SUM of all `.next/static/chunks/*.js` gzipped.
- **Compare like-with-like**: post-slice builds MUST use the same `next build` command + same Node version (v24.x).
- **Be aware of `cmdk` already being present** — the slice's primitive set may reuse it; do not double-count if shadcn vendors a command primitive that imports `cmdk`.
- **pnpm note**: this is a pnpm workspace. Use `pnpm install` / `pnpm add` going forward; mixing `npm install` may reshape the lockfile.
