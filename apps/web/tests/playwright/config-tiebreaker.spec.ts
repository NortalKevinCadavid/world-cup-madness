// --------------------------------------------------------------------------
// Slice 008 / T035 — Tie-breaker order admin surface test.
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/scoring` page wired up in T033 — specifically
// the tie-breaker reorderer portion. Per tasks.md T035 (US3), this spec
// walks an admin through reordering the `scoring.tie_breaker_order`
// array, saving it, and verifying:
//
//   1. The DOM reflects the new order before save.
//   2. `audit_log` carries a new row under
//      `tournament_config.scoring.tie_breaker_order` since test start,
//      with `new_value` equal to the reordered array.
//
// Test flow (per task body, with RUNTIME-DEFERRED note for step 4):
//   1. Visit /admin/config/scoring.
//   2. Move `final_pick_correct` above `exact_match_count` in tie-breaker
//      order (single ↑ click on the `final_pick_correct` row). Save.
//   3. Wait 60s (pragmatic ceiling — we use 2s here for the LISTEN/NOTIFY
//      round trip, mirroring T031's config-locking.spec.ts approach).
//   4. Visit /leaderboard. Assert participant ordering reflects the new
//      priority. — RUNTIME-DEFERRED per D-031: the leaderboard view in
//      Slice 005 still reads legacy `tiebreaker.order`, not the new
//      `scoring.tie_breaker_order`. The dynamic ORDER BY migration is
//      DEFERRED in D-031, so this assertion is gated behind `if (false)`
//      and will be un-deferred once D-031 closes.
//   5. Confirm audit row `tournament_config.scoring.tie_breaker_order`
//      written.
//
// Reordering UX contract (from T033 prior state):
//   - `[data-testid="tie-breaker-list"]` — the wrapping list.
//   - `[data-testid="tie-breaker-item"][data-rank]` — each row, ordered
//     top-to-bottom by `data-rank` (1-indexed).
//   - `[data-testid="tie-breaker-move-up"][data-key]` — ↑ button per row;
//     its `data-key` attribute names the tie-breaker key that row
//     represents (e.g. "final_pick_correct").
//   - `[data-testid="tie-breaker-move-down"][data-key]` — ↓ button per row.
//   - `[data-testid="tie-breaker-save"]` — commits the new array via
//     `configUpsert`.
//
// Default order (seeded in `tournament_config`):
//   ["points_total", "exact_match_count", "final_pick_correct", "earliest_submission"]
//
// After one ↑ click on `final_pick_correct`:
//   ["points_total", "final_pick_correct", "exact_match_count", "earliest_submission"]
//
// Test-fixture admin (Slice 001 / Slice 006):
//   auth_user_id    = 00000000-0000-0000-0000-0000000000d3
//   participants.id = 77777777-7777-7777-7777-777777777777
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import { resetStub, signInWithIdentity } from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";
import { getServiceClient } from "./helpers/service-role";

const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

const CONFIG_KEY = "scoring.tie_breaker_order";
const CONFIG_ACTION = `tournament_config.${CONFIG_KEY}`;

const DEFAULT_ORDER = [
  "points_total",
  "exact_match_count",
  "final_pick_correct",
  "earliest_submission",
] as const;

const REORDERED = [
  "points_total",
  "final_pick_correct",
  "exact_match_count",
  "earliest_submission",
] as const;

test.describe("Slice 008 US3 — Tie-breaker order @slice-008 @us3", () => {
  // 90s headroom mirrors T031 (config-locking.spec.ts): per-step 10s expect
  // timeout + the pragmatic 2s LISTEN/NOTIFY wait + a leaderboard navigation
  // round-trip all fit comfortably.
  test.setTimeout(90_000);

  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
    // Best-effort cleanup: restore the canonical default tie-breaker order
    // so a failed mid-flight upsert does not poison sibling tests. We do
    // NOT delete `audit_log` rows the test wrote — those are append-only by
    // RLS and by contract. The canonical reset is `supabase db reset`
    // between spec files in CI; this is belt-and-braces.
    try {
      const service = getServiceClient();
      await service
        .from("tournament_config")
        .update({ value: DEFAULT_ORDER })
        .eq("key", CONFIG_KEY);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test("Admin reorders tie-breaker; audit row written; leaderboard ordering deferred to D-031 close @slice-008 @us3", async ({
    page,
  }) => {
    // ----------------------------------------------------------------------
    // Step 0: sign in as admin.
    // ----------------------------------------------------------------------
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    // ----------------------------------------------------------------------
    // Step 1: Visit /admin/config/scoring.
    // ----------------------------------------------------------------------
    await page.goto("/admin/config/scoring");
    await expect(
      page.locator('[data-testid="admin-config-scoring-page"]'),
      "[data-testid=admin-config-scoring-page] MUST render on /admin/config/scoring",
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="tie-breaker-list"]'),
      "[data-testid=tie-breaker-list] MUST render the tie-breaker reorderer",
    ).toBeVisible();

    // Sanity: starting order matches the seeded default. We read each row's
    // ↑ button `data-key` in the order the rows appear (move buttons are
    // the contractually-stable carrier for the per-row key per T033's prior
    // state). If T033 chose to also stamp `data-key` on the row itself
    // alongside `data-rank`, that's fine — we're not asserting against the
    // row attribute.
    const startingKeys = await page
      .locator('[data-testid="tie-breaker-move-up"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-key") ?? ""),
      );
    expect(
      startingKeys,
      "starting tie-breaker order MUST match the seeded default",
    ).toEqual([...DEFAULT_ORDER]);

    // ----------------------------------------------------------------------
    // Step 2: Move `final_pick_correct` above `exact_match_count`.
    //
    // Default order:
    //   1. points_total
    //   2. exact_match_count
    //   3. final_pick_correct    ← click ↑ once
    //   4. earliest_submission
    //
    // A single ↑ click on row 3 swaps rows 2 and 3, yielding REORDERED.
    // ----------------------------------------------------------------------
    await page.click(
      '[data-testid="tie-breaker-move-up"][data-key="final_pick_correct"]',
    );

    const reorderedKeys = await page
      .locator('[data-testid="tie-breaker-move-up"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("data-key") ?? ""),
      );
    expect(
      reorderedKeys,
      "after one ↑ click on final_pick_correct, the DOM order MUST equal REORDERED",
    ).toEqual([...REORDERED]);

    // Save.
    await page.click('[data-testid="tie-breaker-save"]');

    // Tie-breaker order is an "affecting" config (changes leaderboard
    // sorting). T033's PreviewWarning may or may not surface for this key
    // depending on whether the page treats tie_breaker_order as
    // affecting=true unconditionally. We tolerate both branches here so the
    // test is resilient to either UX choice:
    //
    //   - Affecting branch: `[data-testid="config-preview-warning"]` shows
    //     with an acknowledge checkbox + confirm button.
    //   - No-preview branch: the save commits directly and the success
    //     toast renders immediately.
    const previewWarning = page.locator(
      '[data-testid="config-preview-warning"]',
    );
    const previewVisible = await previewWarning
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    if (previewVisible) {
      const ack = page.locator('[data-testid="config-preview-acknowledge"]');
      if (await ack.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await ack.check();
      }
      await page.click('[data-testid="config-preview-confirm"]');
    }

    // Success toast — quoted version id pattern matches T031's convention.
    await expect(
      page.locator('[data-testid="config-toast"]').first(),
      "success toast MUST render after the tie-breaker reorder upsert",
    ).toBeVisible({ timeout: 10_000 });

    // ----------------------------------------------------------------------
    // Step 3: Wait for LISTEN/NOTIFY round trip. 2s pragmatic ceiling.
    // ----------------------------------------------------------------------
    await page.waitForTimeout(2_000);

    // ----------------------------------------------------------------------
    // Step 4: Visit /leaderboard and assert participant ordering reflects
    // the new tie-breaker priority. — RUNTIME-DEFERRED per D-031.
    //
    // Per `docs/architecture/open-decisions.md` D-031, the leaderboard view
    // wired in Slice 005 still reads from the legacy `tiebreaker.order`
    // config key, not the new `scoring.tie_breaker_order`. The dynamic
    // ORDER BY migration that pivots the view onto the new key is DEFERRED
    // in D-031. Until D-031 closes, this assertion path would fail not
    // because the reorder didn't happen but because the consumer hasn't
    // been re-wired. We gate the assertion behind `if (false)` so the
    // admin-side flow + audit verify run today, and the consumer-side
    // verify is ready to un-defer the moment D-031 closes.
    //
    // When un-deferring:
    //   1. Confirm D-031 is closed and the leaderboard view's ORDER BY
    //      reads `scoring.tie_breaker_order` dynamically.
    //   2. Drop the `if (false)` guard below.
    //   3. Seed two participants tied on points_total + exact_match_count
    //      but differing on final_pick_correct (one correct, one not) via
    //      service-role in beforeEach; tear down in afterEach.
    //   4. Assert the participant with final_pick_correct=true appears
    //      above the other on /leaderboard under REORDERED.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredLeaderboardOrder = false;
    if (_runtimeDeferredLeaderboardOrder) {
      await page.goto("/leaderboard");
      // TODO(D-031): assert participant ordering follows REORDERED.
    }

    // ----------------------------------------------------------------------
    // Step 5: Verify `audit_log` carries ≥ 1 new row under
    // `action='tournament_config.scoring.tie_breaker_order'` since the test
    // started, with `new_value` equal to REORDERED. `authenticated` cannot
    // read audit_log under RLS, so we use the service-role helper.
    // ----------------------------------------------------------------------
    const service = getServiceClient();
    const { data: auditRows, error: auditErr } = await service
      .from("audit_log")
      .select("id, action, previous_value, new_value, reason, occurred_at")
      .eq("action", CONFIG_ACTION)
      .gte("occurred_at", testStartInstant)
      .order("occurred_at", { ascending: true });

    expect(
      auditErr,
      "service-role audit_log read MUST NOT error",
    ).toBeNull();
    expect(
      auditRows,
      "audit_log read MUST return a non-null payload (possibly empty)",
    ).not.toBeNull();
    expect(
      (auditRows ?? []).length,
      "≥ 1 audit_log row MUST exist for the tie-breaker reorder since test start",
    ).toBeGreaterThanOrEqual(1);

    // Verify the new_value on the most-recent row equals REORDERED. We use
    // the LAST row in the ascending-ordered list to handle the (rare) case
    // where a stray row from a sibling worker slipped in earlier in the
    // window. The MOST RECENT row MUST be the one this test just wrote.
    const lastRow = (auditRows ?? [])[auditRows!.length - 1];
    const newValue = lastRow.new_value as unknown;
    expect(
      Array.isArray(newValue),
      "audit_log.new_value MUST be a JSON array",
    ).toBe(true);
    expect(
      newValue as string[],
      "audit_log.new_value MUST equal REORDERED",
    ).toEqual([...REORDERED]);
  });
});
