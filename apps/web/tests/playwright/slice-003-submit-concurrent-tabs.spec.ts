// --------------------------------------------------------------------------
// Slice 003 / T019 — `POST /api/predictions` concurrency: two tabs, one win.
// --------------------------------------------------------------------------
// RED acceptance test for SC-003 / contracts/predictions.write.md
// § Concurrency guarantee. Exercises the advisory-lock serialization in
// `submit_prediction` over the HTTP route handler.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.write.md
//       § Stored procedure semantics step 1 (pg_advisory_xact_lock) and
//       § Concurrency guarantee — "Each transaction commits before the
//       next acquires the lock. Final state: exactly one row with
//       superseded_at IS NULL; chain of superseded rows in order."
//   - specs/003-match-predictions/spec.md § US2 AS-2 — exactly ONE active
//       prediction per (participant, match) AT ANY POINT IN TIME (FR-006).
//
// Scenario covered:
//   Sign in as alpha in two SEPARATE browser contexts (== two tabs in two
//   isolated sessions). Fire two POST /api/predictions calls in parallel
//   via `Promise.all` — context A submits 1-0, context B submits 2-1 —
//   both targeting M6 USA-JPN for alpha. The SP's
//   pg_advisory_xact_lock(hashtext(participant || ':' || match)) MUST
//   serialize them, so:
//     - BOTH responses are 200 (the supersede branch handles the second
//       writer; neither client sees a 409 race).
//     - exactly ONE active row exists for (alpha, M6) after both calls.
//     - exactly TWO total rows exist (the loser was superseded, not lost).
//     - exactly ONE row has superseded_at IS NOT NULL.
//
// We deliberately do NOT assert which payload (1-0 vs 2-1) won — the
// advisory lock is fair-ish but lock acquisition order is not contract.
// FR-006 only guarantees "exactly one active row"; either ordering is
// acceptable.
//
// Why M6: alpha's fixture-active matches are M3, M4, M5. M6 USA-JPN has
// no seeded prediction for alpha, so we never collide with the existing
// (alpha, M4) 1-1 fixture row.
//
// Cleanup contract: identical to the supersede spec — service-role DELETE
// of any (alpha, M6) rows in both before- and afterEach so the unique
// partial index `predictions_active_uk` never blocks the next run.
//
// RED until T021 replaces the WCM06 DUPLICATE_ACTIVE branch with the
// supersede semantics. Until then the second writer in this test races
// to a 409.
// --------------------------------------------------------------------------

import { test, expect, type BrowserContext } from "@playwright/test";

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

/**
 * Spins up an isolated browser context and drives the OIDC sign-in flow as
 * alpha. The returned context owns its own cookie jar — exercising the
 * concurrent-tabs scenario where the SAME participant has two live
 * sessions racing each other.
 *
 * The caller MUST close the returned context in a finally-block.
 */
async function newAlphaContext(
  browser: import("@playwright/test").Browser,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWithIdentity(page, {
    claims: {
      sub: ALPHA.sub,
      email: ALPHA.email,
      email_verified: ALPHA.email_verified,
      name: ALPHA.name,
    },
  });
  await page.close();
  return context;
}

test.describe(
  "US2 — concurrent POST /api/predictions from two tabs serializes via advisory lock @slice-003 @us2",
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
      "two alpha tabs POST to M6 in parallel; both return 200; exactly 1 active row, 1 superseded, 2 total @slice-003 @us2",
      async ({ browser }) => {
        // Sign in twice — once per context. The signInWithIdentity flow
        // re-registers the OIDC stub's NEXT-token claims each call, so
        // the second sign-in still gets alpha's claims. After both
        // contexts are signed in we never round-trip through the stub
        // again — the POSTs use the contexts' existing Supabase session
        // cookies directly.
        const contextA = await newAlphaContext(browser);
        let contextB: BrowserContext | null = null;
        try {
          contextB = await newAlphaContext(browser);

          // Fire both POSTs from `Promise.all` so they hit the route
          // handler within the same event-loop tick and contend for the
          // SP's advisory lock.
          const [respA, respB] = await Promise.all([
            contextA.request.post("/api/predictions", {
              data: { match_id: M6_USA_JPN_ID, home: 1, away: 0 },
            }),
            contextB.request.post("/api/predictions", {
              data: { match_id: M6_USA_JPN_ID, home: 2, away: 1 },
            }),
          ]);

          expect(
            respA.status(),
            "context A POST MUST be 200 — advisory lock serializes, never 409",
          ).toBe(200);
          expect(
            respB.status(),
            "context B POST MUST be 200 — advisory lock serializes, never 409",
          ).toBe(200);

          // ---- Service-role invariants ---------------------------------
          const client = getServiceClient();

          // Exactly ONE active row for (alpha, M6) — FR-006 / US2 AS-2.
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
            "exactly ONE active prediction MUST exist for (alpha, M6) — FR-006",
          ).toBe(1);

          // Exactly TWO total rows — the loser was superseded, not lost.
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
            "both writes MUST persist — 1 active + 1 superseded = 2 total rows",
          ).toBe(2);

          // Exactly ONE row has superseded_at IS NOT NULL.
          const { count: supersededCount, error: supersededErr } = await client
            .from("predictions")
            .select("id", { count: "exact", head: true })
            .eq("participant_id", ALPHA.participantId)
            .eq("match_id", M6_USA_JPN_ID)
            .not("superseded_at", "is", null);
          if (supersededErr) {
            throw new Error(
              `service-role superseded count failed — ${supersededErr.message}`,
            );
          }
          expect(
            supersededCount,
            "exactly ONE row MUST be superseded — the losing writer's row",
          ).toBe(1);
        } finally {
          await contextA.close();
          if (contextB) await contextB.close();
        }
      },
    );
  },
);
