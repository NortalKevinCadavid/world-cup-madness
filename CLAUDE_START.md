# Getting Started with World Cup Madness

## First Steps

1. Read this file completely
2. Read `INDEX.md` for the repository structure
3. Read `CLAUDE.md` for project-specific instructions
4. Read `docs/architecture/README.md` for product context (FRs, scoring, open decisions)

## Key Directories

- `scripts/` - Automation scripts (bootstrap, secrets, index)
- `secrets/` - Secret management (plain is gitignored, enc is committed)
- `docs/` - Documentation

## Important Rules

1. NEVER commit files in `secrets/plain/`
2. ALWAYS encrypt secrets before sharing
3. Run `./scripts/bootstrap.sh` on first clone

## First-Time Setup

If you just cloned this repository:

```bash
./scripts/bootstrap.sh
```

This will:
- Install git hooks to prevent secret leaks
- Generate your encryption keys (if needed)
- Add your public key to the recipients list
- Regenerate INDEX.md

## Secrets Workflow

### Creating a new secret

```bash
# Create the plaintext file
echo "API_KEY=your_secret" > secrets/plain/my_secret.env

# Encrypt all plaintext secrets
./scripts/secrets/encrypt_all.sh

# Commit the encrypted version
git add secrets/enc/ secrets/manifest.json
git commit -m "Add encrypted secret"
```

### Getting secrets from teammates

```bash
# After pulling, decrypt the secrets
./scripts/secrets/decrypt_all.sh
```

## Index Management

The `INDEX.md` file contains a repository map. To update it:

```bash
./scripts/index/generate.sh
```

## Slice 001 (Eligibility & Login)

Active slice: see [`specs/001-eligibility-login/plan.md`](specs/001-eligibility-login/plan.md).

Slice 001 introduces the foundational app skeleton this repo did not have before:
the Next.js App Router project at `apps/web/`, the Supabase backend at
`supabase/` (migrations, seed fixtures, pgTAP tests, Edge Functions placeholder,
`config.toml` wiring the auth hooks and external IdP), the DEV-ONLY OIDC stub
under `infra/oidc-stub/` plus its `docker-compose.override.yml` sidecar wiring,
and the CI regression gate at `.github/workflows/ci.yml`. Production auth is
Microsoft Entra ID; the OIDC stub is used only by Playwright in dev and CI.

Before working in this slice, also read the **Implementation deviations** log
near the top of [`specs/001-eligibility-login/tasks.md`](specs/001-eligibility-login/tasks.md)
— in particular **D-001** (Supabase CLI v2.98.2 does not support
`[auth.hook.before_user_signed_in]`, so the slice uses
`[auth.hook.custom_access_token]` instead; the PG function name
`public.handle_auth_user_signed_in` is unchanged). Later tasks (T040, T041,
`contracts/auth-hook.sql.md`) are written against the new key.
