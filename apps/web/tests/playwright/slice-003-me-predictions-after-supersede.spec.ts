// --------------------------------------------------------------------------
// Slice 003 / T019 — GET /api/me/predictions after an in-test supersede.
// --------------------------------------------------------------------------
// RED acceptance test cementing Clarifications 2026-05-16 Q3 (active-only,
// no history surface) against an UPDATE flow within the same test —
// proving the read endpoint hides the superseded row even when the test
// itself authored the supersede chain (no fixture seeding required).
//
// Source of truth:
//   - specs/003-match-predictions/spec.md § US2 Acceptance Scenarios
//       — "Exactly one active prediction MUST exist per (participant,
//        match) pair at any point in time (FR-006)" and the new prediction
//        becomes the active record while the previous is RETAINED as a
//        superseded version (NOT deleted but also NOT in /me/predictions).
//   - specs/003-match-predictions/contracts/predictions.read.md
//       § Endpoint GET /api/me/predictions — filters to rows where
//       participant_id = caller AND superseded_at IS NULL.
//
// Scenario covered:
//   Sign in as alpha. POST 1-0 for M6 USA-JPN (CREATE). POST 2-1 for M6
//   (UPDATE — supersedes the first row). Now exercise the read path:
//
//     a. GET /api/me/predictions?match_id=<M6>  ->  exactly 1 entry,
//        predicted_home=2, predicted_away=1. The 1-0 superseded row is
//        ABSENT.
//     b. GET /api/me/predictions (no filter)    ->  M6 entry appears
//        EXACTLY ONCE with 2-1; the superseded 1-0 row is absent.
//
//   We also re-prove the data layer: service-role count of (alpha, M6)
//   total rows = 2, active rows = 1.
//
// Why M6: alpha's fixture-active matches are M3, M4, M5. M6 has no
// seeded prediction for alpha. The (no-filter) assertion only checks the
// M6 entry — alpha's three fixture rows on M3/M4/M5 will also appear and
// MUST be left alone.
//
// Cleanup contract: service-role DELETE of any (alpha, M6) rows in both
// before- and afterEach. The fixture seed never touches (alpha, M6) so
// both DELETEs are no-ops in the happy case.
//
// RED until T021 ships the supersede branch. Until then the second POST
// returns 409 DUPLICATE_ACTIVE and the test fails on the second POST's
// status assertion before ever reaching the GET assertions.
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
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const M6_USA_JPN_ID = "bbbb0000-0000-0000-0000-000000000006";

interface PredictionShape {
  id: string;
  match_id: string;
  predicted_home: number;
  predicted_away: number;
  submitted_at: string;
  source: "ui" | "api" | "admin_override";
  superseded_at?: string | null;
}

interface SubmitResponse {
  prediction: PredictionShape;
}

interface MePredictionsResponse {
  predictions: PredictionShape[];
}

async function cleanupAlphaM6PredictionsViaServiceRole(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("predictions")
    .delete()
    .eq("participant_id", ALPHA.participantId)
    .eq("match_id", M6_USA_JPN_ID);
  if (error) {
    throw new Error(
      `cleanupAlphaM6PredictionsViaServiceRole failed — ${error.message}`,
    );
  }
}

