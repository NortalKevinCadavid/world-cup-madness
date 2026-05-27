# Tasks: World Cup Bracket Team Selection

**Feature**: `010-bracket-team-selection` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Inputs**: plan.md, spec.md (US1–US5), data-model.md (3 tables + status fn + 2 views), contracts/ (4 contracts), research.md (R-001…R-008), quickstart.md

**Test policy**: TDD/BDD is NON-NEGOTIABLE (Constitution IX). Every user story authors its acceptance specs RED-first, before its implementation tasks. Playwright covers UI + API boundary; pgTAP covers SQL functions/RLS/views.

**Conventions**: Each task is self-contained (file path + enough context to dispatch to an isolated agent). `[P]` = parallelizable (different files, no incomplete-task dependency). `[US#]` ties a task to its story. Migration slots continue the project's sequential convention (last used: 0083) → this slice uses **0084–0090**.

**Stack** (from plan): Next.js 14 App Router + React + TypeScript under `apps/web/`; Supabase Postgres migrations under `supabase/migrations/`; Tailwind + slice-009 vendored shadcn primitives; Playwright + pgTAP. Lock signal = `tournament_config.first_kickoff_utc`. Eligibility = slice-001 `requireEligible`.

---

## Phase 1: Setup

- [X] T001 Create the feature's frontend directory skeleton: `apps/web/app/(participant)/bracket/` and `apps/web/app/components/bracket/` and `apps/web/lib/bracket/`, each with a `.gitkeep` if empty. Confirm the `(participant)` route group's existing layout (`apps/web/app/(participant)/layout.tsx`) already provides the eligibility gate + slice-009 TopNav/footer/i18n — no layout changes needed.
- [X] T002 [P] Add the slice-010 i18n message keys (`Bracket.*`: title, progressLabel "{completed} of {total} picks completed", statuses incomplete/ready/submitted/locked, submit/resubmit labels, emptyState, loadError, accessDenied) to `apps/web/messages/en.json`, `es.json`, `pt.json`, matching the next-intl structure already in those files.
- [X] T003 [P] Add a `Bracket` nav entry to `apps/web/app/components/TopNav.tsx` and `MobileNavSheet.tsx` linking to `/bracket`, reusing the existing localized-label pattern (add `Nav.bracket` to the 3 message catalogs).

## Phase 2: Foundational (blocks ALL stories)

**Schema substrate + shared read layer + shared UI primitives. No story can be exercised until these land.**

