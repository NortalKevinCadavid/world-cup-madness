# World Cup Madness

An internal Nortal prediction pool for the FIFA World Cup 2026 — a "March Madness for soccer." Eligible Nortal employees sign in via corporate identity, predict match scores (locked one hour before kickoff) plus four tournament-wide picks (champion, runner-up, top scorer, best player; locked at first kickoff), and compete on a live leaderboard scored automatically against official results.

## Where to start

- [docs/architecture/README.md](docs/architecture/README.md) — index of all product/architecture artifacts
- [docs/architecture/high-level-architecture.md](docs/architecture/high-level-architecture.md) — full Nortal architecture document
- [docs/architecture/acceptance-criteria.md](docs/architecture/acceptance-criteria.md) — test scenarios and acceptance criteria
- [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md) — unresolved questions (OD-001…OD-008)
- [docs/architecture/scoring-model.md](docs/architecture/scoring-model.md) — locking + scoring + tie-breakers
- [docs/architecture/stack-decision.md](docs/architecture/stack-decision.md) — proposed implementation stack (draft ADR)

## Repository infrastructure

This repository uses a standardized pattern for:
- **Repository organization** via an auto-generated INDEX
- **Secret management** with local plaintext (gitignored) and encrypted (committed) secrets using age
- **Pre-commit enforcement** to prevent accidental secret leaks
- **Claude Code integration** with startup instructions

## Quick Start

### First-Time Setup

```bash
# Clone the repository
git clone <repository-url>
cd <repository-name>

# Run bootstrap (requires age to be installed)
./scripts/bootstrap.sh
```

### Prerequisites

| Tool | Check | Install (macOS) |
|------|-------|-----------------|
| Git 2.9+ | `git --version` | `brew install git` |
| Python 3.9+ | `python3 --version` | `brew install python` |
| age | `age --version` | `brew install age` |

## Directory Structure

```
.
├── .claude/           # Claude Code instructions
├── .githooks/         # Git hooks (pre-commit)
├── docs/              # Documentation
├── scripts/           # Automation scripts
│   ├── bootstrap.sh   # First-time setup
│   ├── install_hooks.sh
│   ├── index/         # INDEX.md generation
│   └── secrets/       # Secret encryption/decryption
├── secrets/
│   ├── plain/         # Plaintext secrets (gitignored)
│   ├── enc/           # Encrypted secrets (committed)
│   ├── recipients.txt # Public keys for encryption
│   └── manifest.json  # Secret metadata
├── CLAUDE.md          # Project nickname and agent rules
├── CLAUDE_START.md    # Agent getting started guide
├── INDEX.md           # Repository map (auto-generated)
└── README.md          # This file
```

## Secrets Workflow

### Creating Secrets

1. Create plaintext file in `secrets/plain/`:
   ```bash
   echo "API_KEY=secret123" > secrets/plain/my_secret.env
   ```

2. Encrypt all secrets:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

3. Commit encrypted files:
   ```bash
   git add secrets/enc/ secrets/manifest.json
   git commit -m "Add encrypted secret"
   ```

### Decrypting Secrets

After cloning or pulling:
```bash
./scripts/secrets/decrypt_all.sh
```

### Adding Team Members

1. Get their public key (they run `age-keygen` and share the `age1...` line)
2. Add to `secrets/recipients.txt`
3. Re-encrypt: `./scripts/secrets/encrypt_all.sh`
4. Commit and push

## Pre-commit Hook

The pre-commit hook blocks commits containing:
- Files in `secrets/plain/`
- Files matching `*.env`, `.env.*`, `*.pem`, `*.key`, `credentials.*`

To bypass (not recommended):
```bash
git commit --no-verify
```

## INDEX.md

The repository map in INDEX.md is auto-generated. To update:
```bash
./scripts/index/generate.sh
```

Human-editable sections are preserved across regenerations.

## Claude Code Integration

This repository is configured for Claude Code with:
- `CLAUDE_START.md` - Entry point for agents
- `CLAUDE.md` - Project nickname and behavior rules
- `.claude/instructions.md` - Detailed agent guidance
- `INDEX.md` - Repository structure for context

Agents are instructed to read these files first in any session.
