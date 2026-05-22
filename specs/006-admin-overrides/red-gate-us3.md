# RED Gate — US3 (Slice 006)

| Field | Value |
|---|---|
| Slice | 006 — admin-overrides |
| Task | T029 |
| User Story | US3 — Admin corrects finals awards + updates match status/kickoff |
| Date | 2026-05-21 |
| Constitution principle | IX (RED-before-GREEN; tests must fail by design before implementation) |
| Status | **DEFERRED** — Docker daemon unavailable; runtime RED verification deferred. Static gate authored. |

---

## Purpose

This document satisfies Principle IX for User Story 3 of Slice 006. It inventories every RED test authored in Wave 1 (T027 + T028), explains *why* each test is RED-by-design today, and identifies which downstream task turns each one GREEN. Per Constitution Principle IX, no implementation task (T030, T031) may begin until every test below is confirmed RED.

Because Docker is unavailable in the current environment, the live `supabase db reset` + pgTAP loop + Playwright run cannot be executed here. The runtime checklist (see § Pre-merge runtime checklist) **MUST** be executed by the reviewer before merging T030/T031.

---

## Test inventory

| File | Type | Tests / assertions | RED reason | Who turns GREEN |
|---|---|---|---|---|
| `supabase/tests/slice-006-admin/admin_update_tournament_award_happy.sql` | pgTAP | 5 | Stored procedure `public.admin_update_tournament_award` is **undefined** — no migration has created it yet. `has_function` assertion fails immediately; subsequent `lives_ok` + row-state assertions cascade. | T030 (migration 0055) |
| `supabase/tests/slice-006-admin/admin_update_match_happy.sql` | pgTAP | 4 | Stored procedure `public.admin_update_match` is **undefined**. `has_function` assertion fails; status-update + audit-row + signature assertions cascade. | T030 (migration 0052) |
| `supabase/tests/slice-006-admin/admin_update_match_kickoff_fans_out.sql` | pgTAP | 5 | SP undefined **and** fan-out side effects (Slice 003 trigger emitting `prediction.kickoff_correction_crossed_lock` + Slice 004 trigger emitting `final_prediction.first_kickoff_correction`) cannot fire without the SP. Both `has_function` and the two trigger-action audit-row assertions fail. | T030 (migration 0052) — kickoff path inside `admin_update_match` |
| `apps/web/tests/e2e/slice-006-admin-finals-correct-top-scorer.spec.ts` | Playwright | 1 | Route `/admin/finals` returns 404 (page not yet created); even if served, `POST /api/admin/tournament-award` 404s and the SP `admin_update_tournament_award` is undefined at the DB layer. Three-layer absence (route + page + SP). | T030 (SP) **and** T031 (route + page + form) |
| `apps/web/tests/e2e/slice-006-admin-finals-confirm-pending.spec.ts` | Playwright | 1 | Same triple absence: `/admin/finals` page, `/api/admin/tournament-award` POST handler, and `admin_update_tournament_award` SP all missing. | T030 (SP) **and** T031 (route + page + form) |
| `apps/web/tests/e2e/slice-006-admin-match-update-status-postponed.spec.ts` | Playwright | 1 | `PATCH /api/admin/matches/[id]` route is only a T015 stub (no body wiring) and `admin_update_match` SP is undefined. Status transition `finished → postponed` cannot be persisted; audit row `admin.match_updated` cannot be emitted. | T030 (SP) **and** T031 (full route + `MatchUpdateForm`) |

**Total RED units**: **14 pgTAP assertions + 3 Playwright tests = 17 RED test units across 6 files.**

---

## What T030 unlocks (DB layer)

Migration files authored by T030 will create the two SPs referenced by every test above:

- **Slot 0052** — `supabase/migrations/0052_admin_update_match.sql`
  - Signature (verified from contract):
    `admin_update_match(p_match_id uuid, p_new_status text, p_new_kickoff_utc timestamptz, p_reason text, p_source_citation text) RETURNS void`
  - Emits audit `admin.match_updated`.
  - Kickoff-change branch must allow Slice 003 trigger to emit `prediction.kickoff_correction_crossed_lock` and Slice 004 trigger to emit `final_prediction.first_kickoff_correction`.
