// --------------------------------------------------------------------------
// Slice 005 / T017 — US2 Final-Prediction Scoring Playwright spec (RED).
// --------------------------------------------------------------------------
// RED acceptance tests for User Story 2 (P1) — the 20-points-per-correct-pick
// truth table for champion / runner_up / top_scorer / best_player, plus the
// R-008 Golden Ball-delay edge case (pending → final_pending; flip pending →
// confirmed re-scores correctly).
//
// Source of truth:
//   - specs/005-scoring-leaderboard/spec.md § US2 (Acceptance Scenarios 1-4)
//     and § Edge Cases ("FIFA Golden Ball is delayed").
//   - specs/005-scoring-leaderboard/contracts/scoring-trigger.edge-fn.md
//     § Request (admin path), § Response, § Behavior, § Error responses.
//   - specs/005-scoring-leaderboard/contracts/personal-breakdown.read.md
//     § Response (one row per scored target; final_pending shape).
//   - supabase/seed/slice-005-fixture.sql — hand-verified final-prediction
//     truth table at the bottom of the file. The tournament_award row has
//     champion=ARG/runner_up=ESP/top_scorer=Messi confirmed and best_player
//     pending. The 12 active final_predictions (6 from slice 004 + 6 from
//     slice 005) cover every relevant case.
//   - specs/005-scoring-leaderboard/research.md § R-007 (Golden Boot — single
//     canonical winner only; OD-004) and § R-008 (Golden Ball pending; the
//     `tournament_award.best_player_status='pending'` path emits
//     reason_code='final_pending' / 0).
//   - apps/web/tests/playwright/slice-005-match-scoring.spec.ts (T009 — same
//     auth flow, helpers, cleanup pattern; this file is its US2 sibling).
//   - .specify/memory/constitution.md § Principle IX (BDD: every Then-clause
//     MUST be a checkable assertion — no "should be reasonable" language).
//
// Scenarios covered (all tagged @slice-005 @us2):
//   1. AS1 champion-correct           → charlie's final-champion row → 20 / 'final_correct'
//   2. AS2 runner-up-correct / wrong  → bravo's final-runner_up=20 / 'final_correct'
//                                       bravo's final-champion   = 0 / 'final_incorrect'
//   3. AS3 all-four-correct → 80      → alpha (3 confirmed correct, 1 pending → 60 first;
//                                       flip best_player→Pedri confirmed → re-score →
//                                       alpha total = 80)
//   4. AS4 Golden Boot OD-004         → delta's final-top_scorer=20 / 'final_correct'
//                                       bravo's final-top_scorer= 0 / 'final_incorrect'
//   5. Best-Player-Pending edge case  → alpha / charlie / zeta final-best_player rows
//                                       all show points=0 / reason_code='final_pending' /
//                                       official_team_or_player_id IS NULL
//   6. Flip pending → confirmed       → POST scope='finals' R1 (pending row recorded),
//                                       UPDATE tournament_award best_player → Pedri
//                                       confirmed, POST scope='finals' R2, alpha's
//                                       NEW final-best_player row = 20 / 'final_correct'
//
// Cleanup contract:
//   * Every test captures `testStartInstant` BEFORE its first sync call and
//     uses the service-role client to DELETE score_records +
//     score_calculation_runs rows created at-or-after that instant in
//     afterEach. Audit_log rows are LEFT in place — they are append-only by
//     Slice 007's contract and the next test's `since` filter excludes them.
//   * Tests 3 and 6 mutate `tournament_award` (best_player slot). Both use
//     try/finally to restore the original snapshot byte-identically
//     (best_player_player_id=NULL, best_player_status='pending').
//
// RED-by-design until:
//   * T019 ships `public.score_finals(uuid)` at migration slot 0053.
//   * T020 extends `supabase/functions/score-trigger/` to handle scope='finals'
//     (today it returns 501 + 'scope_pending_t020_t037').
//   Until those land:
//     - The POST returns 501 → tests fail at `expect(status).toBe(200)`.
//     - The score_records query returns 0 rows → tests fail at the points /
//       reason_code assertions.
//   The failure mode is always assertion-level, never infrastructure-error.
//
// Auth posture (T015 D-025 option B):
//   T015 ships an `X-Internal-Auth: <SCORE_TRIGGER_INTERNAL_AUTH_SECRET>`
//   bypass on the Edge Function so Playwright tests can drive it WITHOUT a
//   real admin JWT (slice 006 owns admin_roles). These tests rely exclusively
//   on that header; they DO NOT sign in via the OIDC stub because the auth
//   path under test is the internal-secret path.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Fixture-derived constants. ALL UUIDs and numeric values are anchored to
// supabase/seed/slice-004-fixture.sql + supabase/seed/slice-005-fixture.sql
// and MUST stay in sync if those fixtures are ever edited.
// --------------------------------------------------------------------------

