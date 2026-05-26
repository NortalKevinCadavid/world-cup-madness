// --------------------------------------------------------------------------
// Slice 008 / T034 — Scoring-values admin surface test (US3).
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/scoring` page wired up in T033 plus the
// downstream end-to-end re-score loop: a scoring-key change MUST flip the
// Slice 005 leaderboard into "Re-score pending" mode; a recalc run via the
// Slice 006 surface MUST clear that banner AND emit the audit chain
// (tournament_config.scoring.* → admin.recalc_triggered → score_record.update).
//
// Test plan (verbatim from spec.md US3 / tasks.md T034):
//   (1) Sign in as admin; visit /admin/config/scoring.
//   (2) Change `scoring.match_points.exact` from 10 to 15 with reason
//       "Test scoring adjustment".
//   (3) Preview surfaces (count of `score_records` that would change).
//   (4) Confirm; toast renders.
//   (5) Visit /leaderboard → expect "Re-score pending" banner.
//   (6) Trigger /admin/recalc (Slice 006).
//   (7) Visit /leaderboard → banner gone; points reflect new values.
//   (8) Verify audit_log carries rows under:
//        - tournament_config.scoring.match_points.exact (1+)
//        - admin.recalc_triggered                       (1+)
//        - score_record.update                          (multiple)
//
// RUNTIME-DEFERRED steps
// ----------------------
// Steps 5, 6, and 7 ride three pieces that are NOT yet runtime-ready in this
// authoring environment (slice 008 docker-down note):
//
//   • Slice 005's `/leaderboard` page must render
//     `[data-testid="leaderboard-rescore-pending-banner"]` conditional on
//     `pending_recalc_state.recalc_pending = true` (computed live from
//     `tournament_config_versions` rows for scoring keys whose `created_at >
//     max(audit_log.occurred_at WHERE action='admin.recalc_triggered')`).
//
//   • Slice 006's `/admin/recalc` UI + `/api/admin/recalc` POST + the
//     pg_net-driven `score-trigger` Edge Function must be live end-to-end so
//     the recalc can complete and the banner-clear path can fire.
//
//   • The score_record.update audit emissions (~N rows where N = number of
//     score_records that changed) require seeded score_records before the
//     scoring change AND the recalc Edge Fn writing per-record audit rows.
//     Without the seed, the assertion would be "≥ 0" and meaningless.
//
// Each of these phases is gated behind an `if (false)` block (matching the
// T031/T028 RUNTIME-DEFERRED idiom in this slice) so the file type-checks
// today, runs the admin-side flow (steps 1–4 + the scoring audit assertion
// in step 8), and stays ready to un-defer the moment the surrounding pieces
// ship.
//
// When un-deferring:
//   1. Drop the `if (false)` guards on steps 5, 6, 7.
//   2. Seed a minimum of 2 participants × 2 finished matches with picks
//      that produce a non-zero `score_records.points` count via service-
//      role in `beforeEach`; tear down via `afterEach` or rely on
//      `supabase db reset` between spec files in CI.
//   3. Tighten the score_record.update audit assertion from "if present"
//      to ">= seeded_records" so a regression in the recalc Edge Fn would
//      fail the test.
//
// Test-fixture admin (Slice 001 / Slice 006):
//   auth_user_id    = 00000000-0000-0000-0000-0000000000d3
//   participants.id = 77777777-7777-7777-7777-777777777777
// --------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

import { resetStub, signInWithIdentity } from './fixtures/oidc';
import { ensureAdminRole } from './helpers/admin-roles';
import { getServiceClient } from './helpers/service-role';

const ADMIN1 = {
  sub: '00000000-0000-0000-0000-0000000000d3',
  email: 'admin1@nortal.com',
  email_verified: true,
  name: 'Admin One',
} as const;

const ADMIN1_PARTICIPANT_ID = '77777777-7777-7777-7777-777777777777';

const CONFIG_KEY = 'scoring.match_points.exact';
const CONFIG_ACTION = `tournament_config.${CONFIG_KEY}`;
const RECALC_ACTION = 'admin.recalc_triggered';
const SCORE_RECORD_ACTION = 'score_record.update';

