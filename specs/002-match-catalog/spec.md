# Feature Specification: Match Catalog & Provider Sync

**Feature Branch**: `002-match-catalog`

**Created**: 2026-05-15

**Status**: Draft

**Input**: User description: "Vertical slice covering FR-004 (match catalog) and FR-017 (provider-agnostic data synchronization). Fills the §15 catalog-sync gap and establishes the integration contract used by every downstream scoring/locking decision."

**Architecture anchors**:

- Implements **FR-004, FR-017**
- Satisfies §15.1 scenario: *Provider API failure*; fills the §15.3 gap *(FR-004 needs explicit catalog-sync test)*
- Depends on OD-007 (stack — partially closed for the data layer by the Constitution declaring Supabase, still open for the provider integration runtime)
- Constitution principles in force: IV (Provider Abstraction), VI (Time-Zone Correctness), VII (Operational Resilience)

## Clarifications

### Session 2026-05-15

- Q: What sync cadence drives the scheduled sync runner? → A: **Three-tier, configuration-driven.** *Pre-tournament* (before the first match's `kickoff_utc - 90 minutes`): once per day. *Tournament-day non-live*: once per hour. *Live window* — any moment when at least one match satisfies `now() BETWEEN kickoff_utc - 90 minutes AND kickoff_utc + 4 hours`: every 5 minutes. All three thresholds (pre-tournament cadence, tournament-day cadence, live-window cadence, live-window pre-/post-kickoff offsets) are configurable via `tournament_config.provider_sync.cadence.*` keys with the defaults stated here. The scheduled runner reads the configuration fresh on every invocation and self-selects which tier applies based on `now()` vs the live-window predicate. Rationale: matches architecture document §10.4's intent, respects provider API quotas outside live windows (critical for free-tier providers like football-data.org with 10 calls/min), and remains adjustable without code change per Principle VIII.
- Q: When one row in a multi-row payload is bad, does the entire sync abort or does only the bad row get quarantined? → A: **Hybrid by conflict class.** *Payload-structural anomalies* — empty replacement of populated data, undersized payload (configurable threshold; default `< 50%` of last known catalog count for the same window), in-payload duplicate identifiers — abort the **whole sync run**, leave the catalog untouched, and emit the administrator alert. *Per-row data conflicts* — team-assignment change against an existing match, status backward-transition (e.g., `finished → scheduled`), score reported for a match whose `status != 'finished'`, kickoff time change after the affected match has already locked — quarantine **only the offending row** into `match_pending_review` and apply the remaining rows normally; the run's overall outcome is recorded as `partial` or `conflict_quarantined` per how many rows were affected. Rationale: structural anomalies indicate upstream malfunction (cannot trust any of the payload); per-row anomalies are individual disputes that should not block 49 legitimate updates.
- Q: What does the sustained-outage administrator alert actually do? → A: **Configurable webhook URL with audit-log fallback.** The system writes the audit row (`action='provider.outage_alert_emitted'`) in every alert case. If `tournament_config.notifications.outage_webhook_url` is set, the system additionally POSTs a JSON payload `{ "provider": "<name>", "first_failure_after_success_at": "<iso8601>", "minutes_in_outage": <int>, "recent_runs": [...] }` to the configured URL — the URL may point to a Slack incoming webhook, a Discord webhook, an MS Teams webhook, or any custom HTTPS endpoint that accepts a JSON body. If the URL is null OR the POST fails, the audit row is the canonical record (no exception propagated, no retry storm). The webhook target is set by Slice 008's admin UI; this slice ships the audit-row path and the POST mechanism with a safe `null` default. Recovery emits `action='provider.recovered'` audit row and (if URL configured) a recovery webhook payload — symmetry preserves the operator's mental model.
- Q: Does this slice ship the participant `/matches` page, or only `/api/matches`? → A: **Ship the participant page in this slice.** The slice delivers the complete vertical: the catalog SQL + RLS, the sync engine, the `/api/matches` route handler, AND a server-component participant page at `/matches` that lists fixtures grouped by stage, supports the documented filters (stage, group, status, team, date window), displays kickoff times localized via `Intl.DateTimeFormat` (canonical UTC stays on the wire), and paginates per the route-handler contract. Match-result rows render the official score with a result-status annotation (e.g., "3-2 (4-3 on penalties)") for finished matches. The page is read-only (no actions in this slice — prediction entry comes in Slice 003). Rationale: Constitution Principle X requires shipping the complete vertical, and spec FR-012's verb "present" implies UI delivery, not just an endpoint.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Participant sees the World Cup 2026 fixture list (Priority: P1)

An eligible participant opens the application and sees the full list of FIFA World Cup 2026 matches, organized by stage and group, with each kickoff time localized to their display locale. The catalog is current with respect to the official schedule.

**Why this priority**: Without a trustworthy match catalog, no other slice can function — predictions, locking, scoring, and leaderboards all reference these match records.

**Independent Test**: Sign in as an eligible participant, navigate to the match list, verify that group-stage matches, knockout-stage matches, teams, kickoff times, venues (where available), and statuses render. Change the browser locale and verify kickoff times re-localize while the underlying canonical time remains UTC.

**Acceptance Scenarios**:

1. **Given** the catalog has been synchronized with the official tournament schedule, **When** an eligible participant requests the match list, **Then** all scheduled matches MUST be returned with stage, group (where applicable), home team, away team, canonical UTC kickoff time, venue (if available), and status (scheduled / in-progress / finished / postponed / cancelled).
2. **Given** a participant in a non-UTC locale, **When** they view a match's kickoff time, **Then** the time MUST be presented in their locale while the canonical stored value remains UTC, and no locking decision elsewhere in the system MUST be driven by the localized display value.
3. **Given** the official schedule lists a new match added late, **When** the next provider sync runs, **Then** the new match MUST appear in the catalog without manual intervention.

### User Story 2 - Provider data syncs through an abstraction contract (Priority: P1)

The application pulls fixtures, statuses, and scores from a configured external football data provider through a stable internal integration contract. The contract is provider-agnostic — swapping providers (e.g., from football-data.org to another) requires implementing the contract, not rewriting downstream logic.

**Why this priority**: Provider abstraction is Constitution Principle IV. Coupling domain logic to a specific provider would force a rewrite at any coverage/cost/licensing change.

**Independent Test**: Configure provider A, run a full sync, verify the catalog matches the provider's published fixtures. Disable provider A's adapter, enable a stub provider B with deliberately different field names but contract-compliant output, verify the catalog still matches the expected fixtures with no change to consumer code.

**Acceptance Scenarios**:

1. **Given** a configured provider that satisfies the integration contract, **When** the scheduled sync runs, **Then** fixtures, kickoff times, statuses, and scores MUST be reconciled into the local catalog with no provider-specific identifiers leaking into the domain layer.
2. **Given** two contract-compliant providers, **When** the active provider is switched in configuration, **Then** subsequent syncs MUST function with no code change to the catalog, prediction, scoring, or leaderboard slices.
3. **Given** a successful sync, **When** an audit consumer reads recent sync events, **Then** they MUST find a record per sync attempt with provider identity, timestamp, outcome, counts of created / updated / unchanged records, and any reconciliation conflicts.

### User Story 3 - Catalog remains usable during provider failure (Priority: P1)

The configured provider becomes unavailable (rate-limited, network error, 5xx, returning partial data, or returning stale data). Participants continue to see the last successfully synced catalog; the application does not crash, does not display empty data, and alerts administrators if the failure persists beyond a configurable threshold.

**Why this priority**: External provider outages are expected (Principle VII). Losing the catalog during a match window is a product-defining failure.

**Independent Test**: With a populated catalog, disable the provider endpoint and run a sync. Verify the catalog still serves participant reads with the prior data. Run repeated syncs over a window longer than the configured alert threshold and verify an administrator alert is emitted exactly once per sustained outage. Restore the provider and verify the next sync reconciles correctly.

**Acceptance Scenarios**:

1. **Given** a previously-synced catalog and an unavailable provider, **When** a participant requests the match list, **Then** the catalog MUST serve the last known good data with no user-visible error.
2. **Given** repeated provider failures beyond the configured threshold (e.g., 30 minutes without success), **When** the threshold is crossed, **Then** an administrator alert MUST be emitted exactly once per sustained outage and a sync event MUST be recorded.
3. **Given** the provider returns with corrected data after an outage, **When** the next sync runs, **Then** the catalog MUST reconcile to the corrected data and emit an audit event noting recovery.

### Edge Cases

- Provider returns a kickoff time change for a match that has already locked (kickoff − 60 min has already passed) → the catalog MUST update the canonical kickoff time, but the prediction-lock slice (003) governs whether predictions remain locked or are re-opened; this slice records the change and emits an alert per BR-LOCK-004.
- Provider returns a duplicate match identifier in the same payload → the sync MUST treat it as an error, NOT pick one arbitrarily, and MUST alert administrators.
- Provider returns conflicting data across two consecutive syncs (e.g., team A vs team B at one time, team A vs team C the next) → the catalog MUST flag the conflict, record both observations in the audit trail, and require admin resolution before propagating the change.
- Provider returns a postponed or cancelled status for a match → the catalog MUST reflect the new status, and downstream slices (003, 005) MUST honor the BR-LOCK-004 rule on lock handling for the corrected schedule.
- Provider rate-limits the sync mid-run → the sync MUST checkpoint progress and resume cleanly on retry; it MUST NOT corrupt the catalog with a half-applied update.
- Two scheduled syncs overlap (a previous sync is still running when the next is triggered) → only one sync MUST run at a time per provider; the second MUST be skipped or queued.
- Provider returns an empty payload for a previously-populated league → the catalog MUST NOT replace populated data with empty data; the empty payload MUST be treated as an error.
- A match's kickoff time straddles a daylight-saving boundary in any locale → display layer MUST handle DST correctly; canonical UTC storage MUST remain untouched.
- Provider returns scores for a not-yet-started match → the catalog MUST reject the inconsistent payload and emit an alert.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST maintain a catalog of FIFA World Cup 2026 matches including: official match identifier (canonical), home team, away team, stage, group (where applicable), canonical kickoff time in UTC, venue (if available), status (scheduled / in-progress / finished / postponed / cancelled), home score, away score.
- **FR-002**: System MUST store all kickoff times in UTC (or another normalized canonical time standard) and MUST localize for display only; no business decision MUST consume a localized time (Constitution Principle VI, BR-LOCK-006).
- **FR-003**: System MUST synchronize fixtures, statuses, and scores from one or more configured external football-data providers through a provider-agnostic integration contract (Constitution Principle IV, architecture FR-017).
- **FR-004**: System MUST keep the contract surface free of provider-specific schemas; downstream slices (predictions, scoring, leaderboard) MUST consume only the contract types.
- **FR-005**: System MUST support replacing the active provider through configuration without code changes outside the provider adapter.
- **FR-006**: System MUST tolerate provider failure by serving last-known-good catalog data and MUST NOT replace populated data with empty payloads.
- **FR-007**: System MUST retry failed syncs according to a configurable policy (interval, max attempts, backoff) and MUST emit an administrator alert exactly once per sustained outage beyond a configurable threshold. The alert transport is per Clarifications 2026-05-15: an `audit_log` row is always written; an additional HTTPS POST to a configurable webhook URL fires when the URL is set. The audit-log path is the canonical alert record so that ops can always reconstruct outage history regardless of webhook reachability.
- **FR-008**: System MUST record every sync attempt (successful and failed) with provider identity, started_at, finished_at, outcome, counts, and any reconciliation conflicts.
- **FR-009**: System MUST detect and surface inconsistent payloads as errors requiring administrator review rather than auto-applying them. The detection MUST classify each anomaly by Clarifications 2026-05-15: *structural anomalies* (empty replacement of populated data, undersized payload below the configured threshold, in-payload duplicate identifiers) abort the entire sync run with no catalog mutation; *per-row anomalies* (conflicting team assignment, status backward-transition, score reported for a match whose `status != 'finished'`, kickoff time change after the affected match has already locked) quarantine the offending row only, allowing the remainder of the payload to apply.
- **FR-010**: System MUST ensure only one sync runs concurrently per provider; overlapping triggers MUST be skipped or queued, never executed in parallel against the same dataset.
- **FR-011**: System MUST update match kickoff times when the provider reports a corrected schedule, and MUST emit an audit event noting any affected matches that had already locked (so Slice 003 can apply BR-LOCK-004 policy).
- **FR-012**: System MUST present the catalog to participants through a dedicated participant-facing page that supports stable pagination and filtering by stage, group, date, and team, with kickoff times localized to the participant's browser locale while the canonical stored timestamps remain UTC (per Clarifications 2026-05-15). The page is read-only in this slice — prediction-entry interactions land in Slice 003.

### Key Entities

- **Match**: A single tournament fixture. Attributes: canonical match identifier, home team, away team, stage, group (optional), canonical UTC kickoff time, venue (optional), status, home score, away score, last sync timestamp.
- **Team**: A participating national team. Attributes: stable team identifier, name, short code, flag/icon reference (optional).
- **Provider Sync Event**: A record of one synchronization attempt. Attributes: provider identifier, started_at, finished_at, outcome (success / failure / partial / conflict), counts (created / updated / unchanged / rejected), error reason (if any). Written to the audit trail in Slice 007.
- **Provider Configuration (configuration reference)**: Defines the active provider, credentials reference, retry policy, alert threshold. Managed in Slice 008.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Catalog reflects an approved provider schedule update within 5 minutes of sync trigger under normal conditions.
- **SC-002**: Catalog continues serving last-known-good data through at least 24 hours of provider unavailability with zero user-visible errors.
- **SC-003**: Administrators receive an alert within 15 minutes of sustained provider failure beyond the configured threshold, and exactly once per sustained outage (no flap-spam).
- **SC-004**: Zero participant-visible kickoff times displayed in the wrong locale across at least 1,000 simulated locale-mixed reads.
- **SC-005**: Replacing the active provider with a different contract-compliant provider requires zero code changes outside the provider adapter (verified by an end-to-end swap test).
- **SC-006**: 100% of inconsistent provider payloads (duplicate IDs, empty-replacement, score-before-kickoff) are rejected and surfaced as administrator-actionable alerts.
- **SC-007**: 100% of sync attempts produce a corresponding audit event in the same transaction as any catalog mutation.

## Assumptions

- A football-data provider that can deliver FIFA World Cup 2026 fixtures, statuses, and scores will be selected and credentialed before this slice goes live. The architecture document cites football-data.org as a representative example; this spec is provider-neutral.
- Tournament data may change before and during the tournament (kickoff times, venues, statuses, late additions, postponements). The catalog is expected to receive corrections.
- The catalog is a read-heavy surface during the tournament window; write traffic is bounded by the configured sync cadence.
- Sync cadence and retry policy are configured through Slice 008. This spec locks the cadence shape per Clarifications 2026-05-15: three-tier (pre-tournament daily, tournament-day-non-live hourly, live-window every 5 minutes), where a live window is `now() BETWEEN kickoff_utc - 90 minutes AND kickoff_utc + 4 hours` for any scheduled or in-progress match. Retry policy defaults: exponential backoff, max 3 attempts per cycle. Sustained-outage alert threshold default: 30 minutes.
- The catalog stores team and player reference data only to the extent needed for fixture display and final-prediction scoring (Slice 004 / 005); it does not duplicate broad sports databases.
