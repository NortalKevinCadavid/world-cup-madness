// --------------------------------------------------------------------------
// Slice 004 / T022 — POST /api/final-predictions REJECTS when
// first_kickoff_utc is 1 second in the past (US2 Acceptance Scenario 2).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 2 (P1) Acceptance Scenario 2:
//
//   "Given trusted server time after the first match's kickoff, when any
//   participant attempts to modify any final prediction, then the request
//   MUST be rejected with the same denial reason regardless of entry path."
//
// Boundary strategy:
//   beforeEach sets tournament_config.first_kickoff_utc = `Date.now() - 1s`.
//   This is unambiguously past — no race with test latency, no clock-skew
//   risk. The predicate `now() >= v_first_kickoff` is trivially satisfied.
//
// Source of truth:
//   - specs/004-final-predictions/spec.md § US2 AS-2, SC-001.
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Response codes — 409 Conflict (FINAL_PREDICTIONS_LOCKED,
//     reason='lock_window_passed').
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
  "US2 — POST /api/final-predictions rejected 1s after first_kickoff @slice-004 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // first_kickoff_utc = 1 second in the past — unambiguously locked.
      const justAfterIso = new Date(Date.now() - 1000).toISOString();
      await setFirstKickoffUtc(justAfterIso);
    });

    test.afterEach(async () => {
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await deleteCharlieChampionRows();
      await resetStub();
    });

    test(
      "charlie POST champion=POL with first_kickoff_utc 1s in the past returns 409 FINAL_PREDICTIONS_LOCKED @slice-004 @us2",
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

        const response = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "champion", target_team_id: POL_TEAM_ID },
        });

        expect(
          response.status(),
          "POST 1s after first_kickoff MUST be 409 (BR-LOCK-005)",
        ).toBe(409);

        const body = (await response.json()) as ErrorBody;
        expect(body.error.code).toBe("FINAL_PREDICTIONS_LOCKED");
        expect(body.error.reason).toBe("lock_window_passed");
      },
    );
  },
);
