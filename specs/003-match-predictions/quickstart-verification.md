# Slice 003 — Quickstart end-to-end verification

**Slice**: 003 — Match Predictions with Locking
**Date**: 2026-05-20
**Reference**: `specs/003-match-predictions/quickstart.md` § Manual verification checklist (steps 1–14) + Constitution Principle X (vertical slice delivery)

## Status: DEFERRED

All 14 manual-verification steps are deferred until the operator brings up the local stack (Docker Desktop + `supabase start` + `pnpm -F web dev`). Each row below is a template the operator replaces with PASS / FAIL + exact terminal output.

## Prerequisites

Before running the checklist:

- [ ] Docker Desktop is running.
- [ ] `supabase start` succeeded; `supabase status` shows all containers UP.
- [ ] `supabase db reset` succeeded (loads 32 migrations + 3 seed fixtures).
- [ ] `apps/web/.env.local` is populated with the env vars listed in `apps/web/.env.example` (slice 001 + slice 002 inherited + slice 003 has no new env vars).
- [ ] `pnpm -F web dev` is running on `http://localhost:3000`.
- [ ] `pnpm -F web exec tsc --noEmit` exits 0.
- [ ] OIDC stub container is healthy (slice 001 `infra/oidc-stub/`).
- [ ] Optional: `LOCAL_ALPHA_JWT` env var set (issued by the OIDC stub for alpha). See `quickstart.md` § Run the slice end-to-end for the helper script if one exists.

## Verification matrix (14 steps)

| # | Step | Status | Output |
|---|---|---|---|
| 1 | Submit a valid prediction > 60 min before kickoff (FR-001 / US1.1) | DEFERRED | _replace with PASS/FAIL + exact `psql` + audit output_ |
| 2 | Edit a prediction > 60 min before kickoff (FR-003 / US2.1) | DEFERRED | _replace with chain query output + audit row pair_ |
| 3 | Edit attempt at exactly kickoff − 60 min — REJECTED (FR-004 / US3.1) | DEFERRED | _expected 409 `lock_window_passed`_ |
| 4 | Edit attempt 59 min before kickoff — REJECTED (FR-004 / US3.2) | DEFERRED | _same 409 + audit row_ |
| 5 | Edit attempt at kickoff − 60 min + 1 second — ACCEPTED (US3.5 / SC-001) | DEFERRED | _expected 200 OK; prediction stored_ |
| 6 | Direct API attempt inside lock window — REJECTED at API gate (FR-006 / US3.3) | DEFERRED | _expected 409 `lock_window_passed` via curl_ |
| 7 | Client clock manipulation IGNORED (US3.4 / BR-LOCK-001) | DEFERRED | _expected 409; server clock wins_ |
| 8 | Started match — REJECTED regardless of remaining time (BR-LOCK-004) | DEFERRED | _expected 409 `match_status_locked`_ |
| 9 | Cancelled match — predictions preserved, new edits REJECTED | DEFERRED | _prior pick visible; new submit 409_ |
| 10 | Score upper bound enforcement (FR-008) | DEFERRED | _expected 400 from route OR WCM03 from SP_ |
| 11 | Configuration change responsiveness (SC-005) | DEFERRED | _flip lock_window 60→180→60; verify next call respects_ |
| 12 | Concurrent submissions (FR-009 / SC-003) | DEFERRED | _both 200; exactly one active row_ |
| 13 | Personal predictions read (FR-002 / R-013) | DEFERRED | _alpha sees only alpha; beta sees only beta_ |
| 14 | Audit trail completeness (FR-011 / SC-007) | DEFERRED | _full trail per step sequence_ |

**Tally:** 0/14 PASS, 0/14 FAIL, 14/14 DEFERRED.

## Pre-merge directive

Slice 003 cannot merge until this file shows **14/14 PASS** with exact terminal output recorded in the "Output" column. If any step FAILs:

1. Capture the failure mode (HTTP code, audit row missing, `psql` count mismatch, etc.).
2. File a bug task referencing the failing step's contract clause.
3. Pause Phase 7 sign-off until the bug is resolved.

## Notes for the operator

- **Step 3 / Step 5 timing**: matches calibrated to "exactly 60 min" or "60 min + 1 sec" require fresh fixtures (the slice-003 seed timestamps are fixed at 2026-06-XX which from 2026-05-20 is ~22-30 days out). Either use the synthetic-match Playwright pattern (`dddd0000-...` UUIDs in T025/T029) or update the seed to relative timestamps before running. The simplest path: use `psql -c "INSERT INTO matches (...) VALUES (id, now() + interval '60 min', 'scheduled', ...)"` for each boundary scenario.

- **Step 11 restore**: the test restores `lock_window_minutes = 60` after running. If you abort midway, run `psql -c "UPDATE tournament_config SET value='60'::jsonb WHERE key='lock_window_minutes'"` manually.

- **Step 12 concurrency**: use two distinct browser contexts (different incognito windows) or two `curl` commands fired via `&` in a bash subshell. The advisory lock in `submit_prediction` serializes them at the SP level — both should return 200.

- **Step 14 audit query**: filter by `entity_type='prediction' AND occurred_at >= <step-1-start-time>` to scope to your run; the table accumulates audit history.
