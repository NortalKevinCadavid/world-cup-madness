// --------------------------------------------------------------------------
// Slice 004 / T013 — `POST /api/final-predictions` 404 removed-player path.
// --------------------------------------------------------------------------
// RED acceptance test for the player-removed branch of the
// final-predictions submit route — Clarifications 2026-05-17 Q1.
//
// Source of truth:
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § 404 Not Found — INVALID_TARGET with reason='player_removed'.
//   - § Server behavior step 4: "Player kinds: SELECT 1 FROM players
//     WHERE id = body.target_player_id AND removed_at IS NULL. Zero rows
//     → 404 (distinguish player_not_found vs player_removed by a second
//     query if needed)."
//   - specs/004-final-predictions/spec.md § Clarifications 2026-05-17 Q1
//     — a player with `removed_at IS NOT NULL` MUST NOT be a valid pick
//     target. The pick row referencing them is preserved at score time
//     (Slice 005), but NEW picks against a removed player MUST 404.
//
// Scenario:
//   beforeEach: service-role UPDATE players SET removed_at = now()
//   WHERE id = Pedri's UUID (player 09 — dddd1000-...-09).
//   afterEach: service-role UPDATE players SET removed_at = NULL
//   WHERE id = Pedri's UUID — restore the fixture state so sibling
//   tests (e.g. slice-003 ones that may or may not share workers) see a
//   pristine roster.
//
// Sign in as charlie. POST /api/final-predictions with
// `{ item_kind: 'best_player', target_player_id: <Pedri UUID> }`. Expect
// 404 with body { error: { code: 'INVALID_TARGET', reason:
// 'player_removed', message } }.
//
// Why best_player (not top_scorer): Charlie's fixture row for Pedri is
// `best_player`, so it is the obvious item_kind for this test. Either
// player-kind would exercise the same branch.
//
// Why Pedri (not Zieliński): Pedri is referenced by Charlie's seeded
// best_player row (final_predictions dddd2000-..-06). Marking Pedri
// removed exercises the realistic scenario where a participant ALREADY
// holds an active pick on a player who has since been removed. The
// distinction matters for the spec.md edge case "player is removed from
// a roster AFTER a participant picked them but BEFORE lock" — that pick
// row is preserved unmutated; NEW submissions against the same
// (removed) player MUST be rejected.
//
// We do NOT touch Charlie's existing best_player row in this test. The
// fixture's row remains active (per Clarifications Q1 "Keep the row
// active; evaluate at score time"). We DO verify no new row is
// inserted: the count of best_player rows for Charlie after the rejected
// POST equals the pre-test count (1, the fixture row).
//
// RED until T018 ships the route handler with the dual-query
// player_removed distinguisher.
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

// Pedri — player 09 in the slice-004 fixture (ESP, MF). Referenced by
// Charlie's seeded best_player row (dddd2000-...-06).
const PEDRI_PLAYER_ID = "dddd1000-0000-0000-0000-000000000009";

/**
 * Marks Pedri as removed via service-role (bypassing RLS). Idempotent —
 * if Pedri was already marked removed by a previous failed test, this
 * just rewrites removed_at to the current timestamp.
 */
async function markPedriRemoved(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("players")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", PEDRI_PLAYER_ID);
  if (error) {
    throw new Error(`markPedriRemoved failed — ${error.message}`);
  }
}

/**
 * Restores Pedri to active status (removed_at IS NULL). Called in
 * afterEach to undo the beforeEach mutation. Idempotent.
 */
async function restorePedriActive(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("players")
    .update({ removed_at: null })
    .eq("id", PEDRI_PLAYER_ID);
  if (error) {
    throw new Error(`restorePedriActive failed — ${error.message}`);
  }
}

test.describe(
  "US1 — POST /api/final-predictions 404 removed player (Clarifications Q1) @slice-004 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async ({ page }) => {
      await resetStub();
      // First mark Pedri removed, THEN sign in. Both order-independent
      // but stating it explicitly so a future maintainer is not surprised.
      await markPedriRemoved();
      await signInWithIdentity(page, {
        claims: {
          sub: CHARLIE.sub,
          email: CHARLIE.email,
          email_verified: CHARLIE.email_verified,
          name: CHARLIE.name,
        },
      });
    });

    test.afterEach(async () => {
      await resetStub();
      // Restore Pedri's active state UNCONDITIONALLY — even if the test
      // assertion failed mid-flight, sibling tests must see Pedri active.
      await restorePedriActive();
    });

    test(
      "POST best_player with a removed player MUST be 404 INVALID_TARGET player_removed @slice-004 @us1",
      async ({ request }) => {
        const client = getServiceClient();

        // Pre-state count: Charlie has exactly 1 active best_player row
        // (Pedri, the fixture row). We capture this so we can assert
        // NOTHING was inserted after the rejected POST.
        const { count: preCount, error: preErr } = await client
          .from("final_predictions")
          .select("id", { count: "exact", head: true })
          .eq("participant_id", CHARLIE.participantId)
          .eq("item_kind", "best_player");
        if (preErr) {
          throw new Error(`pre-state best_player count failed — ${preErr.message}`);
        }

        const response = await request.post("/api/final-predictions", {
          data: {
            item_kind: "best_player",
            target_player_id: PEDRI_PLAYER_ID,
          },
        });

        expect(
          response.status(),
          "POST referencing a removed player MUST be 404 (Clarifications Q1)",
        ).toBe(404);

        const body = (await response.json()) as unknown;
        expect(body).toMatchObject({
          error: {
            code: "INVALID_TARGET",
            message: expect.any(String),
            reason: "player_removed",
          },
        });

        // The 404 body MUST distinguish player_removed from
        // player_not_found — § Security invariants requires this so
        // participants get actionable feedback.
        const bodyJson = body as { error: { reason: string } };
        expect(
          bodyJson.error.reason,
          "reason MUST be 'player_removed' (not 'player_not_found' or 'team_not_found')",
        ).toBe("player_removed");

        // Post-state: NO new row was inserted. Charlie's best_player
        // count is unchanged. Crucially, the existing fixture row is
        // NOT mutated by the rejected POST — per Clarifications Q1,
        // pre-existing picks on a removed player stay active until the
        // participant explicitly re-picks (and the SP rejects re-pick
        // against the removed player).
        const { count: postCount, error: postErr } = await client
          .from("final_predictions")
          .select("id", { count: "exact", head: true })
          .eq("participant_id", CHARLIE.participantId)
          .eq("item_kind", "best_player");
        if (postErr) {
          throw new Error(`post-state best_player count failed — ${postErr.message}`);
        }
        expect(
          postCount,
          "no new best_player row MUST be inserted on the 404 path",
        ).toBe(preCount);
      },
    );
  },
);
