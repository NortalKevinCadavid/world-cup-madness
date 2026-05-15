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
├── .githooks/
│   └── pre-commit
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
├── .gitignore
├── CLAUDE.md
├── CLAUDE_START.md
├── INDEX.md
└── README.md
```
<!-- GENERATED:END -->
