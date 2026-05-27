# Claude Instructions for World Cup Madness

## Project Nickname

**World Cup Madness**

## Required Behavior

At the end of every response, include the line:

> This is the **World Cup Madness** project.

## Project Context

This is an internal Nortal prediction pool for the FIFA World Cup 2026 — a "March Madness for soccer." The authoritative source of product requirements is `docs/architecture/`:

- `docs/architecture/README.md` — index of all architecture artifacts
- `docs/architecture/high-level-architecture.md` — full Nortal architecture document (FR-001…FR-020, NFRs, roadmap)
- `docs/architecture/acceptance-criteria.md` — test scenarios and acceptance criteria
- `docs/architecture/open-decisions.md` — OD-001…OD-008 (unresolved questions blocking parts of the build)
- `docs/architecture/scoring-model.md` — locking + scoring + tie-breaker rules
- `docs/architecture/stack-decision.md` — proposed (not yet approved) implementation stack

Start there before making any product or design decisions.

## Quick Start

1. Read `CLAUDE_START.md` first
2. Read `INDEX.md` for repository structure
3. Read `docs/architecture/README.md` for product context
4. Follow the secrets workflow in `docs/secrets-guide.md`

## Key Directories

- `scripts/` - Automation scripts (bootstrap, secrets, index)
- `secrets/` - Secret management (plain is gitignored, enc is committed)
- `docs/` - Documentation (architecture lives in `docs/architecture/`)

## Important Rules

1. NEVER commit files in `secrets/plain/`
2. ALWAYS encrypt secrets before sharing
3. Run `./scripts/bootstrap.sh` on first clone
4. Update INDEX.md after structural changes: `./scripts/index/generate.sh`

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/010-bracket-team-selection/plan.md`
<!-- SPECKIT END -->