- [X] T004 Create migration `supabase/migrations/0084_bracket_matchups.sql`: table `public.bracket_matchups` per data-model.md Entity 1 (id, round enum r32/r16/qf/sf/final, position int, team_a_id/team_b_id nullable FK→teams, next_matchup_id self-FK, next_slot char A/B). Add CHECK invariants (R32 rows have both teams + later rows have neither; non-final rows have next_matchup_id+next_slot; final has neither), `(round,position)` unique. Enable RLS; world-readable to authenticated eligible participants; REVOKE write from authenticated/anon.
- [X] T005 Create migration `supabase/migrations/0085_bracket_picks.sql`: table `public.bracket_picks` per data-model.md Entity 2 (id, participant_id FK, matchup_id FK, winner_team_id FK, timestamps), `(participant_id,matchup_id)` unique. RLS policies `bracket_picks_self_read` / `bracket_picks_self_write` (self via participants.auth_user_id=auth.uid()) and `bracket_picks_admin_read` (is_admin(auth.uid())). Mirror the slice-003 `predictions` RLS shape.
- [X] T006 Create migration `supabase/migrations/0086_bracket_submissions.sql`: table `public.bracket_submissions` per data-model.md Entity 3 (participant_id PK FK, submission_status enum draft/complete/submitted/locked, submitted_at, version int). RLS self-read + admin-read; REVOKE direct INSERT/UPDATE from authenticated (writes only via the submit RPC in T030).
- [X] T007 Create migration `supabase/migrations/0087_bracket_status_fn.sql`: SQL function `public.bracket_status(p_participant_id uuid)` returning (total_required int=31, completed int, is_complete bool, missing_matchup_ids uuid[], submission_status text). submission_status logic: `locked` if now()>=first_kickoff_utc; else `submitted` if a bracket_submissions row exists; else `complete` if is_complete; else `draft`. Reads `tournament_config.first_kickoff_utc` for the lock (server time only — Principle VI).
- [X] T008 Create migration `supabase/migrations/0088_bracket_v.sql`: view `public.bracket_v` (`security_invoker = true`) joining bracket_matchups + the caller's bracket_picks + bracket_status, resolving later-round competitors from the caller's upstream winners. GRANT SELECT to authenticated. Self-RLS on bracket_picks restricts rows to the caller.
- [X] T009 Create seed `supabase/seed/slice-010-fixture.sql`: insert a fixed 31-row R32→Final `bracket_matchups` tree with 32 seeded teams from the existing `teams` table (reuse slice-002 team UUIDs), wiring next_matchup_id/next_slot correctly. Add a few partial `bracket_picks` for alpha + bravo for test fixtures. Register the file in `supabase/config.toml` `[db.seed].sql_paths` AFTER the existing slice fixtures.
- [X] T010 [P] Create `apps/web/app/components/bracket/FlagImage.tsx`: renders a team flag from its flag URL, falling back to a neutral placeholder with alt text "Flag of {name}" / "Flag unavailable for {name}" (FR-002, FR-023). Reuse the slice-009 `Flag` component (`apps/web/app/components/Flag.tsx`) if its API fits; otherwise wrap it.
- [X] T011 [P] Create `apps/web/app/components/bracket/TeamOption.tsx`: one selectable team row (flag + name, selected/disabled states, keyboard-accessible, selected state not color-only per FR-023). Props: team, selected, disabled, onSelect. Reuse slice-009 Button/Card primitives.
- [X] T012 [P] Create `apps/web/app/components/bracket/MatchupCard.tsx`: renders one matchup using TeamOption + FlagImage; shows pending placeholders when competitors unresolved (FR-007); allows exactly one winner when both known (FR-004). Props: matchup, teams, selectedTeamId, disabled, onPickWinner.
- [X] T013 Create `apps/web/lib/bracket/types.ts`: shared TypeScript types mirroring the contract shapes (Team, Matchup, Pick, BracketStatus, BracketResponse) from contracts/bracket.read.md — display/transport types only, NOT the authority.

**Checkpoint**: schema applies via `supabase db reset --local`; `bracket_v` returns the seeded tree for a signed-in participant; shared components compile.

---

## Phase 3: User Story 1 — View all teams with flags (Priority: P1) 🎯 MVP

**Goal**: An eligible player opens `/bracket` and sees every bracket team with name + flag (fallback when missing), same team rendered identically across rounds.

**Independent test**: Sign in as alpha, open `/bracket` with no picks; all 16 R32 matchups show both teams with flags; a flag-less team shows the fallback; later rounds show pending.

- [X] T014 [P] [US1] RED test `apps/web/tests/playwright/slice-010-bracket-view.spec.ts`: sign in (forward `sb-*-auth-token` cookies per the slice-001 cookie-forwarding follow-up), GET `/bracket`; assert all 16 R32 matchups render with both team names + flags, a missing-flag team shows the fallback with alt text, later-round matchups show pending, and the loading state appears before data resolves (FR-001/002/003, FR-021). Authored RED.
- [X] T015 [US1] Implement `apps/web/app/api/bracket/route.ts` GET per contracts/bracket.read.md: `requireEligible()` (401/403), build a session-bound Supabase client (anon key + caller cookies, never service role), SELECT from `bracket_v`, return `{ matchups[], status }` with `Cache-Control: no-store`. Mirror the slice-003 `/api/matches` route shape.
- [X] T016 [US1] Implement `apps/web/app/(participant)/bracket/page.tsx`: server component that fetches the bracket (via the route or a server read of `bracket_v`), renders the round columns of `MatchupCard`s, and handles loading/empty/error states (empty → localized "Teams are not available yet"; error → retry). No pick interactivity yet.
- [X] T017 [US1] Verify T014 passes green; fix any FlagImage/MatchupCard rendering gaps surfaced. Confirm the same team in a later round (once resolvable) reuses the identical FlagImage treatment.

**Checkpoint**: `/bracket` is a viewable, read-only team display — independently demoable.

---

## Phase 4: User Story 2 — Build the bracket by selecting winners (Priority: P1)

**Goal**: Player picks winners; winners advance; changing an earlier pick clears now-impossible later picks.

