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

test.describe('Audit export denial @slice-007 @us3', () => {
  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test('Non-admin GET /api/admin/audit/export → 403 Forbidden + audit row entity_type=audit_export', async ({ page, request }) => {
    await signInWithIdentity(page, {
      claims: {
        sub: ALPHA.sub,
        email: ALPHA.email,
        email_verified: ALPHA.email_verified,
        name: ALPHA.name,
      },
    });

    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const response = await request.get(
      `/api/admin/audit/export?action_pattern=admin.%25&from=${encodeURIComponent(oneDayAgo)}`,
      {
        headers: { Cookie: cookieHeader },
      },
    );

    expect(response.status()).toBe(403);

    const body = await response.text();
    expect(body).toBe('Forbidden');

    // Verify admin.access_denied audit row written
    await page.waitForTimeout(500);

    const service = getServiceClient();
    const { data: rows } = await service
      .from('audit_log')
      .select('*')
      .eq('action', 'admin.access_denied')
      .eq('entity_type', 'audit_export')
      .eq('actor', ALPHA_PARTICIPANT_ID)
      .gte('occurred_at', testStartInstant);

    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
  });
});
