# Phase 0 Research: Match Catalog & Provider Sync

**Feature**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Complete — no spec-level `[NEEDS CLARIFICATION]` markers remain. OD-007 (provider integration runtime) stays open at the **runtime** level (the actual provider selection — football-data.org vs alternatives — is a launch-time decision); this slice resolves the **abstraction-pattern** unknowns so that whichever provider lands at launch plugs into the contract without rewriting downstream code.

## Scope of this document

Each entry follows the template `Decision / Rationale / Alternatives considered / Constitution anchor`. Decisions that resolve directly to a spec FR, an architecture §, a constitution principle, or a cross-slice contract are tagged.

This slice depends on **Slice 001** (eligibility + login) for `is_eligible_nortal_participant(auth.uid())`, the `participants` row shape, and the `audit_log` write pattern. It ships the cross-slice contracts every downstream slice (003 predictions, 004 final-predictions, 005 scoring/leaderboard, 006 admin overrides) builds on: the `matches` table, the `match_results` table (including the `home_score_for_scoring` split referenced by Slice 005), the `teams` table, and the `MatchDataProviderAdapter` TypeScript interface.

---

## R-001 — Provider abstraction shape

**Decision**. The provider abstraction is a **TypeScript interface `MatchDataProviderAdapter`** living in `apps/web/lib/providers/types.ts` (no — see below: it lives in a `supabase/functions/_shared/` directory so it can be imported by both the Edge Function and any Node-side tooling). Concrete adapters implement the interface and live under `supabase/functions/_shared/providers/<name>/`. The sync coordinator (R-002) is the only consumer; the Next.js participant client and every other slice's domain code consume the **normalized output** (rows in `matches` / `match_results` / `teams`), not the adapter.

The adapter surface is intentionally minimal: `fetchFixtures(window)`, `fetchResults(window)`, `fetchTeams()`. Each method returns a typed `NormalizedFixture[]` / `NormalizedResult[]` / `NormalizedTeam[]` defined in the same shared module. Adapters convert provider-specific JSON (football-data.org, sportradar, statsperform, anything) into these types and return them; they do not touch Postgres.

**Rationale**.
- FR-003, FR-004, FR-005 + Constitution Principle IV all converge on "provider replaceable without downstream code change." A single TypeScript interface implemented in one file (`supabase/functions/_shared/providers/footballdata/index.ts`) is the smallest surface that satisfies this.
- Adapters MUST NOT touch the DB so that the **transactional shape** (audit row + catalog mutation in one transaction, per FR-008 + Principle V) is owned entirely by the coordinator. A misbehaving adapter cannot corrupt the catalog mid-transaction.
- Locating adapters under `supabase/functions/_shared/` keeps them adjacent to the runtime that executes them (the Edge Function, R-002) and importable by Deno without bundling tricks.

**Alternatives considered**.
- *SQL-level adapter (a Postgres `FOREIGN DATA WRAPPER` pulling provider JSON via `pg_net` and parsing it in PL/pgSQL).* Rejected: provider JSON parsing, retry logic, and credential handling don't belong in Postgres; the constitution puts orchestration in Edge Functions and rules in SQL — this is orchestration.
- *Adapter as a `class` with a base abstract class.* Rejected: TypeScript interfaces are simpler, support structural typing, and produce no runtime artifact (no `super()` ceremony, no inheritance subtlety). Concrete adapters are stateless functions; the `class` model adds nothing.
- *Common HTTP-layer adapter that returns raw JSON and a separate normalizer per provider.* Rejected: pushes provider schema knowledge into the normalizer's input type; the contract goal is that the **shared module never knows the provider's schema**.

**Constitution anchor**. IV (Provider Abstraction), III (Rules Outside the UI — the adapter is integration, not rules).

---

## R-002 — Sync-runner topology

**Decision**. The sync coordinator is a **Supabase Edge Function** `supabase/functions/sync-catalog/index.ts` (Deno runtime) invoked on a schedule by **`pg_cron`** running inside the Supabase Postgres instance. `pg_cron` calls a Postgres SECURITY DEFINER wrapper `public.trigger_sync_catalog(provider text)` that issues `net.http_post(...)` against the Edge Function with an `X-Internal-Auth` header, exactly like Slice 005's auto-trigger pattern (Slice 005 tasks.md § T042). Default cadence: every 5 minutes during live tournament windows; configurable via `tournament_config.provider_sync.cadence_minutes` (default `5`).