**Independent test**: From an empty bracket, pick an R32 winner → it appears in the dependent R16 matchup; change that R32 pick → dependent QF/champion picks that relied on it clear.

- [X] T018 [P] [US2] RED test `apps/web/tests/playwright/slice-010-bracket-pick.spec.ts`: cookie-forwarded admin/participant session; assert (a) picking a valid R32 winner advances it into the correct R16 slot on re-read; (b) changing an upstream winner returns non-empty `cleared_matchup_ids` and drops `status.completed` (FR-006, SC-006); (c) picking on a pending matchup → 409 MATCHUP_NOT_READY; (d) picking a non-competitor → 422 INVALID_WINNER; (e) picking after lock → 409 BRACKET_LOCKED even with a back-dated client clock. Authored RED. Per contracts/bracket.pick.write.md.
- [X] T019 [P] [US2] RED pgTAP test `supabase/tests/pgtap/slice-010-cascade.sql`: assert that deleting/changing an upstream `bracket_picks` row leaves no downstream pick whose winner can no longer reach its matchup (the cascade invariant), and that a later pick for a still-reachable team survives. Authored RED.
- [X] T020 [US2] Implement `apps/web/lib/bracket/cascade.ts`: pure function computing the set of the caller's later picks made impossible by a changed upstream winner (only impossible ones, not the whole subtree — R-005). Unit-testable, no I/O.
- [X] T021 [US2] Implement `apps/web/app/api/bracket/pick/route.ts` POST per contracts/bracket.pick.write.md: `requireEligible`, lock check from DB time (reject 409 BRACKET_LOCKED), validate winner is a resolved competitor (422 INVALID_WINNER) / matchup ready (409 MATCHUP_NOT_READY), upsert the pick, apply the authoritative server cascade (delete impossible downstream picks), return `{ pick, cleared_matchup_ids, status }`. Never trust client clock (mirror slice-003 clock-ignored).
- [X] T022 [US2] Implement `apps/web/app/(participant)/bracket/BracketClient.tsx`: client island holding pick state, calling the pick endpoint on selection, applying the optimistic cascade (`cascade.ts`) for instant UX then reconciling with the server's `cleared_matchup_ids`. Wires `MatchupCard.onPickWinner`. Read-only when locked/post-lock.
- [X] T023 [US2] Verify T018 + T019 pass green; confirm advancement + cascade behave end-to-end and the lock gate holds server-side.

**Checkpoint**: a player can build a full bracket with correct advancement + cascade.

---

## Phase 5: User Story 3 — Completion status & submission (Priority: P1)

**Goal**: Submit only when all 31 picks present; status shown; server revalidates; re-submission allowed until lock; auto-submit complete drafts at lock.

**Independent test**: incomplete → submit disabled + missing count; complete → enabled; submit → revalidated server-side + one audit row; 30/31 via direct API → 422.