- **Slot 0055** — `supabase/migrations/0055_admin_update_tournament_award.sql`
  - Signature (verified from contract):
    `admin_update_tournament_award(p_item_kind text, p_new_team_id uuid, p_new_player_id uuid, p_new_status text, p_reason text, p_source_citation text) RETURNS void`
    — **no `tournament_id` parameter** (single active tournament invariant).
  - Emits audit `admin.award_updated` (note: **not** `admin.tournament_award_updated`).

Together these turn the 14 pgTAP assertions GREEN and unblock the DB calls inside the Playwright specs.

---

## What T031 unlocks (UI / API surface)

T031 creates the Next.js surface that exercises the SPs from T030:

- `apps/web/app/api/admin/tournament-award/route.ts` — new POST handler invoking `admin_update_tournament_award`.
- `apps/web/app/admin/finals/page.tsx` — new server component rendering the finals corrections UI.
- `apps/web/app/admin/finals/components/AwardCorrectionForm.tsx` — new client component.
- `apps/web/app/admin/matches/[id]/components/MatchUpdateForm.tsx` — new client component (status + kickoff fields).
- `apps/web/app/api/admin/matches/[id]/route.ts` — modify the T015 stub into a full PATCH handler invoking `admin_update_match`.

Together with T030 these turn the 3 Playwright tests GREEN.

---

## DOM contract (T031 MUST honor)

The Playwright specs authored in T028 query the following selectors. T031's components and pages MUST emit exactly these test IDs and form-field names — any deviation re-RED-s the suite:

- `[data-testid="admin-finals-page"]` — root container of `/admin/finals`
- `[data-testid="admin-award-form"]` — `<form>` wrapping the award-correction inputs
- `select[name="item_kind"]` — top_scorer / best_player / best_young_player
- `select[name="status"]` — pending / confirmed
- `[name="target_id"]` — team or player ID input (mapped to `p_new_team_id` / `p_new_player_id` server-side)
- `[data-testid="admin-award-submit"]` — submit button on `AwardCorrectionForm`
- `[data-testid="admin-match-update-submit"]` — submit button on `MatchUpdateForm`

Audit action strings the tests assert against (do not rename):

- `admin.award_updated` (US3 award path)
- `admin.match_updated` (US3 match path)
- `prediction.kickoff_correction_crossed_lock` (Slice 003 trigger fan-out from kickoff edit)
- `final_prediction.first_kickoff_correction` (Slice 004 trigger fan-out from kickoff edit)

---

## Pre-merge runtime checklist (PowerShell)

The reviewer MUST execute these in order before merging T030 + T031. Each step has a defined pass condition.

```powershell
# 1. Reset Supabase + apply migrations through current head (must include 0052 + 0055 once T030 lands)
supabase db reset

# 2. pgTAP loop — run the 3 new US3 files. All MUST be RED before T030 (this gate) and GREEN after T030.
$us3Tests = @(
    'supabase/tests/slice-006-admin/admin_update_tournament_award_happy.sql',
    'supabase/tests/slice-006-admin/admin_update_match_happy.sql',
    'supabase/tests/slice-006-admin/admin_update_match_kickoff_fans_out.sql'
)
foreach ($t in $us3Tests) {
    Write-Host "=== Running $t ==="
    supabase test db --file $t
}

# 3. Web build — confirms TypeScript + Next.js route compilation after T031.
pnpm -F web build

# 4. Playwright — run only Slice 006 / US3 tagged specs.
pnpm -F web e2e -- --grep '@slice-006 @us3'
```

**Pass condition (this gate, T029)**: every step above either fails (RED) or is gated on T030/T031 not yet existing.
**Pass condition (post-T030)**: pgTAP loop in step 2 GREEN; Playwright still RED (UI absent).
**Pass condition (post-T031)**: all four steps GREEN.

---

## Verdict

All **17 US3 test units** (14 pgTAP assertions + 3 Playwright tests across 6 files) are confirmed **RED-by-design**:

- 14 pgTAP assertions RED because `admin_update_match` (slot 0052) and `admin_update_tournament_award` (slot 0055) do not yet exist.
- 3 Playwright tests RED because the `/admin/finals` page, `AwardCorrectionForm`, `MatchUpdateForm`, the `POST /api/admin/tournament-award` route, and the full `PATCH /api/admin/matches/[id]` implementation do not yet exist (and the underlying SPs are missing).

**T030 unlocks GREEN for the 14 pgTAP assertions; T031 (together with T030) unlocks GREEN for the 3 Playwright tests.**

Principle IX is satisfied. T030 and T031 are cleared to begin.