The Edge Function itself is **not** exposed to participant clients. It accepts only the internal-auth header path; an admin-recalc path may be added by Slice 006 with its real `is_admin(auth.uid())` body.

**Rationale**.
- `pg_cron` lives **inside the database transaction boundary**, which means scheduled triggers are paused automatically during DB restarts / migrations / failovers. Vercel Cron and GitHub Actions both fire blindly during outages and would compound problems.
- Edge Functions ship as Deno, share the Supabase JWT helpers, and run on the same provider as the DB — observability and credential management collapse to a single stack.
- The `pg_net + X-Internal-Auth` pattern is already proved out by Slice 005 (its tasks.md T042 implements it for scoring auto-triggers). Reusing the same shape means one cross-cutting pattern across the codebase.

**Alternatives considered**.
- *Vercel Cron Jobs.* Rejected: cadence is shared with the Next.js deploy, harder to pause during incidents, can't acquire Postgres advisory locks naturally (R-006).
- *GitHub Actions on a cron schedule.* Rejected: GHA isn't reliable at minute-level cadence (5-minute drift is common), and credentials would have to live in GitHub.
- *A dedicated long-running worker (Kubernetes Job, ECS task).* Rejected: introduces a new runtime when Edge Function + `pg_cron` is sufficient; over-engineered for a tournament with bounded duration.

**Constitution anchor**. III (Rules Outside the UI — coordinator orchestrates, rules are in SQL), VII (Operational Resilience — same-platform stack).

---

## R-003 — Idempotent sync via deterministic UPSERT

**Decision**. Internal `matches.id` is a UUID generated by the **first** insert. A separate `match_provider_external_ids` table maps `(provider_name, provider_match_id) → match_id` with `UNIQUE (provider_name, provider_match_id)`. The sync coordinator looks up internal IDs via this table; if no mapping exists, it INSERTS a `matches` row and the mapping row in the same transaction. Subsequent runs UPDATE the existing `matches` row via the mapped UUID. Re-running the same sync against the same payload produces identical state (idempotent).

The same pattern is used for `match_provider_external_ids` ↔ `teams` (and, in Slice 004/005, for players).

**Rationale**.
- Spec FR-009 (duplicate ID rejection) plus FR-010 (single-run-at-a-time) plus the spec Edge Case "rate-limit mid-run, checkpoint progress" jointly require the sync to be safely retryable. UPSERT keyed by the mapping table is the simplest mechanism that survives partial-run interruption.
- Constitution Principle IV says provider IDs must be stored for traceability but MUST NOT replace internal IDs. The mapping table is the exact pattern §9.2 prescribes.
- Slice 005 already references `match_results.home_score_for_scoring` (its data-model.md § Entity 1 footnote on the `official_home` column). That column is owned by **this** slice; the schema and idempotency must support repeated re-syncs without ever flipping a finished-match score silently.

**Alternatives considered**.
- *Use `provider_match_id` directly as the PK of `matches`.* Rejected: forecloses provider replacement (Principle IV) and breaks Slice 005's join via `matches.id`.
- *Single matches table with `provider_id text` columns.* Rejected: doesn't scale beyond one provider (FR-005 requires runtime swap; we may have a fallback provider eventually).
- *Append-only matches rows with a version column.* Rejected: makes every downstream query filter on `current_version`, adds plumbing for no extra audit value (the `provider_sync_runs` ledger already captures the history).

**Constitution anchor**. IV, VII. Supports **FR-005, FR-009, FR-010, SC-005**.

---

## R-004 — Empty / undersized payload rejection

**Decision**. The sync coordinator's first action after fetching a provider response is a **payload sanity check**:

1. If `fetchFixtures()` returns zero rows AND `matches` already has rows for the same window: abort the run, mark `outcome='rejected_empty'`, write the audit row, fire alert (R-009). Do NOT mutate `matches`.
2. If `fetchFixtures()` returns a count `< 50%` of the catalog's existing count for that window: abort the run with `outcome='rejected_undersized'`, fire alert. The 50% threshold is configurable via `tournament_config.provider_sync.undersized_threshold` (default `0.5`).
3. If a single payload contains two rows with the same `(provider_name, provider_match_id)`: abort with `outcome='rejected_duplicate_in_payload'`, fire alert.

