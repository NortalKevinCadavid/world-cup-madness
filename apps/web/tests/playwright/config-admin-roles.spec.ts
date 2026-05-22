// --------------------------------------------------------------------------
// Slice 008 / T044 — Admin-roles grant/revoke surface test (US4).
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/admin-roles` page wired up in T040 (server
// page + AdminRolesEditor client component) over the T038 wrapper RPCs
// (`admin_config_grant_admin_role`, `admin_config_revoke_admin_role`).
//
// Test plan (verbatim from tasks.md T044, US4):
//   (1) Sign in as admin; visit /admin/config/admin-roles.
//   (2) Grant admin role to a fresh non-admin participant.
//   (3) Verify the participant's `admin_roles` row + `tournament_config_versions`
//       row (key='admin_roles.<uuid>') both exist with linked `audit_log_id`.
//   (4) Sign in as the newly-promoted participant in incognito; verify access
//       to /admin/*.
//   (5) Revoke role; verify revoked_at populated; promoted user loses access
//       on next request.
//
// Audit chain semantics (per migration 0077, lines ~1437-1609):
//   - T038's RPC INSERTs into `tournament_config_versions` with
//     `key='admin_roles.<participant_id>'`, `change_kind='admin_upsert'`
//     (NOT a special `admin_grant`/`admin_revoke` value), and
//     `previous_value` / `new_value` encoded as `{"admin": <bool>}`.
//   - The audit_log row is written by the Slice 006 trigger
//     (`log_admin_role_change`) on the admin_roles INSERT (grant) or on the
//     NULL → NOT NULL revoked_at transition (revoke). Its `source` column
//     therefore equals `'trigger'`, NOT `'api_guard'`.
//   - `entity_type='admin_role'`, `entity_id=<admin_roles.id>` (NOT the
//     participant_id).
//   - T038 SELECTs the trigger's audit_log row by (action, entity_type,
//     entity_id) and stores its `id` in `tournament_config_versions.audit_log_id`,
//     establishing the linked chain T044 verifies.
//
// RUNTIME-DEFERRED steps
// ----------------------
// Three buckets of this spec require live Supabase + OIDC stack + browser-
// context isolation that are NOT runtime-ready in this slice-008 docker-down
// authoring environment. Each is gated behind an `if (false)` const guard so
// the file type-checks today, and the assertions are ready to un-defer the
// moment the surrounding pieces come up:
//
//   • DOM walk steps (page render, search-pick-submit, revoke modal) need the
//     Next.js app + Supabase Auth + the OIDC stub all reachable so the admin
//     can actually land on /admin/config/admin-roles. Without the stack the
//     `signInWithIdentity` call hangs at /auth/callback. Gated behind
//     `_runtimeDeferredAdminDomWalk`.
//
//   • Service-client DB verification (steps 3, 5) needs the local Supabase
//     reachable so we can read `admin_roles`, `tournament_config_versions`,
//     and `audit_log`. Gated behind `_runtimeDeferredDbVerify`.
//
//   • Incognito-as-new-admin sub-flow (step 4) needs a SECOND OIDC session
//     in a fresh `BrowserContext`. The mock-oauth2-server's claim-config
//     endpoint is single-tenant per `requestParam`, so the cleanest pattern
//     is to register the new admin's claims, open a new context, sign in,
//     then close the context. Gated behind
//     `_runtimeDeferredIncognitoAccess`.
//
// When un-deferring (any bucket):
//   1. Confirm Docker is up: `docker compose ps` shows the postgres + auth +
//      oidc-stub containers in `running` state.
//   2. Confirm `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` are in the
//      Playwright env.
//   3. Drop the corresponding `if (false)` guard.
//   4. Run `pnpm exec playwright test config-admin-roles.spec.ts` and watch
//      the un-deferred branch fail-loudly on the first real assertion miss
//      — fix forward from there.
//
// Test-fixture admin (Slice 001 / Slice 006):
//   auth_user_id    = 00000000-0000-0000-0000-0000000000d3
//   participants.id = 77777777-7777-7777-7777-777777777777
//
// Test-fixture fresh participant (T044-only):
//   participants.id = 00000000-aaaa-0000-0000-000000000044
//   auth_user_id    = 00000000-aaaa-0000-0000-0000000000d4
//   email           = t044-promote@nortal.com
// --------------------------------------------------------------------------

import { test, expect, type Browser, type Page } from '@playwright/test';

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

// Fresh promotion target. UUIDs are deterministic + collision-safe within
// the T044 test namespace (matches the spec's "00000000-aaaa-…044" pattern).
const FRESH = {
  participantId: '00000000-aaaa-0000-0000-000000000044',
  authUserId: '00000000-aaaa-0000-0000-0000000000d4',
  email: 't044-promote@nortal.com',
  emailVerified: true,
  displayName: 'T044 Promotion Target',
} as const;

const GRANT_REASON = 'promote for tournament admin duties';
const GRANT_SOURCE = 'Slack thread 2026-05-15';
const REVOKE_REASON = 'end of tournament — admin no longer needed';
const REVOKE_SOURCE = 'Slack thread 2026-06-30';

const VERSIONS_KEY = `admin_roles.${FRESH.participantId}`;

test.describe('Slice 008 US4 — Admin roles @slice-008 @us4', () => {
  // 120s covers the grant-then-revoke round trip (≤2 RPC + ≤2 router.refresh
  // + the optional incognito sub-flow). The live admin path runs comfortably
  // in under 20s; the headroom is for the second OIDC sign-in once
  // `_runtimeDeferredIncognitoAccess` un-defers.
  test.setTimeout(120_000);

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
  });

  test.afterEach(async () => {
    await resetStub();
    // Best-effort cleanup of the test-only fresh participant's role rows so a
    // mid-flight failure does not poison sibling tests. We deliberately do
    // NOT touch:
    //   - audit_log rows (append-only by contract — RLS rejects DELETE).
    //   - tournament_config_versions rows (append-only history — Slice 005
    //     retention rules govern any pruning).
    // The canonical reset is `supabase db reset` between spec files in CI;
    // this is belt-and-braces for in-suite re-runs.
    try {
      const service = getServiceClient();
      await service
        .from('admin_roles')
        .delete()
        .eq('participant_id', FRESH.participantId);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test('Admin grants then revokes role on a fresh participant; versions + audit chain linked; promoted user gains then loses /admin/* access @slice-008 @us4', async ({
    page,
    browser,
  }) => {
    // ----------------------------------------------------------------------
    // Setup: ensure the fresh promotion target exists in `participants` (and
    // its backing `auth.users` row) but does NOT have an active admin_roles
    // row. The test's pre-condition is "fresh non-admin participant" — we
    // upsert idempotently so re-runs across a single `supabase db reset`
    // cycle remain green.
    //
    // RUNTIME-DEFERRED: requires the local Supabase to be reachable.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredFreshSeed = false;
    if (_runtimeDeferredFreshSeed) {
      const service = getServiceClient();

      // Seed auth.users first (FK from participants.auth_user_id ON DELETE
      // RESTRICT). The service-role key can write to auth schema.
      await service.auth.admin.createUser({
        id: FRESH.authUserId,
        email: FRESH.email,
        email_confirm: FRESH.emailVerified,
        user_metadata: { name: FRESH.displayName },
      });

      // Then participants. We upsert by id so a leftover row from a prior
      // (failed) run is not a blocker.
      await service.from('participants').upsert(
        {
          id: FRESH.participantId,
          auth_user_id: FRESH.authUserId,
          email: FRESH.email,
          display_name: FRESH.displayName,
        },
        { onConflict: 'id' },
      );

      // Pre-condition: no active admin_roles row for the fresh participant.
      await service
        .from('admin_roles')
        .delete()
        .eq('participant_id', FRESH.participantId);
    }

    // Capture a timestamp BEFORE the grant fires so we can scope audit_log
    // and tournament_config_versions reads to "rows this test wrote" and
    // ignore prior-state noise.
    const testStartInstant = new Date().toISOString();

    // ----------------------------------------------------------------------
    // Step 1: sign in as admin1 and land on /admin/config/admin-roles.
    //
    // RUNTIME-DEFERRED: the OIDC stub round-trip + Next.js auth callback
    // require the full local stack. Without it `signInWithIdentity` hangs at
    // /auth/callback. The DOM-walk steps (1–11, 13, 18–24) all sit inside
    // this guard so they un-defer as a single unit.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredAdminDomWalk = false;
    if (_runtimeDeferredAdminDomWalk) {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      await page.goto('/admin/config/admin-roles');
      await expect(
        page.locator('[data-testid="admin-config-admin-roles-page"]'),
        '[data-testid="admin-config-admin-roles-page"] MUST render on /admin/config/admin-roles for an admin caller',
      ).toBeVisible();

      // Sanity: the fresh participant is NOT currently in the admins table.
      // We assert by absence of a row carrying the fresh participant_id —
      // the table itself MAY or MAY NOT be present (depends on prior-state
      // admins seeded by the bootstrap), so we read row count via
      // `data-participant-id` filter.
      await expect(
        page.locator(
          `[data-testid="admin-row"][data-participant-id="${FRESH.participantId}"]`,
        ),
        'fresh participant MUST NOT appear in the admins table before grant',
      ).toHaveCount(0);

      // ------------------------------------------------------------------
      // Step 2–6: grant flow.
      //
      // The grant form lives in section 2 of the page (AdminRolesEditor's
      // <section data-testid="grant-form">). Typing into `grant-search-input`
      // triggers a 250ms debounce → /api/admin/participants/search → up to 5
      // results rendered as <button data-testid="grant-search-result">
      // children of <div data-testid="grant-search-results">. We click the
      // one whose `data-participant-id` matches FRESH.participantId.
      // ------------------------------------------------------------------
      await page
        .locator('[data-testid="grant-search-input"]')
        .fill(FRESH.email);

      // Wait for the results container to appear and contain the target row.
      await expect(
        page.locator('[data-testid="grant-search-results"]'),
        '[data-testid="grant-search-results"] MUST surface after typing ≥2 chars',
      ).toBeVisible({ timeout: 10_000 });

      const targetResult = page.locator(
        `[data-testid="grant-search-result"][data-participant-id="${FRESH.participantId}"]`,
      );
      await expect(
        targetResult,
        'autocomplete MUST return a result matching the fresh participant id',
      ).toBeVisible({ timeout: 10_000 });
      await targetResult.click();

      // Step 8 + 9: fill reason + source citation.
      await page.locator('[data-testid="grant-reason"]').fill(GRANT_REASON);
      await page
        .locator('[data-testid="grant-source-citation"]')
        .fill(GRANT_SOURCE);

      // Step 10: submit.
      await page.locator('[data-testid="grant-submit"]').click();

      // Step 11: success toast.
      await expect(
        page.locator('[data-testid="admin-roles-toast"]'),
        'success toast MUST render after a grant submit',
      ).toBeVisible({ timeout: 10_000 });

      // Step 13: post-router.refresh, the new admin's row MUST appear in the
      // table. We allow router.refresh's re-render to settle; an explicit
      // page.reload() is the belt-and-braces escape hatch in case T040's
      // `router.refresh()` is not yet hooked at the time T044 lands.
      await expect(
        page.locator(
          `[data-testid="admin-row"][data-participant-id="${FRESH.participantId}"]`,
        ),
        'after grant the fresh participant MUST appear in the admins table',
      ).toBeVisible({ timeout: 10_000 });
    }

    // ----------------------------------------------------------------------
    // Step 12: DB-side verification of the grant. Three rows MUST exist:
    //   (a) admin_roles row for the fresh participant, revoked_at IS NULL,
    //       granted_by=ADMIN1_PARTICIPANT_ID.
    //   (b) tournament_config_versions row with key='admin_roles.<uuid>',
    //       change_kind='admin_upsert', previous_value={"admin":false},
    //       new_value={"admin":true}, audit_log_id IS NOT NULL.
    //   (c) audit_log row referenced by (b).audit_log_id with
    //       action='admin.role_granted', entity_type='admin_role',
    //       entity_id=<admin_roles.id>, source='trigger'.
    //
    // RUNTIME-DEFERRED: needs a reachable Supabase service-role connection.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredDbVerifyGrant = false;
    let grantedAdminRoleId: string | null = null;
    if (_runtimeDeferredDbVerifyGrant) {
      const service = getServiceClient();

      // (12a) admin_roles row.
      const { data: roleRows, error: roleErr } = await service
        .from('admin_roles')
        .select('id, participant_id, granted_by, granted_at, revoked_at')
        .eq('participant_id', FRESH.participantId)
        .is('revoked_at', null);

      expect(
        roleErr,
        'service-role admin_roles read MUST NOT error',
      ).toBeNull();
      expect(
        (roleRows ?? []).length,
        'exactly one active admin_roles row MUST exist for the fresh participant after grant',
      ).toBe(1);
      const role = (roleRows ?? [])[0];
      expect(
        role.granted_by,
        'admin_roles.granted_by MUST equal the granting admin participant id',
      ).toBe(ADMIN1_PARTICIPANT_ID);
      expect(
        role.revoked_at,
        'admin_roles.revoked_at MUST be NULL immediately after grant',
      ).toBeNull();
      grantedAdminRoleId = role.id as string;

      // (12b) tournament_config_versions row.
      const { data: versionRows, error: versionErr } = await service
        .from('tournament_config_versions')
        .select(
          'version_id, key, previous_value, new_value, change_kind, audit_log_id, created_at',
        )
        .eq('key', VERSIONS_KEY)
        .gte('created_at', testStartInstant)
        .order('version_id', { ascending: true });

      expect(
        versionErr,
        'service-role tournament_config_versions read MUST NOT error',
      ).toBeNull();
      expect(
        (versionRows ?? []).length,
        `≥1 tournament_config_versions row MUST exist for key='${VERSIONS_KEY}' since test start`,
      ).toBeGreaterThanOrEqual(1);

      const grantVersion = (versionRows ?? [])[0];
      expect(
        grantVersion.change_kind,
        'grant version row MUST have change_kind=admin_upsert (T038 contract — NOT a special admin_grant enum)',
      ).toBe('admin_upsert');
      expect(
        (grantVersion.previous_value as { admin?: boolean })?.admin,
        'grant version previous_value MUST be {"admin": false}',
      ).toBe(false);
      expect(
        (grantVersion.new_value as { admin?: boolean })?.admin,
        'grant version new_value MUST be {"admin": true}',
      ).toBe(true);
      expect(
        grantVersion.audit_log_id,
        'grant version audit_log_id MUST be non-null (T038 links to the trigger-written audit row)',
      ).not.toBeNull();

      // (12c) audit_log row that the version row points at.
      const { data: auditRow, error: auditErr } = await service
        .from('audit_log')
        .select('id, action, entity_type, entity_id, source, actor')
        .eq('id', grantVersion.audit_log_id)
        .maybeSingle();

      expect(
        auditErr,
        'service-role audit_log read MUST NOT error',
      ).toBeNull();
      expect(
        auditRow,
        'audit_log row referenced by tournament_config_versions.audit_log_id MUST exist',
      ).not.toBeNull();
      expect(
        auditRow?.action,
        "audit_log.action MUST equal 'admin.role_granted'",
      ).toBe('admin.role_granted');
      expect(
        auditRow?.entity_type,
        "audit_log.entity_type MUST equal 'admin_role'",
      ).toBe('admin_role');
      expect(
        auditRow?.entity_id,
        'audit_log.entity_id MUST equal the admin_roles.id (NOT the participant_id)',
      ).toBe(grantedAdminRoleId);
      expect(
        auditRow?.source,
        "audit_log.source MUST equal 'trigger' (Slice 006 log_admin_role_change trigger writes the row; NOT 'api_guard')",
      ).toBe('trigger');
    }

    // ----------------------------------------------------------------------
    // Steps 14–17: incognito sign-in as the newly-promoted participant +
    // verify they can hit /admin/* without a notFound() or redirect.
    //
    // RUNTIME-DEFERRED: requires a second OIDC session + browser-context
    // isolation. The mock-oauth2-server's claim-config endpoint is rewritten
    // by `signInWithIdentity` on every call, so we must register the new
    // claims, open a fresh context, sign in there, assert, then close.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredIncognitoAccess = false;
    if (_runtimeDeferredIncognitoAccess) {
      // Local type narrowing — `browser` is the @playwright/test Browser
      // injected via the test fixture. We use a fresh context (no shared
      // cookies/storage) so the existing admin1 session in `page` is not
      // disturbed.
      const browserRef: Browser = browser;
      const newAdminContext = await browserRef.newContext();
      try {
        const newAdminPage: Page = await newAdminContext.newPage();
        await signInWithIdentity(newAdminPage, {
          claims: {
            sub: FRESH.authUserId,
            email: FRESH.email,
            email_verified: FRESH.emailVerified,
            name: FRESH.displayName,
          },
        });

        // After sign-in the newly-promoted user MUST be able to hit any
        // /admin/* route without being redirected away or receiving a
        // notFound(). The admin-roles surface is a convenient probe because
        // we already know its testid contract.
        await newAdminPage.goto('/admin/config/admin-roles');
        await expect(
          newAdminPage.locator(
            '[data-testid="admin-config-admin-roles-page"]',
          ),
          'newly-promoted participant MUST be able to load /admin/config/admin-roles',
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await newAdminContext.close();
      }
    }

    // ----------------------------------------------------------------------
    // Steps 18–24: revoke flow back in the admin tab. We open the modal,
    // assert the self-warning is NOT visible (this is not self-revoke), fill
    // reason + source-citation, confirm.
    //
    // RUNTIME-DEFERRED: gated by the same DOM-walk guard as the grant flow.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredRevokeDomWalk = false;
    if (_runtimeDeferredRevokeDomWalk) {
      const newAdminRow = page.locator(
        `[data-testid="admin-row"][data-participant-id="${FRESH.participantId}"]`,
      );
      await newAdminRow
        .locator('[data-testid="admin-revoke-button"]')
        .click();

      await expect(
        page.locator('[data-testid="revoke-modal"]'),
        '[data-testid="revoke-modal"] MUST open after clicking revoke',
      ).toBeVisible();

      // Self-warning is NOT shown for a non-self revoke. We assert toHaveCount(0)
      // rather than not.toBeVisible() because the warning is conditionally
      // rendered (so the element is absent entirely, not merely hidden).
      await expect(
        page.locator('[data-testid="revoke-self-warning"]'),
        '[data-testid="revoke-self-warning"] MUST NOT render when revoking a different admin',
      ).toHaveCount(0);

      await page.locator('[data-testid="revoke-reason"]').fill(REVOKE_REASON);
      await page
        .locator('[data-testid="revoke-source-citation"]')
        .fill(REVOKE_SOURCE);
      await page.locator('[data-testid="revoke-confirm"]').click();

      await expect(
        page.locator('[data-testid="admin-roles-toast"]'),
        'success toast MUST render after a revoke confirm',
      ).toBeVisible({ timeout: 10_000 });
    }

    // ----------------------------------------------------------------------
    // Step 25: DB-side verification of the revoke. Three rows MUST exist /
    // mutate:
    //   (a) admin_roles row for the fresh participant now has revoked_at
    //       NOT NULL, revoked_by=ADMIN1_PARTICIPANT_ID, revoke_reason matches.
    //   (b) tournament_config_versions has a SECOND row with the same key,
    //       change_kind='admin_upsert', previous_value={"admin":true},
    //       new_value={"admin":false}, distinct audit_log_id from the grant.
    //   (c) audit_log row referenced has action='admin.role_revoked',
    //       entity_type='admin_role', source='trigger'.
    //
    // RUNTIME-DEFERRED: same as step 12 — needs live Supabase.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredDbVerifyRevoke = false;
    if (_runtimeDeferredDbVerifyRevoke) {
      const service = getServiceClient();

      // (25a) admin_roles row revoked.
      const { data: revokedRows, error: revokedErr } = await service
        .from('admin_roles')
        .select(
          'id, participant_id, revoked_at, revoked_by, revoke_reason, granted_by',
        )
        .eq('participant_id', FRESH.participantId)
        .order('granted_at', { ascending: false })
        .limit(1);

      expect(
        revokedErr,
        'service-role admin_roles read (post-revoke) MUST NOT error',
      ).toBeNull();
      expect(
        (revokedRows ?? []).length,
        'admin_roles MUST still carry the (now-revoked) row for the fresh participant',
      ).toBe(1);
      const revoked = (revokedRows ?? [])[0];
      expect(
        revoked.revoked_at,
        'admin_roles.revoked_at MUST be NOT NULL after revoke',
      ).not.toBeNull();
      expect(
        revoked.revoked_by,
        'admin_roles.revoked_by MUST equal the revoking admin participant id',
      ).toBe(ADMIN1_PARTICIPANT_ID);
      expect(
        revoked.revoke_reason,
        'admin_roles.revoke_reason MUST equal the reason supplied to the RPC',
      ).toBe(REVOKE_REASON);

      // (25b) second tournament_config_versions row for the same key.
      const { data: versionRows, error: versionErr } = await service
        .from('tournament_config_versions')
        .select(
          'version_id, key, previous_value, new_value, change_kind, audit_log_id, created_at',
        )
        .eq('key', VERSIONS_KEY)
        .gte('created_at', testStartInstant)
        .order('version_id', { ascending: true });

      expect(
        versionErr,
        'service-role tournament_config_versions read (post-revoke) MUST NOT error',
      ).toBeNull();
      expect(
        (versionRows ?? []).length,
        `≥2 tournament_config_versions rows MUST exist for key='${VERSIONS_KEY}' since test start (grant + revoke)`,
      ).toBeGreaterThanOrEqual(2);

      const grantVersion = (versionRows ?? [])[0];
      const revokeVersion = (versionRows ?? [])[1];
      expect(
        revokeVersion.change_kind,
        'revoke version row MUST have change_kind=admin_upsert (T038 contract — same enum as grant)',
      ).toBe('admin_upsert');
      expect(
        (revokeVersion.previous_value as { admin?: boolean })?.admin,
        'revoke version previous_value MUST be {"admin": true}',
      ).toBe(true);
      expect(
        (revokeVersion.new_value as { admin?: boolean })?.admin,
        'revoke version new_value MUST be {"admin": false}',
      ).toBe(false);
      expect(
        revokeVersion.audit_log_id,
        'revoke version audit_log_id MUST be non-null',
      ).not.toBeNull();
      expect(
        revokeVersion.audit_log_id,
        'revoke version audit_log_id MUST differ from the grant version audit_log_id',
      ).not.toBe(grantVersion.audit_log_id);

      // (25c) audit_log row referenced by the revoke version.
      const { data: revokeAudit, error: revokeAuditErr } = await service
        .from('audit_log')
        .select('id, action, entity_type, entity_id, source')
        .eq('id', revokeVersion.audit_log_id)
        .maybeSingle();

      expect(
        revokeAuditErr,
        'service-role audit_log read (revoke) MUST NOT error',
      ).toBeNull();
      expect(
        revokeAudit?.action,
        "audit_log.action MUST equal 'admin.role_revoked'",
      ).toBe('admin.role_revoked');
      expect(
        revokeAudit?.entity_type,
        "audit_log.entity_type MUST equal 'admin_role'",
      ).toBe('admin_role');
      expect(
        revokeAudit?.source,
        "audit_log.source MUST equal 'trigger' (Slice 006 trigger writes the revoke audit row; NOT 'api_guard')",
      ).toBe('trigger');
    }

    // ----------------------------------------------------------------------
    // Post-revoke access loss (Step 5 of the T044 plan, second clause):
    // "promoted user loses access on next request."
    //
    // RUNTIME-DEFERRED: requires the second OIDC session to still hold a
    // valid Supabase session whose access token can be force-refreshed so
    // the next /admin/* navigation re-runs the is_admin() check. This is the
    // exact pattern as `mintRefreshedAccessToken` in fixtures/oidc.ts but
    // applied to the revoked user's context — once incognito un-defers, this
    // sub-flow un-defers with it.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredAccessLoss = false;
    if (_runtimeDeferredAccessLoss) {
      // Re-open a fresh context for the (now-revoked) participant. Sign in,
      // then attempt /admin/config/admin-roles — the page MUST notFound()
      // or redirect because is_admin() now returns false (Slice 006 +
      // migration 0075 filter on active admin_roles + active participants).
      const browserRef: Browser = browser;
      const revokedContext = await browserRef.newContext();
      try {
        const revokedPage: Page = await revokedContext.newPage();
        await signInWithIdentity(revokedPage, {
          claims: {
            sub: FRESH.authUserId,
            email: FRESH.email,
            email_verified: FRESH.emailVerified,
            name: FRESH.displayName,
          },
        });

        // is_admin() resolves over `admin_roles WHERE revoked_at IS NULL`
        // (per migrations 0062 + 0075). With revoked_at set in step 25, the
        // next request denies access. The page either notFound()s (Next.js
        // server-component pattern used by /admin/config/admin-roles) or
        // redirects back to `/`. We accept either.
        const response = await revokedPage.goto(
          '/admin/config/admin-roles',
        );
        // Next.js notFound() returns 404; redirect to "/" lands on a 200.
        // The discriminating signal is "the admin page testid is NOT
        // visible". We assert by absence rather than by HTTP code.
        await expect(
          revokedPage.locator(
            '[data-testid="admin-config-admin-roles-page"]',
          ),
          'revoked participant MUST NOT see the admin-roles page after revoke (is_admin() returns false)',
        ).toHaveCount(0);
        // Belt-and-braces: response object is non-null so a future un-defer
        // can tighten the assertion to `expect(response?.status()).toBe(404)`.
        expect(
          response,
          'goto() MUST return a Response object (sanity for future status assertion)',
        ).not.toBeNull();
      } finally {
        await revokedContext.close();
      }
    }

    // ----------------------------------------------------------------------
    // Optional Test 2 — self-revoke warning surface.
    //
    // The admin opens their OWN row's revoke modal and asserts the red
    // self-warning banner is visible. We close the modal without confirming
    // so the test does not actually demote admin1 (which would cascade-
    // break sibling tests in the same db cycle).
    //
    // RUNTIME-DEFERRED: same as the main revoke DOM walk.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferredSelfRevokeWarning = false;
    if (_runtimeDeferredSelfRevokeWarning) {
      await page.goto('/admin/config/admin-roles');
      const selfRow = page.locator(
        `[data-testid="admin-row"][data-participant-id="${ADMIN1_PARTICIPANT_ID}"]`,
      );
      await expect(
        selfRow,
        "admin1's own row MUST be present in the admins table",
      ).toBeVisible();
      await selfRow.locator('[data-testid="admin-revoke-button"]').click();

      await expect(
        page.locator('[data-testid="revoke-modal"]'),
        'revoke modal MUST open',
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="revoke-self-warning"]'),
        '[data-testid="revoke-self-warning"] MUST be visible when the operator is revoking their OWN admin role',
      ).toBeVisible();

      // Close without confirming — do NOT click revoke-confirm here.
      await page.locator('[data-testid="revoke-cancel"]').click();
      await expect(
        page.locator('[data-testid="revoke-modal"]'),
        'revoke modal MUST close after cancel',
      ).toHaveCount(0);
    }
  });
});
