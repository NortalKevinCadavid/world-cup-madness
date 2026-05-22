# World Cup Madness — Repository Index

This file provides an overview of the repository structure.

## Quick Links

### Product / architecture
- [docs/architecture/README.md](docs/architecture/README.md) — index of product context
- [docs/architecture/high-level-architecture.md](docs/architecture/high-level-architecture.md) — full Nortal architecture document
- [docs/architecture/acceptance-criteria.md](docs/architecture/acceptance-criteria.md) — test scenarios + acceptance criteria
- [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md) — OD-001 … OD-008 tracker
- [docs/architecture/scoring-model.md](docs/architecture/scoring-model.md) — locking + scoring + tie-breakers
- [docs/architecture/stack-decision.md](docs/architecture/stack-decision.md) — proposed stack (draft ADR)

### Repository operations
- [README.md](README.md) — project overview and setup
- [CLAUDE_START.md](CLAUDE_START.md) — Claude Code getting started
- [docs/secrets-guide.md](docs/secrets-guide.md) — secrets management guide

### Slice 001 (Eligibility & Login)
- [specs/001-eligibility-login/plan.md](specs/001-eligibility-login/plan.md) — current slice plan
- [specs/001-eligibility-login/tasks.md](specs/001-eligibility-login/tasks.md) — task list (incl. D-001 deviation log)

### Slice 007 (Audit Trail)
- [specs/007-audit-trail/spec.md](specs/007-audit-trail/spec.md) — slice specification
- [specs/007-audit-trail/plan.md](specs/007-audit-trail/plan.md) — implementation plan
- [specs/007-audit-trail/tasks.md](specs/007-audit-trail/tasks.md) — task list
- [specs/007-audit-trail/data-model.md](specs/007-audit-trail/data-model.md) — audit_log schema + action label catalog
- [specs/007-audit-trail/quickstart.md](specs/007-audit-trail/quickstart.md) — verification recipe
- [specs/007-audit-trail/research.md](specs/007-audit-trail/research.md) — design research

**Backend (Supabase):**
- [supabase/migrations/0076_audit_trail.sql](supabase/migrations/0076_audit_trail.sql) — audit_log table + RPCs + triggers
- [supabase/tests/007_audit_trail/README.md](supabase/tests/007_audit_trail/README.md) — pgTAP test suite overview
- [supabase/tests/007_audit_trail/monotonic_ordering.sql](supabase/tests/007_audit_trail/monotonic_ordering.sql) — monotonic id ordering
- [supabase/tests/007_audit_trail/action_label_catalog.sql](supabase/tests/007_audit_trail/action_label_catalog.sql) — catalog-freeze enforcement
- [supabase/tests/007_audit_trail/tamper_resistance.sql](supabase/tests/007_audit_trail/tamper_resistance.sql) — UPDATE/DELETE denial
- [supabase/tests/007_audit_trail/audit_search_authorization.sql](supabase/tests/007_audit_trail/audit_search_authorization.sql) — RPC RBAC
- [supabase/tests/007_audit_trail/audit_search_errcodes.sql](supabase/tests/007_audit_trail/audit_search_errcodes.sql) — RPC error code contracts

**Web (Next.js):**
- [apps/web/lib/audit-search.ts](apps/web/lib/audit-search.ts) — audit search RPC client + filter parsing
- [apps/web/lib/csv.ts](apps/web/lib/csv.ts) — CSV streaming helper for audit export
- [apps/web/app/admin/audit/search/page.tsx](apps/web/app/admin/audit/search/page.tsx) — admin audit search page
- [apps/web/app/admin/audit/search/AuditFiltersForm.tsx](apps/web/app/admin/audit/search/AuditFiltersForm.tsx) — filter form component
- [apps/web/app/admin/audit/search/AuditResultsTable.tsx](apps/web/app/admin/audit/search/AuditResultsTable.tsx) — results table component
- [apps/web/app/api/admin/audit/export/route.ts](apps/web/app/api/admin/audit/export/route.ts) — CSV export route handler

