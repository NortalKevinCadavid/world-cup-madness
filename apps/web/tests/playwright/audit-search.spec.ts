// --------------------------------------------------------------------------
// Slice 007 / T022 — Admin audit-search Playwright surface test.
// --------------------------------------------------------------------------
//
// Verifies the `/admin/audit/search` page wired up in T020:
//   1. The page renders with the expected `data-testid` anchors
//      (`audit-search-page`, `audit-filters-form`, `audit-export-link`).
//   2. With `action_pattern=admin.%` and `from=<7d ago>` filters, either at
//      least one results row is shown OR the empty-state placeholder is
//      visible (allows for fixture variance — the cross-slice audit_log
//      seed produces admin.* rows in most runs).
//   3. The export link's `href` carries the active filters through to
//      `/api/admin/audit/export`.
//   4. Submitting the filter form with `source=admin_rpc` updates the URL
//      (the AuditFiltersForm's default behaviour is `router.push` per T020
//      deviation: the page is a server component, no `onSearch` prop).
//
// Test-fixture admin (Slice 001 / Slice 006):
//   auth_user_id   = 00000000-0000-0000-0000-0000000000d3
//   participants.id = 77777777-7777-7777-7777-777777777777
// --------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

import {
  resetStub,
  signInWithIdentity,
} from './fixtures/oidc';
import { ensureAdminRole } from './helpers/admin-roles';

const ADMIN1 = {
  sub: '00000000-0000-0000-0000-0000000000d3',
  email: 'admin1@nortal.com',
  email_verified: true,
  name: 'Admin One',
} as const;

const ADMIN1_PARTICIPANT_ID = '77777777-7777-7777-7777-777777777777';

test.describe('Admin audit search @slice-007 @us3', () => {
  test.setTimeout(60_000);

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test('Admin can search audit_log; results table + filter form + export link all visible @slice-007 @us3', async ({
    page,
  }) => {
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    // Visit with action_pattern=admin.% and from=7 days ago
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400 * 1000).toISOString();
    const url =
      `/admin/audit/search?action_pattern=admin.%25` +
      `&from=${encodeURIComponent(sevenDaysAgo)}`;
    await page.goto(url);

    // Assert page renders.
    await expect(
      page.locator('[data-testid="audit-search-page"]'),
      '[data-testid="audit-search-page"] MUST be visible on /admin/audit/search',
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="audit-filters-form"]'),
      '[data-testid="audit-filters-form"] MUST be visible on /admin/audit/search',
    ).toBeVisible();

    // Assert at least 1 row visible OR the empty-state message.
    // The cross-slice audit_log seed produces admin.* rows in most runs,
    // but if the fixture is truly empty the empty-state path is acceptable.
    const rowCount = await page
      .locator('[data-testid="audit-results-row"]')
      .count();
    const emptyVisible = await page
      .locator('[data-testid="audit-results-empty"]')
      .isVisible()
      .catch(() => false);
    expect(
      rowCount > 0 || emptyVisible,
      'either >=1 [data-testid="audit-results-row"] MUST render OR [data-testid="audit-results-empty"] MUST be visible',
    ).toBe(true);

    // Export CSV link visible (only when filters are set — which they are).
    await expect(
      page.locator('[data-testid="audit-export-link"]'),
      '[data-testid="audit-export-link"] MUST be visible when at least one filter is set',
    ).toBeVisible();
    const href = await page
      .locator('[data-testid="audit-export-link"]')
      .getAttribute('href');
    expect(
      href,
      'export link href MUST be present',
    ).not.toBeNull();
    expect(
      href ?? '',
      'export link MUST target /api/admin/audit/export',
    ).toContain('/api/admin/audit/export');
    expect(
      href ?? '',
      'export link MUST carry the active action_pattern filter through',
    ).toContain('action_pattern=admin');
  });

  test('Submitting filter form with source=admin_rpc updates URL and filters @slice-007 @us3', async ({
    page,
  }) => {
    await signInWithIdentity(page, {
      claims: {
        sub: ADMIN1.sub,
        email: ADMIN1.email,
        email_verified: ADMIN1.email_verified,
        name: ADMIN1.name,
      },
    });

    // Visit base search page.
    await page.goto('/admin/audit/search');

    await expect(
      page.locator('[data-testid="audit-filters-form"]'),
      'filters form MUST be visible before we interact with it',
    ).toBeVisible();

    // Fill source select with 'admin_rpc'.
    await page.selectOption('select[name="source"]', 'admin_rpc');

    // Click submit.
    await page.click('[data-testid="audit-filters-submit"]');

    // Wait for URL update — AuditFiltersForm uses router.push to drive the
    // server component re-render (T020 deviation).
    await page.waitForURL(
      (u) => u.searchParams.get('source') === 'admin_rpc',
      { timeout: 15_000 },
    );

    expect(
      page.url(),
      'URL MUST carry the submitted source=admin_rpc filter',
    ).toContain('source=admin_rpc');
  });
});
