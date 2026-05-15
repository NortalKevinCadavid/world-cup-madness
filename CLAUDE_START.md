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
