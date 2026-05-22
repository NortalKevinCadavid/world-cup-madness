---
description: "Task list for slice 008 — Tournament Configuration"
---

# Tasks: Tournament Configuration (Slice 008)

**Input**: Design documents under `specs/008-configuration/`

**Prerequisites**: plan.md, spec.md (with 4-bullet Clarifications section from 2026-05-17), research.md (R-001..R-014), data-model.md, contracts/{tournament-config.schema.md, admin-config-rpcs.write.md, config-version-history.read.md, config-import.write.md, audit-failure-webhook.outbound.md}, quickstart.md.

**Cross-slice dependencies**: Slices 001–007 MUST be deployed. This slice MIGRATES the bodies of `is_eligible_nortal_participant` (Slice 001), `is_prediction_locked` (Slice 003), `compute_match_score` (Slice 005), and the leaderboard view (Slice 005) to read from `tournament_config`. Slice 006's `is_admin(uuid)` and `admin_grant_admin_role` / `admin_revoke_admin_role` SP signatures are LOCKED and used as wrappers — no schema change. Slice 007's `audit_log` is the regulatory record for every config write; `tournament_config_versions` is the operational record linked via `audit_log_id`.

**Tests requested**: YES — Constitution Principle IX (TDD via BDD) + XI (Regression-Gated). Every non-trivial behavior gets a pgTAP-style SQL test or a Playwright browser test.

**Self-contained task convention** (per user memory `feedback_speckit_tasks_self_contained`): every task is dispatchable to its own subagent. Each task carries explicit absolute Windows paths, contract references, and acceptance signals.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel
- **[Story]**: US1 / US2 / US3 / US4 / US5 (omitted for Setup / Foundational / Polish)

## Path Conventions

