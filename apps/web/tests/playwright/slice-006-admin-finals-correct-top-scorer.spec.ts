// --------------------------------------------------------------------------
// Slice 006 / T028 — `/admin/finals` correct top_scorer happy path (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P2) "Final award correction":
//
//   "Given an authorized administrator and a tournament_award row with
//   top_scorer set to player X (confirmed), When the admin submits a
//   correction changing top_scorer to player Y with reason + source, Then
//   the award row MUST be persisted, an audit row MUST capture the diff,
//   and Slice 005's award_confirmed_trigger MUST fire a score-trigger
//   scope='finals' run that re-scores every participant's final picks."
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `/admin/finals` — per-item form posts to `/api/admin/tournament-award`
//       which calls `admin_update_tournament_award`.
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md
//       § `admin_update_tournament_award(...)` — emits audit row
//       `action='admin.award_updated'` with OLD + NEW award; Slice 005's
//       trigger fires the Edge Function with `scope='finals'`.
//   - specs/006-admin-overrides/data-model.md § audit_log §
//       `action='admin.award_updated'` is the canonical action label.
//   - specs/006-admin-overrides/tasks.md § T028.
//   - supabase/seed/slice-005-fixture.sql § 6 — tournament_award fixture state
//       champion=ARG/confirmed, runner_up=ESP/confirmed,
//       top_scorer=Messi (dddd1000-…-001)/confirmed,
//       best_player=NULL/pending.
//   - apps/web/tests/playwright/slice-005-final-scoring.spec.ts —
//       snapshotAndRestoreTournamentAward + purgeScoringRowsSince patterns
//       (this spec inlines a local copy so the slice-005 file stays the
//       single source of truth for slice 005 itself).
//   - apps/web/tests/playwright/slice-006-admin-match-correct-score-happy.spec.ts —
//       admin1 persona + ensureAdminRole + service-role audit verify pattern.
//
// Persona: admin1 (admin role active via T009 + ensureAdminRole).
//
// Cleanup contract:
//   beforeEach: resetStub + ensureAdminRole(admin1) + snapshot
//   tournament_award row to a local variable + capture testStartInstant.
//   afterEach:
//     1. Restore tournament_award byte-identically to fixture state.
//     2. Service-role DELETE every score_records row with calculated_at
//        >= testStartInstant (Slice 005's recalc would have written some).
//     3. Service-role DELETE every score_calculation_runs row with
//        started_at >= testStartInstant.
//     audit_log rows are append-only (Slice 007 contract) — they are NOT
//     deleted, but the `since` filter excludes pre-test rows.
//     4. resetStub + ensureAdminRole (defensive).
//
// RED-by-design until:
//   - T030 ships `admin_update_tournament_award` SP at migration slot 0068.
//   - T031 ships `/api/admin/tournament-award/route.ts`, `/admin/finals/page.tsx`,
//     and `AwardCorrectionForm`.
//   Until those land:
//     * `page.goto('/admin/finals')` 404s.
//     * Even if the form existed, the POST endpoint would 404.
//   The failure mode is always assertion-level (status / DOM expectation
//   mismatches), never infrastructure-error.
//
// Selectors implied (T031 MUST honor):
//   - [data-testid="admin-finals-page"]
//       Wrapper element on the /admin/finals server-rendered page.
//   - [data-testid="admin-award-form"]
//       AwardCorrectionForm root — exactly one form per item_kind on the
//       page (or one form with select-driven item_kind; this test fills the
//       form for item_kind='top_scorer' and SUBMITs).
//   - select[name="item_kind"]
//       Options: champion | runner_up | top_scorer | best_player.
//   - input[name="target_id"] | select[name="target_id"]
//       Team-id or player-id picker.
//   - select[name="status"]
//       Options: pending | confirmed.
//   - textarea[name="reason"]
//   - input[name="source_citation"]
//   - [data-testid="admin-award-submit"]
//       Submit button.
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

// admin1's participants.id (slice-005-fixture.sql § 2 line 248).
const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

// The single 2026 World Cup tournament uuid (slice-005-fixture.sql § 6).
const TOURNAMENT_ID = "00000000-0000-0000-0000-000000000001";

// Players pre-seeded by slice 004 (slice-004-fixture.sql § Players).
const MESSI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000001";
const VINICIUS_PLAYER_ID = "dddd1000-0000-0000-0000-000000000011";

