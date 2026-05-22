// --------------------------------------------------------------------------
// Slice 003 / T025 — `POST /api/predictions` 409 match_status_locked.
// --------------------------------------------------------------------------
// RED acceptance tests for BR-LOCK-004 (non-scheduled match statuses).
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US3 § Edge Cases:
//     "A participant submits a prediction for a match that has already
//      started (status moved past scheduled) → the request MUST be rejected
//      even if 60 minutes have not yet elapsed since the original kickoff
//      (BR-LOCK-004)."
//   - specs/003-match-predictions/contracts/predictions.write.md
//     § 409 Conflict — PREDICTION_LOCKED, reason='match_status_locked'.
//   - specs/003-match-predictions/spec.md § FR-005:
//     "System MUST reject creation or modification of a match prediction for
//      a match whose status is in-progress, finished, or cancelled,
//      regardless of the lock-window calculation (BR-LOCK-004)."
//
// Two sub-tests in one file:
//   1. status='in_progress', kickoff well in the FUTURE so the lock-window
//      branch (WCM01) cannot fire. Asserts the WCM02 status branch wins.
//   2. status='finished',    kickoff in the past. Asserts WCM02 also fires
//      on finished matches (the SP must check status BEFORE the time math).
//
// Both sub-tests use distinct synthetic match UUIDs so they can run in
// parallel under Playwright's worker fan-out:
//   - in_progress: dddd0000-0000-0000-0000-000000000203
//   - finished   : dddd0000-0000-0000-0000-000000000204
//
// RED until T022 ships the SP's WCM02 branch and T015 wires the 409 +
// `match_status_locked` mapping.
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

const MATCH_ID_IN_PROGRESS = "dddd0000-0000-0000-0000-000000000203";
const MATCH_ID_FINISHED = "dddd0000-0000-0000-0000-000000000204";

interface TeamRow {
  id: string;
  short_code: string;
}

async function setupCalibratedMatch(
  matchId: string,
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
    id: matchId,
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

async function teardownCalibratedMatch(matchId: string): Promise<void> {
  const supabase = getServiceClient();

  const { error: delPredErr } = await supabase
    .from("predictions")
    .delete()
    .eq("match_id", matchId);
  if (delPredErr) {
    throw new Error(`teardownCalibratedMatch: predictions delete failed — ${delPredErr.message}`);
  }

  const { error: delMatchErr } = await supabase
    .from("matches")
    .delete()
    .eq("id", matchId);
  if (delMatchErr) {
    throw new Error(`teardownCalibratedMatch: matches delete failed — ${delMatchErr.message}`);
  }
}

test.describe(
  "US3 / BR-LOCK-004 — POST /api/predictions 409 match_status_locked @slice-003 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await teardownCalibratedMatch(MATCH_ID_IN_PROGRESS);
      await teardownCalibratedMatch(MATCH_ID_FINISHED);

      // In-progress fixture: kickoff far in the FUTURE so the time-window
      // branch (WCM01) provably cannot be the rejection cause. The status
      // alone must drive the WCM02 rejection.
      await setupCalibratedMatch(
        MATCH_ID_IN_PROGRESS,
        24 * 60 * 60 * 1000, // +24h
        "in_progress",
      );

      // Finished fixture: kickoff in the past, status='finished'. The SP
      // must check status BEFORE the time math, so this also raises WCM02.
      await setupCalibratedMatch(
        MATCH_ID_FINISHED,
        -2 * 60 * 60 * 1000, // −2h
        "finished",
      );
    });

    test.afterEach(async () => {
      await teardownCalibratedMatch(MATCH_ID_IN_PROGRESS);
      await teardownCalibratedMatch(MATCH_ID_FINISHED);
      await resetStub();
    });

    test(
      "POST for an in_progress match (kickoff +24h) MUST be 409 match_status_locked @slice-003 @us3",
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
          data: { match_id: MATCH_ID_IN_PROGRESS, home: 1, away: 1 },
        });

        expect(
          response.status(),
          "POST against an in_progress match MUST be 409 (BR-LOCK-004 / SP WCM02)",
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
          "error.reason MUST be 'match_status_locked' — status MUST win over the time-window branch",
        ).toBe("match_status_locked");
      },
    );

    test(
      "POST for a finished match (kickoff −2h) MUST be 409 match_status_locked @slice-003 @us3",
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
          data: { match_id: MATCH_ID_FINISHED, home: 0, away: 0 },
        });

        expect(
          response.status(),
          "POST against a finished match MUST be 409 (BR-LOCK-004 / SP WCM02)",
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
          "error.reason MUST be 'match_status_locked' on finished matches",
        ).toBe("match_status_locked");
      },
    );
  },
);
