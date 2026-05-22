// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` four-in-sequence spec.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenarios 1 + 2:
// the participant submits ALL four item_kinds (champion, runner_up,
// top_scorer, best_player). After all four POSTs succeed, GET
// /api/me/final-predictions MUST return exactly four active entries —
// one per item_kind — and `lock_state='editable'`.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Endpoint POST /api/final-predictions (all four item_kinds).
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Endpoint GET /api/me/final-predictions (active-only).
//   - specs/004-final-predictions/spec.md § US1 Acceptance Scenarios 1, 2.
//   - spec.md FR-002 (four items are independently editable; submitting
//     one does not affect the others).
//
// Scenario:
//   Sign in as charlie. POST in sequence:
//     1. champion    -> POL
//     2. runner_up   -> JPN  (DIFFERENT team — FR-007 disjoint rule)
//     3. top_scorer  -> Messi (player 01)
//     4. best_player -> Yamal (player 10)
//   Each POST asserted 200 with the correct envelope. After all four,
//   GET /api/me/final-predictions MUST return exactly 4 active entries —
//   one per item_kind.
//
// Why charlie:
//   The slice-004 fixture seeds Charlie's best_player row (Pedri). This
//   test will therefore SUPERSEDE that fixture row when submitting the
//   best_player branch (Yamal). beforeEach + afterEach DELETE every
//   final_predictions row for Charlie so the test starts from a clean
//   slate (no fixture rows) and leaves the DB pristine. The fixture is
//   re-seeded by `supabase db reset`; tests do NOT need to restore it.
//
// Cleanup contract:
//   Service-role DELETE all final_predictions rows for Charlie.
//
// RED until T018 ships the route handler.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  participantId: "33333333-3333-3333-3333-333333333333",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;

// Teams (slice-002 fixture).
const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";
const JPN_TEAM_ID = "aaaa0000-0000-0000-0000-000000000008";

// Players (slice-004 fixture).
const MESSI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000001"; // player 01
const YAMAL_PLAYER_ID = "dddd1000-0000-0000-0000-000000000010"; // player 10

interface FinalPredictionShape {
  id: string;
  item_kind: "champion" | "runner_up" | "top_scorer" | "best_player";
  target_team_id: string | null;
  target_player_id: string | null;
  submitted_at: string;
  source: "ui" | "api" | "admin_override";
  superseded_at: string | null;
}

interface SubmitResponse {
  final_prediction: FinalPredictionShape;
}

interface MeFinalPredictionsResponse {
  final_predictions: Array<{
    id: string;
    item_kind: string;
    target_team_id: string | null;
    target_player_id: string | null;
    submitted_at: string;
    source: string;
  }>;
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
}

async function deleteAllCharlieFinalPredictions(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("final_predictions")
    .delete()
    .eq("participant_id", CHARLIE.participantId);
  if (error) {
    throw new Error(
      `deleteAllCharlieFinalPredictions failed — ${error.message}`,
    );
  }
}

test.describe(
  "US1 — POST /api/final-predictions all four item_kinds @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
    });

    test.afterEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
    });

    test(
      "charlie submits champion → runner_up → top_scorer → best_player; GET returns 4 active rows @slice-004 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        // ---- 1. champion -> POL ----------------------------------------
        const champion = await request.post("/api/final-predictions", {
          data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
        });
        expect(
          champion.status(),
          "POST champion MUST be 200",
        ).toBe(200);
        const championBody = (await champion.json()) as SubmitResponse;
        expect(championBody.final_prediction).toMatchObject({
          item_kind: "champion",
          target_team_id: POL_TEAM_ID,
          target_player_id: null,
          superseded_at: null,
        });

        // ---- 2. runner_up -> JPN (must differ from champion per FR-007) -
        const runnerUp = await request.post("/api/final-predictions", {
          data: { item_kind: "runner_up", target_team_id: JPN_TEAM_ID },
        });
        expect(
          runnerUp.status(),
          "POST runner_up MUST be 200 (JPN != POL so FR-007 not triggered)",
        ).toBe(200);
        const runnerUpBody = (await runnerUp.json()) as SubmitResponse;
        expect(runnerUpBody.final_prediction).toMatchObject({
          item_kind: "runner_up",
          target_team_id: JPN_TEAM_ID,
          target_player_id: null,
          superseded_at: null,
        });

        // ---- 3. top_scorer -> Messi -----------------------------------
        const topScorer = await request.post("/api/final-predictions", {
          data: {
            item_kind: "top_scorer",
            target_player_id: MESSI_PLAYER_ID,
          },
        });
        expect(
          topScorer.status(),
          "POST top_scorer MUST be 200",
        ).toBe(200);
        const topScorerBody = (await topScorer.json()) as SubmitResponse;
        expect(topScorerBody.final_prediction).toMatchObject({
          item_kind: "top_scorer",
          target_team_id: null,
          target_player_id: MESSI_PLAYER_ID,
          superseded_at: null,
        });

        // ---- 4. best_player -> Yamal ----------------------------------
        const bestPlayer = await request.post("/api/final-predictions", {
          data: {
            item_kind: "best_player",
            target_player_id: YAMAL_PLAYER_ID,
          },
        });
        expect(
          bestPlayer.status(),
          "POST best_player MUST be 200",
        ).toBe(200);
        const bestPlayerBody = (await bestPlayer.json()) as SubmitResponse;
        expect(bestPlayerBody.final_prediction).toMatchObject({
          item_kind: "best_player",
          target_team_id: null,
          target_player_id: YAMAL_PLAYER_ID,
          superseded_at: null,
        });

        // ---- 5. GET /api/me/final-predictions — exactly 4 active rows -
        const list = await request.get("/api/me/final-predictions");
        expect(
          list.status(),
          "GET /api/me/final-predictions for charlie MUST be 200",
        ).toBe(200);

        const listBody = (await list.json()) as MeFinalPredictionsResponse;
        expect(
          listBody.final_predictions.length,
          "exactly 4 active final_predictions rows MUST exist (one per item_kind)",
        ).toBe(4);

        const byKind = new Map(
          listBody.final_predictions.map((p) => [p.item_kind, p]),
        );
        expect(byKind.get("champion")?.target_team_id).toBe(POL_TEAM_ID);
        expect(byKind.get("runner_up")?.target_team_id).toBe(JPN_TEAM_ID);
        expect(byKind.get("top_scorer")?.target_player_id).toBe(MESSI_PLAYER_ID);
        expect(byKind.get("best_player")?.target_player_id).toBe(YAMAL_PLAYER_ID);

        expect(
          listBody.lock_state,
          "with the fixture's first_kickoff_utc in the future, lock_state MUST be 'editable'",
        ).toBe("editable");
      },
    );
  },
);