**Playwright tests:**
- [apps/web/tests/playwright/audit-regression-cross-slice.spec.ts](apps/web/tests/playwright/audit-regression-cross-slice.spec.ts) — cross-slice regression
- [apps/web/tests/playwright/audit-route-inventory.spec.ts](apps/web/tests/playwright/audit-route-inventory.spec.ts) — route inventory coverage
- [apps/web/tests/playwright/audit-search.spec.ts](apps/web/tests/playwright/audit-search.spec.ts) — admin search happy path
- [apps/web/tests/playwright/audit-search-denial.spec.ts](apps/web/tests/playwright/audit-search-denial.spec.ts) — non-admin denial
- [apps/web/tests/playwright/audit-export.spec.ts](apps/web/tests/playwright/audit-export.spec.ts) — CSV export happy path
- [apps/web/tests/playwright/audit-export-denial.spec.ts](apps/web/tests/playwright/audit-export-denial.spec.ts) — export non-admin denial
- [apps/web/tests/playwright/audit-export-validation.spec.ts](apps/web/tests/playwright/audit-export-validation.spec.ts) — export filter validation

### Slice 008 (Tournament Configuration)
- [specs/008-configuration/spec.md](specs/008-configuration/spec.md) — slice specification
- [specs/008-configuration/plan.md](specs/008-configuration/plan.md) — implementation plan
- [specs/008-configuration/tasks.md](specs/008-configuration/tasks.md) — task list
- [specs/008-configuration/data-model.md](specs/008-configuration/data-model.md) — configuration_versions schema + RPC catalog
- [specs/008-configuration/quickstart.md](specs/008-configuration/quickstart.md) — verification recipe (extended by T073 with slice 008 deltas)
- [specs/008-configuration/research.md](specs/008-configuration/research.md) — design research
- [specs/008-configuration/slice-close-summary.md](specs/008-configuration/slice-close-summary.md) — slice close summary (created by T076)

**Backend (Supabase):**
- [supabase/migrations/0077_configuration.sql](supabase/migrations/0077_configuration.sql) — configuration_versions + secrets + locking/scoring/import RPCs + RLS (single mega-migration)
- [supabase/tests/008_configuration/README.md](supabase/tests/008_configuration/README.md) — pgTAP test suite overview
- [supabase/tests/008_configuration/upsert_authorization.sql](supabase/tests/008_configuration/upsert_authorization.sql) — upsert RBAC (T024)
- [supabase/tests/008_configuration/upsert_concurrency.sql](supabase/tests/008_configuration/upsert_concurrency.sql) — optimistic concurrency check (T025)
- [supabase/tests/008_configuration/upsert_validation.sql](supabase/tests/008_configuration/upsert_validation.sql) — schema + business-rule validation (T026)
- [supabase/tests/008_configuration/eligibility_preview_affecting.sql](supabase/tests/008_configuration/eligibility_preview_affecting.sql) — affected-participants preview (T029)
- [supabase/tests/008_configuration/locking_window_consumer_check.sql](supabase/tests/008_configuration/locking_window_consumer_check.sql) — locking window consumer wiring (T032)
- [supabase/tests/008_configuration/scoring_consumer_check.sql](supabase/tests/008_configuration/scoring_consumer_check.sql) — scoring consumer wiring (T036)
- [supabase/tests/008_configuration/get_secret_authorization.sql](supabase/tests/008_configuration/get_secret_authorization.sql) — provider-secret RBAC (T042)
- [supabase/tests/008_configuration/rollback_happy.sql](supabase/tests/008_configuration/rollback_happy.sql) — rollback happy path (T049)
- [supabase/tests/008_configuration/rollback_retention.sql](supabase/tests/008_configuration/rollback_retention.sql) — rollback retention pruning (T050)
- [supabase/tests/008_configuration/import_signature.sql](supabase/tests/008_configuration/import_signature.sql) — HMAC signature verification (T058)
- [supabase/tests/008_configuration/import_validation_aggregate.sql](supabase/tests/008_configuration/import_validation_aggregate.sql) — bulk-import aggregate validation (T059)
- [supabase/tests/008_configuration/webhook_dispatch.sql](supabase/tests/008_configuration/webhook_dispatch.sql) — config-change webhook dispatch + retry (T067)
- [supabase/tests/008_configuration/config_read_fail_closed.sql](supabase/tests/008_configuration/config_read_fail_closed.sql) — fail-closed when config read errors (T068)
- [supabase/tests/008_configuration/consumer_migrations.sql](supabase/tests/008_configuration/consumer_migrations.sql) — cross-slice consumer migration regression (T070)
- [supabase/tests/007_audit_trail/action_label_catalog.sql](supabase/tests/007_audit_trail/action_label_catalog.sql) — extended by T072 to cover slice 008 action labels

