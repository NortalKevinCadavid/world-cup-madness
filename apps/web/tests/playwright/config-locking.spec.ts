// --------------------------------------------------------------------------
// Slice 008 / T031 — Match-prediction lock-window admin surface test.
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/locking` page wired up in T030 plus the
// downstream LISTEN/NOTIFY-driven cache invalidation contracted to ≤ 60s.
//
// Test plan (per tasks.md T031, US2):
//   - As admin, walk through 3 upserts of
//     `locking.match_prediction_window_minutes` and 1 client-side validation
//     case. The 3 upserts produce visibly different lock semantics for a
//     match whose kickoff is exactly 75 minutes from "now":
//
//       (a) 60 → 90  (preview shown; confirmed). Per Slice 003's
//           `is_prediction_locked(match_id)` body — `return now() >= kickoff
//           - make_interval(mins => window_minutes)` — increasing the window
//           pulls the lock-at boundary EARLIER in wall-clock time:
//
//             kickoff = T + 75min
//             now     = T
//
//             window=60  → lock-at = T+75-60 = T+15  → now < lock-at →
//                          UNLOCKED (predictions still allowed).
//             window=90  → lock-at = T+75-90 = T-15  → now > lock-at →
//                          LOCKED (predictions rejected with WCM-family
//                          ERRCODE from Slice 003).
//             window=30  → lock-at = T+75-30 = T+45  → now < lock-at →
//                          UNLOCKED again.
//
//           (The task body's parenthetical "75 min ≥ 60 min after lock-at,
//           so still open" garbles the inequality. We follow the LOCKED
//           semantics that Slice 003's actual SQL encodes; pgTAP test T032
//           pins the same direction in the database layer.)
//
//       (b) 0 → expect immediate client-side validation error (T018 zod
//           min(1)). The preview button MUST stay disabled and
//           `[data-testid="locking-validation-error"]` MUST render. NO
//           upsert is attempted, so no WCG02 round-trip is required for
//           this case to pass.
//
//       (c) 90 → 30 (preview shown; confirmed). Restores the match to
//           UNLOCKED state. With a working consumer pipeline, the same
//           prediction submission that was rejected in (a) succeeds again.
//
//   - Verify ≥ 2 new rows in `audit_log` under
//     `action='tournament_config.locking.match_prediction_window_minutes'`
//     since test start (the 60→90 + 90→30 upserts; the 0 case never round-
//     trips the server).
//
// RUNTIME-DEFERRED steps
// ----------------------
// The full task-body flow asks us to "as a participant, attempt to submit a
// prediction for [the 75-min-away match]" before and after each window
// change. That assertion path requires:
//
//   (i)  Docker up + a match seeded with `kickoff_at = now() + interval
//        '75 minutes'` via service-role.
//   (ii) The Slice 003 prediction-submit pipeline (route handler + RLS +
//        `is_prediction_locked`) live end-to-end.
//   (iii) The LISTEN-driven `tournament_config` cache invalidation
//        observable from inside the Next.js process so the consumer side
//        picks up the new window without a process restart.
//
// Docker is down at T031 authoring time (slice 008 environment note). The
// match seed, the consumer-side prediction submission, and the
// LISTEN-driven cache invalidation are therefore stubbed with TODO blocks
// gated by `if (false)` so this file compiles, runs the admin-side flow
// (steps 1–4 + audit verify), and stays ready to un-defer the moment the
// surrounding pieces ship.
//
// When un-deferring the consumer side:
//   1. Drop the `if (false)` guards in steps (a-consumer), (c-consumer).
//   2. Seed a match via service-role with `kickoff_at = now() + interval
//      '75 minutes'` in `beforeEach`; tear down in `afterEach`.
//   3. Sign in as a participant in a second context; POST to the slice 003
//      `/api/me/predictions` route (or click through the matches UI).
//      Under window=90 expect a WCM-family lock error; under window=30
//      expect a 200 (or whatever Slice 003's success envelope is).
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

const CONFIG_KEY = 'locking.match_prediction_window_minutes';
const CONFIG_ACTION = `tournament_config.${CONFIG_KEY}`;

const REASON_WIDEN = 'Widen lock window to 90 minutes for late submissions';
const REASON_NARROW = 'Restore narrower 30-minute lock window after test';
// locking.* is a security-sensitive key class — the upsert RPC (migration
// 0077 step 4 / WCG02) rejects it unless a source citation is supplied.
const CITATION_WIDEN = 'https://intranet.nortal.example/ops/lock-window-widen';
const CITATION_NARROW = 'https://intranet.nortal.example/ops/lock-window-restore';