test.describe(
  "US2 — GET /api/me/predictions after a supersede returns the new active row only @slice-003 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await cleanupAlphaM6PredictionsViaServiceRole();
    });

    test.afterEach(async () => {
      await resetStub();
      await cleanupAlphaM6PredictionsViaServiceRole();
    });

    test(
      "alpha POSTs 1-0 then 2-1 for M6; GET /me/predictions returns only the active 2-1 (history is hidden) @slice-003 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward signed-in cookies — see slice 001 cookie-forwarding follow-up.
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        const authHeaders = { Cookie: cookieHeader };

        // ---- 1. CREATE (1-0) ---------------------------------------------
        const create = await request.post("/api/predictions", {
          headers: authHeaders,
          data: { match_id: M6_USA_JPN_ID, home: 1, away: 0 },
        });
        expect(create.status(), "first POST (CREATE) MUST be 200").toBe(200);
        const createBody = (await create.json()) as SubmitResponse;
        const supersededId = createBody.prediction.id;

        // ---- 2. UPDATE (2-1) — supersedes the 1-0 row --------------------
        const update = await request.post("/api/predictions", {
          headers: authHeaders,
          data: { match_id: M6_USA_JPN_ID, home: 2, away: 1 },
        });
        expect(
          update.status(),
          "second POST (UPDATE) MUST be 200 — NOT 409 — per US2 AS-1",
        ).toBe(200);
        const updateBody = (await update.json()) as SubmitResponse;
        const activeId = updateBody.prediction.id;
        expect(
          activeId,
          "supersede branch MUST INSERT a new row with a distinct id",
        ).not.toBe(supersededId);

        // ---- 3a. GET with ?match_id=M6 — exactly the active 2-1 row -----
        const filtered = await request.get(
          `/api/me/predictions?match_id=${M6_USA_JPN_ID}`,
          { headers: authHeaders },
        );
        expect(
          filtered.status(),
          "GET /api/me/predictions?match_id=<M6> MUST be 200",
        ).toBe(200);
        const filteredBody = (await filtered.json()) as MePredictionsResponse;
        expect(filteredBody).toMatchObject({ predictions: expect.any(Array) });
        expect(
          filteredBody.predictions.length,
          "exactly 1 entry — the active 2-1 row; the superseded 1-0 row MUST NOT appear (active-only per Q3)",
        ).toBe(1);

        const only = filteredBody.predictions[0]!;
        expect(only.match_id).toBe(M6_USA_JPN_ID);
        expect(
          only.predicted_home,
          "the returned row MUST carry the NEW (active) score 2",
        ).toBe(2);
        expect(
          only.predicted_away,
          "the returned row MUST carry the NEW (active) score 1",
        ).toBe(1);
        expect(
          only.id,
          "the returned row MUST be the new active prediction's id",
        ).toBe(activeId);
        expect(
          only.id,
          "the superseded row's id MUST NOT appear in the response",
        ).not.toBe(supersededId);

        // ---- 3b. GET without filter — M6 entry appears exactly once -----
        const all = await request.get("/api/me/predictions", {
          headers: authHeaders,
        });
        expect(all.status(), "GET /api/me/predictions MUST be 200").toBe(200);
        const allBody = (await all.json()) as MePredictionsResponse;
        expect(allBody).toMatchObject({ predictions: expect.any(Array) });

        const m6Entries = allBody.predictions.filter(
          (p) => p.match_id === M6_USA_JPN_ID,
        );
        expect(
          m6Entries.length,
          "M6 entry MUST appear EXACTLY ONCE (no history dup) in the unfiltered list",
        ).toBe(1);

        const m6 = m6Entries[0]!;
        expect(m6.id).toBe(activeId);
        expect(m6.predicted_home).toBe(2);
        expect(m6.predicted_away).toBe(1);

        // Belt-and-braces: the superseded row's id MUST be absent from the
        // entire unfiltered list.
        const allIds = allBody.predictions.map((p) => p.id);
        expect(
          allIds,
          "superseded row id MUST NOT leak into /me/predictions (Q3 active-only)",
        ).not.toContain(supersededId);

        // ---- 4. Data-layer cross-check via service-role ------------------
        const client = getServiceClient();
        const { count: totalCount, error: totalErr } = await client
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("participant_id", ALPHA.participantId)
          .eq("match_id", M6_USA_JPN_ID);
        if (totalErr) {
          throw new Error(
            `service-role total count failed — ${totalErr.message}`,
          );
        }
        expect(
          totalCount,
          "2 rows MUST persist in predictions (active + superseded) — history is retained, just hidden from /me",
        ).toBe(2);

        const { count: activeCount, error: activeErr } = await client
          .from("predictions")
          .select("id", { count: "exact", head: true })
          .eq("participant_id", ALPHA.participantId)
          .eq("match_id", M6_USA_JPN_ID)
          .is("superseded_at", null);
        if (activeErr) {
          throw new Error(
            `service-role active count failed — ${activeErr.message}`,
          );
        }
        expect(
          activeCount,
          "exactly 1 active row MUST exist for (alpha, M6) — FR-006",
        ).toBe(1);
      },
    );
  },
);
