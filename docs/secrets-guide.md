# Secrets Management Guide

This project uses [age](https://github.com/FiloSottile/age) for secret encryption.

## Overview

| Location | Git Status | Purpose |
|----------|------------|---------|
| `secrets/plain/` | gitignored | Local working secrets |
| `secrets/enc/` | committed | Encrypted team secrets |
| `secrets/recipients.txt` | committed | Public keys for encryption |
| `secrets/manifest.json` | committed | Secret metadata |

## Setup

### First-Time Setup

Run bootstrap to generate your keys and register as a recipient:

```bash
./scripts/bootstrap.sh
```

This will:
1. Check that age is installed
2. Generate keys to `~/.keys/age/keys.txt` (if not present)
3. Add your public key to `secrets/recipients.txt`

### Installing age

```bash
# macOS
brew install age

# Linux (Debian/Ubuntu)
sudo apt install age

# From source
go install filippo.io/age/cmd/...@latest
```

## Daily Workflow

### Creating a New Secret

```bash
# 1. Create the plaintext file
echo "API_KEY=your_secret_value" > secrets/plain/api.env

# 2. Encrypt all plaintext secrets
./scripts/secrets/encrypt_all.sh

# 3. Verify encryption
ls secrets/enc/
# Output: api.env.age

# 4. Commit encrypted version
git add secrets/enc/ secrets/manifest.json
git commit -m "Add API secret"
```

### Getting Secrets After Pull

```bash
# Decrypt all encrypted secrets
./scripts/secrets/decrypt_all.sh

# Verify
cat secrets/plain/api.env
```

### Checking Secret Health

```bash
./scripts/secrets/audit.sh
```

This shows:
- Number of recipients configured
- Key file status
- List of plaintext and encrypted files
- Staleness warnings (files encrypted >30 days ago)

## Team Workflow

### Adding a New Team Member

1. Have them generate keys:
   ```bash
   age-keygen -o ~/.keys/age/keys.txt
   ```

2. They share their public key (the `age1...` line)

3. You add it to `secrets/recipients.txt`:
   ```bash
   echo "# teammate@example.com" >> secrets/recipients.txt
   echo "age1abc123..." >> secrets/recipients.txt
   ```

4. Re-encrypt all secrets:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

5. Commit and push:
   ```bash
   git add secrets/enc/ secrets/recipients.txt secrets/manifest.json
   git commit -m "Add teammate as recipient"
   git push
   ```

### Removing a Team Member

1. Remove their public key from `secrets/recipients.txt`
2. Re-encrypt all secrets: `./scripts/secrets/encrypt_all.sh`
3. Commit and push

Note: They can still decrypt any secrets encrypted before removal if they have copies.

## Key Management

### Key Location

Keys are stored at: `~/.keys/age/keys.txt`

This file contains both your secret key and public key:
```
# created: 2025-01-01T12:00:00Z
# public key: age1abc123...
AGE-SECRET-KEY-...
```

### Backing Up Keys

**Important**: If you lose your keys, you cannot decrypt secrets.

Options:
1. Store in a password manager
2. Print and store securely (the key is just text)
3. Store encrypted copy in secure location

### Rotating Keys

1. Generate new keys:
   ```bash
   age-keygen -o ~/.keys/age/keys.txt
   ```

2. Add new public key to recipients:
   ```bash
   grep "^age1" ~/.keys/age/keys.txt >> secrets/recipients.txt
   ```

3. Re-encrypt all secrets:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

4. Remove old public key from `recipients.txt` after all team members have updated

## Troubleshooting

### "age: command not found"

Install age (see Setup section above).

### "No recipients in recipients.txt"

Run bootstrap or manually add a recipient:
```bash
grep "^age1" ~/.keys/age/keys.txt >> secrets/recipients.txt
```

### "decryption failed: no identity matched"

Your key is not in the recipients list. Ask a team member to:
1. Add your public key to `recipients.txt`
2. Re-encrypt all secrets
3. Push the changes

### Pre-commit hook blocking commit

You're trying to commit a secret file. Either:
1. Remove from staging: `git reset HEAD <file>`
2. Encrypt first: `./scripts/secrets/encrypt_all.sh`
3. Add to `.gitignore` if not a secret

## Security Best Practices

1. **Never commit plaintext secrets** - The pre-commit hook helps prevent this
2. **Rotate keys periodically** - Especially when team members leave
3. **Audit regularly** - Run `audit.sh` to check for stale secrets
4. **Minimize recipients** - Only add people who need access
5. **Use specific files** - Don't put all secrets in one file
6. **Review before commit** - Check `git status` before committing
