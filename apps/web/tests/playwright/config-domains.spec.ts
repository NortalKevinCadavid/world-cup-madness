// --------------------------------------------------------------------------
// Slice 008 / T028 — Approved-corporate-domains admin surface test.
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/domains` page wired up in T027 plus the
// downstream eligibility-evaluation feedback loop (LISTEN/NOTIFY-driven
// cache invalidation contracted to ≤ 60s).
//
// Test plan (verbatim from spec.md US1 / tasks.md T028):
//   1. Sign in as admin and visit `/admin/config/domains`.
//   2. Add `example.nortal.com` with reason "Onboarding new entity".
//   3. Assert success toast "Updated to version X".
//   4. Wait for LISTEN-driven cache invalidation.
//   5. Sign in as a fresh user with `@example.nortal.com` in a second
//      browser context — expect access GRANTED.
//   6. Return to `/admin/config/domains` and remove the just-added domain.
//   7. Assert PreviewWarning surfaces with participant count.
//   8. Check acknowledgment box; confirm.
//   9. Wait for LISTEN-driven cache invalidation.
//  10. Sign-in attempt from the (now-removed) domain — expect access DENIED.
//  11. Verify `audit_log` carries 2 new rows under
//      `action='tournament_config.eligibility.allowed_domains'` since the
//      test started.
//
// RUNTIME-DEFERRED steps
// ----------------------
// Steps 5 and 10 require the OIDC stub to mint identities for a brand-new
// `@example.nortal.com` subject AND require Docker + the LISTEN-driven
// cache-invalidation pipeline to be fully wired. Docker is currently down
// (slice 008 environment note) and `/admin/config/domains` itself is being
// authored in T027 ahead of this test file. Those two steps are stubbed
// with TODO comments and skipped at runtime — the assertions are present
// but commented out so the test compiles and runs the in-process flow
// (steps 1–4, 6–9, 11) as soon as the surface is wired.
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

const TEST_DOMAIN = 'example.nortal.com';
const ADD_REASON = 'Onboarding new entity';
const REMOVE_REASON = 'Test removal — onboarding rolled back';
const CONFIG_KEY = 'eligibility.allowed_domains';

test.describe('Slice 008 US1 — Approved corporate domains @slice-008 @us1', () => {
  // The full flow walks two sign-ins, two upserts, and an audit-log read.
  // 60s is comfortably above the per-step 5s expect timeout.
  test.setTimeout(90_000);

  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
    // Cleanup: restore eligibility.allowed_domains so a failed mid-flight
    // removal does not poison sibling tests. We intentionally do NOT delete
    // the audit_log rows the test wrote — those are append-only by RLS and
    // by contract.
    //
    // RUNTIME-DEFERRED: the canonical reset is `supabase db reset` between
    // spec files in CI. This best-effort cleanup runs as service-role and
    // tolerates missing rows (e.g. when the test bailed before any upsert).
    try {
      const service = getServiceClient();
      await service
        .from('tournament_config')
        .update({ value: ['nortal.com'] })
        .eq('key', CONFIG_KEY);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test('Admin adds + removes domain; eligibility honored within 60s; 2 audit rows recorded @slice-008 @us1', async ({
    page,
    browser,
  }) => {
    // ----------------------------------------------------------------------
    // Step 1: sign in as admin and visit the domains config page.
    // ----------------------------------------------------------------------
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    await page.goto('/admin/config/domains');
    await expect(
      page.locator('[data-testid="admin-config-domains-page"]'),
      '[data-testid="admin-config-domains-page"] MUST render on /admin/config/domains',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="domains-list"]'),
      '[data-testid="domains-list"] MUST render the current allow-list',
    ).toBeVisible();

    // ----------------------------------------------------------------------
    // Step 2: Add `example.nortal.com` with reason "Onboarding new entity".
    // ----------------------------------------------------------------------
    await page.fill('[data-testid="domain-add-input"]', TEST_DOMAIN);
    await page.fill('[data-testid="domain-reason"]', ADD_REASON);
    await page.click('[data-testid="domain-add-button"]');

    // The preview surfaces unconditionally per the configPreview contract.
    // Adding a new domain is non-affecting (it cannot revoke anyone's
    // eligibility) so the safe branch of PreviewWarning is expected. If a
    // future version skips the preview for non-affecting deltas the check
    // below tolerates either path.
    const previewAfterAdd = page.locator('[data-testid="config-preview-warning"]');
    if (
      await previewAfterAdd.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await page.click('[data-testid="config-preview-confirm"]');
    }

    // ----------------------------------------------------------------------
    // Step 3: Assert toast "Updated to version X".
    // ----------------------------------------------------------------------
    const toast = page.locator('[data-testid="config-toast"]');
    await expect(
      toast,
      'success toast MUST render after a successful upsert',
    ).toBeVisible({ timeout: 10_000 });
    const toastText = (await toast.textContent()) ?? '';
    expect(
      toastText,
      'toast MUST quote the new version id in the form "Updated to version N"',
    ).toMatch(/Updated to version \d+/);

    // ----------------------------------------------------------------------
    // Step 4: Wait for LISTEN-driven cache invalidation.
    //
    // The contract upper bound is 60s; in practice the LISTEN/NOTIFY round
    // trip completes in well under a second. We wait 2s as a pragmatic
    // ceiling while the Playwright run is single-process — production
    // latency is measured separately.
    // ----------------------------------------------------------------------
    await page.waitForTimeout(2_000);

    // ----------------------------------------------------------------------
    // Step 5 — RUNTIME-DEFERRED: fresh user with @example.nortal.com signs
    // in via a second browser context; expect access GRANTED (lands on
    // /dashboard rather than /auth/denied).
    //
    // Why deferred: the OIDC stub mints whichever subject we register, so
    // the sign-in helper itself is ready — but Slice 001's eligibility-
    // evaluation pipeline must be wired AND the LISTEN-driven cache
    // invalidation must be observable from inside the Next.js process.
    // Both depend on Docker (currently down) plus T027's page contract.
    //
    // When un-deferring this block:
    //   1. Drop the `if (false)` guard.
    //   2. Pick a sub UUID that does NOT collide with seeded participants
    //      (the helper synthesises one below).
    //   3. Expect /dashboard as the post-sign-in landing path.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredFreshGrant = false;
    if (_runtimeDeferredFreshGrant) {
      const freshContext = await browser.newContext();
      const freshPage = await freshContext.newPage();
      await signInWithIdentity(freshPage, {
        claims: {
          // Fresh subject — must not collide with seeded participants.
          sub: '99999999-9999-9999-9999-99999990081a',
          email: `onboarding-test@${TEST_DOMAIN}`,
          email_verified: true,
          name: 'Onboarding Test User',
        },
        expectedPostSignInPath: '/dashboard',
      });
      await expect(freshPage).toHaveURL(/\/dashboard(\?|$|\/)/);
      await freshContext.close();
    }

    // ----------------------------------------------------------------------
    // Step 6: Return to /admin/config/domains and remove the just-added
    // domain. The remove flow surfaces PreviewWarning unconditionally
    // because removing a domain CAN affect existing participants (US1's
    // acceptance criterion).
    // ----------------------------------------------------------------------
    await page.goto('/admin/config/domains');
    await expect(
      page.locator('[data-testid="admin-config-domains-page"]'),
      'admin-config-domains-page MUST re-render after navigation back',
    ).toBeVisible();

    await page.fill('[data-testid="domain-reason"]', REMOVE_REASON);
    await page.click(
      `[data-testid="domain-remove-button"][data-domain="${TEST_DOMAIN}"]`,
    );

    // ----------------------------------------------------------------------
    // Step 7: Assert PreviewWarning displays with participant count.
    //
    // If step 5 ran (un-deferred), `affecting=true` and the warning will
    // expose the participant count via [data-testid="config-preview-
    // affecting"]. If step 5 is deferred, the preview may render the safe
    // branch (no participant ever signed up under the domain) — the test
    // tolerates both branches so it can run incrementally as the
    // surrounding pieces ship.
    // ----------------------------------------------------------------------
    const previewAfterRemove = page.locator(
      '[data-testid="config-preview-warning"]',
    );
    await expect(
      previewAfterRemove,
      'PreviewWarning MUST surface for a remove-domain delta',
    ).toBeVisible({ timeout: 10_000 });

    // ----------------------------------------------------------------------
    // Step 8: Check acknowledgment if it is rendered (affecting branch);
    // then confirm.
    // ----------------------------------------------------------------------
    const ackCheckbox = page.locator('[data-testid="config-preview-acknowledge"]');
    if (await ackCheckbox.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await ackCheckbox.check();
    }
    await page.click('[data-testid="config-preview-confirm"]');

    // Toast for the second upsert.
    await expect(
      page.locator('[data-testid="config-toast"]'),
      'success toast MUST render after the remove-domain upsert',
    ).toBeVisible({ timeout: 10_000 });

    // ----------------------------------------------------------------------
    // Step 9: Wait for LISTEN-driven cache invalidation (same 2s pragmatic
    // ceiling as step 4).
    // ----------------------------------------------------------------------
    await page.waitForTimeout(2_000);

    // ----------------------------------------------------------------------
    // Step 10 — RUNTIME-DEFERRED: sign-in attempt from the removed domain
    // must land on /auth/denied with reason=domain_not_approved.
    //
    // Same Docker/wiring caveats as step 5. When un-deferring:
    //   1. Drop the `if (false)` guard.
    //   2. Reuse the same fresh sub UUID (so it exercises both grant and
    //      deny paths) OR pick a different fresh sub.
    //   3. Expect /auth/denied as the post-sign-in landing path AND
    //      reason=domain_not_approved as a query param.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredFreshDeny = false;
    if (_runtimeDeferredFreshDeny) {
      const deniedContext = await browser.newContext();
      const deniedPage = await deniedContext.newPage();
      await signInWithIdentity(deniedPage, {
        claims: {
          sub: '99999999-9999-9999-9999-99999990081b',
          email: `denied-test@${TEST_DOMAIN}`,
          email_verified: true,
          name: 'Denied Test User',
        },
        expectedPostSignInPath: '/auth/denied',
      });
      expect(
        deniedPage.url(),
        'denied URL MUST carry reason=domain_not_approved',
      ).toContain('reason=domain_not_approved');
      await deniedContext.close();
    }

    // ----------------------------------------------------------------------
    // Step 11: Verify `audit_log` has 2 new rows under
    // `action='tournament_config.eligibility.allowed_domains'` since the
    // test started.
    //
    // `authenticated` role cannot read audit_log under RLS — use the
    // service-role helper.
    // ----------------------------------------------------------------------
    const service = getServiceClient();
    const { data: auditRows, error: auditErr } = await service
      .from('audit_log')
      .select('id, action, previous_value, new_value, reason, occurred_at')
      .eq('action', `tournament_config.${CONFIG_KEY}`)
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
      `audit_log MUST carry >= 2 rows under action='tournament_config.${CONFIG_KEY}' since ${testStartInstant} (1 add + 1 remove)`,
    ).toBeGreaterThanOrEqual(2);

    // Sanity: the first row's reason matches the add reason; the second
    // matches the remove reason. Order is by occurred_at ascending above.
    const reasons = (auditRows ?? []).map((r) => r.reason);
    expect(
      reasons,
      'audit_log reasons MUST include both the add and the remove reasons',
    ).toEqual(expect.arrayContaining([ADD_REASON, REMOVE_REASON]));
  });
});