const CORRECTION_REASON = "FIFA awards committee re-evaluation";
const SOURCE_CITATION = "https://fifa.example/awards/top-scorer-correction";

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
  "US3 — admin corrects tournament_award.top_scorer; Slice 005 finals recalc fires @slice-006 @us3",
  () => {
    // Award correction → SP UPDATE → award_confirmed_trigger → pg_net call to
    // the score-trigger Edge Function → row insert with scope='finals'. The
    // outer envelope MUST tolerate the async fan-out; we poll for up to 60s.
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
      // Sanity precondition: fixture MUST start with top_scorer=Messi/confirmed.
      // If a sibling test forgot to restore, fail FAST here with a clear
      // message rather than spelunking the failure later.
      if (snap.top_scorer_player_id !== MESSI_PLAYER_ID) {
        throw new Error(
          `beforeEach precondition: tournament_award.top_scorer_player_id MUST start as Messi (${MESSI_PLAYER_ID}); ` +
            `got '${snap.top_scorer_player_id}'. A sibling test likely left mutated state.`,
        );
      }
      if (snap.top_scorer_status !== "confirmed") {
        throw new Error(
          `beforeEach precondition: tournament_award.top_scorer_status MUST start as 'confirmed'; ` +
            `got '${snap.top_scorer_status}'.`,
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
      "admin1 navigates to /admin/finals, changes top_scorer Messi → Vinícius with reason + source; response 200; tournament_award updated; audit row written; Slice 005 finals recalc fires @slice-006 @us3",
      async ({ page }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        // Navigate to the finals correction page.
        const pageResponse = await page.goto("/admin/finals");
        expect(
          pageResponse,
          "page.goto('/admin/finals') MUST return a Response object — Next.js served the route",
        ).not.toBeNull();
        expect(
          pageResponse!.status(),
          "/admin/finals MUST return 200 for an active admin (admin-ui.surface.md § /admin/finals)",
        ).toBe(200);

        // Final URL pathname MUST still be /admin/finals (no redirect to /admin/denied).
        expect(
          new URL(page.url()).pathname,
          "Final URL pathname MUST be '/admin/finals' for an active admin (no redirect)",
        ).toBe("/admin/finals");

        // The page wrapper MUST be present.
        await expect(
          page.locator('[data-testid="admin-finals-page"]'),
          '[data-testid="admin-finals-page"] MUST be visible on /admin/finals (T031 contract)',
        ).toBeVisible();

        // The AwardCorrectionForm MUST be present. We scope subsequent
        // locators to the form so a multi-item-form layout (one form per
        // item_kind) and a single-form layout (item_kind select) BOTH work
        // — in either case we drive the form by setting item_kind first.
        const form = page.locator('[data-testid="admin-award-form"]').first();
        await expect(
          form,
          '[data-testid="admin-award-form"] MUST be visible on /admin/finals (admin-ui.surface.md § /admin/finals Actions)',
        ).toBeVisible();

        // Select the top_scorer item kind. If the form layout has one form
        // per item_kind, this select may be pre-set; selectOption is idempotent.
        await form
          .locator('select[name="item_kind"]')
          .selectOption("top_scorer");

        // Fill target_id with Vinícius's UUID. The UI MAY use a picker
        // (rendered as either <input> or <select>); both shapes accept .fill
        // for raw UUID entry, and <select> falls back to selectOption. To
        // remain shape-agnostic, prefer locator.fill on the named element.
        await form.locator('[name="target_id"]').first().fill(VINICIUS_PLAYER_ID);

        // Status: 'confirmed' (we're correcting a confirmed award to a new
        // confirmed value — Slice 005's trigger fires for any UPDATE on
        // tournament_award; the assertion is that scope='finals' /
        // trigger='award_confirmed' row appears regardless).
        await form.locator('select[name="status"]').selectOption("confirmed");

        await form.locator('textarea[name="reason"]').fill(CORRECTION_REASON);
        await form.locator('input[name="source_citation"]').fill(SOURCE_CITATION);

        // Submit and capture the underlying POST response.
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

        // Service-role verify: tournament_award.top_scorer_player_id was
        // updated to Vinícius and status remains 'confirmed'.
        const updated = await readTournamentAward();
        expect(
          updated.top_scorer_player_id,
          `tournament_award.top_scorer_player_id MUST equal Vinícius ('${VINICIUS_PLAYER_ID}') after correction`,
        ).toBe(VINICIUS_PLAYER_ID);
        expect(
          updated.top_scorer_status,
          "tournament_award.top_scorer_status MUST be 'confirmed' after the correction (admin posted status='confirmed')",
        ).toBe("confirmed");
        expect(
          updated.set_by,
          `tournament_award.set_by MUST equal admin1's participants.id ('${ADMIN1_PARTICIPANT_ID}') after admin correction (admin-rpcs.write.md § admin_update_tournament_award behavior step 4)`,
        ).toBe(ADMIN1_PARTICIPANT_ID);

        // Service-role verify: audit row 'admin.award_updated' exists since
        // testStartInstant with the expected diff + actor + reason + source.
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
          `audit row reason MUST equal '${CORRECTION_REASON}' verbatim`,
        ).toBe(CORRECTION_REASON);
        expect(
          auditRow.source_citation,
          `audit row source_citation MUST equal '${SOURCE_CITATION}' verbatim (data-model.md § audit_log additive column)`,
        ).toBe(SOURCE_CITATION);

        // Service-role verify: a new score_calculation_runs row with
        // scope='finals' AND trigger='award_confirmed' exists since
        // testStartInstant. Slice 005's award_confirmed_trigger fires the
        // Edge Function via pg_net AFTER the SP's UPDATE returns, so we
        // poll for up to 60 seconds for the row to materialise.
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
          "score_calculation_runs MUST contain at least one row with scope='finals' AND trigger='award_confirmed' since testStartInstant — Slice 005's award_confirmed_trigger MUST fire pg_net → score-trigger Edge Function after the SP's UPDATE",
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