- Next.js app: `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\`
- Supabase migrations: `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\`
- Supabase SQL tests: `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\`
- Playwright tests: `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\`
- Runbooks: `C:\Users\kevin.cadavid\Documents\world-cup-madness\docs\runbooks\`

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 [P] Create the migration file `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\migrations\0077_configuration.sql` (D-030: renamed from spec's `008_configuration.sql` to 4-digit slot 0077 to match project convention; slice 007 last slot is 0076) as a UTF-8/LF file with a header comment block: `-- Slice 008 Tournament Configuration — final consolidated config surface: tournament_config_versions, admin_config_* RPCs, consumer-slice migrations, webhook delivery (closes Slice 007 SC-007).` This file will be appended to throughout Phase 2.

- [X] T002 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\` and a README inside it describing pgTAP fixture conventions used across the slice (mirrors Slice 007's testing layout).

- [X] T003 Verify the Postgres extensions `pgcrypto`, `pg_cron`, and `pg_net` are enabled in `supabase/config.toml` (or via `CREATE EXTENSION IF NOT EXISTS ...` at the top of the migration). Reference: `specs/008-configuration/plan.md` Technical Context "Primary Dependencies > Postgres extensions". If any extension is missing, prepend `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pg_net;` to `0077_configuration.sql`. **Verified 2026-05-21**: pgcrypto enabled in slot 0001; pg_cron + pg_net enabled in slot 0018 (`WITH SCHEMA extensions`); pg_net re-asserted in slot 0059. No prepend required — verification recorded as a comment block in `0077_configuration.sql` header.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete. This is the largest foundational phase in the project because Slice 008 IS the cross-cutting consolidation.

### 2a. DB schema (extends `tournament_config`; creates `tournament_config_versions`)

- [X] T004 Append to `supabase/migrations/008_configuration.sql` the additive `ALTER TABLE public.tournament_config ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'jsonb', ADD COLUMN IF NOT EXISTS updated_by uuid NULL, ADD COLUMN IF NOT EXISTS version_id bigint NULL;` plus the CHECK constraint on `value_type` (11 allowed values from `data-model.md` §1). Add `CREATE INDEX IF NOT EXISTS tournament_config_updated_at_idx ON public.tournament_config (updated_at DESC);` and `REVOKE DELETE ON public.tournament_config FROM authenticated, anon, service_role;`. Reference: `contracts/tournament-config.schema.md` DDL §1.

- [X] T005 Append to the migration the `CREATE TABLE IF NOT EXISTS public.tournament_config_versions (...)` statement with all 12 columns from `contracts/tournament-config.schema.md` DDL §2: `version_id bigserial PK, key, previous_value, new_value, change_kind, actor, reason, source_citation, audit_log_id (FK to audit_log), parent_version_id (self-FK), acknowledge_token_used, created_at`. Add the three CHECK constraints (`change_kind` enum, `previous_value` non-null-except-seed, `parent_version_id` only-on-rollback). Add the three indexes (`key_version_idx`, `created_at_idx`, `rollback_idx`). Add `REVOKE UPDATE, DELETE ON public.tournament_config_versions FROM authenticated, anon, service_role;` and `GRANT USAGE ON SEQUENCE ... TO authenticated, anon, service_role;`.

- [X] T006 [P] Append to the migration the helper function `public.key_is_secret(p_key text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_key LIKE 'providers.%.credentials.%'; $$;`. Reference: `contracts/tournament-config.schema.md` §3.

- [X] T007 Append to the migration the `public.config_read(p_key text, p_default jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public` body per `contracts/tournament-config.schema.md` §4. Body: SELECT into v from `tournament_config WHERE key=p_key`; on NULL, if `p_default IS NULL` raise `WCG06` else return `p_default`; else return `v`. GRANT EXECUTE to `authenticated, service_role`. This is the fail-closed helper referenced by Clarification Q3.

- [X] T008 Append to the migration `ENABLE ROW LEVEL SECURITY` on both `tournament_config` and `tournament_config_versions`. Create the 4 RLS policies from `contracts/tournament-config.schema.md` §3: `tournament_config_authenticated_read` (admin OR not key_is_secret), `tournament_config_no_direct_write` (false), `tournament_config_versions_admin_read` (is_admin), `tournament_config_versions_no_direct_write` (false).

- [X] T009 [P] Append to the migration the `notify_tournament_config_change()` trigger function + `AFTER INSERT OR UPDATE` trigger on `public.tournament_config`. Body: `PERFORM pg_notify('tournament_config_changed', NEW.key); RETURN NEW;`. Reference: R-009 in `research.md` + `contracts/tournament-config.schema.md` §5.

- [X] T010 Append to the migration `INSERT ... ON CONFLICT (key) DO NOTHING` seeds for the full configuration namespace catalog from `data-model.md` "Configuration namespace catalog (FROZEN at slice close)" table — all ~30 keys with their default values and value_type. Include the consolidating row `eligibility.allowed_domains = '["nortal.com"]'::jsonb`. Also INSERT into `tournament_config_versions` an `initial_seed` row for each newly-inserted key (so `tournament_config.version_id` can be backfilled in the same migration step).

### 2b. Core RPC family (shared by every user story)

- [X] T011 Append to the migration the `public.admin_config_upsert(p_key text, p_value jsonb, p_expected_version_id bigint, p_reason text, p_source_citation text DEFAULT NULL, p_acknowledge_token uuid DEFAULT NULL) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public` body per `contracts/admin-config-rpcs.write.md` "Behavior — admin_config_upsert" section. Implement: is_admin check (raise WCG07), per-key + universal validation (raise WCG02), `pg_advisory_xact_lock(hashtext(p_key))`, expected_version verification (raise WCG01), acknowledge-token check via `admin_config_preview` (raise WCG05), atomic 3-write (audit_log → tournament_config_versions → tournament_config). GRANT EXECUTE to `authenticated`.

- [X] T012 Append to the migration the `public.admin_config_preview(p_key text, p_value jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public` body per `contracts/admin-config-rpcs.write.md` "Behavior — admin_config_preview". Implement per-key impact analysis: domain-removal participant count, lock-window match re-classification, score-bound predictions exceeding bound, scoring-change score_records count, provider-active un-confirmed match count, admin-role-revocation open-session count. Issue `acknowledge_token` (HMAC-signed, 5-min TTL) when `affecting=true`. Need helpers `public.issue_acknowledge_token(p_key, p_value)` and `public.verify_acknowledge_token(p_token, p_key, p_value)` — implement both using pgcrypto's hmac() against `app.config_acknowledge_secret` GUC.

- [X] T013 [P] Append to the migration: pgTAP-style smoke fixture as a separate `DO $$ BEGIN ... END $$;` block that asserts each consumer predicate produces the SAME result before AND after the upcoming ALTER FUNCTION steps. Capture pre-migration outputs into a temp table; after T014-T016 ALTERs, re-run and compare. If any divergence, RAISE EXCEPTION halts the entire migration. This is the regression gate per Principle XI.

### 2c. Consumer-slice ALTER FUNCTION migrations (R-014)

- [X] T014 Append to the migration: `CREATE OR REPLACE FUNCTION public.is_eligible_nortal_participant(p_user_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public` body that reads `public.config_read('eligibility.allowed_domains', NULL)` (NULL = fail-closed per Clarification Q3), parses the JSON array, lower-cases + trims, and checks the participant's domain membership. Signature MUST be preserved exactly (Slice 001's tests depend on it). Reference: research R-006 + R-014.

- [X] T015 Append to the migration: `CREATE OR REPLACE FUNCTION public.is_prediction_locked(p_match_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public` body that reads `public.config_read('locking.match_prediction_window_minutes', NULL)` (NULL = fail-closed), casts to interval, and checks if `now() >= matches.kickoff_at - <window>`. Signature preserved exactly. Reference: R-014 row "Slice 003 lock window".

- [X] T016 Append to the migration: `CREATE OR REPLACE FUNCTION public.compute_match_score(p_prediction_home int, p_prediction_away int, p_actual_home int, p_actual_away int) RETURNS int LANGUAGE plpgsql STABLE SET search_path = public` body that reads three keys via `config_read` (`scoring.match_points.exact`, `scoring.match_points.correct_outcome`, `scoring.match_points.incorrect`) and applies the standard 10/5/0 logic with config-driven values. Signature preserved. Reference: R-014 row "Slice 005 scoring values". Also `ALTER VIEW` (or DROP + CREATE) the leaderboard view to read `scoring.tie_breaker_order` from config and dynamically construct ORDER BY clauses — implement via a SECURITY DEFINER `STABLE` function returning the ordering keys rather than a literal view body if dynamic ORDER BY proves too complex.

### 2d. Shared frontend foundation

- [X] T017 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\lib\config-client.ts`. Export typed RPC wrappers: `configUpsert(...)`, `configPreview(...)`, `configRollback(...)`, `configGetSecret(...)`, `configVersionHistory(...)`. Each wrapper surfaces `error.code` (WCG01..WCG08) unchanged to the caller. Also implement a per-process LRU cache (Map<key, {value, cached_at}>) with 60-second TTL per R-009. Subscribe to Postgres `LISTEN tournament_config_changed` via a long-lived Supabase client and invalidate the cache on receipt. If running in an Edge runtime, skip the LISTEN subscription (Edge processes are short-lived; cache is empty per request).

- [X] T018 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\lib\config-validators.ts`. Export zod schemas keyed by `tournament_config.key`. Per-key validators: `eligibility.allowed_domains` → `z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i))`, `locking.match_prediction_window_minutes` → `z.number().int().min(1).max(1440)`, `scoring.match_points.*` + `scoring.final_pick_points` → `z.number().int().min(0).max(1000)`, `scoring.score_upper_bound` → `z.number().int().min(0).max(999)`, `scoring.tie_breaker_order` → `z.array(z.enum(['points_total','exact_match_count','final_pick_correct','earliest_submission']))`, `tournament.phase.current` → `z.enum(['pre_tournament','group_stage','knockout','completed'])`, `providers.active` → `z.string().min(1)`, etc. Export a single `validateConfigValue(key, value)` dispatcher.

- [X] T019 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\lib\hmac.ts`. Export `signEnvelope(body: object, secret: string): string` and `verifyEnvelope(envelope: {…, signature: string}, secret: string): boolean` using Web Crypto SubtleCrypto's HMAC-SHA256. Bodies are canonicalized via key-sorted JSON.stringify before hashing.

- [X] T020 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\ConfigField.tsx` as a client component (`'use client'`). Props: `{ valueType: string; value: unknown; onChange: (newValue: unknown) => void; readOnly?: boolean; }`. Render appropriate input by `valueType`: text → input, integer → number input with step=1, boolean → checkbox, array → dynamic add/remove list with text inputs, object → JSON textarea with syntax-highlighting, timestamptz → datetime-local input, jsonb → raw JSON textarea. Include inline zod validation errors from T018's dispatcher.

- [X] T021 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\PreviewWarning.tsx` as a client component. Props: `{ preview: { affecting: boolean; summary: string; sample: jsonb; acknowledge_token: string | null }; onConfirm: (token: string) => void; onCancel: () => void; }`. Render: if `affecting=false`, render a green "Safe to apply" banner with a single Confirm button (passes null to onConfirm). If `affecting=true`, render an amber/red warning panel listing the summary text + sample rows in a `<details>` block + a "I understand the consequences" checkbox + a Confirm button that becomes enabled only after the checkbox is checked. Passes the `acknowledge_token` to onConfirm.

- [X] T022 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\VersionTimeline.tsx` as a server component. Props: `{ versions: ConfigVersion[]; onRollback: (versionId: number) => void }`. Render a vertical timeline of versions with: version_id, change_kind badge, actor display name, reason, previous_value → new_value diff (collapsed JSON), created_at in tournament timezone. Each row has a "Rollback to this" button enabled only on non-rollback rows (Cannot roll back a rollback row directly — must select the predecessor).

- [X] T023 [P] Create the tabbed landing page `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\page.tsx`. Server component: check `is_admin(auth.uid())` via RPC; if false, write `admin.access_denied` audit row (entity_type='admin_config_page') and `notFound()`. Render a vertical sidebar with links to: /admin/config/domains, /locking, /scoring, /providers, /admin-roles, /phases, /retention, /history, /import-export. Main content area renders a dashboard summary: count of recent versions (last 7 days), count of pending acknowledge tokens, link to latest export.

### 2e. Foundational tests (run after migration completes)

- [X] T024 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\upsert_authorization.sql`. Test plan: (1) SET LOCAL claim to non-admin uuid; call `admin_config_upsert` → expect WCG07. (2) Verify `admin.access_denied` audit row written with entity_type='admin_config_upsert'. (3) SET LOCAL claim to admin uuid; call with valid args; expect bigint return.

- [X] T025 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\upsert_concurrency.sql`. Test plan: capture current version_id of key X. In transaction A: call `admin_config_upsert('X', new_value, current_version_id, 'reason')`. In transaction B (separate session): call with the SAME `current_version_id` — expect WCG01. Confirm only ONE row added to `tournament_config_versions` for key X. Reference Clarification Q2.

- [X] T026 [P] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\upsert_validation.sql`. Test plan: Call upsert with invalid values per key — `locking.match_prediction_window_minutes` = -5 (negative integer) → WCG02; `eligibility.allowed_domains` = "not-an-array" → WCG02; `scoring.match_points.exact` = "abc" → WCG02; unknown key 'foo.bar' → WCG03; empty reason → WCG02.

**Checkpoint**: After T004-T026, the DB foundation, RPC core, consumer-slice migrations, shared frontend foundation, and basic regression tests are complete. User-story phases can begin.

---

## Phase 3: User Story 1 — Approved corporate domains (Priority: P1) 🎯 MVP

**Goal**: Admin can add/remove `eligibility.allowed_domains` entries. New eligibility evaluations in Slice 001 honor changes within 1 minute.

**Independent Test**: Add new domain via UI → fresh signup from that domain succeeds within 60s. Remove domain (with affecting-data warning) → fresh signup from that domain denied within 60s. Both changes audited.

- [X] T027 [US1] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\domains\page.tsx`. Server component: gate via `is_admin`; read current `eligibility.allowed_domains` value + version_id via `configClient`. Render: a list of current domains with per-row Remove button + an Add-new input + Reason textarea + Source-citation input. On Remove: call `configPreview('eligibility.allowed_domains', <new array without this>)` → render `<PreviewWarning>` → on confirm, call `configUpsert` with the returned token. On Add: same flow but without preview if `affecting=false`. Use the shared `<ConfigField valueType="array" />` for the domain list editor (alternative). All errors (WCG01/02/05/06/07) rendered as inline toasts.

- [X] T028 [P] [US1] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\config-domains.spec.ts`. Test plan as admin: (1) Visit /admin/config/domains. (2) Add `example.nortal.com` with reason "Onboarding new entity". (3) Assert toast "Updated to version X". (4) Wait 60s OR detect LISTEN/NOTIFY-driven cache invalidation. (5) Sign in as a fresh user with `@example.nortal.com` in a second browser context — expect access GRANTED. (6) Return to /admin/config/domains. Remove the just-added domain. (7) Assert PreviewWarning panel displays with the participant count (≥ 1 from step 5). (8) Check the acknowledgment box; confirm. (9) Wait 60s. (10) Sign-in attempt from the same domain — expect access DENIED. (11) Confirm `audit_log` has 2 new rows under `action='tournament_config.eligibility.allowed_domains'` with previous/new values.

- [X] T029 [P] [US1] Create pgTAP test `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\eligibility_preview_affecting.sql`. Test plan: seed 3 participants with domains [a, b, c]. Call `admin_config_preview('eligibility.allowed_domains', '["a","b"]'::jsonb)` (removes c). Expect: `affecting=true`, `summary` mentioning "1 affected participant", `sample` jsonb array containing the c-domain participant. Verify a non-removal change (rearranging the same domains) returns `affecting=false`.

**Checkpoint**: US1 fully functional. Admins can manage the corporate domain list with affecting-data safety.

---

## Phase 4: User Story 2 — Match-prediction lock window (Priority: P1)

**Goal**: Admin can change `locking.match_prediction_window_minutes`. Slice 003 honors within 1 minute.

**Independent Test**: Change from 60 → 90 min; participant with 75-min-away match can submit (previously blocked under 60). Change to invalid value (0) rejected with WCG02.

- [X] T030 [US2] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\locking\page.tsx`. Server component: gate via `is_admin`. Read current `locking.match_prediction_window_minutes` + version_id. Render: a single integer input (60-min default visible), Reason textarea, Source-citation. On submit: call `configPreview` to surface affecting matches (those whose `kickoff_at` falls in the changed window), render `<PreviewWarning>`, then `configUpsert`. Validation: client-side via T018 zod schema (1..1440); server enforces same via WCG02.

- [X] T031 [P] [US2] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\config-locking.spec.ts`. Test plan as admin: seed a match with kickoff exactly 75 minutes from now. (1) Change window from 60 to 90; preview warning shows the match would change classification; confirm. (2) Wait 60s. (3) As a participant, attempt to submit a prediction for that match → expect SUCCESS (under new 90-min rule, 75 min ≥ 60 min after lock-at, so still open). (4) Change window to 0 → expect immediate validation error toast (WCG02) WITHOUT submitting. (5) Change to 30 → preview confirms; confirm; then as participant attempt same submission → expect lock-error (WCM-family ERRCODE from Slice 003).

- [X] T032 [P] [US2] Create pgTAP test `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\locking_window_consumer_check.sql`. Test plan: capture `is_prediction_locked(match_id)` result for a match 75 min away under default config. Upsert `locking.match_prediction_window_minutes` to 90. Call `is_prediction_locked` again on same match — assert result FLIPPED appropriately (was locked under 90, now not under 60... or vice versa per setup). This verifies Slice 003's ALTER FUNCTION migration (T015) reads from config.

**Checkpoint**: US2 fully functional with regression-gated consumer behavior.

---

## Phase 5: User Story 3 — Scoring values + tie-breaker order (Priority: P1)

**Goal**: Admin can change scoring values and tie-breaker order. Leaderboard shows "re-score pending" banner; recalc applies new values.

**Independent Test**: Change `scoring.match_points.exact` from 10 to 15 → leaderboard banner appears → admin triggers recalc (Slice 006) → all points recompute with 15.

- [X] T033 [US3] Create `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\app\admin\config\scoring\page.tsx`. Server component: gate via `is_admin`. Read 6 keys at once: `scoring.match_points.exact`, `match_points.correct_outcome`, `match_points.incorrect`, `final_pick_points`, `score_upper_bound`, `tie_breaker_order`. Render: 4 numeric inputs for the point values, 1 integer for upper bound, 1 drag-and-drop reorderer for tie-breaker (use `react-dnd` if needed — verify dep; otherwise simple up/down buttons). Each section has its own Save button (one upsert per key). After ANY scoring-value change, the leaderboard surface (Slice 005) must show "re-score pending" — that flag is computed live from `tournament_config_versions` showing scoring keys modified after the most recent `admin.recalc_triggered` event (admin UI fetches this).

- [X] T034 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\config-scoring.spec.ts`. Test plan as admin: (1) Change `scoring.match_points.exact` from 10 to 15 with reason "Test scoring adjustment". (2) Preview shows the count of `score_records` that would change. (3) Confirm. (4) Visit /leaderboard — expect "Re-score pending" banner (Slice 005 conditional rendering). (5) Trigger `/admin/recalc` (Slice 006). (6) Visit /leaderboard — banner gone; points reflect new values. (7) Verify `audit_log` has rows: `tournament_config.scoring.match_points.exact` then `admin.recalc_triggered` then `score_record.update` (multiple).

- [X] T035 [P] [US3] Create Playwright test `C:\Users\kevin.cadavid\Documents\world-cup-madness\apps\web\tests\playwright\config-tiebreaker.spec.ts`. Test plan: (1) Visit /admin/config/scoring. (2) Drag `final_pick_correct` above `exact_match_count` in tie-breaker order. Save. (3) Wait 60s. (4) Visit /leaderboard — assert participant ordering reflects the new tie-breaker priority (need seed data where two participants are tied on points_total + exact_match_count but differ on final_pick_correct — verify the one with more final picks correct is now ranked higher). (5) Confirm audit row `tournament_config.scoring.tie_breaker_order` written.

- [X] T036 [P] [US3] Create pgTAP test `C:\Users\kevin.cadavid\Documents\world-cup-madness\supabase\tests\008_configuration\scoring_consumer_check.sql`. Test plan: capture output of `compute_match_score(2, 1, 2, 1)` (exact match) — expect 10 (default). Upsert `scoring.match_points.exact` to 15. Call `compute_match_score(2, 1, 2, 1)` again — expect 15. Verifies T016 ALTER FUNCTION migration.

**Checkpoint**: US3 fully functional. Scoring infrastructure is config-driven end-to-end.

---

## Phase 6: User Story 4 — Providers, admin roles, tournament phases (Priority: P2)

**Goal**: Admins manage active provider + per-provider settings (with secret credential reveal), grant/revoke admin roles, change tournament phase.

**Independent Test**: Grant admin role; promoted user can access /admin/*. Switch provider; next sync uses new adapter. Change phase; UI surfaces conditioned on phase update.

- [X] T037 [US4] Append to `supabase/migrations/008_configuration.sql` the `admin_config_get_secret(p_key text)` RPC body per `contracts/admin-config-rpcs.write.md` "Behavior — admin_config_get_secret". Verify `key_is_secret(p_key)` (else WCG03), write `admin.config_secret_accessed` audit row, return the raw `tournament_config.value` jsonb. GRANT EXECUTE to `authenticated`. **Status**: DONE (appended at bottom of slot 0077; D-T037-A logged inline — contract says STABLE but body INSERTs so we ship VOLATILE).

- [X] T038 [US4] Append to the migration the wrapper RPCs `admin_config_grant_admin_role(p_participant_id uuid, p_reason text, p_source_citation text)` and `admin_config_revoke_admin_role(...)` per `contracts/admin-config-rpcs.write.md` "Behavior — admin role wrappers". Each: is_admin check (WCG07), call Slice 006's `admin_grant_admin_role` / `admin_revoke_admin_role` (LOCKED signatures), then INSERT row into `tournament_config_versions` with `key='admin_roles.<participant_id>'`, linked to the audit row Slice 006 already produced (SELECT id FROM audit_log WHERE action='admin.role_granted' AND entity_id=p_participant_id ORDER BY sequence_id DESC LIMIT 1). **Status**: DONE. **D-T038-A contract drift**: slice 006 does NOT ship `admin_grant_admin_role` / `admin_revoke_admin_role` SPs — it ships the `admin_roles` table at slot 0060 + AFTER trigger that auto-writes `admin.role_granted`/`role_revoked`. T038 RPCs direct-INSERT/UPDATE `admin_roles` (trigger writes the audit row automatically); LOCKED parameter signatures preserved verbatim. WCG02 on missing reason/source_citation; WCG03 on revoke when no active role exists.

- [X] T039 [US4] Create `apps/web/app/admin/config/providers/page.tsx`. Server component: gate via `is_admin`. Read `providers.active` + all `providers.<id>.*` keys. Render: dropdown of registered providers for "active", per-provider sub-section with retry/backoff/alert inputs, separate "Reveal credential" button that calls `admin_config_get_secret` and shows the value in a copy-only modal (no inline text). Each save calls `configUpsert`. Confirm dialog warns that switching provider takes effect on next scheduled sync. **Status**: DONE (page + ProvidersEditor + segments.ts + `/api/admin/config/get-secret` route; build clean at 6.08 kB / 105 kB; D-T039-A: task body used short key suffixes (`retry.max_attempts`, `retry.backoff_seconds`, `alert.failure_threshold`); the canonical seed in 0077 + validator catalog use `retry.max_attempts_base`, `retry.backoff_seconds_base`, `alert.threshold_consecutive_failures` — page follows seed; testids use short forms).

- [X] T040 [US4] Create `apps/web/app/admin/config/admin-roles/page.tsx`. Server component: gate via `is_admin`. Render: list of current admin participants (LEFT JOIN `admin_roles` with `participants`), each row has a "Revoke" button. A separate form: select participant by email (with autocomplete from `participants` LIKE filter) + reason + source-citation + "Grant admin role" button. On grant: call `admin_config_grant_admin_role`. On revoke: call `admin_config_revoke_admin_role`. Show in-page warning if revoking own admin role. **Status**: DONE (page + AdminRolesEditor + grant/revoke API routes + participants search route + config-client typed wrappers; build clean; debounced 250ms autocomplete, max 5 results; self-revoke surfaces in-modal warning, no client-side block).

- [X] T041 [US4] Create `apps/web/app/admin/config/phases/page.tsx`. Server component: gate via `is_admin`. Read `tournament.phase.current`. Render: 4-radio (`pre_tournament`, `group_stage`, `knockout`, `completed`) + Reason textarea + Source-citation. On save: `configUpsert`. The page also warns when transitioning backward (e.g., `completed` → `knockout`) with a confirmation prompt — spec edge case allows this but flags it. **Status**: DONE (page + PhasesEditor; build clean at 4.13 kB / 105 kB; backward-transition rank check 0..3; reuses /preview + /upsert + PreviewWarning; source-citation enforced client-side per task body even though SQL backstop doesn't list `tournament.phase.current` in the security-sensitive list).

- [X] T042 [P] [US4] Create pgTAP test `supabase/tests/008_configuration/get_secret_authorization.sql`. Test plan: SET LOCAL non-admin claim → `admin_config_get_secret('providers.football_data_org.credentials.api_key')` → expect WCG07. Verify `admin.access_denied` audit row. SET LOCAL admin claim → expect successful return jsonb. Verify `admin.config_secret_accessed` audit row with the admin's uuid + key in `new_value`, BUT no secret value in the audit row. **Status**: DONE plan(9). 9 assertions: WCG07 + denial audit + denial new_value-key + admin-success-return + access audit + access new_value exact + **A7 security: audit row carries no secret material** + WCG03-non-secret-key + WCG03-absent-row. Reused slot 0074 admin/non-admin bootstrap fixtures (alpha/admin1) for consistency with sibling tests. RUNTIME-DEFERRED — Docker daemon down.

- [X] T043 [P] [US4] Create Playwright test `apps/web/tests/playwright/config-providers.spec.ts`. Test plan as admin: visit /admin/config/providers; verify dropdown shows registered adapters; click "Reveal credential" — modal opens with the key value; verify `admin.config_secret_accessed` audit row written; change `retry.max_attempts` from 3 to 5, save, confirm. **Status**: DONE — 16-step test tagged @slice-008 @us4 inside one `if (false)` RUNTIME-DEFERRED guard; `pnpm tsc --noEmit` clean. **D-T039-A refinement**: only `retry.backoff_seconds_base` + `alert.threshold_consecutive_failures` use long-form suffixes; `retry.max_attempts` (the actual save target) is short — spec uses literal seed key for service-role assertions, short alias for DOM testids.

- [X] T044 [P] [US4] Create Playwright test `apps/web/tests/playwright/config-admin-roles.spec.ts`. Test plan as admin: grant admin role to a fresh non-admin participant; verify the participant's `admin_roles` row + `tournament_config_versions` row (key='admin_roles.<uuid>') both exist with linked `audit_log_id`. Sign in as the newly-promoted participant in incognito; verify access to /admin/*. Revoke role; verify revoked_at populated; promoted user loses access on next request. **Status**: DONE — single main test + optional self-revoke warning sub-test, 8 distinct RUNTIME-DEFERRED guards (fresh seed → grant DOM → grant DB verify → incognito access → revoke DOM → revoke DB verify → access loss → self-revoke modal). Captures D-T038-A reality correctly: `change_kind='admin_upsert'` not a special grant/revoke enum; `source='trigger'`; `entity_id=admin_roles.id`; `previous/new_value={"admin":bool}`. Fresh participant uuid `00000000-aaaa-0000-0000-000000000044`. `pnpm tsc --noEmit` clean.

- [X] T045 [P] [US4] Create Playwright test `apps/web/tests/playwright/config-phases.spec.ts`. Test plan as admin: read current `tournament.phase.current` (initial `pre_tournament`); change to `group_stage`; verify backward-transition warning (none for forward). Change `completed` → `knockout` → verify warning prompt appears; confirm; verify audit row written. **Status**: DONE — 3 tests tagged @slice-008 @us4: (1) forward `pre_tournament → group_stage` no backward warning, (2) backward `completed → knockout` shows warning + confirm → upsert, (3) cancel path gated `if (false)`. Confirmed action_label `tournament_config.tournament.phase.current` (slot 0077 line 599). `pnpm tsc --noEmit` clean. Service-role IO wrapped with try/catch fallthrough so spec is graceful when Docker is up OR down.

**Checkpoint**: US4 fully functional.

---

## Phase 7: User Story 5 — Rollback + version history (Priority: P2)

**Goal**: Admin views version history and rolls back any prior version. Rollback is a NEW audit event (not a delete).

**Independent Test**: Make a change; verify history shows it; roll back; verify history shows BOTH the original change AND the rollback as new rows.

- [X] T046 [US5] Append to `supabase/migrations/008_configuration.sql` the `admin_config_rollback(p_target_version_id bigint, p_reason text, p_source_citation text DEFAULT NULL)` RPC body per `contracts/admin-config-rpcs.write.md` "Behavior — admin_config_rollback". Logic: is_admin check (WCG07), validate target version exists (else WCG03), retention check (else WCG04 — defer to Slice 007 retention config), advisory lock, audit row with reason prefixed by "Rollback to version N:", versions row with `change_kind='admin_rollback'` + `parent_version_id=target`, update `tournament_config` with target's `new_value`. GRANT EXECUTE to `authenticated`. **Status**: DONE. Also shipped helper `_config_rollback_retention_horizon()`. **D-T046-A retention semantics**: policy_kind='keep' (default per slot 0076) → horizon=-infinity (no WCG04 ever). policy_kind='prune' → horizon = now() - buffer_months × 1mo (default 12mo). T050 exercises the 'prune' branch.

- [X] T047 [US5] Append to the migration the `config_version_history(p_key text DEFAULT NULL, p_limit int DEFAULT 50, p_offset int DEFAULT 0) RETURNS TABLE(...)` body per `contracts/config-version-history.read.md`. is_admin check (WCG07), limit/offset validation (WCG02), SELECT from `tournament_config_versions` filtered by `p_key` if non-null, ORDER BY version_id DESC, LIMIT/OFFSET. GRANT EXECUTE to `authenticated`. **Status**: DONE. **D-T047-A**: contract says STABLE; we keep STABLE volatility and drop the in-body admin.access_denied audit row on WCG07 denial (STABLE forbids INSERT). Route handlers write the denial audit row externally (matching their existing /api/admin/config/upsert pattern).

- [X] T048 [US5] Create `apps/web/app/admin/config/history/page.tsx`. Server component: gate via `is_admin`. Optional `?key=<key>` searchParam. Call `config_version_history` and render `<VersionTimeline>` (T022). Each timeline entry's "Rollback to this" button calls `configRollback(version_id, reason, source_citation)` via a confirmation modal with reason input. Display the rollback as a new entry at the top of the timeline immediately after success. **Status**: DONE (page + HistoryView + `/api/admin/config/rollback` route; build clean at 3.27 kB; debounced 300ms filter input; ERRCODE map WCG02→400, WCG03→404, WCG04→410, WCG07→403; `config-client.ts` extended — `configRollback` now passes the locked third param `p_source_citation`).

- [X] T049 [P] [US5] Create pgTAP test `supabase/tests/008_configuration/rollback_happy.sql`. Test plan: (1) Upsert `scoring.match_points.exact` from 10 to 15 — capture new version_id v1. (2) Upsert again to 20 — capture v2. (3) Roll back to v1's version_id — assert: new version v3 created with `change_kind='admin_rollback'`, `parent_version_id=v1`; `tournament_config WHERE key='scoring.match_points.exact'` now has value 15 (the value at v1, NOT 10); audit_log has 3 rows for `tournament_config.scoring.match_points.exact`. **Status**: DONE plan(7). Captures initial/v1/v2/v3 + initial_value into `_t049_state` temp ON COMMIT DROP; impersonation via JWT claims + SET LOCAL ROLE authenticated + RESET ROLE between assertions. A6 cross-references v1's new_value rather than literal '15' for explicit target-linkage. Noted: `admin_config_rollback` does NOT enforce source_citation requirement (unlike `admin_config_upsert`), contract-faithful.

- [X] T050 [P] [US5] Create pgTAP test `supabase/tests/008_configuration/rollback_retention.sql`. Test plan: synthesize a `tournament_config_versions` row with `created_at = now() - interval '24 months'`. Call `admin_config_rollback` against its `version_id` — expect WCG04 (`Rollback target version exceeds retention horizon`). Verify retention horizon respects `audit.retention.tournament_end_buffer_months` (12 by default — anything older than 12 months past tournament end raises WCG04). **Status**: DONE plan(7). Flips policy_kind='prune' → A1/A2 verify horizon ≈ now()-12mo → A3 throws_ok WCG04 on 24-mo-old synth → A4 no admin_rollback row → flip back to 'keep' → A5 horizon=-infinity → A6 lives_ok same rollback now succeeds → A7 exactly 1 admin_rollback row with parent_version_id=synthetic. Synth uses WITH/RETURNING into `_t050_state` temp table. Defensive proof gate is solely policy-driven.

- [X] T051 [P] [US5] Create Playwright test `apps/web/tests/playwright/config-history-rollback.spec.ts`. Test plan as admin: (1) Make 2 changes to `scoring.final_pick_points` (20 → 25 → 30). (2) Visit /admin/config/history?key=scoring.final_pick_points — verify 2 entries + initial seed. (3) Click "Rollback to this" on the 25 entry. (4) Provide reason. (5) Confirm. (6) Verify a new entry appears at top with rollback badge. (7) Read current value — assert 25. (8) Verify audit row chain. **Status**: DONE — 1 active test + 2 RUNTIME-DEFERRED (empty-state, cancel-modal); 6 distinct const guards for service-client + DOM walk + verify + audit chain count + the 2 optional tests; tsc clean. **D-T051-A note**: `admin_config_upsert` can't be invoked from service-role context (auth.uid() is null → WCG07); seed bypasses via direct INSERTs into versions + UPDATE config, so the seed upserts don't emit audit_log rows (audit chain ≥3 assertion gated behind `_runtimeDeferredFullAuditChain`; rollback-only audit row remains strictly asserted). Baseline confirmed as `final_pick_points=20` from slot 0077 line 310 (NUMERIC_DEFAULTS=25 in scoring/page.tsx is only the input fallback when row absent).

**Checkpoint**: US5 fully functional. The configuration surface is complete with version history + rollback.

---

## Phase 8: Polish & Cross-Cutting Concerns

This phase wraps up the slice with import/export, the audit-failure webhook delivery (closes Slice 007's deferred SC-007), cross-slice regression, runbook updates, and quickstart validation.

### 8a. Import / export (FR-009)

- [X] T052 Append `admin_config_export() RETURNS jsonb` to slot 0077. **Status**: DONE. **D-T052-A**: contract spec references non-existent helper `canonical_jsonb_to_bytea`; we use `(envelope - 'signature')::text::bytea` (Postgres jsonb text is keys-sorted, minimal-whitespace — matches `jq -c -S` in practice). **D-T052-B**: contract says STABLE but body INSERTs audit row; ship VOLATILE (same as T037/T046). WCG08 if `app.config_export_secret` GUC unset. Signature via `extensions.hmac()` from pgcrypto.

- [X] T053 Append `admin_config_import(jsonb, text) RETURNS jsonb` to slot 0077. **Status**: DONE. Atomicity: per-key validation aggregate collects ALL failures into `v_validation_errors jsonb` then raises WCG08 with the aggregate (atomic rollback). Order: schema_version check (WCG08) → signature check (WCG08) → per-key aggregate (WCG08) → single audit row → per-key versions+config upsert. Acknowledge-token bypass per contract (admin already vetted source). Secret-redacted entries skipped.

- [X] T054 [P] Create `apps/web/app/admin/config/import-export/page.tsx`. **Status**: DONE (page + ImportExportPanel; full DOM testid contract; export-button triggers blob download via hidden anchor; import upload as multipart; per-key WCG08 validation errors render in list).

- [X] T055 [P] Create `apps/web/app/api/admin/config/export/route.ts`. **Status**: DONE. GET handler with `Content-Disposition: attachment; filename="world-cup-madness-config-<env>-<timestamp>.json"`. ERRCODE map: WCG07→403, WCG08→409 (`error: 'export_secret_not_configured'`), others→500. Pretty-printed JSON (2-space indent) for human edit-ability.

- [X] T056 [P] Create `apps/web/app/api/admin/config/import/route.ts`. **Status**: DONE. POST handler parses multipart, validates file + reason. ERRCODE map: WCG02→400, WCG07→403, WCG08→422 (extracts validation_errors array from SQLERRM bracket slice + JSON.parse), others→500. Returns version_ids as decimal strings to preserve bigint precision.

- [X] T057 [P] Create `scripts/config/sign-import.sh`. **Status**: DONE — executable 0755; bash 3.2 / Git-Bash compatible; manual case-loop CLI parsing (no GNU getopt); 6 exit codes wired (0/64/65/66/69/74); canonical body via `jq -c -S '. | del(.signature)'`; HMAC via `openssl dgst -sha256 -hmac`; header docs D-T052-A divergence caveats. Smoke verify documented for jq-equipped env.

- [X] T058 [P] Create pgTAP test `supabase/tests/008_configuration/import_signature.sql`. **Status**: DONE plan(5). A1 lives_ok roundtrip → A2 throws WCG08 tampered body (HMAC mismatch) → A3 throws WCG08 missing signature → A4 throws WCG08 schema_version='9.9.9' (Step 3 ordering before Step 4) → A5 cmp_ok >0 roundtrip wrote import_bulk version row. SET LOCAL app.config_export_secret inside transaction so export+import see same secret.

- [X] T059 [P] Create pgTAP test `supabase/tests/008_configuration/import_validation_aggregate.sql`. **Status**: DONE plan(6). A1 WCG08 + A2a/A2b BOTH bad keys in error message (proves no short-circuit on first failure) + A3 atomic rollback (no versions rows) + A4 no admin.config_imported audit row + A5 phase unchanged (validation fires before any mutation). Inline HMAC computation so signature gate passes and aggregate is exercised.

- [X] T060 [P] Create Playwright test `apps/web/tests/playwright/config-import-export.spec.ts`. **Status**: DONE — 1 active + 1 deferred (aggregate validation); 6 named const guards (_runtimeDeferred*Admin/Baseline/ExportSecret/Signer/Verify/AggregateTest); `.gitignore` extended for `apps/web/tests/playwright/.tmp/`. Modified value computed as baseline+5 (defaults 20→25 but tolerates dirty dev DB). app.config_export_secret GUC is project-level → flagged as RUNTIME-DEFERRED with Promise.race on download vs error banner. `pnpm tsc --noEmit` clean.

### 8b. Audit-failure webhook delivery (closes Slice 007 SC-007)

- [X] T061 Append `notification_dispatch_queue` + partial index `pending_idx` to slot 0077. **Status**: DONE. Privilege posture mirrors audit_log: REVOKE ALL FROM authenticated, anon; SECURITY DEFINER paths only.

- [X] T062 Append `enqueue_alert(text, text, jsonb, uuid) RETURNS uuid` SECURITY DEFINER to slot 0077. **Status**: DONE. Returns NULL no-op when webhook URL unset OR literal `"null"`. Inner BEGIN/EXCEPTION wrap on config_read so WCG06 becomes silent no-op.

- [X] T063 Append `dispatch_pending_alerts() RETURNS int` SECURITY DEFINER to slot 0077. **Status**: DONE. Uses `extensions.http_post` (pg_net) with 10s timeout. **D-T063-A**: contract refs non-existent `canonical_jsonb_to_bytea`; ship `payload::text::bytea` (matches T052/T053 D-T052-A). **D-T063-B**: pg_net response trigger (delivered_at finalizer) is operator-wired post-migration per T075 runbook. Walks queue LIMIT 50 per tick + exponential backoff `now() + (attempts+1)*60s`. Sweep marks failed_at when attempts ≥ max_attempts.

- [X] T064 Append pg_cron schedule `tournament-config-alert-dispatcher` (`*/30 * * * * *` — 30s cadence) to slot 0077. **Status**: DONE. **D-T064-A**: idempotent via unschedule-then-schedule pattern wrapped in EXCEPTION fallthrough so dev envs without pg_cron extension don't fail the migration.

- [X] T065 Extend audit writers to call enqueue_alert on failure. **Status**: DONE — 23 audit writers inventoried across slices 001-008; **5 PATCHED** (auth hook `handle_auth_user_created` + `handle_auth_user_signed_in`, `participants_write_audit`, `log_admin_role_change`, `admin_config_upsert`); **17 DEFERRED** to future polish pass (documented in T065 block header). 13 PERFORM enqueue_alert sites added (all include SQLERRM + SQLSTATE + writer/branch). Wrap pattern: enqueue_alert in inner BEGIN/EXCEPTION/NULL (alert path can never masquerade as primary error) then RAISE original. Migration 0077 grew 2509→3416 lines, all CREATE OR REPLACE idempotent.

- [X] T066 [P] Create `apps/web/app/admin/config/retention/page.tsx` + RetentionEditor. **Status**: DONE — 4 independent sections (policy radio, buffer-months int, webhook URL text, webhook secret password-toggle); build clean 5.84 kB; tsc clean. **D-T066-A**: T018 zod schema lists `'keep'|'delete'` but T066 spec + T046 retention helper use `'keep'|'prune'` — editor bypasses zod for `'prune'`; forward-compat. Webhook secret value never round-tripped server→client (presence-only via version_id probe; user re-enters to overwrite).

- [X] T067 [P] Create pgTAP test `supabase/tests/008_configuration/webhook_dispatch.sql`. **Status**: DONE plan(8). A1 isnt-null enqueue id → A2-A3 payload shape + attempts=0 → A4 attempts→1 after tick (path-agnostic — holds in success AND exception branches of dispatch) → A5 next_attempt_at >50s future → A6 delivered_at populated via SIMULATED finalizer (D-T063-B compensated by runbook) → A7 second tick no-op on delivered → A8 `"null"` literal returns NULL no-op. Agent also extended `docs/runbooks/audit-write-failure.md` with section (f) manual verification (T075 overlap). Schema fix: tournament_config has no `value_type` column per slot 0002.

### 8c. Fail-closed verification

- [X] T068 [P] Create pgTAP test `supabase/tests/008_configuration/config_read_fail_closed.sql`. **Status**: DONE plan(4) — A1 WCG06 raise + A2 default return + A3 eligibility FALSE + A4 locking TRUE (using locking_window_consumer_check.sql matches insert pattern: kickoff_utc + stage='group' + group_id='A' + LIMIT/OFFSET team FKs).

- [X] T069 [P] Create Playwright test `apps/web/tests/playwright/config-fail-closed.spec.ts`. **Status**: DONE — 7 RUNTIME-DEFERRED guards; tsc clean. **D-T069-A** (4 sub-codes): (1) `system.config_unavailable` label never emitted; (2) PredictionForm uses role=alert without data-testid; (3) participant OIDC stub Docker-dependent; (4) recovery needs page.reload not router.refresh. Additional gap: PostgREST can't run DDL → no exec_sql RPC, REVOKE/GRANT path deferred behind `tryExecSql`.

### 8d. Cross-slice regression

- [X] T070 [P] Create pgTAP test `supabase/tests/008_configuration/consumer_migrations.sql`. **Status**: DONE plan(6) — A1 Slice 001 eligibility + A2 Slice 003 30-min lock + A3-A5 Slice 005 score branches (exact=10, correct_outcome=5, incorrect=0) + A6 leaderboard_v exists. Each assertion gates a Phase 2 ALTER (T014/T015/T016).

- [X] T071 [P] Create Playwright test `apps/web/tests/playwright/config-cross-slice-regression.spec.ts`. **Status**: DONE — all 7 action labels per slice **verified against frozen action_label_catalog.sql**: access.granted / provider.sync_no_changes / prediction.% / final_prediction.% / score_record.insert / admin.recalc_triggered / audit_search read-only (no audit row). 6 D-T071-A.x drift notes (sync.triggered→provider.sync_no_changes per catalog, .created/.superseded tolerance, Slice 005 SCORE_TRIGGER_INTERNAL_AUTH_SECRET, Slice 006 drives /api/admin/recalc not service-role SP due to auth.uid() context). tsc clean.

- [X] T072 [P] Extend Slice 007 catalog assertion. **Status**: DONE — additive edit; 3 new labels (admin.config_exported, admin.config_imported, admin.config_secret_accessed); preflight threshold bumped 40→43. `tournament_config.<key>` NOT enumerated — existing file (line 167) uses prefix-match rule `NOT LIKE 'tournament_config.%'` so dynamic future keys auto-pass. plan(3) unchanged.

### 8e. Documentation + index

- [X] T073 Run quickstart against fresh DB; document deltas. **Status**: DONE — appended `## Quickstart deltas (Slice 008)` section. **RUNTIME-DEFERRED**: 14-step end-to-end not run (Docker down throughout). 8 specific deltas captured from accumulated D-codes (D-T046-A retention, D-T038-A admin role wrappers, D-T052-A canonical form, D-T063-B pg_net finalizer, D-T069-A config_unavailable label, etc.). Verification queued for consolidated post-merge runtime sweep.

- [X] T074 [P] Update INDEX.md. **Status**: DONE — INDEX.md is partially auto-generated (between `<!-- GENERATED:START/END -->` markers, "Repository Map" tree rebuilt by `scripts/index/generate.sh`). Manual-content section (slice 001-007 entries) gets new "### Slice 008 (Tournament Configuration)" section with 7 spec docs + 1 migration + 15 pgTAP entries + 3 lib helpers + 23 admin config UI files + 9 API routes + 11 Playwright specs + 1 script + 1 docs addendum = ~71 file references. All paths verified via Glob.

- [X] T075 [P] Extend audit-write-failure runbook. **Status**: DONE — new `## Audit-failure webhook delivery (Slice 008+)` section inserted after T067's pre-existing section (f). Five sub-sections (a)-(e): admin UI walkthrough, receiver behavior (idempotency + HMAC + response handling + LOCKED payload schema), notification_dispatch_queue inspection psql queries, manual `dispatch_pending_alerts()` invocation, known limitations (D-T063-B finalizer + pg_net not CI-testable + 6-step per-release manual smoke + D-T069-A.1 system.config_unavailable not emitted).

- [X] T076 [P] Create slice-close-summary.md. **Status**: DONE — `specs/008-configuration/slice-close-summary.md` authored: outcome statement (v1 feature-complete), OD-001/-002/-004/-005/-006 resolved via mechanism (OD-001 awaits Security sign-off), OD-007/-008 still open with rationale, 12 locked cross-slice contracts enumerated, forward-compatibility protocol documented, cumulative cross-slice totals at close, 9 known carry-forward items, 4 next milestones (production deployment runbook update, regression-final.md, OD-001 sign-off, webhook receiver setup).

**Checkpoint**: Slice 008 complete. v1 product is feature-complete.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: No dependencies.
- **Phase 2 (Foundational)**: Depends on Phase 1. BLOCKS all user stories.
- **Phase 3 (US1)** through **Phase 7 (US5)**: All depend on Phase 2. Within each phase, browser-test tasks depend on the page implementation task.
- **Phase 8 (Polish)**: Depends on Phases 3-7 for the page-level integration tests; the webhook delivery + cross-slice regression tasks can begin earlier (after Phase 2).

### Within Phase 2

- T004 → T005 → T006/T009 → T007/T008 → T010 (DB schema must build up sequentially; T006 and T009 are parallel).
- T011 → T012 (depend on T004-T010).
- T013 must run after T014/T015/T016 (regression gate after ALTER FUNCTIONs).
- T014 || T015 || T016 (independent consumer migrations) — but they share the migration file; write order is sequential in the SQL but conceptually parallel.
- T017–T023 are TS/TSX files; all parallel to each other and to T011-T016.
- T024 || T025 || T026 (different test files; depend on T011).

### Within each user-story phase

- The page implementation task is sequential.
- The Playwright + pgTAP tests for that story are parallel.

### Within Phase 8

- T052 → T053 → T058/T059/T060 (export/import RPCs before tests).
- T061 → T062 → T063 → T064 → T065 → T067 (webhook delivery pipeline; sequential because they share the migration file).
- T066, T068, T069 parallel after Phase 2.
- T070, T071, T072 parallel (different files).
- T073 must run last (full quickstart verification).
- T074, T075, T076 parallel after T073.

---

## Parallel Example: User Story 1

```bash
# After Phase 2 completes, fan out US1 tasks:
Agent: "Implement /admin/config/domains page per T027"
Agent: "Write Playwright test config-domains.spec.ts per T028"
Agent: "Write pgTAP test eligibility_preview_affecting.sql per T029"
```

T028 and T029 run BEFORE T027 to maintain TDD discipline (red → green).

## Parallel Example: Phase 2 frontend foundation

```bash
# After T004-T016 (DB done), 7 parallel agents:
Agent: "Create config-client.ts per T017"
Agent: "Create config-validators.ts per T018"
Agent: "Create hmac.ts per T019"
Agent: "Create ConfigField.tsx per T020"
Agent: "Create PreviewWarning.tsx per T021"
Agent: "Create VersionTimeline.tsx per T022"
Agent: "Create /admin/config/page.tsx per T023"
```

---

## Implementation Strategy

### MVP-first

1. Complete Phase 1 (Setup) — 3 tasks.
2. Complete Phase 2 (Foundational) — 23 tasks. The DB foundation is now built; the migration is mostly complete except for the additional RPCs added in later phases.
3. Complete Phase 3 (US1 — Domains) — 3 tasks.
4. **STOP and VALIDATE**: Confirm `/admin/config/domains` works end-to-end. This is the MVP — administrator-managed corporate domain list.
5. Decide whether to continue with US2/US3 (P1) or skip ahead.

### Incremental delivery

- After Phase 3 (US1 done): live domain management is operational.
- After Phase 4 (US2 done): live lock-window management is operational.
- After Phase 5 (US3 done): live scoring management is operational.
- After Phase 6 (US4 done): admin role + provider + phase management operational.
- After Phase 7 (US5 done): version history + rollback operational.
- After Phase 8 (Polish): import/export + webhook delivery + cross-slice regression all green.

### Parallel-team strategy

- After Phase 2: dev A → US1, dev B → US2, dev C → US3 (all P1). Then dev A → US4, dev B → US5, dev C → Phase 8 (in parallel).

---

## Cross-slice contract reminders (do not break)

1. `tournament_config` 6-column shape (key, value, value_type, updated_at, updated_by, version_id) — LOCKED at slice close.
2. `tournament_config_versions` 12-column shape with `bigserial version_id` — LOCKED at slice close.
3. ~30-key configuration namespace catalog — FROZEN at slice close.
4. ERRCODE WCG01–WCG08 — owned by this slice.
5. `config_read(text, jsonb)` signature + fail-closed behavior.
6. 6 `admin_config_*` RPC signatures + behavior contracts.
7. `pg_notify` channel `'tournament_config_changed'` + payload format.
8. Export/import JSON envelope schema `1.0.0` + HMAC signature.
9. Webhook payload envelope schema `1.0.0`.
10. Consumer-slice function bodies — Slice 001 `is_eligible_nortal_participant`, Slice 003 `is_prediction_locked`, Slice 005 `compute_match_score` + leaderboard view — now config-driven via `config_read`. Their signatures remain UNCHANGED (prior slices' tests continue to pass).
11. Slice 006's `is_admin(uuid)`, `admin_grant_admin_role(...)`, `admin_revoke_admin_role(...)` — LOCKED; this slice wraps but does not modify.
12. Slice 007's `audit_log` (with `sequence_id`, `source_citation`) — read-only consumer.
13. Slice 007's action label catalog — extended (not renamed) with `tournament_config.*` and `admin.config_*` prefixes per the documented forward-compatible protocol.

---

## Notes

- Migration smoke checks (T013) MUST halt the migration on any divergence — Principle XI.
- All tests run via `supabase test db` (SQL) and `pnpm --filter web playwright test` (browser).
- Each task is self-contained per user memory `feedback_speckit_tasks_self_contained` — a subagent receiving only the task description plus the design docs under `specs/008-configuration/` should be able to complete the task without further context.
- Commit cadence: one commit per Phase checkpoint. Slice 008 should land as 7–9 commits.
- WSL2 install remains the blocker for `supabase start` and `pnpm playwright test`.

---

## Total task count

**76 tasks** across 8 phases:

- Phase 1 (Setup): 3
- Phase 2 (Foundational): 23
- Phase 3 (US1 — Domains): 3
- Phase 4 (US2 — Locking): 3
- Phase 5 (US3 — Scoring + tie-breaker): 4
- Phase 6 (US4 — Providers/admin-roles/phases): 9
- Phase 7 (US5 — Rollback + history): 6
- Phase 8 (Polish): 25

Suggested MVP scope: Phase 1 + Phase 2 + Phase 3 (T001–T029) — live administrator-managed corporate domain list. The other P1 stories (US2, US3) follow shortly after.
