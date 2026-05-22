// --------------------------------------------------------------------------
// Slice 004 / T027 — `POST /api/final-predictions` identical champion /
// runner-up validation + config-flag toggle.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P2) + FR-007 — by default the
// runner-up team MUST differ from the champion team. The check is
// configurable via `tournament_config.predictions.allow_identical_champion_runner_up`
// (seed slot 0047 ships `false`). Toggling the flag to `true` MUST allow
// the otherwise-rejected submission.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 409 Conflict (IDENTICAL_CHAMPION_RUNNER_UP, reason
//     `identical_champion_runner_up`).
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Stored procedure semantics step 6 (disjoint check FR-007 with
//     config-flag bypass).
//   - specs/004-final-predictions/spec.md § US3 + Edge Cases ("same team
//     for champion AND runner-up → REJECT by default; configurable").
//
// Scenario covered:
//   Charlie (clean state):
//     1. POST champion = POL → 200.
//     2. POST runner_up = POL → 409 with body
//        `{error:'IDENTICAL_CHAMPION_RUNNER_UP', reason:'identical_champion_runner_up'}`
//        (route handler maps SP ERRCODE='WFP06' to this 409).
//     3. Service-role flips
//        `tournament_config.predictions.allow_identical_champion_runner_up`
//        to `true`.
//     4. POST runner_up = POL again → 200.
//     5. GET /api/me/final-predictions shows champion=POL AND
//        runner_up=POL as the two active entries.
//
// Cleanup contract:
//   - beforeEach + afterEach DELETE all of Charlie's final_predictions
//     rows AND restore the config flag to `false` so sibling tests see
//     the seeded default.
//   - The flip-up to `true` happens INSIDE the test body (not via
//     `withTemporaryConfig`) because we need to interleave the toggle
//     with a second POST. The afterEach restore is the authoritative
//     reset.
//
// RED until T029 ships the SP's identical-champ-runner check + the route
// handler's ERRCODE='WFP06' → 409 mapping (the disjoint check is wired
// into the supersede / submit transaction in step 6 of the SP). Pre-T029,
// the second POST either succeeds (no disjoint check) or returns the
// wrong error, and this test fails on the 409 + reason assertion.
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

const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";

const ALLOW_IDENTICAL_KEY = "predictions.allow_identical_champion_runner_up";

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

interface SubmitErrorBody {
  error: {
    code?: string;
    message?: string;
    reason?: string;
  } | string;
  reason?: string;
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

async function setAllowIdenticalFlag(value: boolean): Promise<void> {
  // tournament_config.value is JSONB; the slice 002 fixture stores this
  // key as a plain JSON boolean. `withTemporaryConfig` likewise calls
  // `.update({ value })` with a raw JS boolean — the Supabase client
  // serializes it correctly into the JSONB column.
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_config")
    .update({ value })
    .eq("key", ALLOW_IDENTICAL_KEY);
  if (error) {
    throw new Error(
      `setAllowIdenticalFlag(${value}) failed — ${error.message}`,
    );
  }
}

test.describe(
  "US3 — POST /api/final-predictions rejects identical champion/runner-up by default; config toggle allows it @slice-004 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
      // Restore seed default (false) so each test starts from the
      // documented baseline.
      await setAllowIdenticalFlag(false);
    });

    test.afterEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
      // Restore seed default (false) for sibling specs.
      await setAllowIdenticalFlag(false);
    });

    test(
      "charlie POSTs champion=POL then runner_up=POL → 409; flip config → 200; both surface as active @slice-004 @us3",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        // ---- 1. POST champion = POL → 200 -----------------------------
        const champion = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
        });
        expect(
          champion.status(),
          "POST champion=POL MUST be 200 (clean state, no disjoint conflict)",
        ).toBe(200);
        const championBody = (await champion.json()) as SubmitResponse;
        expect(championBody.final_prediction).toMatchObject({
          item_kind: "champion",
          target_team_id: POL_TEAM_ID,
          superseded_at: null,
        });

        // ---- 2. POST runner_up = POL → 409 with disjoint reason ------
        const conflicted = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "runner_up", target_team_id: POL_TEAM_ID },
        });
        expect(
          conflicted.status(),
          "POST runner_up=POL while champion=POL MUST be 409 (FR-007 disjoint, flag=false)",
        ).toBe(409);
        const conflictBody = (await conflicted.json()) as SubmitErrorBody;

        // Tolerate either `{error: 'STRING', reason: '...'}` or the
        // nested `{error: {code: '...', reason: '...'}}` shape — the
        // contract pins the code value but not the envelope nesting
        // precisely for legacy callers. Either branch MUST surface the
        // `identical_champion_runner_up` reason.
        const code =
          typeof conflictBody.error === "string"
            ? conflictBody.error
            : conflictBody.error?.code;
        const reason =
          typeof conflictBody.error === "string"
            ? conflictBody.reason
            : conflictBody.error?.reason ?? conflictBody.reason;

        expect(
          code,
          "409 body MUST carry code='IDENTICAL_CHAMPION_RUNNER_UP'",
        ).toBe("IDENTICAL_CHAMPION_RUNNER_UP");
        expect(
          reason,
          "409 body MUST carry reason='identical_champion_runner_up' (SP ERRCODE='WFP06')",
        ).toBe("identical_champion_runner_up");

        // ---- 3. Flip the config flag to TRUE -------------------------
        await setAllowIdenticalFlag(true);

        // ---- 4. POST runner_up = POL again → 200 ---------------------
        const allowed = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "runner_up", target_team_id: POL_TEAM_ID },
        });
        expect(
          allowed.status(),
          "with flag=true, POST runner_up=POL MUST be 200 (FR-007 disjoint bypassed)",
        ).toBe(200);
        const allowedBody = (await allowed.json()) as SubmitResponse;
        expect(allowedBody.final_prediction).toMatchObject({
          item_kind: "runner_up",
          target_team_id: POL_TEAM_ID,
          superseded_at: null,
        });

        // ---- 5. GET shows BOTH champion=POL AND runner_up=POL --------
        const list = await request.get("/api/me/final-predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(
          list.status(),
          "GET /api/me/final-predictions MUST be 200",
        ).toBe(200);
        const listBody = (await list.json()) as MeFinalPredictionsResponse;

        const championEntry = listBody.final_predictions.find(
          (p) => p.item_kind === "champion",
        );
        const runnerUpEntry = listBody.final_predictions.find(
          (p) => p.item_kind === "runner_up",
        );

        expect(
          championEntry,
          "GET MUST surface the active champion entry",
        ).toBeDefined();
        expect(championEntry!.target_team_id).toBe(POL_TEAM_ID);

        expect(
          runnerUpEntry,
          "GET MUST surface the active runner_up entry (flag=true allowed it)",
        ).toBeDefined();
        expect(runnerUpEntry!.target_team_id).toBe(POL_TEAM_ID);
      },
    );
  },
);