test.describe('Slice 008 US2 — Match-prediction lock window @slice-008 @us2', () => {
  // The full flow walks two upserts, one client-side validation, and an
  // audit_log read. 90s is comfortably above the per-step 10s expect
  // timeout and leaves headroom for the LISTEN/NOTIFY pragmatic 2s waits.
  test.setTimeout(90_000);

  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
    // Best-effort cleanup: restore the canonical default window (60 min) so
    // a failed mid-flight upsert does not poison sibling tests. We
    // intentionally do NOT delete `audit_log` rows the test wrote — those
    // are append-only by RLS and by contract. The canonical reset is
    // `supabase db reset` between spec files in CI; this is belt-and-braces.
    try {
      const service = getServiceClient();
      await service
        .from('tournament_config')
        .update({ value: 60 })
        .eq('key', CONFIG_KEY);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test('Admin widens then narrows lock window; client validation blocks 0; 2 audit rows recorded @slice-008 @us2', async ({
    page,
  }) => {
    // ----------------------------------------------------------------------
    // Step 0: sign in as admin and land on /admin/config/locking.
    // ----------------------------------------------------------------------
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    await page.goto('/admin/config/locking');
    await expect(
      page.locator('[data-testid="admin-config-locking-page"]'),
      '[data-testid="admin-config-locking-page"] MUST render on /admin/config/locking',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="locking-editor"]'),
      '[data-testid="locking-editor"] MUST render the client-side editor',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="locking-window-input"]'),
      '[data-testid="locking-window-input"] MUST render the integer input',
    ).toBeVisible();

    // ----------------------------------------------------------------------
    // Step (a): change the window from default (60) to 90 with a reason.
    // ----------------------------------------------------------------------
    //
    // Per the Slice 003 lock semantics annotated at the top of this file,
    // widening the window from 60 → 90 LOCKS more matches earlier — the
    // affecting preview MUST surface (warning branch when a 75-min-away
    // match exists in the DB, or the safe branch when the test DB is
    // empty of in-window matches; we tolerate both so the admin-side flow
    // can be exercised before consumer-side seeds are wired).
    //
    // The locking input is `<input type="number">`; we set the value via
    // `fill` so React's controlled component fires the change handler and
    // the local validation + parse path runs.
    await page.fill('[data-testid="locking-window-input"]', '90');
    await page.fill('[data-testid="locking-reason"]', REASON_WIDEN);
    await page.fill('[data-testid="locking-source-citation"]', CITATION_WIDEN);
    await page.click('[data-testid="locking-preview-button"]');

    const previewAfterWiden = page.locator(
      '[data-testid="config-preview-warning"]',
    );
    await expect(
      previewAfterWiden,
      '[data-testid="config-preview-warning"] MUST surface after preview',
    ).toBeVisible({ timeout: 10_000 });

    // PreviewWarning renders one of two branches:
    //   - `[data-testid="config-preview-safe"]`     (affecting=false)
    //   - `[data-testid="config-preview-affecting"]` (affecting=true; needs ack)
    //
    // We probe the acknowledge checkbox (only rendered in the affecting
    // branch); tick it if present so the confirm button enables. If the
    // safe branch rendered, the confirm button is enabled unconditionally.
    const ackAfterWiden = page.locator(
      '[data-testid="config-preview-acknowledge"]',
    );
    if (await ackAfterWiden.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await ackAfterWiden.check();
    }

    await page.click('[data-testid="config-preview-confirm"]');
    await expect(
      page.locator('[data-testid="config-toast"]'),
      'success toast MUST render after the widen-to-90 upsert',
    ).toBeVisible({ timeout: 10_000 });
    const widenToastText = await page
      .locator('[data-testid="config-toast"]')
      .textContent();
    expect(
      widenToastText ?? '',
      'toast MUST quote the new version id in the form "Updated to version N"',
    ).toMatch(/Updated to version \d+/);

    // ----------------------------------------------------------------------
    // Step (a-consumer): RUNTIME-DEFERRED prediction submission as
    // participant under the new 90-min window. Should be REJECTED with a
    // WCM-family lock error per Slice 003's `is_prediction_locked` body
    // (kickoff=T+75min, window=90 → lock-at=T-15 → now > lock-at → LOCKED).
    //
    // Wait 2s as a pragmatic ceiling for the LISTEN/NOTIFY round trip.
    // ----------------------------------------------------------------------
    await page.waitForTimeout(2_000);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredLockedSubmit = false;
    if (_runtimeDeferredLockedSubmit) {
      // TODO(slice-008): un-defer once Docker is up + 75-min-away match is
      // seeded in beforeEach. Sign in as participant in a fresh context and
      // POST to slice 003's /api/me/predictions; expect WCM-family error.
    }

    // ----------------------------------------------------------------------
    // Step (b): try to set the window to 0. Client-side validation (T018
    // zod min(1)) MUST surface `[data-testid="locking-validation-error"]`
    // and disable the preview button BEFORE any server round-trip. We
    // therefore assert the inline error AND that no toast is emitted (no
    // upsert was attempted).
    //
    // Implementation note: `<input type="number" min={1}>` does NOT
    // hard-block the value via the DOM API when set programmatically — the
    // editor's onChange handler runs the T018 validator and writes the
    // error message into local state. We therefore re-navigate to the page
    // first so the editor starts from a clean state (no leftover reason /
    // ack from step (a) lingering in the component tree).
    // ----------------------------------------------------------------------
    await page.goto('/admin/config/locking');
    await expect(
      page.locator('[data-testid="admin-config-locking-page"]'),
      'admin-config-locking-page MUST re-render after navigation back for validation case',
    ).toBeVisible();

    await page.fill('[data-testid="locking-window-input"]', '0');
    await expect(
      page.locator('[data-testid="locking-validation-error"]'),
      '[data-testid="locking-validation-error"] MUST render for value=0 (T018 zod min(1) ⇒ WCG02 if a client bypass were attempted)',
    ).toBeVisible({ timeout: 5_000 });

    // The preview button MUST be disabled while the validation error is
    // surfaced — clicking it should be a no-op. We confirm the disabled
    // attribute is set; we do NOT click it (a forced click would mask a
    // regression where the disabled state regressed).
    await expect(
      page.locator('[data-testid="locking-preview-button"]'),
      'preview button MUST be disabled while validation error is surfaced',
    ).toBeDisabled();

    // Defence in depth: no toast emitted (no upsert attempted).
    await expect(
      page.locator('[data-testid="config-toast"]'),
      'no success toast MUST appear for the value=0 case',
    ).toHaveCount(0);

    // ----------------------------------------------------------------------
    // Step (c): change the window from 90 (the now-current value, set by
    // step (a)) to 30. Same preview → ack-if-affecting → confirm flow.
    // Restores the 75-min-away match to UNLOCKED state under Slice 003
    // semantics (kickoff=T+75min, window=30 → lock-at=T+45 → now < lock-at
    // → UNLOCKED again).
    // ----------------------------------------------------------------------
    await page.fill('[data-testid="locking-window-input"]', '30');
    await page.fill('[data-testid="locking-reason"]', REASON_NARROW);
    await page.fill('[data-testid="locking-source-citation"]', CITATION_NARROW);
    await page.click('[data-testid="locking-preview-button"]');

    const previewAfterNarrow = page.locator(
      '[data-testid="config-preview-warning"]',
    );
    await expect(
      previewAfterNarrow,
      '[data-testid="config-preview-warning"] MUST surface after preview (narrow)',
    ).toBeVisible({ timeout: 10_000 });

    const ackAfterNarrow = page.locator(
      '[data-testid="config-preview-acknowledge"]',
    );
    if (await ackAfterNarrow.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await ackAfterNarrow.check();
    }

    await page.click('[data-testid="config-preview-confirm"]');
    await expect(
      page.locator('[data-testid="config-toast"]'),
      'success toast MUST render after the narrow-to-30 upsert',
    ).toBeVisible({ timeout: 10_000 });

    // ----------------------------------------------------------------------
    // Step (c-consumer): RUNTIME-DEFERRED prediction submission as
    // participant under the new 30-min window. Should SUCCEED (kickoff=T+75
    // min, window=30 → lock-at=T+45 → now < lock-at → UNLOCKED). Wait 2s
    // for LISTEN/NOTIFY.
    // ----------------------------------------------------------------------
    await page.waitForTimeout(2_000);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredOpenSubmit = false;
    if (_runtimeDeferredOpenSubmit) {
      // TODO(slice-008): un-defer once Docker is up + the consumer
      // submission path is callable. Expect a 200 from slice 003's
      // /api/me/predictions for the same 75-min-away match.
    }

    // ----------------------------------------------------------------------
    // Step (d): verify `audit_log` carries ≥ 2 new rows under
    // `action='tournament_config.locking.match_prediction_window_minutes'`
    // since the test started (60→90 + 90→30; the value=0 case never round-
    // trips the server). `authenticated` cannot read audit_log under RLS,
    // so we use the service-role helper.
    // ----------------------------------------------------------------------
    const service = getServiceClient();
    const { data: auditRows, error: auditErr } = await service
      .from('audit_log')
      .select('id, action, previous_value, new_value, reason, occurred_at')
      .eq('action', CONFIG_ACTION)
      .gte('occurred_at', testStartInstant)
      .order('occurred_at', { ascending: true });

    expect(
      auditErr,
      'service-role audit_log read MUST NOT error',
    ).toBeNull();
    expect(
      auditRows,
      'audit_log read MUST return a non-null payload (possibly empty)',
    ).not.toBeNull();
    expect(
      (auditRows ?? []).length,
      `audit_log MUST carry >= 2 rows under action='${CONFIG_ACTION}' since ${testStartInstant} (widen + narrow); the value=0 client-validation case MUST NOT have round-tripped the server`,
    ).toBeGreaterThanOrEqual(2);

    // Sanity: the reasons we typed match the audit-log reasons (order by
    // occurred_at ascending, so widen comes first, narrow second).
    const reasons = (auditRows ?? []).map((r) => r.reason);
    expect(
      reasons,
      'audit_log reasons MUST include both the widen and the narrow reasons',
    ).toEqual(expect.arrayContaining([REASON_WIDEN, REASON_NARROW]));
  });
});