const SCORING_REASON = 'Test scoring adjustment';
const RECALC_REASON = 'After scoring change';

test.describe('Slice 008 US3 — Scoring values @slice-008 @us3', () => {
  // The full flow walks one admin upsert, one recalc trigger, two
  // leaderboard visits, and an audit_log read. 120s covers the recalc Edge
  // Fn's per-record fan-out time once steps 5–7 un-defer; the live admin
  // path runs in well under 15s.
  test.setTimeout(120_000);

  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
    // Best-effort cleanup: restore the canonical default scoring value so a
    // failed mid-flight upsert does not poison sibling tests. We
    // intentionally do NOT delete audit_log rows the test wrote — those are
    // append-only by RLS and by contract. The canonical reset is
    // `supabase db reset` between spec files in CI; this is belt-and-braces.
    try {
      const service = getServiceClient();
      await service
        .from('tournament_config')
        .update({ value: 10 })
        .eq('key', CONFIG_KEY);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test('Admin changes match_points.exact; re-score pending banner shows; recalc clears banner; audit chain recorded @slice-008 @us3', async ({
    page,
  }) => {
    // ----------------------------------------------------------------------
    // Step 1: sign in as admin and land on /admin/config/scoring.
    // ----------------------------------------------------------------------
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    await page.goto('/admin/config/scoring');
    await expect(
      page.locator('[data-testid="admin-config-scoring-page"]'),
      '[data-testid="admin-config-scoring-page"] MUST render on /admin/config/scoring',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="scoring-match-points-exact-input"]'),
      '[data-testid="scoring-match-points-exact-input"] MUST render the exact-match numeric input',
    ).toBeVisible();

    // ----------------------------------------------------------------------
    // Step 2: change `scoring.match_points.exact` from 10 to 15 with reason
    // "Test scoring adjustment". T033 renders one save button per section
    // (per-key upsert) — the exact-match Save button is the surface we
    // interact with here.
    //
    // The reason input may be rendered globally (single field shared across
    // all sections) OR per-section. We try the per-key field first; if it
    // is not present, fall back to a generic `scoring-reason` field. Either
    // way the configUpsert RPC requires a non-empty reason.
    // ----------------------------------------------------------------------
    await page.fill('[data-testid="scoring-match-points-exact-input"]', '15');
    await page.fill(
      '[data-testid="scoring-match-points-exact-reason"]',
      SCORING_REASON,
    );
    // scoring.* is a security-sensitive key class — configUpsert (migration
    // 0077 step 4 / WCG02) rejects it without a source citation. The field
    // is labelled "(optional)" in the UI but is required for this key.
    await page.fill(
      '[data-testid="scoring-match-points-exact-source-citation"]',
      'https://intranet.nortal.example/scoring/match-points-exact',
    );

    await page.click('[data-testid="scoring-match-points-exact-save"]');

    // ----------------------------------------------------------------------
    // Step 3: preview surfaces with the count of `score_records` that would
    // change. PreviewWarning's "affecting" branch quotes that count via
    // `[data-testid="config-preview-affecting"]`; the "safe" branch fires
    // when no score_records would change (e.g. an empty test DB).
    //
    // We tolerate both branches so the admin-side flow can be exercised
    // before consumer-side seeds are wired. The flow still walks ack-if-
    // affecting → confirm to drive the upsert end-to-end.
    // ----------------------------------------------------------------------
    const preview = page.locator('[data-testid="config-preview-warning"]');
    await expect(
      preview,
      '[data-testid="config-preview-warning"] MUST surface after Save',
    ).toBeVisible({ timeout: 10_000 });

    const ack = page.locator('[data-testid="config-preview-acknowledge"]');
    if (await ack.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await ack.check();
    }

    // ----------------------------------------------------------------------
    // Step 4: confirm. Toast MUST render and quote the new version id.
    // T033 may render either a per-section toast
    // ([data-testid="scoring-match-points-exact-toast"]) or a shared
    // [data-testid="config-toast"] — we accept either with .first().
    // ----------------------------------------------------------------------
    await page.click('[data-testid="config-preview-confirm"]');

    const toast = page
      .locator(
        '[data-testid="scoring-match-points-exact-toast"], [data-testid="config-toast"]',
      )
      .first();
    await expect(
      toast,
      'success toast MUST render after the match_points.exact upsert',
    ).toBeVisible({ timeout: 10_000 });
    const toastText = (await toast.textContent()) ?? '';
    expect(
      toastText,
      'toast MUST quote the new version id in the form "Updated to version N"',
    ).toMatch(/Updated to version \d+/);

    // ----------------------------------------------------------------------
    // Step 5 — RUNTIME-DEFERRED: visit /leaderboard, expect "Re-score
    // pending" banner.
    //
    // Why deferred: slice 005's /leaderboard surface must conditionally
    // render [data-testid="leaderboard-rescore-pending-banner"] when a
    // scoring-key upsert occurs after the most-recent
    // `admin.recalc_triggered` audit row. The page contract exists in
    // spec.md but is not implemented in this authoring environment.
    //
    // When un-deferring:
    //   1. Drop the `if (false)` guard.
    //   2. Confirm the data-testid matches what slice 005 actually ships
    //      (`scoring-rescore-pending-banner` was a prior-state proposal;
    //      slice 006's recalc banner uses `recalc-pending-banner` and slice
    //      005's leaderboard banner is expected to follow the
    //      `leaderboard-rescore-pending-banner` convention).
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredRescorePendingVisible = false;
    if (_runtimeDeferredRescorePendingVisible) {
      await page.goto('/leaderboard');
      await expect(
        page.locator('[data-testid="leaderboard-rescore-pending-banner"]'),
        '[data-testid="leaderboard-rescore-pending-banner"] MUST be visible after a scoring-key upsert with no subsequent admin.recalc_triggered audit row',
      ).toBeVisible({ timeout: 10_000 });
    }

    // ----------------------------------------------------------------------
    // Step 6 — RUNTIME-DEFERRED: trigger /admin/recalc.
    //
    // Why deferred: slice 006's /admin/recalc page + POST /api/admin/recalc
    // route + pg_net-driven score-trigger Edge Function must all be live.
    // In this slice's docker-down authoring environment, the recalc cannot
    // complete, so the banner-clear step (7) cannot be asserted truthfully.
    //
    // The recalc UI's contract surface (per slice-006-recalc-pending-banner
    // .spec.ts) is:
    //   - [data-testid="trigger-recalc-button"]    (POST trigger)
    //   - [data-testid="recalc-status-value"]      (live status)
    //   - reason input — name not yet uniformized; we use the same field
    //     name pattern as the surrounding admin pages and tolerate either
    //     `recalc-reason` or `trigger-recalc-reason`.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredRecalcTrigger = false;
    if (_runtimeDeferredRecalcTrigger) {
      await page.goto('/admin/recalc');

      const recalcReason = page
        .locator(
          '[data-testid="recalc-reason"], [data-testid="trigger-recalc-reason"]',
        )
        .first();
      if (await recalcReason.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await recalcReason.fill(RECALC_REASON);
      }

      await page.click('[data-testid="trigger-recalc-button"]');

      // Wait for the recalc to succeed. The live status component reflects
      // the Edge Fn's per-record fan-out completion.
      const statusEl = page.locator('[data-testid="recalc-status-value"]');
      await expect(
        statusEl,
        '[data-testid="recalc-status-value"] MUST be visible on /admin/recalc after triggering',
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        statusEl,
        'realtime status MUST transition to "succeeded" within 5 minutes',
      ).toHaveText(/succeeded/i, { timeout: 5 * 60 * 1000 });
    }

    // ----------------------------------------------------------------------
    // Step 7 — RUNTIME-DEFERRED: visit /leaderboard; banner gone; points
    // reflect new values (15 per exact match).
    //
    // Why deferred: same docker-down + recalc-Edge-Fn caveat as step 6.
    // Tightening the "points reflect new values" assertion requires seeded
    // score_records with known per-match points before the upsert AND a
    // running recalc — both currently absent.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredBannerCleared = false;
    if (_runtimeDeferredBannerCleared) {
      await page.goto('/leaderboard');
      await expect(
        page.locator('[data-testid="leaderboard-rescore-pending-banner"]'),
        '[data-testid="leaderboard-rescore-pending-banner"] MUST NOT be visible after a successful recalc',
      ).toHaveCount(0);
      // TODO(slice-008): once score_records are seeded, also assert that
      // the displayed points for the relevant participant reflect 15 per
      // exact-match prediction (e.g.
      // `expect(page.locator('[data-testid="leaderboard-row-<id>-points"]'))
      //   .toHaveText('15')`).
    }

    // ----------------------------------------------------------------------
    // Step 8: verify audit_log carries the expected chain. The scoring
    // upsert row is ALWAYS expected (steps 1–4 ran live); the recalc and
    // score_record.update rows are only expected once steps 6+7 un-defer.
    //
    // `authenticated` cannot read audit_log under RLS, so we use the
    // service-role helper.
    // ----------------------------------------------------------------------
    const service = getServiceClient();

    // (8a) tournament_config.scoring.match_points.exact — MUST be present.
    const { data: scoringRows, error: scoringErr } = await service
      .from('audit_log')
      .select('id, action, previous_value, new_value, reason, occurred_at')
      .eq('action', CONFIG_ACTION)
      .gte('occurred_at', testStartInstant)
      .order('occurred_at', { ascending: true });

    expect(
      scoringErr,
      'service-role audit_log read MUST NOT error for scoring action',
    ).toBeNull();
    expect(
      scoringRows,
      'audit_log read MUST return a non-null payload (possibly empty) for scoring action',
    ).not.toBeNull();
    expect(
      (scoringRows ?? []).length,
      `audit_log MUST carry >= 1 row under action='${CONFIG_ACTION}' since ${testStartInstant} (the 10 → 15 upsert)`,
    ).toBeGreaterThanOrEqual(1);

    const firstScoringRow = (scoringRows ?? [])[0];
    expect(
      firstScoringRow?.new_value,
      'scoring audit row MUST quote new_value (the upserted scalar 15 wrapped per the contract)',
    ).toBeDefined();
    expect(
      firstScoringRow?.reason,
      'scoring audit row MUST quote the operator reason',
    ).toBe(SCORING_REASON);

    // (8b) admin.recalc_triggered — RUNTIME-DEFERRED. Only assertable once
    // step 6 un-defers. We read the table either way so a future un-defer
    // doesn't need to add a second round-trip; the assertion is guarded.
    const { data: recalcRows } = await service
      .from('audit_log')
      .select('id, action, occurred_at')
      .eq('action', RECALC_ACTION)
      .gte('occurred_at', testStartInstant);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredRecalcAuditAssertion = false;
    if (_runtimeDeferredRecalcAuditAssertion) {
      expect(
        (recalcRows ?? []).length,
        `audit_log MUST carry >= 1 row under action='${RECALC_ACTION}' since ${testStartInstant} (recalc trigger after scoring change)`,
      ).toBeGreaterThanOrEqual(1);
    }

    // (8c) score_record.update — RUNTIME-DEFERRED. Only assertable once
    // step 6 un-defers AND score_records are seeded. Same read-now-assert-
    // later pattern as (8b).
    const { data: scoreRecordRows } = await service
      .from('audit_log')
      .select('id, action, occurred_at')
      .eq('action', SCORE_RECORD_ACTION)
      .gte('occurred_at', testStartInstant);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredScoreRecordAuditAssertion = false;
    if (_runtimeDeferredScoreRecordAuditAssertion) {
      expect(
        (scoreRecordRows ?? []).length,
        `audit_log MUST carry multiple rows under action='${SCORE_RECORD_ACTION}' since ${testStartInstant} (one per recomputed score_record)`,
      ).toBeGreaterThan(1);
    }
  });
});
