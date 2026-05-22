# Contract: Admin UI Surface (`/admin/*`)

**Slice**: 006-admin-overrides
**Date**: 2026-05-17
**Status**: Phase 1 (Plan).

The admin-side Next.js page tree. Every page is server-rendered with a `requireAdmin(client)` gate at the top; on denial → 403 redirect or denial screen.

## Page tree

```
/admin                             — dashboard
/admin/matches                     — list + filter matches
/admin/matches/[id]                — match detail + actions
/admin/finals                      — tournament_award correction
/admin/predictions/[participant]   — search + view participant predictions; admin submit
/admin/recalc                      — trigger recalc + watch live status
/admin/audit                       — search audit_log filtered to source='admin_rpc' + free-text
/admin/pending-review              — match_pending_review open rows
/admin/denied                      — 403 denial screen (server-rendered)
```

## Common server-side gate

```typescript
// apps/web/app/admin/layout.tsx
import { requireAdmin } from '@/lib/auth/requireAdmin';
import { redirect } from 'next/navigation';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const client = createServerClient(...);
  try {
    await requireAdmin(client);
  } catch {
    redirect('/admin/denied');
  }
  return <div className="admin-shell">{children}</div>;
}
```

Each page additionally re-checks `requireAdmin` for defense-in-depth (Next.js layouts run independently of pages).

## `/admin` — dashboard

### Server data fetch

- `pending_review_count`: `SELECT count(*) FROM match_pending_review WHERE reviewed_at IS NULL`
- `recent_overrides`: `SELECT * FROM audit_log WHERE source = 'admin_rpc' ORDER BY occurred_at DESC LIMIT 10`
- `last_recalc`: `SELECT * FROM score_calculation_runs ORDER BY started_at DESC LIMIT 1`
- `pending_recalc_state`: `SELECT * FROM pending_recalc_state` (the VIEW)
- `current_admin_count`: `SELECT count(*) FROM admin_roles WHERE revoked_at IS NULL`

### Rendered layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ World Cup Madness — Admin                                            │
├──────────────────────────────────────────────────────────────────────┤
│ [Banner if pending_recalc_state.recalc_pending = true]               │
│ "Configuration changed — recalculation pending"  [Trigger Recalc]    │
├──────────────────────────────────────────────────────────────────────┤
│ ┌───── Open Pending Review ─────┐  ┌───── Recent Overrides ──────┐  │
│ │ N rows open                    │  │ 10 recent admin actions     │  │
│ │ → /admin/pending-review        │  │ → /admin/audit              │  │
│ └────────────────────────────────┘  └─────────────────────────────┘  │
│                                                                       │
│ ┌───── Last Recalc ─────────────┐  ┌───── Admin Roster ──────────┐  │
│ │ scope=all, started=T, status=…│  │ N active admins             │  │
│ │ → /admin/recalc               │  │ (Slice 008 admin UI ships)  │  │
│ └────────────────────────────────┘  └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-dashboard-eligible-admin.spec.ts` | Sign in as admin; assert dashboard renders with expected sections |
| `slice-006-admin-dashboard-eligible-non-admin.spec.ts` | Sign in as eligible non-admin; visit `/admin` → redirect to `/admin/denied` + audit row |
| `slice-006-admin-dashboard-recalc-pending-banner.spec.ts` | Mutate a scoring-config row; banner appears within 5 seconds |

---

## `/admin/matches` — list + filter

### Server data fetch

Same as Slice 002's `/matches` endpoint but with admin-visible columns: status, kickoff, last_synced_at, has_pending_review (LEFT JOIN match_pending_review), has_admin_override (LEFT JOIN audit_log filter). Sortable, filterable.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-matches-list-200.spec.ts` | Admin → 200 + list rendered |
| `slice-006-admin-matches-filter-by-pending.spec.ts` | Filter to only matches with pending review |

---

## `/admin/matches/[id]` — match detail + actions

### Server data fetch

- Match details + match_results (if exists).
- All audit_log rows for this match (with `entity_id = match_id`).
- All match_pending_review rows for this match.
- All `predictions` for this match (admin can see all per RLS).

### Actions

- "Correct Score" form → POST `/api/admin/match-results` → `admin_record_match_result`.
- "Update Status / Kickoff" form → POST `/api/admin/matches/[id]` → `admin_update_match`.
- "Trigger Recalc for This Match" button → POST `/api/admin/recalc` with `scope='match'` → `admin_trigger_recalc`.
- "View Predictions" link → `/admin/predictions?match_id=<id>`.

Each form requires reason + source_citation; client-side validation matches server-side ERRCODE expectations.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-match-correct-score-happy.spec.ts` | Fill form, submit → 200 + audit row + Slice 005 recalc fires |
| `slice-006-admin-match-correct-score-missing-reason.spec.ts` | Empty reason → 400 inline error |
| `slice-006-admin-match-update-status-postponed.spec.ts` | Update status to 'postponed' → 200 + Slice 003 fan-out trigger fires for active predictions |

---

## `/admin/finals` — tournament_award correction (US3)

### Server data fetch

- Single `tournament_award` row.
- Recent audit_log rows for tournament_award changes.

### Actions

- Per-item form (champion, runner_up, top_scorer, best_player) → POST `/api/admin/tournament-award` → `admin_update_tournament_award`.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-finals-correct-top-scorer.spec.ts` | Correct top_scorer; assert Slice 005 scope='finals' recalc fires for all participants |
| `slice-006-admin-finals-confirm-pending.spec.ts` | Flip best_player status from 'pending' to 'confirmed'; recalc + reason audit |

