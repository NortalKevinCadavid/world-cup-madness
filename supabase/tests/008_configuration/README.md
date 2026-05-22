# Slice 008 Tournament Configuration — pgTAP Tests

This directory contains pgTAP-style test fixtures for slice 008. Each `.sql` file is a self-contained pgTAP test wrapping `BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;` per project convention (mirrors slice 007's `supabase/tests/007_audit_trail/`).

## How to run

```powershell
# Single file
supabase test db --file supabase/tests/008_configuration/<filename>.sql

# CI loop
Get-ChildItem supabase/tests/008_configuration -Filter *.sql | ForEach-Object {
  supabase test db --file $_.FullName
}
```

## Reference
- Slice 007 testing pattern: `supabase/tests/007_audit_trail/`
- Contracts: `specs/008-configuration/contracts/`
- Spec: `specs/008-configuration/spec.md`