- [X] T024 [P] [US3] RED test `apps/web/tests/playwright/slice-010-bracket-submit.spec.ts`: assert (a) submit control disabled + "N of 31" shown while incomplete; (b) enabled at 31/31; (c) submit → 200 submitted; (d) 30/31 via direct API → 422 BRACKET_INCOMPLETE with missing_count; (e) re-submit after edit before lock supersedes (FR-028); (f) submit after lock → 409 BRACKET_LOCKED. Cookie-forwarded. Per contracts/bracket.submit.write.md. Authored RED.
- [X] T025 [P] [US3] RED pgTAP test `supabase/tests/pgtap/slice-010-submit-rpc.sql`: assert `submit_bracket` (a) rejects incomplete with the typed error; (b) on success writes a `bracket_submissions` row AND exactly one `audit_log` row (`action='bracket.submitted'`) in the same transaction (Principle V); (c) is idempotent on `run_token`; (d) rejects when now()>=first_kickoff_utc. Authored RED.
- [X] T026 [P] [US3] RED pgTAP test `supabase/tests/pgtap/slice-010-status-fn.sql`: assert `bracket_status` returns total_required=31, correct completed/missing for a partial fixture, is_complete only at 31, and submission_status transitions draft→complete→submitted→locked per the lock and submission state. Authored RED.
- [X] T027 [US3] Create migration `supabase/migrations/0090_submit_bracket_rpc.sql` (slot shifted from 0089→0090; US2 cascade took 0089): `public.submit_bracket(p_run_token uuid)` SECURITY DEFINER per contracts/bracket.submit.write.md + research R-003: eligibility check, lock check (now()<first_kickoff_utc else WCG-style BRACKET_LOCKED), server-side recompute of completeness (all 31 valid), upsert bracket_submissions→submitted + bump version, insert one audit_log row in-transaction, idempotent on run_token. GRANT EXECUTE to authenticated.
- [X] T028 [US3] Implement `apps/web/app/api/bracket/submit/route.ts` POST: `requireEligible`, call `submit_bracket` RPC via session-bound client, map typed errors → 422 BRACKET_INCOMPLETE / 409 BRACKET_LOCKED / 401 / 403, return `{ submission_status, submitted_at, version, status }`.
- [X] T029 [P] [US3] Implement `apps/web/app/components/bracket/BracketProgressSummary.tsx`, `BracketStatusBadge.tsx`, and `SubmitBracketButton.tsx`: all consume the single `BracketStatus` shape (R-004); progress shows "{completed} of {total}"; submit button disabled when incomplete/locked, labeled submit-vs-resubmit when complete (FR-010), explains disabled reason for a11y (FR-023).
- [X] T030 [US3] Wire `BracketClient.tsx` + `page.tsx` to render the progress summary, status badge, and submit button, calling the submit endpoint and reflecting the returned status. Implement the auto-submit-at-lock display semantics (FR-029): post-lock, a complete-but-unsubmitted bracket shows as accepted; incomplete shows frozen-incomplete.
- [X] T031 [US3] Verify T024 + T025 + T026 pass green; confirm the server is the authority on completeness and the audit row lands exactly once.

**Checkpoint**: full fill → submit → lock lifecycle works, server-enforced.

---

## Phase 6: User Story 4 — Privacy before lock & peer view after (Priority: P1)

**Goal**: Other players' brackets fully hidden (UI + server) before lock; readable after lock.

**Independent test**: pre-lock peer GET → null + direct REST → []; post-lock → visible.

- [X] T032 [P] [US4] RED test `apps/web/tests/playwright/slice-010-bracket-peer.spec.ts`: mirror slice-005 SC-009 — (a) pre-lock alpha GET `/api/bracket-peer/<bravo>` → 200 `{bracket:null}`; (b) pre-lock alpha direct `/rest/v1/bracket_peer_v?participant_id=eq.<bravo>` with their JWT → `[]`; (c) admin pre-lock direct REST → `[]` (no bypass); (d) post-lock (first_kickoff_utc in past) → bravo's read-only bracket. Use a 5-min-safe lock buffer + cookie/JWT forwarding per the slice-005 peer-view follow-up. Authored RED.
- [X] T033 [P] [US4] RED pgTAP test `supabase/tests/pgtap/slice-010-peer-view-rls.sql`: assert `bracket_peer_v` returns zero rows when now()<first_kickoff_utc (any target), excludes the caller's own participant_id, and returns rows post-lock; verify it runs SECURITY DEFINER so underlying self-RLS does not collapse it. Authored RED.
- [X] T034 [US4] Create migration `supabase/migrations/0091_bracket_peer_v.sql` (slot shifted 0090→0091; US3 submit RPC took 0090): view `public.bracket_peer_v` with `security_invoker = false` (DEFINER — research R-002), body enforcing `now() >= first_kickoff_utc` AND `participant_id <> (caller's participant)`; display-name masking mirroring `leaderboard_v` visibility config. GRANT SELECT to authenticated; REVOKE from PUBLIC.
- [X] T035 [US4] Implement `apps/web/app/api/bracket-peer/[participant_id]/route.ts` GET per contracts/bracket-peer.read.md: thin pass-through over `bracket_peer_v` (gate is in the view, not the route); pre-lock returns `{bracket:null}` (non-leaking, no existence oracle); post-lock returns the peer's read-only bracket. `Cache-Control: no-store`.
- [X] T036 [US4] Audit the frontend for pre-lock leaks (FR-017): ensure no route, link, preview, card, or client-state anywhere exposes another participant's bracket before lock. Add the post-lock peer-view entry point only where lock state permits. Verify T032 + T033 green.

**Checkpoint**: privacy holds at the server boundary; post-lock viewing works.

---

## Phase 7: User Story 5 — Consistent status from one source (Priority: P2)

**Goal**: Header, submit control, badge, mobile footer, review, and confirmation all derive from the one status shape.

