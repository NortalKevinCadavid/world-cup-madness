import { test, expect } from '@playwright/test';
import { signInWithIdentity, resetStub } from './fixtures/oidc';
import { getServiceClient } from './helpers/service-role';
import { ensureAdminRole } from './helpers/admin-roles';

const ADMIN1_PARTICIPANT_ID = '77777777-7777-7777-7777-777777777777';

test.describe('Audit export validation @slice-007 @us3', () => {
  let testStartInstant: string;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
  });

  test.afterEach(async () => {
    await resetStub();
  });

  test('Validation 422s: no filters / max_rows>1M / source=garbage; no audit pollution', async ({ page, request }) => {
    await signInWithIdentity(page, {
      claims: {
        sub: '00000000-0000-0000-0000-0000000000d3',
        email: 'admin1@nortal.com',
        email_verified: true,
        name: 'Admin One',
      },
    });
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Case 1: no filters
    let res = await request.get('/api/admin/audit/export', { headers: { Cookie: cookieHeader } });
    expect(res.status()).toBe(422);
    let body = await res.json();
    expect(body.error).toMatch(/filter.*required/i);

    // Case 2: max_rows > 1_000_000
    res = await request.get('/api/admin/audit/export?action_pattern=admin.%25&max_rows=2000000', { headers: { Cookie: cookieHeader } });
    expect(res.status()).toBe(422);
    body = await res.json();
    expect(typeof body.error).toBe('string');

    // Case 3: source=garbage
    res = await request.get('/api/admin/audit/export?source=garbage', { headers: { Cookie: cookieHeader } });
    expect(res.status()).toBe(422);
    body = await res.json();
    expect(typeof body.error).toBe('string');

    // Verify NO audit row was written for these 422s
    await page.waitForTimeout(500);

    const service = getServiceClient();
    const { data: rows } = await service
      .from('audit_log')
      .select('*')
      .in('entity_type', ['audit_export', 'audit_search_page', 'audit_search'])
      .gte('occurred_at', testStartInstant);

    expect(rows).not.toBeNull();
    // Only admin.access_denied for actual denial; no rows for validation 422s
    // Since admin1 is admin, no admin.access_denied should fire either
    const validationRelatedRows = (rows ?? []).filter(r => {
      // Filter out unrelated audit rows that happen to share entity_type
      return ['audit_export', 'audit_search_page'].includes(r.entity_type as string);
    });
    expect(validationRelatedRows.length).toBe(0);
  });
});
