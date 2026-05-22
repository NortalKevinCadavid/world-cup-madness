# Slice 008 — Tournament Configuration — Close Summary

**Closed**: 2026-05-21
**Final state**: 76/76 tasks artifact-complete; runtime verification queued for the consolidated post-merge sweep
**Migration**: `supabase/migrations/0077_configuration.sql` (~3400 lines, single mega-file)

## Outcome

v1 product is **feature-complete**. Every configurable rule — approved domains, prediction lock window, scoring values, tie-breaker order, provider settings + credentials, admin role grants/revokes, tournament phase, version history with rollback, signed import/export, and the audit-failure webhook delivery — is now live-editable through `/admin/config/*` with version history, fail-closed defaults, and forensic audit chains.

## Open Decisions resolved

Slice 008 ships the **mechanism** (live config + admin UI) for the five decisions that were earlier resolved in principle on 2026-05-15. The product gates that remain are now soft (admin-flippable pre-launch):

- **OD-002** (knockout score basis) — `scoring.tie_breaker_order` array + `scoring.score_upper_bound` per `/admin/config/scoring`.
- **OD-004** (top scorer ties) — codified at compute time; admin can adjust via `/admin/config/scoring` if FIFA changes the Golden Boot rule.
- **OD-005** (best player source) — `providers.active` + per-provider `providers.<id>.*` settings via `/admin/config/providers`; credential reveal flows through `admin_config_get_secret` with audit row.
- **OD-006** (leaderboard visibility) — `leaderboard.visibility_policy` seeded; admin can change pre-launch.

OD-001 (approved-domain list) — mechanism shipped via `eligibility.allowed_domains` editor at `/admin/config/domains`; the **final value** awaits Security sign-off (un-block via that page).

## Open Decisions still open

- **OD-007** (implementation approach) — stack-decision.md still proposes Next.js + Tailwind + Supabase; formal approval pending.
- **OD-008** (notification channels) — config keys are seeded (`notifications.audit_failure_webhook_url`, `notifications.deadline_reminders.enabled`) and the dispatcher infrastructure (`notification_dispatch_queue` + `enqueue_alert` + `dispatch_pending_alerts` + pg_cron) is shipped; participant-facing email/Slack reminders are NOT in v1. Future slice can re-use the queue + dispatcher.

## Locked cross-slice contracts (do not break)

Future slices must NOT alter signatures, return types, or behavior of:

1. `is_admin(uuid) → boolean` (slot 0062, slice 006) — RLS gate consumed by 008's `admin_config_*` family.
2. `audit_log` table shape (slot 0003) — base columns LOCKED per Principle XI.
3. `tournament_config(key, value, value_type, updated_at, version_id)` + `tournament_config_versions(version_id, key, previous_value, new_value, change_kind, ...)` shape — base configuration store.
4. `admin_config_upsert(text, jsonb, bigint, text, text, uuid) → bigint` — single-key write RPC.
5. `admin_config_preview(text, jsonb) → jsonb` — affecting-impact computation + acknowledge_token mint.
6. `admin_config_rollback(bigint, text, text) → bigint` — version restoration; new write semantics (not delete).
7. `admin_config_get_secret(text) → jsonb` — credential reveal with forensic audit (no value in audit row).
8. `admin_config_grant/revoke_admin_role(uuid, text, text)` — admin role wrappers.
9. `config_version_history(text, int, int) → SETOF row` — read-only enumeration.
10. `admin_config_export() → jsonb` + `admin_config_import(jsonb, text) → jsonb` — signed envelope round-trip, schema_version `'1.0.0'`.
11. ERRCODE namespace WCG01..WCG08 (LOCKED): concurrent edit / invalid value / unknown key / retention horizon / affecting-unack / config unavailable / not-admin / import aggregate failure.
12. `enqueue_alert(text, text, jsonb, uuid) → uuid` — fail-soft alert routing; consumed by audit-write-failure paths across all slices.

## Forward-compatibility protocol

