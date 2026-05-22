# Quickstart: Tournament Configuration (Slice 008)

**Feature**: 008-configuration
**Date**: 2026-05-17
**Audience**: Developer or admin verifying the slice end-to-end.

This quickstart assumes Slices 001–007 are deployed.

## 0. Preconditions

- `supabase start` running locally with all migrations through 007 applied.
- Seeded fixture set: at least one admin participant (`is_admin(<your_uuid>) = true`), several non-admin participants, several matches with future kickoffs, a few submitted predictions, some completed score_records.
- `app.environment_label` GUC set to `"local"` (Supabase project config).
- `app.config_export_secret` GUC set to a random string.

## 1. Apply Slice 008 migration

```bash
supabase db push
```

Verify the structural pieces landed:

```sql
-- 1a. tournament_config has new columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tournament_config'
ORDER BY ordinal_position;
-- Expect: key, value, value_type, updated_at, updated_by, version_id

-- 1b. tournament_config_versions exists with monotonic version_id
SELECT max(version_id) FROM public.tournament_config_versions;
-- Expect: > 0 (initial seed rows produced by the migration)

-- 1c. Defaults seeded for new keys
SELECT key, value FROM public.tournament_config
WHERE key IN (
  'eligibility.allowed_domains',
  'locking.match_prediction_window_minutes',
  'scoring.match_points.exact',
  'scoring.tie_breaker_order',
  'providers.active',
  'tournament.phase.current'
)
ORDER BY key;
-- Expect: all present with documented defaults from data-model.md catalog

-- 1d. RLS posture
SELECT polname, polcmd
FROM pg_policy
WHERE polrelid = 'public.tournament_config'::regclass;
-- Expect: tournament_config_authenticated_read, tournament_config_no_direct_write

-- 1e. REVOKE took effect
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'tournament_config_versions'
  AND privilege_type IN ('UPDATE', 'DELETE');
-- Expect: 0 rows.
```

## 2. Verify consumer-slice migrations did not regress prior behavior

```sql
-- 2a. Slice 001's predicate still works against the (newly-config-backed) domain list
SELECT public.is_eligible_nortal_participant('<a-nortal-user-uuid>');
-- Expect: true

SELECT public.is_eligible_nortal_participant('<a-non-nortal-user-uuid>');
-- Expect: false

-- 2b. Slice 003's lock predicate still works with config-driven window
SELECT public.is_prediction_locked('<a-future-match-uuid-> 90min away>');
-- With default window (60min): Expect: false (open)

-- 2c. Slice 005's scoring still works with config-driven values
-- (Run a score recalc via Slice 006 RPC; verify points sum correctly.)
SELECT public.admin_recalc_triggered_now('Quickstart Slice 008 verification');
```

## 3. Admin UI smoke (User Story 1 — domain list)

Sign in as admin in browser. Visit `/admin/config/domains`.

1. Verify the current domain list renders (e.g., `nortal.com`).
2. Add a new domain `example.nortal.com` via the form. Submit with `reason = "Adding acquired entity"`.
3. Confirm a green toast appears with the new version_id.
4. Within 1 minute, sign in as a fresh user from `example.nortal.com` in an incognito window — expect access GRANTED.
5. Remove `example.nortal.com`. Confirm the warning prompt appears listing affected participants (those who signed in during step 4). Confirm the prompt requires explicit confirmation.
6. After confirm: within 1 minute, sign-in attempts from `example.nortal.com` are DENIED.

Audit trail check:
```sql
SELECT sequence_id, action, actor, reason, source_citation, previous_value, new_value
FROM public.audit_log
WHERE action = 'tournament_config.eligibility.allowed_domains'
ORDER BY sequence_id DESC LIMIT 5;
-- Expect: 2 rows (add, remove) with reason + previous/new values
```

Version history check:
```sql
SELECT version_id, change_kind, previous_value, new_value, created_at
FROM public.tournament_config_versions
WHERE key = 'eligibility.allowed_domains'
ORDER BY version_id DESC LIMIT 5;
-- Expect: rows mirroring the audit_log entries plus the initial_seed row.
```

