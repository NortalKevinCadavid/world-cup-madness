// --------------------------------------------------------------------------
// Slice 003 / T025 — `POST /api/predictions` 409 at EXACT lock boundary.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P1) Acceptance Scenario 1 + SC-001.
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US3 Acceptance Scenario 1
//     "Given trusted server time equal to (kickoff − 60 minutes) exactly,
//      When the participant attempts to create or modify a prediction,
//      Then the request MUST be rejected because the rule is strict:
//      remaining time MUST be GREATER THAN 60 minutes (BR-LOCK-003)."
//   - specs/003-match-predictions/contracts/predictions.write.md
//     § 409 Conflict — PREDICTION_LOCKED, reason='lock_window_passed'
//   - specs/003-match-predictions/spec.md § SC-001 (boundary calibration).
//
// Scenario covered:
//   Create a SYNTHETIC match in beforeEach with `kickoff_utc = now() + 60min`
//   (the exact lock boundary). Sign in as alpha, POST /api/predictions for
//   that match, assert 409 with `code='PREDICTION_LOCKED'` and
//   `reason='lock_window_passed'`.
//
// Calibration approach: the slice-003 fixture matches have FIXED kickoffs in
// June 2026 which drift relative to runtime "now". To pin the boundary
// precisely we create a synthetic match via service-role and DELETE it on
// teardown. This decouples the test from wall-clock drift and from any
// reseeding of the fixture catalog.
//
// Synthetic match UUID: dddd0000-0000-0000-0000-000000000200 (Playwright
// namespace; outside the `bbbb...` catalog block to avoid collision).
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

const MATCH_ID = "dddd0000-0000-0000-0000-000000000200";

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

  // Resolve two distinct team UUIDs by short_code (alphabetical first two).
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

  // Clean any predictions referencing this synthetic match first
  // (the FK on predictions.match_id has no CASCADE per slice-003 schema).
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
  "US3 / SC-001 — POST /api/predictions 409 at EXACT lock boundary @slice-003 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Idempotent: clear any leftover state from a prior crashed run.
      await teardownCalibratedMatch();
      // Calibrate: kickoff = now + 60 minutes (the exact boundary).
      await setupCalibratedMatch(60 * 60 * 1000);
    });

    test.afterEach(async () => {
      await teardownCalibratedMatch();
      await resetStub();
    });

    test(
      "POST for a match at exactly (kickoff − 60min) MUST return 409 lock_window_passed @slice-003 @us3",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward the browser session cookies onto the API request.
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
          "POST at exact lock boundary MUST be 409 (BR-LOCK-003 / contract § 409)",
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
          "error.reason MUST be 'lock_window_passed' (BR-LOCK-002 / BR-LOCK-003)",
        ).toBe("lock_window_passed");
      },
    );
  },
);
