// --------------------------------------------------------------------------
// Slice 008 / T043 — Sync-provider admin surface test (US4).
// --------------------------------------------------------------------------
//
// Exercises the `/admin/config/providers` page wired up in T039 plus the
// downstream credential-reveal path: clicking "Reveal credential" hits
// `/api/admin/config/get-secret`, which delegates to the T037
// `admin_config_get_secret` RPC and writes a forensic
// `admin.config_secret_accessed` audit row (key only — never the value).
//
// Test plan (verbatim from spec.md US4 / tasks.md T043):
//   (1) Sign in as admin and visit /admin/config/providers.
//   (2) Capture baseline `max(audit_log.sequence_id)` via service-role.
//   (3) Verify the page renders.
//   (4) Verify the dropdown shows registered adapters (≥ 1 option whose value
//       equals the seeded provider id `football_data_org`).
//   (5) Expand the football_data_org section.
//   (6) Click "Reveal credential" — modal opens with the credential key value.
//   (7) Assert the modal renders.
//   (8) Assert the readonly credential value input is present (the seed ships
//       `value: null` so the field renders empty — we still assert presence).
//   (9) Verify a NEW `admin.config_secret_accessed` audit row was written with
//       `new_value->>'key'` equal to the credential key AND no secret value
//       leaked into the audit row (`new_value->'value' IS NULL` AND
//       `new_value->'secret' IS NULL`).
//   (10) Close the modal — assert it is hidden.
//   (11) Change `retry.max_attempts` from 3 (seed) to 5.
//   (12) Save (triggers Preview → PreviewWarning → Confirm).
//   (13) Walk the PreviewWarning branch (ack-if-affecting → Confirm).
//   (14) Assert the per-section success toast renders.
//   (15) Verify `tournament_config.value` for the long-form key
//        `providers.football_data_org.retry.max_attempts` equals 5.
//   (16) Verify the newest `audit_log` row for that key carries the
//        previous_value (3), new_value (5), and the admin actor uuid.
//
// Key-name drift note (D-T039-A, restated)
// ----------------------------------------
// The T043 task body told us to "change `retry.max_attempts` from 3 to 5."
// The DOM testid suffix uses the SHORT alias `retry-max-attempts` (per the
// SEGMENT_TESTID_ALIAS map in ProvidersEditor.tsx). The actual catalog key
// in `tournament_config` is — verified against
// `supabase/migrations/0077_configuration.sql` ~ line 370 — also
// `providers.football_data_org.retry.max_attempts` (NOT
// `retry.max_attempts_base`, which is what the T043 prompt incorrectly
// asserted). Two of the THREE per-provider numeric keys carry the `_base`
// suffix in the seed (`backoff_seconds_base`, `threshold_consecutive_failures`),
// but `max_attempts` does NOT. We use the literal seed key in the
// service-role assertions below.
//
// RUNTIME-DEFERRED steps
// ----------------------
// Slice 008 is in a docker-down authoring environment (same as T031/T034/T035
// across this file's siblings). Steps that require:
//   • a live Supabase stack (signInWithIdentity → JWT mint → cookies),
//   • the T037 RPC + slot 0077 audit_log INSERT policy live,
//   • the T039 page reachable behind the admin gate (auth.uid() → is_admin),
// are gated behind an `if (false) { ... }` block matching the T031/T034/T035
// idiom. The block is type-checked (locals declared inside reference the same
// `page` object), so the spec compiles today and is one guard-flip away from
// running end-to-end the moment Docker is back up.
//
// We keep nothing OUTSIDE the guard — even the page-renders assertion (step
// 3) requires the admin OIDC login round-trip and the live Supabase session
// cookie, so it cannot truthfully run against a `pnpm next dev` process alone.
// Sibling specs (T031/T034) gate identically.
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

const PROVIDER_ID = 'football_data_org';
const CREDENTIAL_KEY = `providers.${PROVIDER_ID}.credentials.api_key`;

// Long-form catalog key — matches the seed in 0077 (line 370). The DOM testid
// suffix is the SHORT alias `retry-max-attempts`; the catalog key is the
// SAME SHORT NAME for max_attempts (NOT `max_attempts_base`). See the
// "Key-name drift" note in the file header.
const RETRY_KEY = `providers.${PROVIDER_ID}.retry.max_attempts`;
const RETRY_ACTION = `tournament_config.${RETRY_KEY}`;
const SECRET_ACTION = 'admin.config_secret_accessed';

