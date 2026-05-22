// --------------------------------------------------------------------------
// Slice 004 / T022 — POST /api/final-predictions ACCEPTS when
// first_kickoff_utc is in the future (US2 Acceptance Scenario 3).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Acceptance Scenario 3:
//
//   "Given trusted server time at first_kickoff − 1 second, when a
//   participant submits a valid edit, then the edit MUST be accepted and
//   audited."
//
// Boundary strategy:
//   beforeEach sets tournament_config.first_kickoff_utc = `Date.now() + 60s`.
//   The spec asks for "first_kickoff − 1s ACCEPT", but a 1-second window
//   is fragile under Playwright HTTP latency (cold zod compile, server
//   startup, network RTT) — a slow CI run could push request handling
//   past the boundary and flip 200 → 409 spuriously. A 60-second future
//   window proves the same semantics ("lock not yet fired → ACCEPT")
//   without racing the clock. The strict `<` branch of the predicate
//   `now() >= v_first_kickoff` is exercised identically at +1s and +60s.
//
// Cleanup contract:
//   afterEach DELETEs the newly-inserted (charlie, champion) row via the
//   service-role helper so sibling tests start from a clean slate, then
//   restores the fixture first_kickoff value.
//
// Source of truth:
//   - specs/004-final-predictions/spec.md § US2 AS-3, SC-001.
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Response codes — 200 OK.
//
// Persona: charlie.
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

async function deleteCharlieChampionRows(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("final_predictions")
    .delete()
    .eq("participant_id", CHARLIE.participantId)
    .eq("item_kind", "champion");
  if (error) {
    throw new Error(`deleteCharlieChampionRows failed — ${error.message}`);
  }
}

test.describe(
  "US2 — POST /api/final-predictions accepted just before lock @slice-004 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await deleteCharlieChampionRows();
      // first_kickoff_utc = 60s in the future — robust against test latency
      // while still exercising the strict-`<` branch of the lock predicate.
      const justBeforeIso = new Date(Date.now() + 60_000).toISOString();
      await setFirstKickoffUtc(justBeforeIso);
    });

    test.afterEach(async () => {
      // Remove the inserted row so sibling tests see a clean slate.
      await deleteCharlieChampionRows();
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await resetStub();
    });

    test(
      "charlie POST champion=POL with first_kickoff_utc 60s in the future returns 200 @slice-004 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        const response = await request.post("/api/final-predictions", {
          data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
        });

        expect(
          response.status(),
          "POST before first_kickoff MUST be 200 (SC-001)",
        ).toBe(200);

        const body = (await response.json()) as SubmitResponse;
        expect(
          body.final_prediction.target_team_id,
          "response envelope MUST echo back the submitted target_team_id",
        ).toBe(POL_TEAM_ID);
        expect(body.final_prediction.item_kind).toBe("champion");
        expect(body.final_prediction.target_player_id).toBeNull();
        expect(body.final_prediction.superseded_at).toBeNull();
      },
    );
  },
);