## 4. Admin UI smoke (User Story 2 — lock window)

Visit `/admin/config/locking`. Change the window from 60 to 90 minutes.

1. The form shows an "Affecting data" preview: list of matches that would be re-classified from open to locked (and vice versa).
2. Confirm. Within 1 minute, a participant with a 75-minute-away match attempts to submit a prediction — works (under 90-min rule).
3. Change to 0. Expect rejection: `WCG02` validation error in toast.
4. Change to 45. Confirm. Verify a participant with a 50-minute-away match can still submit (open).

## 5. Admin UI smoke (User Story 3 — scoring + tie-breaker)

Visit `/admin/config/scoring`. Change `scoring.match_points.exact` from 10 to 15.

1. Confirm "Affecting data" preview: shows count of `score_records` rows that would change on recalc.
2. After commit: leaderboard surface (Slice 005) shows a "re-score pending" banner.
3. Trigger recalc via `/admin/recalc` (Slice 006). Verify points recompute under the new value.
4. Audit trail: confirm `tournament_config.scoring.match_points.exact` row + the subsequent `admin.recalc_triggered` row.

Re-order tie-breakers: drag `final_pick_correct` above `exact_match_count`. Confirm. Verify leaderboard rendering reflects new order within 1 minute.

## 6. Admin UI smoke (User Story 4 — providers, admin roles, phases)

### Provider switch

Visit `/admin/config/providers`. Switch active provider (if a second adapter is seeded). Verify next scheduled sync uses the new adapter via Supabase logs / `audit_log.action = 'provider.sync_no_changes'` rows referencing the new provider id.

### Admin role grant

Visit `/admin/config/admin-roles`. Grant admin role to a non-admin participant. Submit with reason + source citation.

```sql
SELECT * FROM public.admin_roles WHERE participant_id = '<target-uuid>';
-- Expect: row with revoked_at IS NULL
```

```sql
SELECT * FROM public.tournament_config_versions
WHERE key = 'admin_roles.<target-uuid>'
ORDER BY version_id DESC LIMIT 1;
-- Expect: change_kind = 'admin_upsert', linked audit_log_id present
```

Sign in as the newly-promoted participant in incognito — `/admin/*` routes are accessible.

### Tournament phase