**Web (Next.js) — lib helpers:**
- [apps/web/lib/config-client.ts](apps/web/lib/config-client.ts) — configuration RPC client + rollback/history helpers (T017, extended by T040/T048)
- [apps/web/lib/config-validators.ts](apps/web/lib/config-validators.ts) — client-side config schema + business-rule validators (T018)
- [apps/web/lib/hmac.ts](apps/web/lib/hmac.ts) — Web Crypto HMAC verification for import signatures (T019)

**Web (Next.js) — admin config UI:**
- [apps/web/app/admin/config/page.tsx](apps/web/app/admin/config/page.tsx) — admin config landing page (T023)
- [apps/web/app/admin/config/ConfigField.tsx](apps/web/app/admin/config/ConfigField.tsx) — shared form-field component (T020)
- [apps/web/app/admin/config/PreviewWarning.tsx](apps/web/app/admin/config/PreviewWarning.tsx) — eligibility-preview banner (T021)
- [apps/web/app/admin/config/VersionTimeline.tsx](apps/web/app/admin/config/VersionTimeline.tsx) — version timeline component (T022)
- [apps/web/app/admin/config/domains/page.tsx](apps/web/app/admin/config/domains/page.tsx) — eligibility domains editor page (T027)
- [apps/web/app/admin/config/domains/DomainsEditor.tsx](apps/web/app/admin/config/domains/DomainsEditor.tsx) — domains editor client component (T027)
- [apps/web/app/admin/config/locking/page.tsx](apps/web/app/admin/config/locking/page.tsx) — locking-window editor page (T030)
- [apps/web/app/admin/config/locking/LockingEditor.tsx](apps/web/app/admin/config/locking/LockingEditor.tsx) — locking editor client component (T030)
- [apps/web/app/admin/config/scoring/page.tsx](apps/web/app/admin/config/scoring/page.tsx) — scoring + tie-breaker editor page (T033)
- [apps/web/app/admin/config/scoring/ScoringEditor.tsx](apps/web/app/admin/config/scoring/ScoringEditor.tsx) — scoring editor client component (T033)
- [apps/web/app/admin/config/providers/page.tsx](apps/web/app/admin/config/providers/page.tsx) — OIDC providers editor page (T039)
- [apps/web/app/admin/config/providers/ProvidersEditor.tsx](apps/web/app/admin/config/providers/ProvidersEditor.tsx) — providers editor client component (T039)
- [apps/web/app/admin/config/providers/segments.ts](apps/web/app/admin/config/providers/segments.ts) — provider config segment helpers (T039)
- [apps/web/app/admin/config/admin-roles/page.tsx](apps/web/app/admin/config/admin-roles/page.tsx) — admin-roles editor page (T040)
- [apps/web/app/admin/config/admin-roles/AdminRolesEditor.tsx](apps/web/app/admin/config/admin-roles/AdminRolesEditor.tsx) — admin-roles editor client component (T040)
- [apps/web/app/admin/config/phases/page.tsx](apps/web/app/admin/config/phases/page.tsx) — phases / scheduling editor page (T041)
- [apps/web/app/admin/config/phases/PhasesEditor.tsx](apps/web/app/admin/config/phases/PhasesEditor.tsx) — phases editor client component (T041)
- [apps/web/app/admin/config/history/page.tsx](apps/web/app/admin/config/history/page.tsx) — version history + rollback page (T048)
- [apps/web/app/admin/config/history/HistoryView.tsx](apps/web/app/admin/config/history/HistoryView.tsx) — history view client component (T048)
- [apps/web/app/admin/config/import-export/page.tsx](apps/web/app/admin/config/import-export/page.tsx) — bulk import/export page (T054)
- [apps/web/app/admin/config/import-export/ImportExportPanel.tsx](apps/web/app/admin/config/import-export/ImportExportPanel.tsx) — import/export client panel (T054)
- [apps/web/app/admin/config/retention/page.tsx](apps/web/app/admin/config/retention/page.tsx) — retention policy editor page (T066)
- [apps/web/app/admin/config/retention/RetentionEditor.tsx](apps/web/app/admin/config/retention/RetentionEditor.tsx) — retention editor client component (T066)