**Independent test**: change one pick → all surfaces update to identical counts/state simultaneously.

- [X] T037 [P] [US5] RED test `apps/web/tests/playwright/slice-010-bracket-status-consistency.spec.ts`: change a single pick and assert the header progress, mobile sticky footer, status badge, submit-button label, and review screen all show identical completed/required counts and the same submission state (SC-004, FR-014/015). Authored RED.
- [X] T038 [P] [US5] Implement `apps/web/lib/bracket/status.ts`: the client-side mirror of the `bracket_status` shape for instant in-progress display — display-only, explicitly NOT the submission authority (the server value from the read/submit endpoints is truth). Single function consumed by every surface.
- [X] T039 [US5] Create `apps/web/app/(participant)/bracket/review/page.tsx`: review/confirmation screen rendering the full bracket read-only with the same `BracketProgressSummary` + `BracketStatusBadge`, sourced from the one status shape.
- [X] T040 [US5] Add the mobile sticky footer (completed count + submit button + locked/submitted state) to `BracketClient.tsx`/`page.tsx`, consuming the same status; ensure no surface recomputes status independently (FR-014).
- [X] T041 [US5] Verify T037 passes green; confirm every status surface updates from the single source with no disagreement.

**Checkpoint**: status is consistent everywhere.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T042 [P] Accessibility pass across all bracket components (FR-023, SC-007): keyboard operability for every selection, non-color selected state, flag alt text, button labels, disabled-submit explanation, screen-reader-exposed status messages. Add an axe-core check to a Playwright spec.
- [X] T043 [P] Mobile pass (FR-024, SC-007): verify the primary completion flow on a 375px viewport with no horizontal scroll; if a horizontal bracket layout is used, provide clear round-to-round navigation. Add a 375px Playwright project assertion.
- [X] T044 [P] Localize all bracket UI strings via the T002 message keys (en/es/pt); confirm no hard-coded English remains in the bracket components.
- [X] T045 Regression gate (Constitution XI): run the full slice-001–009 Playwright + pgTAP suites and confirm all stay green — the slice-010 objects (migrations 0084–0090, new `(participant)/bracket` routes) are additive and must not regress any prior slice.
- [X] T046 Author `specs/010-bracket-team-selection/regression-checkpoint.md` summarizing what shipped, the migration slots used, the test counts per story, and any deferred items.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational)** must complete before any user story.
- **US1 (Phase 3)** is the MVP and depends only on Foundational.
- **US2 (Phase 4)** depends on Foundational + US1's read view (uses `bracket_v`).
- **US3 (Phase 5)** depends on Foundational (status fn) + US2 (picks exist to complete). Adds migration 0089.
- **US4 (Phase 6)** depends on Foundational (picks/matchups) only; independent of US2/US3 logic. Adds migration 0090.
- **US5 (Phase 7)** depends on US3 (status surfaces) being present.
- **Phase 8 (Polish)** last; T045 regression gate runs after all stories.

Migration apply order (sequential): 0084 → 0085 → 0086 → 0087 → 0088 → 0089 → 0090.

## Parallel Execution Examples

- **Foundational**: T010, T011, T012 (3 components) run in parallel after T004–T009 schema lands; T002, T003 (i18n/nav) parallel with schema.
- **US1**: T014 (RED test) authored in parallel with nothing blocking; implementation T015→T016 sequential (route then page).
- **US3**: T024, T025, T026 (3 RED specs) all parallel; T029 (3 status components) parallel with the RPC migration T027.
- **US4**: T032, T033 (Playwright + pgTAP RED) parallel.
- **Polish**: T042, T043, T044 parallel; T045 after them.

## Implementation Strategy

- **MVP = Phase 1 + 2 + US1** (T001–T017): a viewable, eligibility-gated bracket showing all teams with flags. Independently shippable and demoable.
- **Increment 2 = US2 + US3** (T018–T031): the playable fill-and-submit loop with server-enforced completeness — the core game.
- **Increment 3 = US4** (T032–T036): the privacy guarantee + post-lock peer view — security-critical, ships once the bracket has content to protect.
- **Increment 4 = US5 + Polish** (T037–T046): status consistency, a11y, mobile, i18n, regression gate.
- Each increment keeps the full prior-slice suite green (Constitution XI) and authors its acceptance specs RED-first (Constitution IX).