// participants UUIDs (slice 001 + slice 005 fixtures).
const PARTICIPANTS = {
  alpha: "11111111-1111-1111-1111-111111111111",
  bravo: "22222222-2222-2222-2222-222222222222",
  charlie: "33333333-3333-3333-3333-333333333333",
  delta: "44444444-4444-4444-4444-444444444444",
  epsilon: "55555555-5555-5555-5555-555555555555",
  zeta: "66666666-6666-6666-6666-666666666666",
} as const;

// The single 2026 World Cup tournament uuid (placeholder per data-model
// § Entity 3; matches the `tournaments` placeholder used in the Edge Fn).
const TOURNAMENT_ID = "00000000-0000-0000-0000-000000000001";

// Players pre-seeded by slice 004 (slice-004-fixture.sql § Players).
const PEDRI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000009";

const SCORE_TRIGGER_ENDPOINT =
  (process.env.SUPABASE_FUNCTIONS_BASE_URL ??
    "http://localhost:54321/functions/v1") + "/score-trigger";

const INTERNAL_AUTH_SECRET =
  process.env.SCORE_TRIGGER_INTERNAL_AUTH_SECRET ?? "";

// --------------------------------------------------------------------------
// Local contract types — mirror scoring-trigger.edge-fn.md WITHOUT importing
// any app code so the spec stays decoupled from server refactors.
// --------------------------------------------------------------------------

interface ScoreTriggerRequest {
  scope: "match" | "finals" | "all";
  target_id?: string;
  reason: string;
  run_id?: string;
}

interface ScoreTriggerResponse {
  run_id: string;
  scope: "match" | "finals" | "all";
  target_id: string | null;
  calculation_version_written: number;
  affected_record_count: number;
  started_at: string;
  completed_at: string;
  notes: string | null;
  status: "succeeded";
}

type FinalItemKind = "champion" | "runner_up" | "top_scorer" | "best_player";

interface ScoreRecordRow {
  id: string;
  participant_id: string;
  target_kind: "match" | "final";
  target_id: string;
  final_item_kind: FinalItemKind | null;
  predicted_team_or_player_id: string | null;
  official_team_or_player_id: string | null;
  points: number;
  reason_code:
    | "exact"
    | "outcome"
    | "incorrect"
    | "none"
    | "final_correct"
    | "final_incorrect"
    | "final_pending";
  calculation_version: number;
  run_id: string;
  calculated_at: string;
}

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

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * POSTs to /functions/v1/score-trigger with the T015 X-Internal-Auth bypass
 * header (D-025 option B). Returns the parsed JSON response on 200; otherwise
 * the caller can inspect status + rawBody to surface the RED failure shape.
 */
async function callScoreTriggerFinals(
  request: import("@playwright/test").APIRequestContext,
  body: ScoreTriggerRequest,
): Promise<{
  status: number;
  rawBody: string;
  parsed: ScoreTriggerResponse | null;
}> {
  // Gateway gate — Supabase Edge Runtime requires Authorization: Bearer <jwt>
  // before reaching any /functions/v1/* path. Anon key suffices; the gateway
  // does not inspect role. The function's X-Internal-Auth bypass remains
  // authoritative for skipping the is_admin check inside.
  // (Added 2026-05-23 — slice 005 follow-up cascade. See
  //  specs/001-eligibility-login/follow-up-oidc-stub-keycloak-vs-mock-oauth2.md
  //  § "NEW issues found" #2.)
  const SUPABASE_ANON_KEY_FOR_GATEWAY =
    process.env.SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    "";
  const response = await request.post(SCORE_TRIGGER_ENDPOINT, {
    headers: {
      "Content-Type": "application/json",
      ...(SUPABASE_ANON_KEY_FOR_GATEWAY
        ? { Authorization: `Bearer ${SUPABASE_ANON_KEY_FOR_GATEWAY}` }
        : {}),
      "X-Internal-Auth": INTERNAL_AUTH_SECRET,
    },
    data: body,
  });
  const rawBody = await response.text().catch(() => "<unreadable body>");
  let parsed: ScoreTriggerResponse | null = null;
  try {
    parsed = JSON.parse(rawBody) as ScoreTriggerResponse;
  } catch {
    parsed = null;
  }
  return { status: response.status(), rawBody, parsed };
}