**Web (Next.js) — API route handlers:**
- [apps/web/app/api/admin/config/preview/route.ts](apps/web/app/api/admin/config/preview/route.ts) — eligibility preview endpoint (T027)
- [apps/web/app/api/admin/config/upsert/route.ts](apps/web/app/api/admin/config/upsert/route.ts) — config upsert endpoint (T027)
- [apps/web/app/api/admin/config/get-secret/route.ts](apps/web/app/api/admin/config/get-secret/route.ts) — provider secret retrieval endpoint (T039)
- [apps/web/app/api/admin/config/grant-admin-role/route.ts](apps/web/app/api/admin/config/grant-admin-role/route.ts) — grant admin role endpoint (T040)
- [apps/web/app/api/admin/config/revoke-admin-role/route.ts](apps/web/app/api/admin/config/revoke-admin-role/route.ts) — revoke admin role endpoint (T040)
- [apps/web/app/api/admin/participants/search/route.ts](apps/web/app/api/admin/participants/search/route.ts) — participant search endpoint for admin-role grants (T040)
- [apps/web/app/api/admin/config/rollback/route.ts](apps/web/app/api/admin/config/rollback/route.ts) — config rollback endpoint (T048)
- [apps/web/app/api/admin/config/export/route.ts](apps/web/app/api/admin/config/export/route.ts) — signed-bundle export endpoint (T055)
- [apps/web/app/api/admin/config/import/route.ts](apps/web/app/api/admin/config/import/route.ts) — signed-bundle import endpoint (T056)

**Playwright tests:**
- [apps/web/tests/playwright/config-domains.spec.ts](apps/web/tests/playwright/config-domains.spec.ts) — domains editor E2E (T028)
- [apps/web/tests/playwright/config-locking.spec.ts](apps/web/tests/playwright/config-locking.spec.ts) — locking editor E2E (T031)
- [apps/web/tests/playwright/config-scoring.spec.ts](apps/web/tests/playwright/config-scoring.spec.ts) — scoring editor E2E (T034)
- [apps/web/tests/playwright/config-tiebreaker.spec.ts](apps/web/tests/playwright/config-tiebreaker.spec.ts) — tie-breaker editor E2E (T035)
- [apps/web/tests/playwright/config-providers.spec.ts](apps/web/tests/playwright/config-providers.spec.ts) — providers editor E2E (T043)
- [apps/web/tests/playwright/config-admin-roles.spec.ts](apps/web/tests/playwright/config-admin-roles.spec.ts) — admin-roles editor E2E (T044)
- [apps/web/tests/playwright/config-phases.spec.ts](apps/web/tests/playwright/config-phases.spec.ts) — phases editor E2E (T045)
- [apps/web/tests/playwright/config-history-rollback.spec.ts](apps/web/tests/playwright/config-history-rollback.spec.ts) — history view + rollback E2E (T051)
- [apps/web/tests/playwright/config-import-export.spec.ts](apps/web/tests/playwright/config-import-export.spec.ts) — bulk import/export E2E (T060)
- [apps/web/tests/playwright/config-fail-closed.spec.ts](apps/web/tests/playwright/config-fail-closed.spec.ts) — fail-closed UX E2E (T069)
- [apps/web/tests/playwright/config-cross-slice-regression.spec.ts](apps/web/tests/playwright/config-cross-slice-regression.spec.ts) — cross-slice regression E2E (T071)

