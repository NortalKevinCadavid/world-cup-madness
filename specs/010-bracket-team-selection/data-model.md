# Phase 1 Data Model: World Cup Bracket Team Selection

Additive only — no existing slice-001–009 table is modified. New objects live in migrations 0084–0089.

## Entity 1 — `bracket_matchups` (tournament structure; global seed data)

The fixed single-elimination shape. 31 rows total per tournament.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | stable per matchup |
| `round` | enum (`r32`,`r16`,`qf`,`sf`,`final`) | knockout round |
| `position` | int | 1-based slot within the round (R32: 1–16, R16: 1–8, QF: 1–4, SF: 1–2, Final: 1) |
| `team_a_id` | uuid NULL → `teams(id)` | seeded only for R32; NULL for later rounds (resolved from winners) |
| `team_b_id` | uuid NULL → `teams(id)` | seeded only for R32 |
| `next_matchup_id` | uuid NULL → `bracket_matchups(id)` | where the winner advances; NULL for the Final |
| `next_slot` | char(1) NULL (`A`/`B`) | which competitor slot of the next matchup the winner fills; NULL for the Final |

**Validation / invariants**
- Exactly 16 `r32` + 8 `r16` + 4 `qf` + 2 `sf` + 1 `final` rows (= 31).
- Every non-`final` row has a `next_matchup_id` + `next_slot`; the `final` row has neither.
- R32 rows MUST have both `team_a_id` and `team_b_id`; non-R32 rows MUST have both NULL.
- `(round, position)` unique.

**RLS**: world-readable to authenticated eligible participants (structure is not secret). No write for `authenticated`.

## Entity 2 — `bracket_picks` (per-participant winner selections)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `participant_id` | uuid → `participants(id)` | owner |
| `matchup_id` | uuid → `bracket_matchups(id)` | which matchup |
| `winner_team_id` | uuid → `teams(id)` | the picked winner |
| `created_at` / `updated_at` | timestamptz | |

**Validation / invariants**
- `(participant_id, matchup_id)` unique — one winner per matchup per participant (FR-004).
- `winner_team_id` MUST be one of the matchup's resolved competitors (R32: `team_a_id`/`team_b_id`; later rounds: the winners feeding `next_slot` A/B). Enforced in the pick-write path + revalidated at submit.
- Changing an upstream pick clears downstream picks made impossible (R-005); the cascade deletes the now-invalid `bracket_picks` rows.

**RLS** (mirrors `predictions` slice-003):
- `bracket_picks_self_read`: `participant_id IN (SELECT id FROM participants WHERE auth_user_id = auth.uid())`.
- `bracket_picks_self_write`: same predicate, INSERT/UPDATE/DELETE, only while not locked (lock re-checked in the write path, not just RLS).
- `bracket_picks_admin_read`: `is_admin(auth.uid())`.

## Entity 3 — `bracket_submissions` (per-participant submit state)

| Column | Type | Notes |
|--------|------|-------|
| `participant_id` | uuid PK → `participants(id)` | one row per participant |
| `submission_status` | enum (`draft`,`complete`,`submitted`,`locked`) | derived/asserted state |
| `submitted_at` | timestamptz NULL | set when `submit_bracket` succeeds |
| `version` | int | bump on each submit (audit linkage) |

**State transitions**
```
draft ──(all 31 picks present)──▶ complete ──(submit_bracket)──▶ submitted ──(first_kickoff_utc reached)──▶ locked
  ▲                                                                  │
  └──────────────(pick removed / cascade clears one)────────────────┘   (only while now() < first_kickoff_utc)
```
- `draft`/`complete` are computed by `bracket_status` from picks; they need not be persisted, but `submitted`/`locked` are asserted by the RPC + lock.
- Re-submission (Q3 / FR-028): while `now() < first_kickoff_utc`, a participant may edit after submitting and submit again; each submit supersedes the prior (bump `version`). Submission does not freeze the bracket — only the lock does.
- At lock (Q4 / FR-029): once `now() >= first_kickoff_utc`, the read-time overlay reports `locked` for every bracket. A bracket that was complete-but-unsubmitted at lock is treated as auto-accepted (its picks stand as the final entry); an incomplete bracket is frozen read-only **as incomplete** and is NOT a valid submission. Because this slice has no scoring (Non-Goals), "auto-accepted" affects only the displayed status and the post-lock peer view's eligibility to show the bracket — a future scoring slice consumes this distinction.

**RLS**: self-read + admin-read; writes only via the `submit_bracket` RPC (no direct `authenticated` INSERT/UPDATE).

## Derived — `bracket_status(p_participant_id)` function

Single source of truth (R-004). Returns:

| Field | Meaning |
|-------|---------|
| `total_required` | count of matchups requiring a pick = 31 |
| `completed` | count of the participant's valid picks |
| `is_complete` | `completed == total_required` |
| `missing_matchup_ids` | required matchups with no valid pick |
| `submission_status` | `locked` if `now() >= first_kickoff_utc`; else `submitted` if a submission row exists; else `complete` if `is_complete`; else `draft` |

## View 1 — `bracket_v` (own bracket read)

`security_invoker = true`. Joins `bracket_matchups` + the caller's `bracket_picks` + `bracket_status`. Self-RLS on `bracket_picks` restricts to the caller. Resolves later-round competitors from the caller's upstream winners so the UI can render the live tree.

## View 2 — `bracket_peer_v` (post-lock peer read)

`security_invoker = false` (DEFINER — see R-002). View body enforces:
- `now() >= (SELECT (value #>> '{}')::timestamptz FROM tournament_config WHERE key = 'first_kickoff_utc')` (lock passed), AND
- `participant_id <> (SELECT id FROM participants WHERE auth_user_id = auth.uid())` (self-exclusion — own bracket is served by `bracket_v`).
Returns zero rows before lock (FR-017/FR-018). Display-name masking mirrors `leaderboard_v` visibility config.

## Audit linkage (Principle V)

`submit_bracket` writes one `audit_log` row per successful submit: `action='bracket.submitted'`, `actor=<auth.uid()>`, `entity_type='bracket'`, `entity_id=<participant_id>`, `new_value` = `{version, completed, total_required}`, in the same transaction as the `bracket_submissions` write.

## Relationship to existing entities

- **`teams`** (slice 002): read-only source of flags/names. No change.
- **`participants`** (slice 001): owner FK + eligibility. No change.
- **`tournament_config.first_kickoff_utc`** (slice 004): lock signal. Read-only. No change.
- **slice-004 `final_predictions`**: **no relationship** — standalone per Q2 (FR-025).
