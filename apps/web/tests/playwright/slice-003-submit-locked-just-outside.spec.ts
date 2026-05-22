// --------------------------------------------------------------------------
// Slice 003 / T025 — `POST /api/predictions` 200 JUST OUTSIDE the lock window.
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 (P1) Acceptance Scenario 5 + SC-001.
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US3 Acceptance Scenario 5
//     "Given trusted server time at (kickoff − 60 minutes + 1 second), When
//      the participant submits a valid edit, Then the edit MUST be accepted
//      and audited."
//   - specs/003-match-predictions/contracts/predictions.write.md
//     § 200 OK — submission accepted (create OR update)
//   - specs/003-match-predictions/spec.md § SC-001 (the "+0:01 outside" leg
//     of the boundary calibration matrix).
//
// Scenario covered:
//   Create a SYNTHETIC match with `kickoff_utc = now() + 60:05` (a 5-second
//   buffer past the lock boundary to defend against beforeEach-to-SP-eval
//   latency on slow CI runners). Sign in as alpha. POST /api/predictions
//   and assert 200 + the expected envelope. Then GET /api/me/predictions
//   filtered by this match and assert the row is visible.
//
// Synthetic match UUID: dddd0000-0000-0000-0000-000000000202.
//
// Cleanup contract:
//   The afterEach hook deletes any predictions for the synthetic match AND
//   the match itself (in that order, because predictions.match_id has no
//   ON DELETE CASCADE). The HAPPY path creates exactly one prediction row;
//   the cleanup removes it without relying on the route handler being
//   wired yet.
//
// RED until T022 ships the SP and T015 wires the 200 happy-path response.
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

const MATCH_ID = "dddd0000-0000-0000-0000-000000000202";

interface TeamRow {
  id: string;
  short_code: string;
}

interface PredictionShape {
  id: string;
  match_id: string;
  predicted_home: number;
  predicted_away: number;
  submitted_at: string;
  source: "ui" | "api" | "admin_override";
  superseded_at: string | null;
}

interface SubmitResponse {
  prediction: PredictionShape;
}

interface MePredictionsResponse {
  predictions: Array<{
    id: string;
    match_id: string;
    predicted_home: number;
    predicted_away: number;
    submitted_at: string;
    source: string;
  }>;
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
  "US3 / SC-001 — POST /api/predictions 200 JUST OUTSIDE lock window (60:05) @slice-003 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await teardownCalibratedMatch();
      // Calibrate: kickoff = now + 60:05. The +5s buffer absorbs any
      // beforeEach → SP-evaluation latency on slow CI workers so the SP's
      // remaining-time check still resolves to > 60:00 when the POST lands.
      await setupCalibratedMatch(60 * 60 * 1000 + 5 * 1000);
    });

    test.afterEach(async () => {
      await teardownCalibratedMatch();
      await resetStub();
    });

    test(
      "POST for a match at (kickoff − 60:05) MUST be 200 and the row MUST appear in /api/me/predictions @slice-003 @us3",
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
          "POST 5 seconds outside the lock window MUST be 200 (US3 AS-5)",
        ).toBe(200);

        const submitBody = (await response.json()) as SubmitResponse;
        expect(
          submitBody,
          "200 body MUST match { prediction: { ... } } envelope per contract § 200",
        ).toMatchObject({
          prediction: {
            id: expect.any(String),
            match_id: MATCH_ID,
            predicted_home: 2,
            predicted_away: 1,
            submitted_at: expect.any(String),
            source: "ui",
            superseded_at: null,
          },
        });

        // Verify the new prediction is visible via the read path, filtered.
        const list = await request.get(`/api/me/predictions?match_id=${MATCH_ID}`, {
          headers: { Cookie: cookieHeader },
        });
        expect(
          list.status(),
          "GET /api/me/predictions?match_id=<MATCH_ID> for alpha MUST be 200",
        ).toBe(200);

        const listBody = (await list.json()) as MePredictionsResponse;
        const entry = listBody.predictions.find((p) => p.match_id === MATCH_ID);
        expect(
          entry,
          "the newly-inserted prediction MUST appear in /api/me/predictions filtered by this match",
        ).toBeDefined();
        expect(entry!.id).toBe(submitBody.prediction.id);
        expect(entry!.predicted_home).toBe(2);
        expect(entry!.predicted_away).toBe(1);
      },
    );
  },
);
