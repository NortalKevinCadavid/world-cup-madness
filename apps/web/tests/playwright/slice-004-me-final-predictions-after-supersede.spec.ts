// --------------------------------------------------------------------------
// Slice 004 / T027 — GET /api/me/final-predictions after an in-test
// supersede (active-only read posture).
// --------------------------------------------------------------------------
// RED acceptance test cementing the active-only read posture (contract
// § 200) against an UPDATE flow within the same test — proving the read
// endpoint hides the superseded row even when the test itself authored
// the supersede chain.
//
// Tag rationale:
//   - `@us1` because the underlying read endpoint (`GET
//     /api/me/final-predictions`) is the US1 surface and its active-only
//     contract is what this test pins down.
//   - `@us3` because the test exercises the supersede branch (the
//     second-POST path is owned by US3 / T029); pre-T029 the second
//     POST fails and this test is RED.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.read.md
//     § Test surface — `slice-004-me-final-predictions-after-supersede.spec.ts`:
//     "Submit champion = A, then = B; GET → 1 entry for champion with
//      target_team_id=B".
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Stored procedure semantics step 7 (the supersede arm shipped by
//     T029).
//   - specs/004-final-predictions/spec.md § US1 (active-only read) and
//     § US3 (supersede preserves history).
//
// Why charlie:
//   The slice-004 fixture seeds Charlie's `best_player` (Pedri) but does
//   NOT seed any champion row for Charlie. The two POSTs in this test
//   therefore exercise CREATE-then-SUPERSEDE on a clean (charlie,
//   champion) pair with no fixture row to occlude the active-only check.
//
// Cleanup contract:
//   Service-role DELETE every `final_predictions` row for Charlie before
//   and after each test. `supabase db reset` regenerates Charlie's
//   fixture `best_player` row.
//
// RED until T029 ships the SP's supersede arm. Pre-T029 the second POST
// returns 409 ALREADY_SUBMITTED and this test fails on the second-status
// assertion. Post-T029, it flips to GREEN.
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

const ARG_TEAM_ID = "aaaa0000-0000-0000-0000-000000000001";
const BRA_TEAM_ID = "aaaa0000-0000-0000-0000-000000000002";

interface FinalPredictionShape {
  id: string;
  item_kind: "champion" | "runner_up" | "top_scorer" | "best_player";
  target_team_id: string | null;
  target_player_id: string | null;
  submitted_at: string;
  source: string;
}

interface SubmitResponse {
  final_prediction: FinalPredictionShape;
}

interface MeFinalPredictionsResponse {
  final_predictions: FinalPredictionShape[];
  lock_state: "editable" | "locked";
  first_kickoff_utc: string | null;
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
  "US1+US3 — GET /api/me/final-predictions after a supersede returns only the new active row @slice-004 @us1 @us3",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
    });

    test.afterEach(async () => {
      await resetStub();
      await deleteAllCharlieFinalPredictions();
    });

    test(
      "charlie POSTs champion=ARG then champion=BRA; GET returns only the active BRA row (history is hidden) @slice-004 @us1 @us3",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        const cookies = await page.context().cookies();
        const cookieHeader = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        // ---- 1. CREATE champion = ARG ---------------------------------
        const create = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "champion", target_team_id: ARG_TEAM_ID },
        });
        expect(
          create.status(),
          "first POST (CREATE champion=ARG) MUST be 200",
        ).toBe(200);
        const createBody = (await create.json()) as SubmitResponse;
        const argId = createBody.final_prediction.id;
        expect(createBody.final_prediction.target_team_id).toBe(ARG_TEAM_ID);

        // ---- 2. SUPERSEDE — champion = BRA ----------------------------
        const update = await request.post("/api/final-predictions", {
          headers: { Cookie: cookieHeader },
          data: { item_kind: "champion", target_team_id: BRA_TEAM_ID },
        });
        expect(
          update.status(),
          "second POST (UPDATE/supersede champion to BRA) MUST be 200 — supersede branch is the US3 arm (T029)",
        ).toBe(200);
        const updateBody = (await update.json()) as SubmitResponse;
        const braId = updateBody.final_prediction.id;
        expect(
          braId,
          "supersede branch MUST INSERT a new row with a distinct id",
        ).not.toBe(argId);

        // ---- 3. GET — exactly one champion entry; target = BRA -------
        const all = await request.get("/api/me/final-predictions", {
          headers: { Cookie: cookieHeader },
        });
        expect(
          all.status(),
          "GET /api/me/final-predictions MUST be 200",
        ).toBe(200);
        const allBody = (await all.json()) as MeFinalPredictionsResponse;

        // Response has a `final_predictions` array.
        expect(
          Array.isArray(allBody.final_predictions),
          "GET response MUST carry a `final_predictions` array",
        ).toBe(true);

        const championEntries = allBody.final_predictions.filter(
          (p) => p.item_kind === "champion",
        );
        expect(
          championEntries.length,
          "champion entry MUST appear EXACTLY ONCE (no history dup)",
        ).toBe(1);
        const champion = championEntries[0]!;
        expect(champion.id).toBe(braId);
        expect(
          champion.target_team_id,
          "active champion MUST carry the NEW target_team_id (BRA)",
        ).toBe(BRA_TEAM_ID);
        expect(champion.target_player_id).toBeNull();

        // No champion entry MUST point at the superseded ARG team value.
        const championTargets = allBody.final_predictions
          .filter((p) => p.item_kind === "champion")
          .map((p) => p.target_team_id);
        expect(
          championTargets,
          "no champion entry MUST carry target_team_id=ARG (the superseded value)",
        ).not.toContain(ARG_TEAM_ID);

        // The superseded ARG row id MUST NOT leak into the response.
        const allIds = allBody.final_predictions.map((p) => p.id);
        expect(
          allIds,
          "superseded ARG row id MUST NOT leak into /me/final-predictions (active-only)",
        ).not.toContain(argId);

        // Across all four item_kinds, no kind MUST appear more than
        // once in the active read (FR-010 — exactly one active per
        // (participant, item) pair).
        const kindCounts: Record<string, number> = {};
        for (const p of allBody.final_predictions) {
          kindCounts[p.item_kind] = (kindCounts[p.item_kind] ?? 0) + 1;
        }
        for (const kind of Object.keys(kindCounts)) {
          expect(
            kindCounts[kind],
            `item_kind='${kind}' MUST appear at most once in the active read`,
          ).toBe(1);
        }
      },
    );
  },
);
