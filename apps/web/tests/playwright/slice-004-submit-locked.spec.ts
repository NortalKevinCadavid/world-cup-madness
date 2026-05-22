// --------------------------------------------------------------------------
// Slice 004 / T022 — POST /api/final-predictions REJECTS at exactly the
// first-kickoff boundary (US2 Acceptance Scenario 1).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Acceptance Scenario 1:
//
//   "Given trusted server time equal to the first match's canonical UTC
//   kickoff, when any participant attempts to create or modify any final
//   prediction (UI or API), then the request MUST be rejected
//   (BR-LOCK-005); no record MUST be created or updated."
//
// Source of truth:
//   - specs/004-final-predictions/spec.md § US2 AS-1, SC-001.
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Response codes — 409 Conflict (FINAL_PREDICTIONS_LOCKED,
//     reason='lock_window_passed').
//   - migrations/0041_is_final_prediction_locked.sql — strict `>=`.
//
// Boundary strategy:
//   beforeEach mutates tournament_config.first_kickoff_utc to the EXACT
//   wall-clock instant of test setup (`new Date().toISOString()`). By the
//   time the route handler invokes the SP (network + zod + auth), Postgres
//   `now()` is unambiguously greater than (or equal to) that timestamp, so
//   the predicate `now() >= v_first_kickoff` fires and the SP raises
//   ERRCODE='WFP01' → route maps to 409 FINAL_PREDICTIONS_LOCKED with
//   reason='lock_window_passed'.
//
// Persona: charlie (cleanest fixture slate — only seeded row is best_player
// = Pedri; never a champion row, so this POST is unambiguously a CREATE
// attempt against the lock check).
//
// Cleanup contract:
//   - afterEach restores tournament_config.first_kickoff_utc to the slice
//     fixture value `'2026-06-16T20:00:00Z'` unconditionally.
//   - No row deletion needed: the POST is expected to 409 BEFORE the SP
//     inserts anything (lock check fires before INSERT per slot 0044
//     ordering). Belt-and-braces: also delete any (charlie, champion) row
//     in case a future SP refactor reorders the check.
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

interface ErrorBody {
  error: {
    code: string;
    message: string;
    reason?: string;
  };
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
  "US2 — POST /api/final-predictions rejected at exact lock boundary @slice-004 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Boundary: now(). By the time the SP executes, Postgres now() will
      // be `>= boundaryIso` so the strict-`>=` predicate fires.
      const boundaryIso = new Date().toISOString();
      await setFirstKickoffUtc(boundaryIso);
    });

    test.afterEach(async () => {
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await deleteCharlieChampionRows();
      await resetStub();
    });

    test(
      "charlie POST champion=POL at first_kickoff boundary returns 409 FINAL_PREDICTIONS_LOCKED @slice-004 @us2",
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
          "POST at exact first_kickoff boundary MUST be 409 (BR-LOCK-005 strict >=)",
        ).toBe(409);

        const body = (await response.json()) as ErrorBody;
        expect(
          body.error.code,
          "error.code MUST be 'FINAL_PREDICTIONS_LOCKED' per contract § 409 Conflict",
        ).toBe("FINAL_PREDICTIONS_LOCKED");
        expect(
          body.error.reason,
          "error.reason MUST be 'lock_window_passed' per contract § 409 Conflict",
        ).toBe("lock_window_passed");
      },
    );
  },
);