/**
 * Service-role: query the LATEST (highest calculation_version) score_records
 * row for a (participant, target_kind='final', final_item_kind) tuple. There
 * is exactly one active final-item per participant in the fixture so the
 * latest version is the only row callers care about for per-test assertions.
 */
async function readLatestFinalRow(
  participantId: string,
  finalItemKind: FinalItemKind,
): Promise<ScoreRecordRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_records")
    .select(
      "id,participant_id,target_kind,target_id,final_item_kind,predicted_team_or_player_id,official_team_or_player_id,points,reason_code,calculation_version,run_id,calculated_at",
    )
    .eq("participant_id", participantId)
    .eq("target_kind", "final")
    .eq("final_item_kind", finalItemKind)
    .order("calculation_version", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(
      `readLatestFinalRow(${participantId}, ${finalItemKind}): ${error.message}`,
    );
  }
  return ((data ?? [])[0] as ScoreRecordRow | undefined) ?? null;
}

/**
 * Service-role: SUM(points) across every `target_kind='final'` score_record
 * row for `participantId` at the LATEST calculation_version. Used by AS3 to
 * assert "all four items correct → 80".
 */
async function sumFinalPointsAtLatestVersion(
  participantId: string,
): Promise<{ total: number; version: number | null }> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_records")
    .select("points,calculation_version")
    .eq("participant_id", participantId)
    .eq("target_kind", "final")
    .order("calculation_version", { ascending: false });
  if (error) {
    throw new Error(`sumFinalPointsAtLatestVersion(${participantId}): ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ points: number; calculation_version: number }>;
  if (rows.length === 0) {
    return { total: 0, version: null };
  }
  const latestVersion = rows[0].calculation_version;
  const total = rows
    .filter((r) => r.calculation_version === latestVersion)
    .reduce((acc, r) => acc + r.points, 0);
  return { total, version: latestVersion };
}

/**
 * Service-role: delete every score_records + score_calculation_runs row
 * created at-or-after `since`. Idempotent. Audit_log is NOT touched
 * (append-only by Slice 007's contract).
 */
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

/**
 * Service-role: read the single tournament_award row for the fixture
 * tournament. Used as a snapshot before tests that mutate the best_player
 * slot (AS3 and Flip-pending-→-confirmed). The restore() callable writes
 * the snapshot back byte-identically.
 */
async function snapshotAndRestoreTournamentAward(): Promise<{
  snapshot: TournamentAwardSnapshot;
  restore: () => Promise<void>;
}> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("tournament_award")
    .select(
      "tournament_id,champion_team_id,champion_status,runner_up_team_id,runner_up_status,top_scorer_player_id,top_scorer_status,best_player_player_id,best_player_status,set_at,set_by",
    )
    .eq("tournament_id", TOURNAMENT_ID)
    .maybeSingle();
  if (error) {
    throw new Error(`snapshotAndRestoreTournamentAward read: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `snapshotAndRestoreTournamentAward: no tournament_award row for ${TOURNAMENT_ID}. ` +
        `Confirm supabase/seed/slice-005-fixture.sql was applied.`,
    );
  }
  const snapshot = data as TournamentAwardSnapshot;
  return {
    snapshot,
    restore: async () => {
      const { error: restoreErr } = await client
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
      if (restoreErr) {
        throw new Error(
          `snapshotAndRestoreTournamentAward restore: ${restoreErr.message}. ` +
            `Manual repair required — slice-005 fixture invariant is now broken.`,
        );
      }
    },
  };
}

/**
 * Service-role: flip the best_player slot on tournament_award to a CONFIRMED
 * Pedri pick. Used by AS3 + the Flip-pending-→-confirmed test. Restoration
 * is handled by the caller via the snapshot restore() callable.
 */
