import { test, expect } from '@playwright/test';
import { signInWithIdentity, resetStub } from './fixtures/oidc';
import { getServiceClient } from './helpers/service-role';

const ALPHA_PARTICIPANT_ID = '11111111-1111-1111-1111-111111111111';

// alpha — eligible non-admin participant (matches the seeded fixture
// identity used across Slice 001 / 002 / 007 regression specs).
const ALPHA = {
  sub: '00000000-0000-0000-0000-00000000000a',
  email: 'alpha@nortal.com',
  email_verified: true,
  name: 'Alpha Tester',
} as const;

test.describe('Audit search denial @slice-007 @us3', () => {
  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test('Non-admin visit to /admin/audit/search → 404 + admin.access_denied audit row', async ({ page }) => {
    await signInWithIdentity(page, {
      claims: {
        sub: ALPHA.sub,
        email: ALPHA.email,
        email_verified: ALPHA.email_verified,
        name: ALPHA.name,
      },
    });

    const response = await page.goto('/admin/audit/search');

    // Next.js notFound() returns a 404 status
    // OR the layout's requireAdmin redirects to /admin/denied (slice 006 pattern)
    // Either is acceptable per T020's contract
    const status = response?.status() ?? 0;
    const url = page.url();
    expect(status === 404 || url.endsWith('/admin/denied') || url.endsWith('/')).toBe(true);

    // Verify audit row written
    // Wait briefly for the DB insert to complete
    await page.waitForTimeout(500);

    const service = getServiceClient();
    const { data: rows } = await service
      .from('audit_log')
      .select('*')
      .eq('action', 'admin.access_denied')
      .eq('entity_type', 'audit_search_page')
      .eq('actor', ALPHA_PARTICIPANT_ID)
      .gte('occurred_at', testStartInstant);

    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
  });
});