In all three rejection cases, the existing catalog is untouched. SC-002 ("zero user-visible errors during 24h provider unavailability") holds because participants continue reading the last-known-good state.

**Rationale**.
- Spec Edge Case "provider returns an empty payload for a previously-populated league" is explicit: empty MUST be treated as an error.
- The 50% threshold catches the "provider returned a partial result due to an internal upstream filter" failure mode without false-positive on legitimate small windows (the first few hours of the tournament where the day's matches genuinely number under 50% of the full bracket).
- Detecting duplicates in-payload is a separate check from the cross-payload conflict detection in R-005 — both must fire.

**Alternatives considered**.
- *Trust the provider; merge unconditionally.* Rejected: contradicts FR-006 and FR-009.
- *Hard-code the 50% threshold.* Rejected: Principle VIII (Extensibility) — pulled out to `tournament_config`.

**Constitution anchor**. II (fail-closed), VII (degraded mode preserves prior data), VIII. Supports **FR-006, FR-009, SC-002, SC-006**.

---

## R-005 — Cross-run conflict detection and quarantine

**Decision**. When a provider response differs in a load-bearing way from the existing `matches` row for the same provider mapping, the sync coordinator **does not silently UPDATE**. Instead it:

1. Computes the diff (changed fields).
2. If the change is **non-conflicting** (kickoff_utc within ± a small tolerance, venue update, status forward-transition `scheduled → in_progress → finished`) → UPDATE the matches row, write `outcome='applied'` audit row referencing both `previous_value` and `new_value`.
3. If the change is **conflicting** (team assignment changed, status backward-transition, score reported while `status != 'finished'`, kickoff change larger than the configured tolerance after a match has already locked per Slice 003) → do NOT UPDATE the row. Instead, INSERT a row into `match_pending_review (match_id, provider_observation jsonb, observed_at, reviewed_at NULL, reviewer NULL, resolution NULL)` and write `outcome='conflict_quarantined'`. Slice 006's admin UI surfaces these rows for human resolution.
4. Conflicting changes ALSO fire the administrator alert (R-009) and write a `audit_log` row with `action='match.conflict_quarantined'`.

The kickoff-tolerance default is **5 minutes** (provider clock drift on minor reschedules is common); configurable via `tournament_config.provider_sync.kickoff_tolerance_minutes`.

**Rationale**.
- Spec Edge Case "provider returns conflicting data across two consecutive syncs (e.g., team A vs team B at one time, team A vs team C the next)" requires the catalog to flag, not propagate.
- Spec Edge Case "provider returns scores for a not-yet-started match" requires rejection — this is a conflict case that gets quarantined.
- Spec FR-011 / BR-LOCK-004 — kickoff changes after lock get an audit row; Slice 003 decides whether predictions remain locked or re-open. This slice records and surfaces; it does not decide locking policy.
- Quarantine table (`match_pending_review`) keeps the conflict resolution out of the participant read path. Reads of `matches` see the last-confirmed state until an admin resolves.

**Alternatives considered**.
- *Auto-apply and audit.* Rejected: Principle II says administratively-correctable issues must require explicit action; silent overwrite of team assignments is a participation-eroding bug.
- *Reject the entire sync on any conflict.* Rejected: one anomalous match shouldn't block updates to 50 others.

**Constitution anchor**. II, V (audit + quarantine traceability), VII. Supports **FR-009, FR-011, SC-006**.

---

## R-006 — Single-sync-at-a-time concurrency (Postgres advisory lock)

**Decision**. The Edge Function's first non-trivial action is `SELECT pg_try_advisory_lock(hashtext('sync_catalog'), hashtext(provider_name))`. If `false`, the function returns `409 Conflict` immediately with body `{ "error": "sync already in flight" }`. If `true`, the function proceeds and the lock is released in a `finally` block.

The advisory lock is **session-scoped**, not transaction-scoped, so it covers the full duration of the sync run (including the audit-write step). If the Edge Function process dies, the session ends and the lock is auto-released — no manual cleanup.

**Rationale**.
- FR-010 (only one sync per provider concurrently) requires a serialization mechanism. Postgres advisory locks are the cheapest mechanism that survives a coordinator crash.
- The same pattern is used by Slice 005's `score-trigger` Edge Function (Slice 005 contracts/scoring-trigger.edge-fn.md). One cross-cutting pattern is easier to reason about than two.
- Per-provider locking (rather than global) means multiple providers — e.g., a primary + a fallback in a future iteration — can sync in parallel without contending.

**Alternatives considered**.
- *Application-level mutex (e.g., a Redis lock).* Rejected: introduces a new infrastructure dependency; Postgres advisory locks already exist.
- *Row-level lock on `provider_sync_state`.* Rejected: requires manual release on coordinator crash; advisory locks self-release.

**Constitution anchor**. VII. Supports **FR-010**.

---

## R-007 — Retry, backoff, and circuit-breaking

**Decision**. The Edge Function implements a **bounded retry loop**:

1. On a transient error from the adapter (HTTP 5xx, network error, timeout) — retry with exponential backoff `1s, 2s, 4s` (default), max 3 attempts per cycle. Configurable via `tournament_config.provider_sync.retry_policy` jsonb (`{ "max_attempts": 3, "initial_backoff_ms": 1000, "multiplier": 2 }`).
2. On HTTP 429 (rate-limited) — honor the provider's `Retry-After` header if present; otherwise back off as above.
3. On HTTP 4xx other than 429 — do NOT retry (it's a credential or contract problem, not a transient one). Mark the run `outcome='client_error'`, write audit row, fire alert.
4. After max attempts exhausted on a single cycle — mark `outcome='exhausted_retries'`, write audit row, increment the outage counter (R-009). Do NOT roll back any partial updates from previous *successful* cycles — those have their own audit rows.

The Edge Function returns within the Supabase 60-second runtime limit. Long retry chains that would exceed the limit are split across cycles (the next `pg_cron` invocation picks up).

**Rationale**.
- FR-007 explicitly calls out configurable retry + backoff + alert threshold.
- The 60-second Edge Function ceiling is a Supabase constraint; designing the coordinator around it is non-negotiable.
- Distinguishing 429 from generic 5xx lets us honor `Retry-After` (the polite-citizen pattern, prevents account suspension per architecture §10.5).

**Alternatives considered**.
- *Unbounded retry until success.* Rejected: violates the runtime ceiling and hammers a failing provider.
- *Skip backoff; immediate retry.* Rejected: amplifies provider load during an outage; trivially produces an account-suspension scenario.

**Constitution anchor**. VII. Supports **FR-007, SC-002**.

---

## R-008 — Sustained-outage alert deduplication ("exactly once per outage")

**Decision**. A separate `provider_sync_state` table holds one row per provider with:
- `last_success_at timestamptz`
- `first_failure_after_success_at timestamptz NULL` (set to `now()` on the **first** failure after a success; cleared on the next success)
- `outage_alerted_at timestamptz NULL` (set when the alert fires; cleared on the next success)

The Edge Function's final step writes the result to this state row. Alert fires **iff**:

```
first_failure_after_success_at IS NOT NULL
AND now() - first_failure_after_success_at > tournament_config.provider_sync.outage_alert_threshold_minutes
AND outage_alerted_at IS NULL
```

On alert: set `outage_alerted_at = now()`, emit the alert (Slack webhook / email / whatever Slice 008 configures via `tournament_config.notifications.*`), write `audit_log` row with `action='provider.outage_alert_emitted'`.

On the next successful sync: clear both `first_failure_after_success_at` and `outage_alerted_at`. Write an `audit_log` row with `action='provider.recovered'`.

**Rationale**.
- Spec FR-007 + SC-003 explicitly require **exactly one alert per sustained outage**. The "no flap-spam" requirement (SC-003) makes the dedup behavior load-bearing.
- Holding the dedup state in Postgres (rather than in the Edge Function's memory) means the dedup survives Edge-Function cold-starts and coordinator restarts.
- The "recovery audit event" lets ops verify the outage closed without paging on every success.

**Alternatives considered**.
- *Compute the threshold on every alert call.* Acceptable but doesn't address dedup; the `outage_alerted_at` field is what makes it once-per-outage.
- *Use an external alert manager (PagerDuty, Opsgenie) with its own dedup.* Acceptable but adds a service this slice doesn't yet need; revisit during Slice 008 when notification channels are formally chosen.

**Constitution anchor**. VII. Supports **FR-007, SC-003**.

---

## R-009 — Locale-aware display, canonical UTC storage

**Decision**. All timestamps (`matches.kickoff_utc`, `match_results.*_at`, `provider_sync_runs.*_at`) are stored as Postgres `timestamptz` with the convention that **all writes are UTC**. The Postgres session timezone is set to `UTC` in `supabase/config.toml` (`[db.settings] timezone = 'UTC'`). The Next.js participant client uses `Intl.DateTimeFormat` on the client to render the timestamp in the participant's browser locale. The server returns ISO-8601 UTC strings; the client never sees a localized string.

Lock decisions (Slice 003's `kickoff_utc - INTERVAL '60 minutes'`) operate directly on the `timestamptz` column. No business decision ever consumes a localized representation (Constitution Principle VI, BR-LOCK-001, BR-LOCK-006).

**Rationale**.
- FR-002 + Principle VI + BR-LOCK-006 are unambiguous: canonical UTC storage, localize for display only.
- Postgres `timestamptz` handles DST transparently — the same instant displayed in two locales straddling DST renders correctly without app-side fixup.
- ISO-8601 strings on the wire (rather than Unix epochs) make API responses human-readable in logs and audit trails, which helps disputes.

**Alternatives considered**.
- *Store everything as Unix epoch milliseconds.* Rejected: harder to debug, no DST nuance in storage, fewer human-readable audit logs.
- *Localize server-side based on `Accept-Language`.* Rejected: introduces a per-request localization pathway that could leak into a lock decision; FR-002 forbids that.

**Constitution anchor**. VI. Supports **FR-002, SC-004, BR-LOCK-006**.

---

## R-010 — Knockout `home_score_for_scoring` split (OD-002 implementation surface)

**Decision**. `match_results` carries **both** a published score and a for-scoring score:

| Column | Meaning |
|---|---|
| `home_score_official` | The score as the provider reports it, including extra time and penalty shootouts where applicable. Used for display only. |
| `away_score_official` | Same for the away team. |
| `home_score_for_scoring` | The score Slice 005's prediction-points engine consumes. **Regulation + extra time, excluding penalty shootouts** per OD-002 (resolved in Slice 005's `/speckit-clarify` round on 2026-05-15). |
| `away_score_for_scoring` | Same for the away team. |
| `result_status` | `regulation` / `extra_time` / `penalties_shootout` — tells the UI how to render the score. |

The sync coordinator populates `*_official` directly from the provider. It then computes `*_for_scoring` per `tournament_config.knockout_score_basis` (default `reg_plus_extra`; the only other supported value `reg_plus_extra_plus_pens` is reserved for future tournaments). For group-stage matches (no knockout possibility), `*_official == *_for_scoring` always.

**Rationale**.
- This contract is **referenced by name** in Slice 005's `data-model.md` § Entity 1 footnote on the `official_home` column: "the column name in `match_results` is `home_score_for_scoring` because Slice 002 owns the resolution of OD-002." Slice 005 ships before Slice 002 in plan order but assumed this slice would implement the column.
- Keeping both columns (official + for-scoring) means the participant UI can show "2-2 (4-3 on penalties)" while Slice 005's scoring engine continues to see `2-2` and computes points accordingly.
- Pulling the basis from `tournament_config` (Principle VIII) means future tournaments that elect to count shootouts can flip a single config row without code change.

**Alternatives considered**.
- *Single score column with a separate `penalties_winner` field.* Rejected: makes Slice 005's scoring math conditional on result_status; the for-scoring column flattens that condition into data.
- *Compute for-scoring on every read.* Rejected: makes Slice 005's leaderboard query touch `tournament_config` per row; the stored column is faster and just as auditable.

**Constitution anchor**. VIII, IV (provider-specific shootout encoding stays in the adapter; the for-scoring column is provider-neutral). Cross-slice locked contract — referenced by Slice 005.

---

## R-011 — Catalog read endpoint shape, pagination, filters

**Decision**. A single Next.js route handler `GET /api/matches` serves the catalog. Query parameters:

| Param | Type | Default | Notes |
|---|---|---|---|
| `stage` | enum | (all) | `group` / `r16` / `qf` / `sf` / `final` / `third_place` |
| `group` | string | (all) | e.g., `A`, `B`, … `L` for group-stage filtering |
| `status` | enum (multi) | (all) | `scheduled` / `in_progress` / `finished` / `postponed` / `cancelled` |
| `team_id` | uuid (multi) | (all) | matches involving any of the supplied teams |
| `from`, `to` | ISO-8601 | (none) | kickoff_utc window; both inclusive |
| `page` | int | `1` | 1-indexed |
| `page_size` | int | `50` | max `200`; over-sized values clamp |

Response: `{ matches: Match[], page: number, page_size: number, total: number }`. `Match` includes the `match_results` join inline when `status='finished'`; otherwise `match_results` is `null`.

RLS via Slice 001's `is_eligible_nortal_participant(auth.uid())` — caller must be eligible to read; admin path is via `is_admin(auth.uid())`. No anonymous endpoint.

**Rationale**.
- FR-012 explicitly requires stage / group / date / team filtering plus pagination. One endpoint serving all filters is simpler than separate `/schedule` and `/live` routes (the `status` filter handles both).
- Default page_size 50 is the typical "groups of 4 × ~10 groups" scan window. Clamp at 200 to prevent abusive scans during the tournament traffic spike.
- Including `match_results` only when `finished` reduces payload size for the participant scheduling UX and aligns with the catalog being mostly "scheduled" until match day.

**Alternatives considered**.
- *Cursor-based pagination (`after_id`).* Rejected: tournament dataset is small (~104 matches total); offset pagination is fine and simpler for the participant UI.
- *Separate `/matches/upcoming`, `/matches/finished` endpoints.* Rejected: doubles the surface for marginal benefit.

**Constitution anchor**. II (RLS-gated, no anonymous access), III (read-only — no rule logic).

---

## R-012 — `matches` vs `match_results` table separation

**Decision**. `matches` (catalog) and `match_results` (post-match data) are **separate tables**, both owned by this slice. `matches` is the always-populated catalog (every fixture has a `matches` row from sync time). `match_results` is INSERTed only when a match transitions to `status='finished'` (or `postponed`/`cancelled` for completeness) and the provider confirms scores. The relationship is `match_results.match_id` UNIQUE FK to `matches(id)` — at most one results row per match.

**Rationale**.
- A separate table means the catalog (used by every read query) stays narrow; the wide `*_official` / `*_for_scoring` / `result_status` columns live where they're actually consumed (Slice 005 scoring).
- INSERT-rather-than-UPDATE for results semantics: a `match_results` row's existence signals "this match has been scored." The audit trail captures the transition cleanly via the row INSERT.
- Allows different RLS posture if needed later — e.g., `match_results` admin-only-write while `matches` admin-only-write-by-sync. Today both are sync-written via the SECURITY DEFINER coordinator, but the separation gives Slice 006 room to differentiate.

**Alternatives considered**.
- *Single wide `matches` table with `home_score_*` NULL pre-match.* Acceptable but mixes catalog and result semantics; the separation pays off in Slice 005 which only reads `match_results`.
- *Append-only results history (multiple rows per match).* Rejected: `audit_log` already captures the history. A single current `match_results` row with audit-tracked changes is enough.

**Constitution anchor**. III (clean rule/data separation), V (audit captures result history). Cross-slice contract referenced by Slice 005.

---

## R-013 — Provider configuration storage and credential handling

**Decision**. Provider selection + non-secret config lives in `tournament_config`:

| Key | Value | Notes |
|---|---|---|
| `provider.active` | `"footballdata"` | Name of the active adapter |
| `provider.fallback` | `null` (string) | Reserved for a future fallback provider (FR-005 / R-001) |
| `provider.<name>.base_url` | `"https://api.football-data.org/v4"` | Adapter-specific |
| `provider.<name>.credentials_ref` | `"FOOTBALLDATA_API_TOKEN"` | The **environment variable name** holding the secret — never the secret itself |
| `provider_sync.cadence_minutes` | `5` | pg_cron schedule |
| `provider_sync.retry_policy` | `{...}` | R-007 |
| `provider_sync.outage_alert_threshold_minutes` | `30` | R-008 |
| `provider_sync.undersized_threshold` | `0.5` | R-004 |
| `provider_sync.kickoff_tolerance_minutes` | `5` | R-005 |
| `knockout_score_basis` | `"reg_plus_extra"` | R-010 |

The actual secret (`FOOTBALLDATA_API_TOKEN`) is set as a Supabase Edge Function secret (via `supabase secrets set FOOTBALLDATA_API_TOKEN=...`) — it lives only in the Edge Function's runtime env, never in Postgres, never in a Vercel env var visible to client bundles.

**Rationale**.
- Architecture §11.1 *Least privilege* — credentials accessible only to the runtime that needs them; the Edge Function does, the participant client doesn't.
- Spec FR-005 — provider swap is "configuration only" → flip `provider.active` and ensure the named env var exists.
- Slice 008 owns the admin UI for these keys; this slice writes only the seed defaults.

**Alternatives considered**.
- *Store the API token in `tournament_config`.* Rejected: any admin reading `tournament_config` could exfiltrate the token; secrets belong in the runtime env, not in the DB.
- *Vault / KMS-backed secrets.* Acceptable for a production hardening pass; out of scope for the slice 002 MVP. Documented as a follow-up.

**Constitution anchor**. II (Security — credentials least-privileged), VIII (provider config). Cross-slice handoff to Slice 008.

---

## R-014 — Cross-slice contract locks introduced by this slice

The following are locked cross-slice contracts after this slice ships. Body changes require coordinated regression updates across consumers (Constitution Principle XI):

| Contract | Owner task (in this slice's tasks.md) | Consumers |
|---|---|---|
| `matches` table shape — columns `(id, home_team_id, away_team_id, stage, group_id, kickoff_utc, venue, status, last_synced_at)` | Migration 0020 | Slices 003 (predictions FK), 004, 005 (scoring), 006 (admin overrides) |
| `match_results` table shape including `home_score_for_scoring` + `away_score_for_scoring` + `result_status` | Migration 0021 | Slice 005 (explicit reference in its data-model § Entity 1 footnote) |
| `teams` table shape — `(id, name, short_code, flag_url)` | Migration 0019 | Slice 004 (final-prediction `champion_team_id` FK), Slice 005 (`tournament_award.champion_team_id`) |
| `MatchDataProviderAdapter` TypeScript interface | `supabase/functions/_shared/providers/types.ts` | Future provider implementations; Slice 006 admin manual-result entry path |
| `provider_sync_runs` table shape — audit ledger | Migration 0022 | Slice 007 hardens; Slice 006 admin "view recent syncs" surface |

These five contracts together form the foundation for Slices 003–008. The Constitution Check in `plan.md` re-evaluates whether any of them violate Principles I, II, III, V, or VIII.

---

## R-015 — Out of scope (intentionally deferred)

- **Player roster ingest**: FR-009/FR-010 of the architecture (final-prediction top scorer / best player) requires player data. That ingest path is **Slice 004**'s scope — this slice's adapter contract includes a `fetchPlayers()` method stub but the call site and storage are deferred.
- **Admin manual-result entry UI**: surfaced as a contract anchor in `match-results.write.md` but the UI is **Slice 006**'s scope. This slice ships the SQL path admin tooling will call into.
- **Provider fallback failover**: spec FR-005 mentions multi-provider; this slice implements the abstraction but ships only one active adapter. Adding a fallback is a future amendment guided by the locked `MatchDataProviderAdapter` interface.
- **OD-007 (actual provider selection)**: spec status note says "remains open." This slice picks the abstraction so the selection can happen at launch without code change.

**Rationale**. Constitution Principle X — vertical slices ship one complete capability. Stretching this slice to include player ingest or admin UI would over-couple it.

**Constitution anchor**. X. Tracked deferrals: Slice 004 (players), Slice 006 (admin UIs), Slice 008 (full provider-config admin), OD-007 (provider runtime selection).

---

## Summary

All implementation-pattern unknowns are resolved. The slice can proceed to Phase 1 (data-model.md + contracts/ + quickstart.md). The constitution check in `plan.md` references these decisions by ID.