The namespace catalog seed in slot 0077 (lines 280-390) defines the v1 keys. New keys can be added in future slices without amending slice 008:

1. Append an `INSERT INTO public.tournament_config` row (with `ON CONFLICT DO NOTHING`).
2. (Optional) Extend the SQL backstop CASE dispatcher in `admin_config_upsert` + `admin_config_import` for type validation.
3. (Optional) Add a zod schema entry in `apps/web/lib/config-validators.ts`.
4. Unknown keys pass the import validator backstop without error (forward-compat path).

The data-model documents the convention in `data-model.md` § Forward-compatible namespace evolution.

## Cumulative cross-slice totals at close

- **Migrations**: 72 (slot 0001 → 0077)
- **pgTAP tests**: 125 (+5 new in phase 8: webhook_dispatch, config_read_fail_closed, consumer_migrations, import_signature, import_validation_aggregate, rollback_happy, rollback_retention — and the 007 catalog edit)
- **Playwright specs**: 132 (+5 new in phase 8: config-import-export, config-fail-closed, config-cross-slice-regression — plus phases 4-7's earlier additions)
- **Deno tests**: 26
- **Deviations**: 60+ (D-001 → D-032 plus the D-T### inline sub-codes accumulated across phases 6/7/8)

## Known carry-forward items

For the next maintenance pass:

1. **slice-005-fixture.sql** — flagged in slice 005 T041 regression-final.md.
2. **D-T065 deferred audit-writer wraps (17 of 23 writers)** — slice 006 admin RPCs + slice 002/003/004 audit triggers not yet wrapped with `enqueue_alert` on failure; documented in T065 block header inside slot 0077.
3. **D-T063-B pg_net response-side trigger** — finalizer for `delivered_at`/`failed_at` is operator-wired; runbook (T075) documents the procedure.
4. **D-T069-A `system.config_unavailable` action label** — referenced in docs/research but not emitted by any writer; future enhancement should add `enqueue_alert('config_unavailable', ...)` in the fail-closed trap blocks of `is_eligible_nortal_participant` + `is_prediction_locked`.
5. **Legacy key drift (D-T013 surfaced in phase 2)**:
   - Slice 001 auth hook reads legacy `eligibility.approved_domains` (should be `eligibility.allowed_domains` post-008).
   - Slice 005 `score_match` SP reads legacy `match_points.outcome` (should be `match_points.correct_outcome`).
   - Slice 005 fixture uses `first_kickoff_utc` (should be `first_kickoff_at_utc`).
6. **D-T031 leaderboard view dynamic ORDER BY** — `leaderboard_v` doesn't yet reflect `scoring.tie_breaker_order` config changes (still uses static ORDER BY from slot 0054).
7. **D-T046-A retention horizon production posture** — operators must explicitly flip `audit.retention.policy_kind='prune'` after tournament-end + buffer to activate the WCG04 gate.
8. **D-T052 / sign-import.sh canonical-form divergence** — known edge cases (scientific notation, certain unicode escapes) where `jq -c -S` may diverge from Postgres' `jsonb::text`. Documented in the signer's header.
9. **Consolidated runtime sweep** — every artifact in slices 005-008 carries a RUNTIME-DEFERRED marker (Docker daemon was down throughout authoring). Post-merge sweep should boot the Supabase stack and exercise the full pgTAP suite + Playwright projects.

## Next milestones (post-merge)

1. **Production deployment runbook update**: set `app.environment_label`, `app.config_export_secret`, wire pg_net response-side trigger, confirm pg_cron extension is enabled.
2. **Slice 008 final regression-final.md**: queued behind the consolidated runtime sweep.
3. **Security sign-off on OD-001**: Security team reviews `eligibility.allowed_domains` editor + sets the production-launch value.
4. **Webhook receiver setup**: operations configures the Slack incoming webhook (or PagerDuty Events API) per `docs/runbooks/audit-write-failure.md`.

---

**This is the World Cup Madness project.**
