// --------------------------------------------------------------------------
// Slice 004 / T022 — POST /api/final-predictions is rejected at the API
// level (not just UI) for ALL four item_kinds after lock (SC-002).
// --------------------------------------------------------------------------
// RED acceptance test for Success Criterion SC-002:
//
//   "100% of direct-API attempts to modify final predictions after lock
//   receive the same denial as UI attempts."
//
// And User Story 2 (P1) Acceptance Scenario 2:
//
//   "Given trusted server time after the first match's kickoff, when any
//   participant attempts to modify any final prediction, then the request
//   MUST be rejected with the same denial reason regardless of entry path."
//
// Why this test exists separately from `slice-004-submit-locked.spec.ts`:
//   The lock-state-locked / locked-just-after specs exercise the
//   *champion* branch through the POST surface. SC-002 specifically
//   demands that direct-API submissions are rejected at the API LEVEL
//   "not just the UI", meaning every one of the four item_kinds must be
//   refused by the same server-side gate. This test iterates all four
//   item_kinds and asserts identical 409/FINAL_PREDICTIONS_LOCKED
//   responses — proving the lock check sits BEFORE the item-kind
//   dispatch and applies uniformly.
//
// Approach:
//   - beforeEach sets first_kickoff_utc = Date.now() − 1s (unambiguously
//     past). afterEach restores the fixture value.
//   - Sign in charlie. For each item_kind in {champion, runner_up,
//     top_scorer, best_player}, fire a `request.post` with a valid
//     kind/target combination and assert 409 + reason='lock_window_passed'.
//   - No UI navigation: the assertion is that the API itself enforces.
//
// Persona: charlie.
//
// Source of truth:
//   - specs/004-final-predictions/spec.md § US2 AS-2, SC-002.
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Response codes — 409 FINAL_PREDICTIONS_LOCKED.
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

// Valid targets (slice-002 + slice-004 fixtures).
const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";
const JPN_TEAM_ID = "aaaa0000-0000-0000-0000-000000000008";
const MESSI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000001";
const YAMAL_PLAYER_ID = "dddd1000-0000-0000-0000-000000000010";

const FIXTURE_FIRST_KICKOFF = "2026-06-16T20:00:00Z";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    reason?: string;
  };
}

interface SubmitCase {
  readonly label: string;
  readonly body: Record<string, string>;
}

const SUBMIT_CASES: readonly SubmitCase[] = [
  {
    label: "champion",
    body: { item_kind: "champion", target_team_id: POL_TEAM_ID },
  },
  {
    label: "runner_up",
    body: { item_kind: "runner_up", target_team_id: JPN_TEAM_ID },
  },
  {
    label: "top_scorer",
    body: { item_kind: "top_scorer", target_player_id: MESSI_PLAYER_ID },
  },
  {
    label: "best_player",
    body: { item_kind: "best_player", target_player_id: YAMAL_PLAYER_ID },
  },
];

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
  "US2 — direct-API POST rejected for all four item_kinds after lock (SC-002) @slice-004 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      const justAfterIso = new Date(Date.now() - 1000).toISOString();
      await setFirstKickoffUtc(justAfterIso);
    });

    test.afterEach(async () => {
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await deleteAllCharlieFinalPredictions();
      await resetStub();
    });

    test(
      "charlie direct-API POST for every item_kind returns 409 FINAL_PREDICTIONS_LOCKED after lock @slice-004 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        for (const submitCase of SUBMIT_CASES) {
          const response = await request.post("/api/final-predictions", {
            data: submitCase.body,
          });

          expect(
            response.status(),
            `${submitCase.label}: direct-API POST after lock MUST be 409 (SC-002)`,
          ).toBe(409);

          const body = (await response.json()) as ErrorBody;
          expect(
            body.error.code,
            `${submitCase.label}: error.code MUST be 'FINAL_PREDICTIONS_LOCKED'`,
          ).toBe("FINAL_PREDICTIONS_LOCKED");
          expect(
            body.error.reason,
            `${submitCase.label}: error.reason MUST be 'lock_window_passed'`,
          ).toBe("lock_window_passed");
        }
      },
    );
  },
);
