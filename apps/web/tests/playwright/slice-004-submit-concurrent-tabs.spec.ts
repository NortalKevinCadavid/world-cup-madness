// --------------------------------------------------------------------------
// Slice 004 / T022 — Concurrent same-item POSTs from "two tabs" produce
// exactly one active row (FR-010 / SC-004).
// --------------------------------------------------------------------------
// RED acceptance test for:
//
//   FR-010: "System MUST maintain exactly one active value per
//   (participant, item) pair while preserving every prior submission as
//   immutable history."
//
//   SC-004: "Across 1,000 simulated concurrent edits to the same
//   (participant, item) pair, exactly one active value exists at the end
//   and every submitted version is retrievable."
//
// This test exercises the smallest non-trivial concurrent case: TWO
// parallel POSTs for the same (charlie, champion) with different
// target_team_ids. The SP serializes them via
// `pg_advisory_xact_lock(hashtext(participant_id::text || ':' ||
// item_kind))` (slot 0044 step 1).
//
// Expected behaviour POST-US3 (post-supersede, T029 + T030):
//   - Setup: first_kickoff_utc 60s in the future (unlocked).
//   - The advisory lock serializes the two transactions. The first to
//     acquire the lock INSERTs successfully → 200.
//   - The second waits, then sees there is ALREADY an active row for
//     (charlie, champion). T029 (US3) wired the SP's supersede
//     UPDATE+INSERT branch (slot 0048), so the second submission no
//     longer raises 23505 — it supersedes the OLD row (superseded_at =
//     now(), superseded_by = NEW.id) and inserts a fresh active NEW
//     row. Both POSTs therefore return 200.
//   - The route handler's 23505 → 409 ALREADY_SUBMITTED mapping
//     (D-014 provisional) is now unreachable on the same-(participant,
//     item_kind) path because the SP no longer raises 23505 there.
//
//   So post-US3 (T030 revision applied), the assertion is:
//     - BOTH responses are 200 (one CREATE-branch winner; one SUPERSEDE-
//       branch loser, in lock-acquisition order);
//     - GET /api/me/final-predictions shows EXACTLY ONE active champion
//       row (the FR-010 / SC-004 invariant — unchanged across US2 → US3).
//
//   The FR-010 / SC-004 "exactly one active row" invariant is the
//   load-bearing assertion of this test and survives the US2 → US3
//   transition unchanged. Only the HTTP-status-pair shape moved from
//   [200, 409] (pre-T029) to [200, 200] (post-T029) — owned by T030.
//
// Cleanup: afterEach service-role DELETEs every charlie final_predictions
// row to keep sibling tests clean (this test churns history).
//
// Persona: charlie.
//
// Source of truth:
//   - specs/004-final-predictions/spec.md FR-010, SC-004,
//     Edge Cases: "Concurrent edits from the same participant to the
//     same final-prediction item from two tabs → exactly one MUST be
//     the active value; the other MUST be a superseded version."
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Test surface — `slice-004-submit-concurrent-tabs.spec.ts`.
//   - T018 route: 23505 → 409 ALREADY_SUBMITTED branch (provisional).
//   - SP slot 0044: pg_advisory_xact_lock per (participant, item_kind).
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

// Two DIFFERENT teams so we can tell which submission won.
const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";
const JPN_TEAM_ID = "aaaa0000-0000-0000-0000-000000000008";

const FIXTURE_FIRST_KICKOFF = "2026-06-16T20:00:00Z";

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

async function setFirstKickoffUtc(isoValue: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_config")
    .update({ value: isoValue })
    .eq("key", "first_kickoff_utc");
  if (error) {
    throw new Error(`setFirstKickoffUtc(${isoValue}) failed — ${error.message}`);
  }
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
  "US2+US3/FR-010/SC-004 — concurrent same-item POSTs yield exactly one active row @slice-004 @us2 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
      // Unlocked: 60s in the future. The lock branch is not what we're
      // testing here.
      const justBeforeIso = new Date(Date.now() + 60_000).toISOString();
      await setFirstKickoffUtc(justBeforeIso);
    });

    test.afterEach(async () => {
      await deleteAllCharlieFinalPredictions();
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await resetStub();
    });

    test(
      "two parallel POSTs for (charlie, champion) result in exactly one active row (FR-010) @slice-004 @us2 @us3",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const authHeaders = { Cookie: cookieHeader };

        // Fire both POSTs as close to simultaneously as the event loop
        // permits. The SP's advisory lock per (participant, item_kind)
        // serializes them inside Postgres.
        const [responseA, responseB] = await Promise.all([
          request.post("/api/final-predictions", {
            headers: authHeaders,
            data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
          }),
          request.post("/api/final-predictions", {
            headers: authHeaders,
            data: { item_kind: "champion", target_team_id: JPN_TEAM_ID },
          }),
        ]);

        const statusA = responseA.status();
        const statusB = responseB.status();

        // Post-US3 expectation (per inline header comment): BOTH 200.
        // T029's supersede UPDATE+INSERT branch (slot 0048) means the
        // second submission supersedes the first instead of raising 23505.
        // T030 owns this status-pair revision: [200, 409] → [200, 200].
        const statuses = [statusA, statusB].sort();
        expect(
          statuses,
          "both parallel POSTs MUST succeed (200) — the second is serialized behind the first by the SP's pg_advisory_xact_lock and lands on the SUPERSEDE branch (T029)",
        ).toEqual([200, 200]);

        // Both responses now carry SubmitResponse envelopes. The latter
        // active row is the one whose `target_team_id` ends up in the GET
        // result; we cannot determine winner from status alone here, so we
        // read both 200 bodies and identify the active winner via GET below.
        const bodyA = (await responseA.json()) as SubmitResponse;
        const bodyB = (await responseB.json()) as SubmitResponse;
        const submittedTeamIds = [
          bodyA.final_prediction.target_team_id,
          bodyB.final_prediction.target_team_id,
        ];
        expect(
          submittedTeamIds.every(
            (t) => t === POL_TEAM_ID || t === JPN_TEAM_ID,
          ),
          "both submitted target_team_ids MUST be one of the two posted teams",
        ).toBe(true);

        // The FR-010 / SC-004 invariant: GET shows EXACTLY ONE active
        // champion row regardless of which submission won.
        const list = await request.get("/api/me/final-predictions", {
          headers: authHeaders,
        });
        expect(list.status(), "GET /api/me/final-predictions MUST be 200").toBe(
          200,
        );

        const listBody = (await list.json()) as MeFinalPredictionsResponse;
        const championRows = listBody.final_predictions.filter(
          (p) => p.item_kind === "champion",
        );
        expect(
          championRows.length,
          "exactly ONE active champion row MUST exist (FR-010 / SC-004 invariant — load-bearing across US2 → US3)",
        ).toBe(1);
        expect(
          submittedTeamIds.includes(championRows[0]?.target_team_id ?? ""),
          "the surviving active row MUST match one of the two posted teams (post-T029 supersede: the second-to-acquire-lock wins)",
        ).toBe(true);
      },
    );
  },
);
