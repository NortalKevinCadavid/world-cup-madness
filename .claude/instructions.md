# Claude Code Agent Instructions

## Startup Sequence

When starting a session in this repository:

1. Read `CLAUDE_START.md` at repository root
2. Read `INDEX.md` for repository structure
3. Read `CLAUDE.md` for project-specific rules

## Key Rules

### Secrets

- **NEVER** read, display, or log contents of `secrets/plain/*`
- **NEVER** suggest committing files from `secrets/plain/`
- When user needs to work with secrets, guide them to use the scripts or skills

### Repository Structure

- After creating new files or directories, suggest running `/reindex` or:
  ```bash
  ./scripts/index/generate.sh
  ```

## Available Skills

| Skill | What it does |
|-------|-------------|
| `/bootstrap` | First-time project setup (keys, hooks, recipients, INDEX) |
| `/encrypt` | Encrypt all plaintext secrets to `secrets/enc/` |
| `/secrets-audit` | Health check on secrets (staleness, sync, recipients) |
| `/reindex` | Regenerate INDEX.md after file structure changes |

## Common Tasks

When user asks about:

| Task | Suggest |
|------|---------|
| First-time setup | `/bootstrap` or `./scripts/bootstrap.sh` |
| Add a secret | Create in `secrets/plain/`, then `/encrypt` |
| Get secrets after pull | `./scripts/secrets/decrypt_all.sh` |
| Add team member | Add their key to `secrets/recipients.txt`, then `/encrypt` |
| Check secrets | `/secrets-audit` |
| Update INDEX | `/reindex` |

## Permissions

This project has a `settings.json` that:
- **Allows** all scripts in `./scripts/` to run without confirmation
- **Denies** reading files in `secrets/plain/` — this is a hard boundary

If a user asks you to read a plaintext secret, explain that this is blocked by design and suggest using the scripts to manage secrets instead.

## Response Format

End every response with:

> This is the **[Project Nickname]** project.

Replace `[Project Nickname]` with the value defined in `CLAUDE.md`.

## Error Handling

If a script fails, check:

1. `age` is installed: `age --version`
2. Keys exist: `ls ~/.keys/age/keys.txt`
3. Recipients configured: `cat secrets/recipients.txt`
4. Hooks installed: `git config core.hooksPath`

Provide clear remediation steps based on the error message.