Change `tournament.phase.current` from `pre_tournament` to `group_stage`. Within 1 minute, UI surfaces conditioned on the phase update accordingly (e.g., Slice 004's final-prediction form may become locked if logic depends on phase).

## 7. Rollback (User Story 5)

1. Visit `/admin/config/history`. See the list of recent versions ordered by version_id DESC.
2. Select a prior version of `scoring.match_points.exact` (the version where it was 10). Click "Rollback to this version."
3. Provide `reason = "Reverting test change"`.
4. After confirm: within 1 minute, `tournament_config.scoring.match_points.exact` reads as 10 again.
5. Audit trail:
```sql
SELECT sequence_id, action, reason
FROM public.audit_log
WHERE action = 'tournament_config.scoring.match_points.exact'
ORDER BY sequence_id DESC LIMIT 3;
-- Expect: original change, then current change, then rollback (with reason "Rolling back...").
```
6. Version history:
```sql
SELECT version_id, change_kind, parent_version_id
FROM public.tournament_config_versions
WHERE key = 'scoring.match_points.exact'
ORDER BY version_id DESC LIMIT 5;
-- Expect: most-recent row has change_kind = 'admin_rollback' with parent_version_id pointing at the version being restored.
```

## 8. Concurrent edit handling

Open `/admin/config/scoring` in TWO admin browser tabs. In both, edit `scoring.final_pick_points`. Submit Tab A first. Tab B's submit fails with a clear error mentioning concurrent edit (ERRCODE `WCG01`). UI offers "Reload."

```sql
SELECT count(*) FROM public.tournament_config_versions WHERE key = 'scoring.final_pick_points';
-- Expect: exactly ONE new row, not two.
```

## 9. Secret key access

```sql
SET request.jwt.claims = '{"sub": "<admin-uuid>"}';
SELECT public.admin_config_get_secret('providers.football_data_org.credentials.api_key');
-- Expect: {"secret": true, "value": "<the actual key>"}

-- Check audit row was written
SELECT sequence_id, action, actor
FROM public.audit_log
WHERE action = 'admin.config_secret_accessed'
ORDER BY sequence_id DESC LIMIT 1;
-- Expect: row with admin uuid

-- Non-admin attempt
SET request.jwt.claims = '{"sub": "<non-admin-uuid>"}';
SELECT public.admin_config_get_secret('providers.football_data_org.credentials.api_key');
-- Expect: ERROR WCG07
```

## 10. Import / export

### Export

Visit `/admin/config/import-export`. Click "Export configuration." Browser downloads `world-cup-madness-config-local-<timestamp>.json`.

Inspect the file:
- `schema_version: "1.0.0"`
- `current_config` contains all keys; secrets redacted to `{secret: true, value: null}`
- `version_history` contains all `tournament_config_versions` rows
- `signature` is non-empty hex

### Import

Modify a value in the exported JSON (e.g., change `scoring.match_points.exact` from 10 to 12). Save.

In the same UI page, click "Import" and upload the modified file. Provide a reason.

Expected:
- If signature is intact (you can re-sign by running the export against the modified body — provide a small dev utility), expect: success, all keys imported, `admin.config_imported` audit row written.
- If signature was modified or omitted: expect rejection (`WCG08`).

## 11. Fail-closed behavior

Simulate config-store unavailability by REVOKEing SELECT temporarily:
```sql
REVOKE SELECT ON public.tournament_config FROM authenticated;
```

In browser as participant, attempt to submit a prediction. Expect:
- The action fails (because `is_prediction_locked` raises `WCG06`).
- An audit row `system.config_unavailable` is written.
- An alert is enqueued in `notification_dispatch_queue`.

Restore:
```sql
GRANT SELECT ON public.tournament_config TO authenticated;
```

## 12. Audit-failure webhook delivery (closes Slice 007's SC-007)

Set up a test webhook receiver (e.g., `https://webhook.site/<your-bin>`).

```sql
SELECT public.admin_config_upsert(
  'notifications.audit_failure_webhook_url',
  to_jsonb('https://webhook.site/<your-bin>'::text),
  (SELECT version_id FROM public.tournament_config WHERE key = 'notifications.audit_failure_webhook_url'),
  'Wire up audit-failure webhook'
);
```

Inject a synthetic audit-write failure (e.g., temporarily REVOKE INSERT on `audit_log` and attempt an action that audits). Within 5 minutes:
- The webhook receiver receives a POST with the locked envelope schema.
- Signature is present and matches `notifications.audit_failure_webhook_secret` if set.

## 13. Constitutional checks

- **Principle II (Security)**: REVOKE statements on `tournament_config_versions` mirror `audit_log`; secrets redacted via `key_is_secret`; admin gating at every RPC body.
- **Principle III (Rules Outside the UI)**: All consumer slices read values via `config_read`, not from UI state.
- **Principle V (Auditability)**: Every config write produces an `audit_log` row + `tournament_config_versions` row in the same transaction.
- **Principle VIII (Extensibility & Configuration)**: Every previously-hardcoded value is now in `tournament_config` and admin-mutable.
- **Principle X (Vertical Slice Delivery)**: This slice is the cross-cutting consolidation; all prior slices' configuration touchpoints are migrated atomically.
- **Principle XI (Regression-Gated)**: Migration ALTER FUNCTION steps are individually smoke-tested mid-migration.

## 14. Regression smoke matrix

After the migration:
- Slice 001 sign-in: still works → `access.granted` audit row.
- Slice 002 sync: still works → `match.updated` audit rows.
- Slice 003 prediction submit: still works → `prediction.created` audit rows.
- Slice 004 final prediction: still works → `final_prediction.created` audit rows.
- Slice 005 recalc: still works → `score_record.*` audit rows.
- Slice 006 admin RPCs: still work → `admin.*` audit rows.
- Slice 007 audit_search: still works → returns config-change rows under new `tournament_config.*` namespace.

If any of the above fails, the migration's ALTER FUNCTION step is at fault — review the migration log for the failing smoke-check.

---

## Quickstart deltas (Slice 008)

**T073 verification — 2026-05-21**: **RUNTIME-DEFERRED** — Docker daemon down throughout slice 008 authoring. The 14-step quickstart was NOT run end-to-end against a live local stack.

Deltas inferred from the artifact-complete state (validation pending the consolidated runtime sweep that closes the deferred items across slices 005-008):

1. **Step 0 preconditions** — `app.config_export_secret` is documented as a "random string"; the production deployment runbook (T075) needs to add: this GUC MUST be set at the Supabase project level (env var → role-level `SET`) before T052 export will succeed. Empty/unset surfaces as `WCG08` ("app.config_export_secret GUC is not configured; refusing to export").

2. **Step 1 namespace catalog** — confirmed seeded by slot 0077 (lines 280-390). 24+ keys across `eligibility.*`, `locking.*`, `scoring.*`, `providers.*`, `tournament.*`, `notifications.*`, `leaderboard.*`, `audit.retention.*`. Forward-compat keys (unrecognized prefixes) pass the import validator backstop without error.

3. **Step 5 import-export round trip** — the canonical signature form is `(envelope - 'signature')::text::bytea` per **D-T052-A** (contract referenced a non-existent `canonical_jsonb_to_bytea` helper). The bash signer `scripts/config/sign-import.sh` uses `jq -c -S '. | del(.signature)'`, which matches Postgres jsonb's text form in the vast majority of cases. Known divergence risks: scientific-notation numbers, certain unicode escapes — documented in the signer's header.

4. **Step 8 retention policy** — **D-T046-A** semantics: `audit.retention.policy_kind='keep'` (slice 007 default) yields `_config_rollback_retention_horizon() = '-infinity'::timestamptz` — no rollback ever raises WCG04. Flipping to `'prune'` activates `now() - audit.retention.tournament_end_buffer_months` horizon. T050 pgTAP exercises both branches.

5. **Step 9 admin-roles** — **D-T038-A**: slice 006 ships the `admin_roles` table + AFTER INSERT/UPDATE trigger that auto-writes `admin.role_granted`/`role_revoked` audit rows; it does NOT ship `admin_grant_admin_role`/`admin_revoke_admin_role` SPs. T038's `admin_config_grant/revoke_admin_role` direct-INSERT/UPDATE the admin_roles table (trigger writes the audit row); LOCKED parameter signatures preserved verbatim.

6. **Step 11 webhook delivery** — **D-T063-B**: the pg_net response-side trigger (which finalizes `delivered_at` on 2xx and `failed_at` on 4xx) is OUT of migration scope; operators wire it post-deployment per `docs/runbooks/audit-write-failure.md` section (f) (added by T067). Until then, the `attempts` counter still increments and exponential backoff still fires, but `delivered_at` remains NULL until the operator-wired finalizer lands.

7. **Step 12 fail-closed** — **D-T069-A**: the `system.config_unavailable` action label referenced in the quickstart is NOT emitted by any writer in the shipped migration set. The fail-closed paths (T014/T015 ALTER FUNCTIONs) trap `WCG06` to safe defaults (FALSE eligibility, TRUE locking) without writing an audit row. A follow-up slice would need to add an `enqueue_alert('config_unavailable', ...)` call in those trap blocks, OR add a separate audit writer.

8. **Step 14 consumer migrations** — T070 + T071 + T072 are the on-disk pgTAP/Playwright/catalog assertions that codify the regression. Plan(6) pgTAP `consumer_migrations.sql` + 7-step Playwright `config-cross-slice-regression.spec.ts` (each step uses the catalog-verified action label) + extended slice 007 catalog with 3 new labels (`admin.config_exported`, `admin.config_imported`, `admin.config_secret_accessed`).

**Conclusion**: artifact-complete; runtime verification queued for the consolidated post-merge sweep that also clears the slice 005-007 Docker-deferred items.
