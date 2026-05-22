// --------------------------------------------------------------------------
// Slice 006 / T028 — `/admin/finals` flip best_player pending → confirmed (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P2) — "Final award correction"
// pending-confirmation path. Pairs with R-008 Golden Ball delay edge case:
//
//   "Given a tournament_award row whose best_player_status='pending'
//   (best_player_player_id IS NULL), When an authorized administrator
//   submits the AwardCorrectionForm with best_player_player_id=Pedri and
//   status='confirmed' (plus reason + source), Then the award row MUST be
//   persisted, an audit row MUST capture the transition, and Slice 005's
//   award_confirmed_trigger MUST fire a score-trigger scope='finals' run
//   that re-scores every participant's best_player picks (alpha, charlie,
//   zeta — all on Pedri — flip from final_pending/0 → final_correct/20)."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/finals` — AwardCorrectionForm; one form per item_kind.
//       Test surface line: "Flip best_player status from 'pending' to
//       'confirmed'; recalc + reason audit".
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § `admin_update_tournament_award` — UPDATE sets target +
//       status + set_at + set_by; trigger fires; audit row emitted with
//       action='admin.award_updated'.
//   - specs/006-admin-overrides/data-model.md § audit_log §
//       admin.award_updated action label.
//   - specs/006-admin-overrides/tasks.md § T028.
//   - supabase/seed/slice-005-fixture.sql § 6 — best_player slot pre-state:
//       best_player_player_id=NULL, best_player_status='pending'.
//   - apps/web/tests/playwright/slice-005-final-scoring.spec.ts —
//       "Flip-pending-→-confirmed" sibling test in slice 005's own surface
//       (drives the Edge Function directly via X-Internal-Auth instead of
//       through the admin UI; this slice 006 test drives via the admin UI).
//   - apps/web/tests/playwright/slice-006-admin-recalc-full-happy.spec.ts —
//       admin1 auth + service-role + cleanup pattern.
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + snapshot
//   tournament_award (asserting pre-state best_player IS NULL / pending) +
//   capture testStartInstant.
//   afterEach:
//     1. Restore tournament_award byte-identically (best_player_player_id=NULL,
//        best_player_status='pending').
//     2. Service-role DELETE every score_records row with
//        calculated_at >= testStartInstant.
//     3. Service-role DELETE every score_calculation_runs row with
//        started_at >= testStartInstant.
//     4. audit_log rows append-only; not deleted.
//     5. resetStub + ensureAdminRole (defensive).
//
// RED-by-design until:
//   - T030 ships `admin_update_tournament_award` SP at migration slot 0068.
//   - T031 ships `/api/admin/tournament-award/route.ts`, `/admin/finals/page.tsx`,
//     `AwardCorrectionForm`.
//   Failure is always assertion-level.
//
// Selectors implied (T031 MUST honor; identical to
// slice-006-admin-finals-correct-top-scorer.spec.ts):
//   - [data-testid="admin-finals-page"]
//   - [data-testid="admin-award-form"]
//   - select[name="item_kind"]
//   - [name="target_id"]
//   - select[name="status"]
//   - textarea[name="reason"]
//   - input[name="source_citation"]
//   - [data-testid="admin-award-submit"]
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";
import { getServiceClient } from "./helpers/service-role";

const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

const TOURNAMENT_ID = "00000000-0000-0000-0000-000000000001";

// Pedri (slice-004-fixture.sql § Players: ESP, MF). The 3 pending-best_player
// active picks (alpha, charlie, zeta) all point at Pedri — confirming the
// award to Pedri makes ALL three correct in the Slice 005 recalc.
const PEDRI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000009";

const CONFIRMATION_REASON = "Golden Ball ceremony — Pedri confirmed";
const SOURCE_CITATION = "https://fifa.example/awards/golden-ball-2026";

interface TournamentAwardSnapshot {
  tournament_id: string;
  champion_team_id: string | null;
  champion_status: string;
  runner_up_team_id: string | null;
  runner_up_status: string;
  top_scorer_player_id: string | null;
  top_scorer_status: string;
  best_player_player_id: string | null;
  best_player_status: string;
  set_at: string | null;
  set_by: string | null;
}