**Scripts:**
- [scripts/config/sign-import.sh](scripts/config/sign-import.sh) — HMAC sign config import bundles for the import endpoint (T057)

**Documentation:**
- [docs/runbooks/audit-write-failure.md](docs/runbooks/audit-write-failure.md) — extended by T067 (webhook-dispatch section) and T075 (slice 008+ operational addendum)

> **Note:** the auto-generated **Repository Map** section below does not yet reflect slice 007 or slice 008 files. Run `./scripts/index/generate.sh` after merge to refresh it.

<!-- GENERATED:START -->
## Repository Map

```
.
├── .claude/
│   ├── skills/
│   │   ├── bootstrap.md
│   │   ├── encrypt.md
│   │   ├── reindex.md
│   │   └── secrets-audit.md
│   ├── instructions.md
│   └── settings.json
├── .github/
│   └── workflows/
│       └── ci.yml                 # CI regression gate (typecheck / playwright / pgtap)
├── .githooks/
│   └── pre-commit
├── apps/
│   └── web/                       # Next.js App Router app (slice 001+)
│       ├── app/                   # Next.js routes (auth/, api/me, …)
│       ├── lib/                   # Cross-slice helpers (auth, types)
│       ├── tests/playwright/      # Playwright E2E specs
│       └── package.json
├── docs/
│   ├── architecture/
│   │   ├── acceptance-criteria.md
│   │   ├── high-level-architecture.md
│   │   ├── Nortal_World_Cup_2026_Prediction_Pool_High_Level_Architecture_EN.docx
│   │   ├── open-decisions.md
│   │   ├── README.md
│   │   ├── scoring-model.md
│   │   └── stack-decision.md
│   └── secrets-guide.md
├── infra/
│   └── oidc-stub/                 # DEV-ONLY fake OIDC IdP for Playwright (see its README.md)
├── scripts/
│   ├── index/
│   │   ├── generate.sh
│   │   └── generate_index.py
│   ├── secrets/
│   │   ├── audit.sh
│   │   ├── decrypt_all.sh
│   │   ├── encrypt_all.sh
│   │   └── gen_keys.sh
│   ├── bootstrap.sh
│   └── install_hooks.sh
├── secrets/
│   ├── enc/
│   │   └── .gitkeep
│   ├── manifest.json
│   └── recipients.txt
├── specs/                         # Spec Kit slices (001-eligibility-login, …)
├── supabase/                      # Supabase backend (slice 001+)
│   ├── config.toml                # Supabase project config (auth hooks, external IdPs, …)
│   ├── functions/                 # Edge Functions (empty in slice 001)
│   ├── migrations/                # SQL migrations (participants, RLS, auth hooks, …)
│   ├── seed/                      # Deterministic test fixtures
│   └── tests/pgtap/               # pgTAP SQL tests
├── .gitignore
├── CLAUDE.md
├── CLAUDE_START.md
├── INDEX.md
├── README.md
└── docker-compose.override.yml    # DEV-ONLY: wires the OIDC stub sidecar into `supabase start`
```
<!-- GENERATED:END -->
