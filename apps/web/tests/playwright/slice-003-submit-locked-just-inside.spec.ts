// --------------------------------------------------------------------------
// Slice 003 / T025 — `POST /api/predictions` 409 JUST INSIDE the lock window.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P1) Acceptance Scenario 2 + SC-001.
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US3 Acceptance Scenario 2
//     "Given trusted server time within the lock window (e.g., kickoff − 59
//      minutes), When the participant attempts to create or modify a
//      prediction via the UI, Then the request MUST be rejected ..."
//   - specs/003-match-predictions/contracts/predictions.write.md
//     § 409 Conflict — PREDICTION_LOCKED, reason='lock_window_passed'
//   - specs/003-match-predictions/spec.md § SC-001 (calibration at offsets
//     including 59:59 inside the window).
//
// Scenario covered:
//   Create a SYNTHETIC match in beforeEach with `kickoff_utc = now() +
//   (59*60 + 59) seconds` — i.e. 1 second INSIDE the 60-minute lock
//   window. Sign in as alpha, POST /api/predictions, assert 409 with
//   `code='PREDICTION_LOCKED'` and `reason='lock_window_passed'`.
//
// Synthetic match UUID: dddd0000-0000-0000-0000-000000000201.
//
// RED until T022 ships the SP `submit_prediction` with the WCM01 branch and
// T015 wires the route handler error mapping to 409/`lock_window_passed`.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const MATCH_ID = "dddd0000-0000-0000-0000-000000000201";

interface TeamRow {
  id: string;
  short_code: string;
}

async function setupCalibratedMatch(
  kickoffOffsetMs: number,
  status: "scheduled" | "in_progress" | "finished" = "scheduled",
): Promise<void> {
  const supabase = getServiceClient();
  const kickoffUtc = new Date(Date.now() + kickoffOffsetMs).toISOString();

  const { data: teams, error: teamsErr } = await supabase
    .from("teams")
    .select("id, short_code")
    .order("short_code", { ascending: true })
    .limit(2);
  if (teamsErr) {
    throw new Error(`setupCalibratedMatch: teams lookup failed — ${teamsErr.message}`);
  }
  const rows = (teams ?? []) as TeamRow[];
  const homeId = rows[0]?.id;
  const awayId = rows[1]?.id;
  if (!homeId || !awayId) {
    throw new Error("setupCalibratedMatch: teams fixture missing — need at least two team rows");
  }

  const { error: upsertErr } = await supabase.from("matches").upsert({
    id: MATCH_ID,
    home_team_id: homeId,
    away_team_id: awayId,
    stage: "group",
    group_id: "A",
    kickoff_utc: kickoffUtc,
    status,
  });
  if (upsertErr) {
    throw new Error(`setupCalibratedMatch: matches upsert failed — ${upsertErr.message}`);
  }
}

async function teardownCalibratedMatch(): Promise<void> {
  const supabase = getServiceClient();

  const { error: delPredErr } = await supabase
    .from("predictions")
    .delete()
    .eq("match_id", MATCH_ID);
  if (delPredErr) {
    throw new Error(`teardownCalibratedMatch: predictions delete failed — ${delPredErr.message}`);
  }

  const { error: delMatchErr } = await supabase
    .from("matches")
    .delete()
    .eq("id", MATCH_ID);
  if (delMatchErr) {
    throw new Error(`teardownCalibratedMatch: matches delete failed — ${delMatchErr.message}`);
  }
}

test.describe(
  "US3 / SC-001 — POST /api/predictions 409 JUST INSIDE lock window (59:59) @slice-003 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await teardownCalibratedMatch();
      // Calibrate: kickoff = now + 59:59 — i.e. one second INSIDE the
      // 60-minute lock window. Remaining time at SP evaluation: ≤ 59:59 < 60:00.
      await setupCalibratedMatch(59 * 60 * 1000 + 59 * 1000);
    });

    test.afterEach(async () => {
      await teardownCalibratedMatch();
      await resetStub();
    });

    test(
      "POST for a match at (kickoff − 59:59) MUST return 409 lock_window_passed @slice-003 @us3",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

        const response = await request.post("/api/predictions", {
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
          },
          data: { match_id: MATCH_ID, home: 2, away: 1 },
        });

        expect(
          response.status(),
          "POST inside lock window MUST be 409 (BR-LOCK-002 / contract § 409)",
        ).toBe(409);

        const body = (await response.json()) as {
          error?: { code?: string; reason?: string; message?: string };
        };
        expect(
          body.error?.code,
          "error.code MUST be PREDICTION_LOCKED per contract § 409",
        ).toBe("PREDICTION_LOCKED");
        expect(
          body.error?.reason,
          "error.reason MUST be 'lock_window_passed' (remaining_time ≤ lock_window)",
        ).toBe("lock_window_passed");
      },
    );
  },
);