const INITIAL_RETRY_VALUE = 3;
const NEW_RETRY_VALUE = 5;

const RETRY_REASON = 'Bump retry budget from 3 to 5 for transient 5xx tolerance';
const RETRY_SOURCE = 'T043 acceptance test';

test.describe('Slice 008 US4 — Providers config @slice-008 @us4', () => {
  // The full flow walks one credential reveal + one per-key upsert + two
  // audit_log reads. 90s mirrors T031/T035 headroom — comfortably above the
  // per-step 10s expect timeout.
  test.setTimeout(90_000);

  let testStartInstant: string;
  let baselineSequenceId: number;

  test.beforeEach(async () => {
    await resetStub();
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
    testStartInstant = new Date().toISOString();
    baselineSequenceId = 0;
  });

  test.afterEach(async () => {
    await resetStub();
    // Best-effort cleanup: restore the canonical default retry budget so a
    // failed mid-flight upsert does not poison sibling tests. We deliberately
    // do NOT delete `audit_log` rows the test wrote — those are append-only
    // by RLS and by contract. The canonical reset is `supabase db reset`
    // between spec files in CI; this is belt-and-braces.
    try {
      const service = getServiceClient();
      await service
        .from('tournament_config')
        .update({ value: INITIAL_RETRY_VALUE })
        .eq('key', RETRY_KEY);
    } catch {
      // Cleanup failures must never fail the test — surface in db reset.
    }
  });

  test('Admin views provider dropdown + retry config + reveals credential + saves retry change @slice-008 @us4', async ({
    page,
  }) => {
    // ----------------------------------------------------------------------
    // Step 1: sign in as admin via the OIDC stub.
    //
    // RUNTIME-DEFERRED: requires the mock-oauth2-server sidecar + Supabase
    // stack to be running so the JWT cookie is minted and the admin gate in
    // the page server component resolves. See file header.
    // ----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _runtimeDeferred = false;
    if (_runtimeDeferred) {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const service = getServiceClient();

      // --------------------------------------------------------------------
      // Step 2: capture baseline max(sequence_id) so the audit-log assertion
      // in step 9 can scope to "rows written AFTER this point" — defence in
      // depth against sibling-worker writes interleaved within the same
      // 1s `testStartInstant` window.
      // --------------------------------------------------------------------
      const { data: baselineRow, error: baselineErr } = await service
        .from('audit_log')
        .select('sequence_id')
        .order('sequence_id', { ascending: false })
        .limit(1)
        .maybeSingle();
      expect(
        baselineErr,
        'service-role audit_log baseline read MUST NOT error',
      ).toBeNull();
      baselineSequenceId =
        typeof baselineRow?.sequence_id === 'number'
          ? baselineRow.sequence_id
          : 0;

      // --------------------------------------------------------------------
      // Step 3: visit /admin/config/providers and verify the page renders.
      // --------------------------------------------------------------------
      await page.goto('/admin/config/providers');
      await expect(
        page.locator('[data-testid="admin-config-providers-page"]'),
        '[data-testid="admin-config-providers-page"] MUST render on /admin/config/providers',
      ).toBeVisible();

      // --------------------------------------------------------------------
      // Step 4: verify the dropdown shows registered adapters. Seed ships
      // exactly one (`football_data_org`); we assert ≥ 1 option whose value
      // matches the known seed id so a future second adapter doesn't break
      // this test.
      //
      // If `[data-testid="config-empty"]` is showing instead (no providers
      // seeded — would mean the migration didn't replay), bail out with a
      // clear assertion failure rather than continue to a broken step 6.
      // --------------------------------------------------------------------
      const emptyBanner = page.locator('[data-testid="config-empty"]');
      const empty = await emptyBanner
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      expect(
        empty,
        'config-empty banner MUST NOT show — the 0077 seed ships providers.football_data_org.*',
      ).toBe(false);

      const dropdown = page.locator('[data-testid="active-provider-select"]');
      await expect(
        dropdown,
        '[data-testid="active-provider-select"] MUST render the registered-adapters dropdown',
      ).toBeVisible();

      const optionValues = await dropdown
        .locator('option')
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLOptionElement).value),
        );
      expect(
        optionValues,
        `active-provider-select MUST include the seeded provider id "${PROVIDER_ID}"`,
      ).toContain(PROVIDER_ID);

      // --------------------------------------------------------------------
      // Step 5: expand the football_data_org section so the per-key inputs +
      // credential reveal button are mounted. The default state opens only
      // the active provider's section, which IS football_data_org per the
      // seed — but we click the toggle defensively in case the seed drifts.
      // --------------------------------------------------------------------
      const section = page.locator(
        `[data-testid="provider-section"][data-provider-id="${PROVIDER_ID}"]`,
      );
      await expect(
        section,
        `provider-section[data-provider-id="${PROVIDER_ID}"] MUST be present`,
      ).toBeVisible();

      const revealButton = page.locator(
        `[data-testid="provider-${PROVIDER_ID}-reveal-credential"]`,
      );
      if (!(await revealButton.isVisible({ timeout: 500 }).catch(() => false))) {
        // Section is collapsed — flip it open.
        await page.click(`[data-testid="provider-${PROVIDER_ID}-toggle"]`);
        await expect(
          revealButton,
          'reveal-credential button MUST be visible after expanding the section',
        ).toBeVisible({ timeout: 5_000 });
      }

      // --------------------------------------------------------------------
      // Step 6: click "Reveal credential" — fires POST /api/admin/config/get-secret,
      // which delegates to the T037 RPC.
      // --------------------------------------------------------------------
      await revealButton.click();

      // --------------------------------------------------------------------
      // Step 7: assert the modal appears.
      // --------------------------------------------------------------------
      const modal = page.locator(
        `[data-testid="provider-${PROVIDER_ID}-credential-modal"]`,
      );
      await expect(
        modal,
        '[data-testid="provider-football_data_org-credential-modal"] MUST be visible after reveal',
      ).toBeVisible({ timeout: 10_000 });

      // --------------------------------------------------------------------
      // Step 8: assert the readonly credential value input is rendered.
      //
      // Note on emptiness: the 0077 seed ships
      //   providers.football_data_org.credentials.api_key = {"secret":true,"value":null}
      // so the cleartext rendered into the input is the empty string. We
      // therefore assert the input is RENDERED (the modal got past the
      // "Loading credential…" branch) but do NOT assert non-empty content —
      // a non-empty assertion would require pre-seeding a fake API key via
      // service-role in beforeEach, which is out of scope for T043's task
      // body ("modal opens with the key value").
      //
      // The input's existence is itself the contract: the RPC returned a
      // non-error envelope, the audit row WAS written (asserted in step 9),
      // and the modal's `value === null` loading branch is gone.
      // --------------------------------------------------------------------
      const valueInput = page.locator(
        `[data-testid="provider-${PROVIDER_ID}-credential-value"]`,
      );
      await expect(
        valueInput,
        '[data-testid="provider-football_data_org-credential-value"] MUST be visible (RPC returned)',
      ).toBeVisible({ timeout: 10_000 });
      const renderedValue = await valueInput.inputValue();
      // Defence in depth: it is a string (the empty string IS allowed; a
      // null/undefined would mean Playwright pulled the value from a
      // non-input element, which would be a contract regression).
      expect(
        typeof renderedValue,
        'credential-value MUST be an <input>, so .inputValue() returns string',
      ).toBe('string');

      // --------------------------------------------------------------------
      // Step 9: verify the forensic admin.config_secret_accessed audit row
      // was written. The T037 RPC INSERTs exactly one row per successful
      // reveal with `new_value = {"key": "<key>"}` — no secret value, no
      // `value` field, no `secret` field in the audit envelope.
      // --------------------------------------------------------------------
      const { data: secretRows, error: secretErr } = await service
        .from('audit_log')
        .select(
          'sequence_id, actor, action, new_value, occurred_at',
        )
        .eq('action', SECRET_ACTION)
        .gt('sequence_id', baselineSequenceId)
        .order('sequence_id', { ascending: false });

      expect(
        secretErr,
        `service-role audit_log read MUST NOT error for action='${SECRET_ACTION}'`,
      ).toBeNull();
      expect(
        secretRows,
        'audit_log secret-access read MUST return a non-null payload',
      ).not.toBeNull();
      expect(
        (secretRows ?? []).length,
        `audit_log MUST carry >= 1 row under action='${SECRET_ACTION}' with sequence_id > ${baselineSequenceId} (the reveal we just triggered)`,
      ).toBeGreaterThanOrEqual(1);

      const newestSecret = (secretRows ?? [])[0];
      expect(
        newestSecret?.actor,
        'admin.config_secret_accessed row MUST carry the admin participant uuid as actor',
      ).toBe(ADMIN1_PARTICIPANT_ID);

      const newValue = newestSecret?.new_value as Record<string, unknown> | null;
      expect(
        newValue,
        'new_value MUST be a JSON object containing the key field',
      ).not.toBeNull();
      expect(
        (newValue ?? {})['key'],
        `new_value->>'key' MUST equal '${CREDENTIAL_KEY}'`,
      ).toBe(CREDENTIAL_KEY);

      // Secret-leak defence: the audit row MUST NOT carry the cleartext or
      // the secret envelope. Per the T037 RPC body, only `{"key": "..."}` is
      // ever INSERTed into new_value.
      expect(
        Object.prototype.hasOwnProperty.call(newValue ?? {}, 'value'),
        'new_value MUST NOT carry a "value" field (no secret leak)',
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(newValue ?? {}, 'secret'),
        'new_value MUST NOT carry a "secret" field (no envelope leak)',
      ).toBe(false);

      // --------------------------------------------------------------------
      // Step 10: close the modal.
      // --------------------------------------------------------------------
      await page.click(
        `[data-testid="provider-${PROVIDER_ID}-credential-close"]`,
      );
      await expect(
        modal,
        'credential modal MUST be hidden after Close',
      ).toBeHidden({ timeout: 5_000 });

      // --------------------------------------------------------------------
      // Step 11: change retry.max_attempts from 3 → 5.
      //
      // Capture the rendered initial value first so a future seed drift
      // (e.g. someone bumps the default to 4) doesn't silently mask a
      // regression in this assertion path.
      // --------------------------------------------------------------------
      const retryInput = page.locator(
        `[data-testid="provider-${PROVIDER_ID}-retry-max-attempts-input"]`,
      );
      await expect(
        retryInput,
        'retry-max-attempts-input MUST be visible',
      ).toBeVisible();

      const initialRetryDisplay = await retryInput.inputValue();
      expect(
        Number.parseInt(initialRetryDisplay, 10),
        `retry-max-attempts initial value MUST equal seed (${INITIAL_RETRY_VALUE})`,
      ).toBe(INITIAL_RETRY_VALUE);

      await retryInput.fill(String(NEW_RETRY_VALUE));

      // Reason + source citation. T039 makes reason required; source
      // citation is optional for non-sensitive provider keys but we fill
      // it anyway for forensic completeness.
      //
      // The reason/source-citation testids aren't stamped per-key on the
      // numeric sections (the inputs are local <textarea>/<input> within
      // the section). We address them via role+name selectors scoped to the
      // section so a parallel section's reason field can't be matched. The
      // safer locator chain: the per-section card carries `data-config-key`
      // on the wrapping div for each segment — we anchor our locator there.
      const retrySegmentCard = page.locator(
        `[data-config-key="${RETRY_KEY}"]`,
      );
      await retrySegmentCard
        .getByRole('textbox', { name: /Reason \(required\)/i })
        .fill(RETRY_REASON);
      // Source citation is rendered as a single <input type="text"> inside
      // the same segment card. getByLabel matches the wrapping <label>.
      await retrySegmentCard
        .getByLabel(/Source citation/i)
        .fill(RETRY_SOURCE);

      // --------------------------------------------------------------------
      // Step 12: save (kicks off Preview → PreviewWarning).
      // --------------------------------------------------------------------
      await page.click(
        `[data-testid="provider-${PROVIDER_ID}-retry-max-attempts-save"]`,
      );

      // --------------------------------------------------------------------
      // Step 13: walk the PreviewWarning branch.
      //
      // `retry.max_attempts` is NOT in the affecting-key list (it doesn't
      // recompute scoring or invalidate any prediction state) so the safe
      // branch is the EXPECTED render. We tolerate both branches in case
      // the affecting list grows: tick the ack-checkbox if present, then
      // click Confirm.
      // --------------------------------------------------------------------
      const preview = page.locator('[data-testid="config-preview-warning"]');
      await expect(
        preview,
        '[data-testid="config-preview-warning"] MUST surface after Save',
      ).toBeVisible({ timeout: 10_000 });

      const ack = page.locator('[data-testid="config-preview-acknowledge"]');
      if (await ack.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await ack.check();
      }
      await page.click('[data-testid="config-preview-confirm"]');

      // --------------------------------------------------------------------
      // Step 14: assert the per-section success toast renders. The toast
      // quotes the new version_id ("Updated to version N") per the
      // ProvidersEditor convention shared with T030/T033.
      // --------------------------------------------------------------------
      const toast = page.locator(
        `[data-testid="provider-${PROVIDER_ID}-retry-max-attempts-toast"]`,
      );
      await expect(
        toast,
        '[data-testid="provider-football_data_org-retry-max-attempts-toast"] MUST be visible after Confirm',
      ).toBeVisible({ timeout: 10_000 });
      const toastText = (await toast.textContent()) ?? '';
      expect(
        toastText,
        'toast MUST quote the new version id in the form "Updated to version N"',
      ).toMatch(/Updated to version \d+/);

      // --------------------------------------------------------------------
      // Step 15: verify the row in `tournament_config` updated to 5. Read
      // via service-role to bypass any RLS quirk; we already know we're
      // admin, but the canonical assertion target is the row itself.
      // --------------------------------------------------------------------
      const { data: cfgRow, error: cfgErr } = await service
        .from('tournament_config')
        .select('key, value')
        .eq('key', RETRY_KEY)
        .maybeSingle();

      expect(
        cfgErr,
        `service-role read of tournament_config['${RETRY_KEY}'] MUST NOT error`,
      ).toBeNull();
      expect(
        cfgRow,
        `tournament_config row '${RETRY_KEY}' MUST exist`,
      ).not.toBeNull();
      // The seed shape is `'5'::jsonb` for integer values; supabase-js
      // returns it as a JS number. Cover both shapes defensively.
      const persistedValue = cfgRow?.value;
      const persistedAsNumber =
        typeof persistedValue === 'number'
          ? persistedValue
          : typeof persistedValue === 'string'
            ? Number.parseInt(persistedValue, 10)
            : NaN;
      expect(
        persistedAsNumber,
        `tournament_config['${RETRY_KEY}'].value MUST equal ${NEW_RETRY_VALUE} after the upsert`,
      ).toBe(NEW_RETRY_VALUE);

      // --------------------------------------------------------------------
      // Step 16: verify the audit_log row + previous_value/new_value
      // contract. The configUpsert RPC writes one row per successful upsert
      // with previous_value=3 and new_value=5 under
      // `action='tournament_config.providers.football_data_org.retry.max_attempts'`.
      // --------------------------------------------------------------------
      const { data: cfgAuditRows, error: cfgAuditErr } = await service
        .from('audit_log')
        .select(
          'sequence_id, actor, action, previous_value, new_value, reason, occurred_at',
        )
        .eq('action', RETRY_ACTION)
        .gte('occurred_at', testStartInstant)
        .order('sequence_id', { ascending: false });

      expect(
        cfgAuditErr,
        `service-role audit_log read MUST NOT error for action='${RETRY_ACTION}'`,
      ).toBeNull();
      expect(
        cfgAuditRows,
        'audit_log retry-key read MUST return a non-null payload',
      ).not.toBeNull();
      expect(
        (cfgAuditRows ?? []).length,
        `audit_log MUST carry >= 1 row under action='${RETRY_ACTION}' since ${testStartInstant} (the 3 → 5 upsert)`,
      ).toBeGreaterThanOrEqual(1);

      const newestRetryRow = (cfgAuditRows ?? [])[0];

      // previous_value/new_value are jsonb; supabase-js may return them as
      // JS numbers, JS strings, or {value: N}-wrapped envelopes depending on
      // how the configUpsert RPC body chooses to serialise them. Be tolerant.
      const prevAsNumber =
        typeof newestRetryRow?.previous_value === 'number'
          ? newestRetryRow.previous_value
          : typeof newestRetryRow?.previous_value === 'string'
            ? Number.parseInt(newestRetryRow.previous_value, 10)
            : NaN;
      const newAsNumber =
        typeof newestRetryRow?.new_value === 'number'
          ? newestRetryRow.new_value
          : typeof newestRetryRow?.new_value === 'string'
            ? Number.parseInt(newestRetryRow.new_value, 10)
            : NaN;
      expect(
        prevAsNumber,
        `audit_log.previous_value MUST equal ${INITIAL_RETRY_VALUE}`,
      ).toBe(INITIAL_RETRY_VALUE);
      expect(
        newAsNumber,
        `audit_log.new_value MUST equal ${NEW_RETRY_VALUE}`,
      ).toBe(NEW_RETRY_VALUE);
      expect(
        newestRetryRow?.actor,
        'audit_log.actor MUST equal the admin participant uuid',
      ).toBe(ADMIN1_PARTICIPANT_ID);
      expect(
        newestRetryRow?.reason,
        'audit_log.reason MUST quote the operator reason',
      ).toBe(RETRY_REASON);
    }
  });
});