async function confirmBestPlayerAsPedri(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_award")
    .update({
      best_player_player_id: PEDRI_PLAYER_ID,
      best_player_status: "confirmed",
    })
    .eq("tournament_id", TOURNAMENT_ID);
  if (error) {
    throw new Error(`confirmBestPlayerAsPedri: ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US2 — Final-Prediction Scoring @slice-005 @us2", () => {
  // Run serially within the file. fullyParallel: true would otherwise
  // spawn one worker per test, racing on tournament_config.current_calculation_version
  // and tripping score_records_uk on concurrent INSERTs. Same pattern as
  // slice-005-breakdown.spec.ts. (Added 2026-05-23.)
  test.describe.configure({ mode: "serial" });

  // Each test's scoring trigger + service-role round-trips take a bit longer
  // than the default Playwright budget.
  test.setTimeout(60_000);

  // Per-test wall-clock instant captured in beforeEach so afterEach can purge
  // ONLY rows created by this test.
  let testStartInstant: Date;

  test.beforeEach(async () => {
    testStartInstant = new Date();
  });

  test.afterEach(async () => {
    await purgeScoringRowsSince(testStartInstant);
  });

  // ----------------------------------------------------------------------
  // AS1 — champion-correct → 20 points.
  // ----------------------------------------------------------------------
  // Fixture truth (slice-005-fixture.sql § truth table):
  //   charlie picked champion=ARG (slice 005 row), tournament_award.champion=ARG
  //   confirmed → 20 / 'final_correct'.
  test(
    "AS1 — Given official champion=ARG (confirmed) and charlie's champion pick=ARG, When final scoring runs, Then charlie's final-champion row MUST award exactly 20 points / 'final_correct' @slice-005 @us2",
    async ({ request }) => {
      const runId = crypto.randomUUID();
      const { status, rawBody, parsed } = await callScoreTriggerFinals(
        request,
        {
          scope: "finals",
          reason: "T017 AS1 — champion-correct → 20",
          run_id: runId,
        },
      );

      expect(
        status,
        `score-trigger scope='finals' MUST return 200 (contract § Response). Got body: ${rawBody}`,
      ).toBe(200);
      expect(
        parsed?.affected_record_count,
        "affected_record_count MUST be > 0 (every final-prediction in the fixture emits one score_records row)",
      ).toBeGreaterThan(0);
      expect(
        parsed?.calculation_version_written,
        "calculation_version_written MUST be a positive integer (contract § Response)",
      ).toBeGreaterThan(0);

      const row = await readLatestFinalRow(PARTICIPANTS.charlie, "champion");
      expect(
        row,
        "score_finals MUST emit one row for (charlie, target_kind='final', final_item_kind='champion')",
      ).not.toBeNull();
      expect(
        row!.points,
        "charlie / champion=ARG (matches official ARG, status='confirmed') MUST award 20 points per fixture truth table",
      ).toBe(20);
      expect(
        row!.reason_code,
        "charlie / champion / correct-and-confirmed MUST be reason_code='final_correct'",
      ).toBe("final_correct");
      expect(
        row!.target_kind,
        "charlie / champion row MUST have target_kind='final' (data-model § Entity 1)",
      ).toBe("final");
      expect(
        row!.final_item_kind,
        "charlie / champion row MUST have final_item_kind='champion'",
      ).toBe("champion");
    },
  );

  // ----------------------------------------------------------------------
  // AS2 — runner-up-correct → 20 / wrong-champion → 0.
  // ----------------------------------------------------------------------
  // Fixture truth:
  //   bravo picked runner_up=ESP (slice 005 row) → official ESP confirmed → 20 / 'final_correct'.
  //   bravo picked champion=BRA (slice 004 row)  → official ARG confirmed → 0  / 'final_incorrect'.
  // This single bravo participant exercises BOTH the correct and the
  // incorrect halves of AS2 in one fixture column.
  test(
    "AS2 — Given bravo's runner_up=ESP (correct) and bravo's champion=BRA (wrong against official ARG), When final scoring runs, Then bravo's runner_up row=20/'final_correct' AND bravo's champion row=0/'final_incorrect' @slice-005 @us2",
    async ({ request }) => {
      const { status, rawBody } = await callScoreTriggerFinals(request, {
        scope: "finals",
        reason: "T017 AS2 — runner-up correct / champion wrong",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger scope='finals' MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      const runnerUp = await readLatestFinalRow(PARTICIPANTS.bravo, "runner_up");
      expect(
        runnerUp,
        "score_finals MUST emit a (bravo, runner_up) row",
      ).not.toBeNull();
      expect(
        runnerUp!.points,
        "bravo / runner_up=ESP matches official ESP (confirmed) MUST award 20 points",
      ).toBe(20);
      expect(
        runnerUp!.reason_code,
        "bravo / runner_up / correct-and-confirmed MUST be reason_code='final_correct'",
      ).toBe("final_correct");

      const champion = await readLatestFinalRow(PARTICIPANTS.bravo, "champion");
      expect(
        champion,
        "score_finals MUST emit a (bravo, champion) row (slice 004 active pick exists)",
      ).not.toBeNull();
      expect(
        champion!.points,
        "bravo / champion=BRA does NOT match official ARG MUST award 0 points (FR-002)",
      ).toBe(0);
      expect(
        champion!.reason_code,
        "bravo / champion / incorrect-against-confirmed MUST be reason_code='final_incorrect'",
      ).toBe("final_incorrect");
    },
  );

  // ----------------------------------------------------------------------
  // AS3 — all-four-correct → 80.
  // ----------------------------------------------------------------------
  // Approach (b) per T017 prompt: alpha picks champion=ARG, runner_up=ESP,
  // top_scorer=Messi (all 3 confirmed correct via slice 004) PLUS
  // best_player=Pedri (slice 005, currently pending → 0). With pending,
  // alpha's total = 60. To exercise AS3's "all four confirmed AND correct →
  // 80" assertion, we mutate tournament_award.best_player to Pedri/confirmed
  // INSIDE the test, then re-trigger scoring with a new run_id, then assert
  // alpha's NEW latest-version total = 80. The award is restored in
  // finally. This also exercises the "flip pending→confirmed re-scores"
  // edge case for alpha specifically.
  test(
    "AS3 — Given alpha's 4 picks all correct AFTER best_player is confirmed=Pedri, When final scoring re-runs, Then alpha's SUM(points) across the 4 final rows at the latest calculation_version MUST equal exactly 80 @slice-005 @us2",
    async ({ request }) => {
      const award = await snapshotAndRestoreTournamentAward();

      try {
        // Sanity precondition: fixture must START with best_player pending so
        // the test exercises the "flip pending → confirmed" path. If a sibling
        // test forgot to restore, this assertion catches it.
        expect(
          award.snapshot.best_player_status,
          "fixture precondition: best_player_status MUST start as 'pending'",
        ).toBe("pending");
        expect(
          award.snapshot.best_player_player_id,
          "fixture precondition: best_player_player_id MUST start as NULL",
        ).toBeNull();

        // Mutate award: best_player → Pedri / confirmed. After this, all four
        // of alpha's picks are correct (and confirmed).
        await confirmBestPlayerAsPedri();

        const runId = crypto.randomUUID();
        const { status, rawBody } = await callScoreTriggerFinals(request, {
          scope: "finals",
          reason: "T017 AS3 — all four confirmed correct → 80",
          run_id: runId,
        });

        expect(
          status,
          `score-trigger scope='finals' MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);

        const { total, version } = await sumFinalPointsAtLatestVersion(
          PARTICIPANTS.alpha,
        );
        expect(
          version,
          "alpha MUST have at least one final-kind row at the latest version after scope='finals'",
        ).not.toBeNull();
        expect(
          total,
          "alpha's SUM(points) for target_kind='final' rows at the latest calculation_version MUST equal exactly 80 (4 items × 20, all correct, all confirmed) per FR-002 + spec § US2 AS3",
        ).toBe(80);
      } finally {
        await award.restore();
      }
    },
  );

  // ----------------------------------------------------------------------
  // AS4 — Golden Boot OD-004: only the officially-named top scorer counts.
  // ----------------------------------------------------------------------
  // Fixture truth:
  //   tournament_award.top_scorer = Messi, confirmed.
  //   delta picked top_scorer=Messi (slice 005)        → 20 / 'final_correct'.
  //   bravo picked top_scorer=Vinícius (slice 004)     →  0 / 'final_incorrect'.
  // Per R-007 / FR-009 / OD-004: only participants whose pick equals the
  // single officially-named Golden Boot winner get 20. Vinícius is NOT the
  // officially-named top scorer regardless of any goal-tie scenario, so
  // bravo's top_scorer row MUST be 0 / 'final_incorrect'. The fixture does
  // NOT exercise a tied-on-raw-goals branch — but the assertion SHAPE here
  // (points=0 for non-officially-named picks) is the load-bearing OD-004
  // invariant the contract guarantees regardless of raw-goal ties.
  test(
    "AS4 — Given official top_scorer=Messi (confirmed) and only Messi-pickers count per FR-009/OD-004, When final scoring runs, Then delta's top_scorer row=20/'final_correct' AND bravo's top_scorer row=0/'final_incorrect' @slice-005 @us2",
    async ({ request }) => {
      const { status, rawBody } = await callScoreTriggerFinals(request, {
        scope: "finals",
        reason: "T017 AS4 — Golden Boot OD-004 single-winner invariant",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger scope='finals' MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      const deltaTop = await readLatestFinalRow(PARTICIPANTS.delta, "top_scorer");
      expect(
        deltaTop,
        "score_finals MUST emit a (delta, top_scorer) row",
      ).not.toBeNull();
      expect(
        deltaTop!.points,
        "delta / top_scorer=Messi matches officially-named Golden Boot winner MUST award 20 points",
      ).toBe(20);
      expect(
        deltaTop!.reason_code,
        "delta / top_scorer / correct-and-confirmed MUST be reason_code='final_correct'",
      ).toBe("final_correct");

      const bravoTop = await readLatestFinalRow(PARTICIPANTS.bravo, "top_scorer");
      expect(
        bravoTop,
        "score_finals MUST emit a (bravo, top_scorer) row (slice 004 active pick exists)",
      ).not.toBeNull();
      expect(
        bravoTop!.points,
        "bravo / top_scorer=Vinícius is NOT the officially-named Golden Boot winner per FR-009/OD-004 — MUST award 0 points regardless of raw-goal ties",
      ).toBe(0);
      expect(
        bravoTop!.reason_code,
        "bravo / top_scorer / non-officially-named-pick MUST be reason_code='final_incorrect'",
      ).toBe("final_incorrect");
    },
  );

  // ----------------------------------------------------------------------
  // Best-Player-Pending → final_pending reason (R-008 / Golden Ball delay).
  // ----------------------------------------------------------------------
  // Fixture truth:
  //   tournament_award.best_player_status = 'pending', best_player_player_id = NULL.
  //   3 active best_player picks (all on Pedri):
  //     alpha   (slice 005)  → final_pending / 0
  //     charlie (slice 004)  → final_pending / 0
  //     zeta    (slice 005)  → final_pending / 0
  // Per R-008 + personal-breakdown.read.md § Response: pending items emit
  // reason_code='final_pending', points=0, official_team_or_player_id=NULL
  // (the UI shows "scoring pending" rather than implying 0).
  test(
    "Best-Player-Pending — Given tournament_award.best_player_status='pending', When final scoring runs, Then alpha/charlie/zeta's best_player rows MUST each be points=0, reason_code='final_pending', official_team_or_player_id IS NULL @slice-005 @us2",
    async ({ request }) => {
      const { status, rawBody } = await callScoreTriggerFinals(request, {
        scope: "finals",
        reason: "T017 R-008 — best_player pending → final_pending / 0",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger scope='finals' MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      for (const participantId of [
        PARTICIPANTS.alpha,
        PARTICIPANTS.charlie,
        PARTICIPANTS.zeta,
      ]) {
        const row = await readLatestFinalRow(participantId, "best_player");
        expect(
          row,
          `score_finals MUST emit a (${participantId}, best_player) row even when the award is pending (R-008 / personal-breakdown.read.md)`,
        ).not.toBeNull();
        expect(
          row!.points,
          `${participantId} / best_player while award pending MUST award 0 points (R-008)`,
        ).toBe(0);
        expect(
          row!.reason_code,
          `${participantId} / best_player while award pending MUST be reason_code='final_pending' (personal-breakdown.read.md § Response)`,
        ).toBe("final_pending");
        expect(
          row!.official_team_or_player_id,
          `${participantId} / best_player while award pending MUST have official_team_or_player_id=NULL (personal-breakdown.read.md § Response: official_display=null for final_pending)`,
        ).toBeNull();
      }
    },
  );

  // ----------------------------------------------------------------------
  // Flip pending → confirmed re-scores correctly.
  // ----------------------------------------------------------------------
  // Phase 1: POST scope='finals' with R1 against the fixture-default award
  // (best_player pending). Capture alpha's best_player row → final_pending / 0.
  // Phase 2: Service-role UPDATE tournament_award best_player → Pedri /
  // confirmed.
  // Phase 3: POST scope='finals' with R2 (DIFFERENT run_id → version bumps).
  // Phase 4: Query alpha's NEW best_player row at the latest version → 20 /
  // 'final_correct' (Pedri matches Pedri, status=confirmed).
  // The award is restored in finally.
  test(
    "Flip-pending-→-confirmed — Given alpha's best_player_pending row at version V, When tournament_award.best_player flips to Pedri/confirmed AND finals re-score runs with a new run_id, Then alpha's NEW best_player row at version V+1 MUST be points=20, reason_code='final_correct' @slice-005 @us2",
    async ({ request }) => {
      const award = await snapshotAndRestoreTournamentAward();

      try {
        // Precondition: confirm we start at pending.
        expect(
          award.snapshot.best_player_status,
          "fixture precondition: best_player_status MUST start as 'pending'",
        ).toBe("pending");

        // Phase 1: first scoring run against the pending-state award.
        const runR1 = crypto.randomUUID();
        const r1 = await callScoreTriggerFinals(request, {
          scope: "finals",
          reason: "T017 Flip — R1 (pending baseline)",
          run_id: runR1,
        });
        expect(
          r1.status,
          `score-trigger scope='finals' R1 MUST return 200. Got body: ${r1.rawBody}`,
        ).toBe(200);

        const alphaPending = await readLatestFinalRow(
          PARTICIPANTS.alpha,
          "best_player",
        );
        expect(
          alphaPending,
          "after R1, alpha MUST have a best_player row",
        ).not.toBeNull();
        expect(
          alphaPending!.reason_code,
          "after R1, alpha's best_player MUST be reason_code='final_pending' (award still pending)",
        ).toBe("final_pending");
        expect(
          alphaPending!.points,
          "after R1, alpha's best_player MUST be 0 points (award still pending)",
        ).toBe(0);
        const versionAtR1 = alphaPending!.calculation_version;

        // Phase 2: flip the award to Pedri / confirmed.
        await confirmBestPlayerAsPedri();

        // Phase 3: second scoring run with a DIFFERENT run_id so the version
        // bumps and a NEW row is appended (data-model § Entity 1 — append-only
        // by calculation_version).
        const runR2 = crypto.randomUUID();
        expect(runR2).not.toBe(runR1);
        const r2 = await callScoreTriggerFinals(request, {
          scope: "finals",
          reason: "T017 Flip — R2 (after best_player→Pedri confirmed)",
          run_id: runR2,
        });
        expect(
          r2.status,
          `score-trigger scope='finals' R2 MUST return 200. Got body: ${r2.rawBody}`,
        ).toBe(200);

        // Phase 4: alpha's NEW best_player row at the latest version MUST be
        // 20 / 'final_correct'. Calculation_version MUST have bumped past R1.
        const alphaConfirmed = await readLatestFinalRow(
          PARTICIPANTS.alpha,
          "best_player",
        );
        expect(
          alphaConfirmed,
          "after R2, alpha MUST have a best_player row at a later calculation_version",
        ).not.toBeNull();
        expect(
          alphaConfirmed!.calculation_version,
          `after R2, alpha's NEW best_player row calculation_version MUST be > ${versionAtR1} (recalc bumps version per contract § Behavior step 3)`,
        ).toBeGreaterThan(versionAtR1);
        expect(
          alphaConfirmed!.points,
          "after R2, alpha's best_player=Pedri MUST match official Pedri (confirmed) and award 20 points",
        ).toBe(20);
        expect(
          alphaConfirmed!.reason_code,
          "after R2, alpha's best_player MUST be reason_code='final_correct'",
        ).toBe("final_correct");
      } finally {
        await award.restore();
      }
    },
  );
});