---

## `/admin/predictions/[participant]` — participant prediction view + admin submit

### Server data fetch

- Participant profile (basic).
- All predictions (active + history) per RLS admin-read.
- All final_predictions (active + history).

### Actions

- "Submit Prediction on Behalf" form → POST `/api/admin/predictions` → `admin_submit_prediction`.
- "Submit Final Prediction on Behalf" form → POST `/api/admin/final-predictions` → `admin_submit_final_prediction`.

Forms surface "bypass lock?" affordance for locked matches/post-first-kickoff; the bypass requires extra confirmation.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-prediction-bypass-locked-match.spec.ts` | Locked match; admin submits with confirmation → 200 |
| `slice-006-admin-prediction-without-confirmation-rejected.spec.ts` | Locked match without bypass confirmation → 400 inline error |

---

## `/admin/recalc` — trigger + watch live

### Server data fetch

- Last 10 `score_calculation_runs`.
- `pending_recalc_state` view.

### Actions

- "Trigger Full Recalc" → POST `/api/admin/recalc` with `scope='all'`.
- Live status: Supabase Realtime subscription to `score_calculation_runs` (Slice 005 already publishes inserts/updates).

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-recalc-full-happy.spec.ts` | Trigger scope='all'; watch status transitions (running → succeeded) via Realtime |
| `slice-006-admin-recalc-concurrent-blocked.spec.ts` | Trigger second recalc while first is running → 409 |
| `slice-006-admin-recalc-resumes-after-interrupt.spec.ts` | Kill Edge Function mid-run; reaper job re-POSTs within 30s; assert resume |

---

## `/admin/audit` — admin action log

### Server data fetch

- Paginated `audit_log` filtered to `source = 'admin_rpc'` (and/or `action LIKE 'admin.%'`).
- Filters: actor (admin participant), action, target entity_type, date range, free-text search on reason + source_citation.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-audit-search-by-actor.spec.ts` | Filter by admin participant; assert results |
| `slice-006-admin-audit-search-free-text.spec.ts` | Free-text search on `reason` |

---

## `/admin/pending-review` — Slice 002 quarantine resolution

### Server data fetch

- `SELECT * FROM match_pending_review WHERE reviewed_at IS NULL ORDER BY observed_at DESC`.
- For each row: JOIN to matches for context.

### Actions

- Per-row resolution buttons (accept_provider / reject_provider / manual_override) → POST `/api/admin/pending-review/[id]` → `admin_resolve_match_pending_review`.

### Test surface

| File | Test |
|---|---|
| `slice-006-admin-pending-accept-provider.spec.ts` | Pre-state: pending row; click "Accept Provider"; matches row updates; review marked resolved |
| `slice-006-admin-pending-reject-provider.spec.ts` | Click "Reject Provider"; matches unchanged; review marked resolved with `resolution='reject_provider'` |

---

## `/admin/denied` — denial screen

Static page rendered for:
- Non-admin participants who reach `/admin/*` directly.
- Admins whose `admin_roles` row was revoked mid-session (next request lands here).

### Content

"You don't have administrator access for this application. If you believe this is an error, contact the tournament organizer."

No detail about who the admins are. No "request access" form in this slice (Slice 008 may add).

---

## `requireAdmin(client)` helper

```typescript
// apps/web/lib/auth/requireAdmin.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireEligible } from './requireEligible';
import type { Participant } from '../types/participant';

export class AdminAccessDeniedError extends Error {
  constructor() { super('AdminAccessDenied'); }
}

export async function requireAdmin(client: SupabaseClient): Promise<Participant> {
  const participant = await requireEligible(client);   // Slice 001's helper
  const { data: isAdmin, error } = await client.rpc('is_admin', {
    p_uid: participant.auth_user_id,
  });
  if (error || !isAdmin) {
    // Write audit_log row
    await client.from('audit_log').insert({
      actor: participant.id,
      action: 'admin.access_denied',
      entity_type: 'admin_attempt',
      reason: error ? 'is_admin_rpc_failed' : 'not_admin',
      source: 'api_guard',
    }).select();
    throw new AdminAccessDeniedError();
  }
  return participant;
}
```

The audit-write may fail under RLS — the Slice 006 migration ships an INSERT policy on `audit_log` for the `authenticated` role specifically scoped to `admin.access_denied` rows with `actor = caller's participants.id` (analogous to Slice 001 / 003 patterns).

## Cross-slice contract summary

| Surface | Locked? |
|---|---|
| Admin route tree URL pattern (`/admin/*`) | **Locked** (Slice 008 may add `/admin/config/*` sub-pages) |
| `requireAdmin(client)` helper signature | **Locked** |
| Route handler ERRCODE → HTTP mapping table | **Locked** per WAR01-06 |
| Cache-Control: `no-store` on every admin POST/GET | **Locked** |
| Realtime subscription channel `score_calculation_runs` | **Locked** (Slice 005 produces; this slice consumes; Slice 008 may also consume) |
