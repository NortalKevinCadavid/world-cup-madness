# Slice 007 Audit Trail — pgTAP Tests

This directory contains pgTAP-style test fixtures for slice 007 (Audit Trail). Each `.sql` file is a single self-contained pgTAP test wrapping `BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;` per the project's testing convention (established in Slice 001).

## How to run

Per slice 001's testing pattern, these tests run via:

```powershell
# Run a single file
supabase test db --file supabase/tests/007_audit_trail/<filename>.sql

# Or via the standard pgTAP loop in CI:
Get-ChildItem supabase/tests/007_audit_trail -Filter *.sql | ForEach-Object {
  supabase test db --file $_.FullName
}
```

Tests in this directory exercise:
- T007: monotonic_ordering.sql — sequence_id is strictly increasing across sessions
- T008: action_label_catalog.sql — only known action labels appear in audit_log
- T010: tamper_resistance.sql — UPDATE/DELETE on audit_log fails for all application roles
- T014: audit_search_authorization.sql — non-admin caller of audit_search() raises WAT01
- T015: audit_search_errcodes.sql — input validation surfaces WAT02/WAT03 correctly
- Additional files per T016+ as Phase 5 progresses.

## Reference
- Slice 001 testing pattern: `supabase/tests/pgtap/` (existing directory)
- Contract: `specs/007-audit-trail/contracts/audit-log.schema.md` + `audit-search.read.md`
- Spec: `specs/007-audit-trail/spec.md`