async function readTournamentAward(): Promise<TournamentAwardSnapshot> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("tournament_award")
    .select(
      "tournament_id,champion_team_id,champion_status,runner_up_team_id,runner_up_status,top_scorer_player_id,top_scorer_status,best_player_player_id,best_player_status,set_at,set_by",
    )
    .eq("tournament_id", TOURNAMENT_ID)
    .maybeSingle();
  if (error) {
    throw new Error(`readTournamentAward: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `readTournamentAward: no tournament_award row for ${TOURNAMENT_ID}. ` +
        `Confirm supabase/seed/slice-005-fixture.sql was applied.`,
    );
  }
  return data as TournamentAwardSnapshot;
}

async function restoreTournamentAward(
  snapshot: TournamentAwardSnapshot,
): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_award")
    .update({
      champion_team_id: snapshot.champion_team_id,
      champion_status: snapshot.champion_status,
      runner_up_team_id: snapshot.runner_up_team_id,
      runner_up_status: snapshot.runner_up_status,
      top_scorer_player_id: snapshot.top_scorer_player_id,
      top_scorer_status: snapshot.top_scorer_status,
      best_player_player_id: snapshot.best_player_player_id,
      best_player_status: snapshot.best_player_status,
      set_at: snapshot.set_at,
      set_by: snapshot.set_by,
    })
    .eq("tournament_id", TOURNAMENT_ID);
  if (error) {
    throw new Error(
      `restoreTournamentAward: ${error.message}. ` +
        `Manual repair required — slice-005 fixture invariant is now broken.`,
    );
  }
}

interface AuditLogRow {
  id: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  reason: string | null;
  source: string;
  source_citation: string | null;
  occurred_at: string;
}

async function readAwardUpdatedAuditRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select(
      "id,actor,action,entity_type,entity_id,previous_value,new_value,reason,source,source_citation,occurred_at",
    )
    .eq("action", "admin.award_updated")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readAwardUpdatedAuditRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

interface ScoreCalculationRunRow {
  id: string;
  scope: "match" | "finals" | "all";
  target_id: string | null;
  trigger: string;
  triggered_by: string | null;
  started_at: string;
  completed_at: string | null;
  status: "running" | "succeeded" | "failed";
}

async function readFinalsRecalcRunsSince(
  since: Date,
): Promise<ScoreCalculationRunRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_calculation_runs")
    .select(
      "id,scope,target_id,trigger,triggered_by,started_at,completed_at,status",
    )
    .eq("scope", "finals")
    .eq("trigger", "award_confirmed")
    .gte("started_at", since.toISOString())
    .order("started_at", { ascending: false });
  if (error) {
    throw new Error(`readFinalsRecalcRunsSince: ${error.message}`);
  }
  return (data ?? []) as ScoreCalculationRunRow[];
}

async function purgeScoringRowsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();

  const { error: srErr } = await client
    .from("score_records")
    .delete()
    .gte("calculated_at", sinceIso);
  if (srErr) {
    throw new Error(`purgeScoringRowsSince score_records: ${srErr.message}`);
  }

  const { error: runsErr } = await client
    .from("score_calculation_runs")
    .delete()
    .gte("started_at", sinceIso);
  if (runsErr) {
    throw new Error(
      `purgeScoringRowsSince score_calculation_runs: ${runsErr.message}`,
    );
  }
}

test.describe(
  "US3 — admin flips best_player pending → confirmed; Slice 005 finals recalc fires @slice-006 @us3",
  () => {
    test.setTimeout(2 * 60 * 1000);

    let fixtureSnapshot: TournamentAwardSnapshot | null = null;
    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
      const snap = await readTournamentAward();
      // Sanity precondition: fixture MUST start with best_player NULL/pending.
      if (snap.best_player_player_id !== null) {
        throw new Error(
          `beforeEach precondition: tournament_award.best_player_player_id MUST start as NULL; ` +
            `got '${snap.best_player_player_id}'. A sibling test likely left mutated state.`,
        );
      }
      if (snap.best_player_status !== "pending") {
        throw new Error(
          `beforeEach precondition: tournament_award.best_player_status MUST start as 'pending'; ` +
            `got '${snap.best_player_status}'.`,
        );
      }
      fixtureSnapshot = snap;
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      if (fixtureSnapshot) {
        await restoreTournamentAward(fixtureSnapshot);
      }
      await purgeScoringRowsSince(testStartInstant);
      await resetStub();
      await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    });

    test(
      "admin1 navigates to /admin/finals, sets best_player=Pedri + status='confirmed' with reason + source; response 200; tournament_award updated; audit row written; Slice 005 finals recalc fires @slice-006 @us3",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Navigate to /admin/finals.
        const pageResponse = await page.goto("/admin/finals");
        expect(
          pageResponse,
          "page.goto('/admin/finals') MUST return a Response object — Next.js served the route",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/finals MUST return 200 for an active admin (admin-ui.surface.md § /admin/finals)",
        ).toBe(200);

        expect(
          new URL(page.url()).pathname,
          "Final URL pathname MUST be '/admin/finals' for an active admin (no redirect to /admin/denied)",
        ).toBe("/admin/finals");

        await expect(
          page.locator('[data-testid="admin-finals-page"]'),
          '[data-testid="admin-finals-page"] MUST be visible on /admin/finals (T031 contract)',
        ).toBeVisible();

        const form = page.locator('[data-testid="admin-award-form"]').first();
        await expect(
          form,
          '[data-testid="admin-award-form"] MUST be visible on /admin/finals (admin-ui.surface.md § /admin/finals Actions)',
        ).toBeVisible();

        // Drive the form for item_kind='best_player'. Set Pedri as target_id
        // and flip status to 'confirmed'.
        await form
          .locator('select[name="item_kind"]')
          .selectOption("best_player");
        await form.locator('[name="target_id"]').first().fill(PEDRI_PLAYER_ID);
        await form.locator('select[name="status"]').selectOption("confirmed");

        await form.locator('textarea[name="reason"]').fill(CONFIRMATION_REASON);
        await form.locator('input[name="source_citation"]').fill(SOURCE_CITATION);

        const [postResponse] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes("/api/admin/tournament-award") &&
              r.request().method() === "POST",
            { timeout: 15_000 },
          ),
          form.locator('[data-testid="admin-award-submit"]').click(),
        ]);

        expect(
          postResponse.status(),
          "POST /api/admin/tournament-award MUST return 200 (admin-rpcs.write.md § admin_update_tournament_award)",
        ).toBe(200);

        // Service-role verify: tournament_award updated to Pedri / confirmed.
        const updated = await readTournamentAward();
        expect(
          updated.best_player_player_id,
          `tournament_award.best_player_player_id MUST equal Pedri ('${PEDRI_PLAYER_ID}') after admin confirmation`,
        ).toBe(PEDRI_PLAYER_ID);
        expect(
          updated.best_player_status,
          "tournament_award.best_player_status MUST flip from 'pending' to 'confirmed' after admin confirmation",
        ).toBe("confirmed");
        expect(
          updated.set_by,
          `tournament_award.set_by MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}') after admin correction`,
        ).toBe(ADMIN1_PARTICIPANT_ID);

        // Service-role verify: audit row 'admin.award_updated' written.
        const auditRows = await readAwardUpdatedAuditRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain at least one admin.award_updated row written after the test started",
        ).toBeGreaterThanOrEqual(1);

        const auditRow = auditRows[0];
        expect(
          auditRow.action,
          "audit row action MUST be 'admin.award_updated' (data-model.md § audit_log)",
        ).toBe("admin.award_updated");
        expect(
          auditRow.actor,
          `audit row actor MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}')`,
        ).toBe(ADMIN1_PARTICIPANT_ID);
        expect(
          auditRow.reason,
          `audit row reason MUST equal '${CONFIRMATION_REASON}' verbatim`,
        ).toBe(CONFIRMATION_REASON);
        expect(
          auditRow.source_citation,
          `audit row source_citation MUST equal '${SOURCE_CITATION}' verbatim`,
        ).toBe(SOURCE_CITATION);

        // Service-role verify: scope='finals' / trigger='award_confirmed'
        // recalc row exists since testStartInstant. Slice 005's
        // award_confirmed_trigger fires pg_net after the SP UPDATE.
        const pollDeadline = Date.now() + 60_000;
        let finalsRuns: ScoreCalculationRunRow[] = [];
        // eslint-disable-next-line no-await-in-loop -- polling loop is intentional
        while (Date.now() < pollDeadline) {
          finalsRuns = await readFinalsRecalcRunsSince(testStartInstant);
          if (finalsRuns.length > 0) break;
          await new Promise((r) => setTimeout(r, 2_000));
        }
        expect(
          finalsRuns.length,
          "score_calculation_runs MUST contain at least one row with scope='finals' AND trigger='award_confirmed' since testStartInstant — Slice 005's award_confirmed_trigger fires pg_net → score-trigger when the pending row transitions to confirmed",
        ).toBeGreaterThanOrEqual(1);

        const finalsRun = finalsRuns[0];
        expect(
          finalsRun.scope,
          "the score_calculation_runs row MUST have scope='finals'",
        ).toBe("finals");
        expect(
          finalsRun.trigger,
          "the score_calculation_runs row MUST have trigger='award_confirmed' (Slice 005 contract)",
        ).toBe("award_confirmed");
      },
    );
  },
);
