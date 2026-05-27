# Implementation Plan: World Cup Bracket Team Selection

**Branch**: `010-bracket-team-selection` | **Date**: 2026-05-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-bracket-team-selection/spec.md`

## Summary

A standalone knockout-bracket game: each eligible participant fills a single-elimination bracket from a fixed, pre-seeded Round-of-32 field (R32 → R16 → QF → SF → Final → Champion = 31 winner picks), sees live completion status from one shared calculation, and may submit only when all 31 picks are present. Other participants' brackets stay fully private — UI and server — until the tournament lock (first kickoff). The bracket is independent of the slice-004 final-tournament predictions.

Technical approach: a new set of Postgres tables (`bracket_matchups` seed structure, `bracket_picks` per-participant winners, `bracket_submissions` submit-state) plus a single SQL status function and two views (`bracket_v` self-read, `bracket_peer_v` post-lock peer-read with SECURITY DEFINER). Server-side enforcement lives in a `submit_bracket` RPC + RLS; the Next.js App Router frontend reuses the slice-009 design system and mirrors slice-005's peer-visibility pattern. Lock reuses `tournament_config.first_kickoff_utc` (BR-LOCK-005).

## Technical Context

**Language/Version**: TypeScript 5.x (Next.js 14 App Router, React 18); SQL (Postgres 15 via Supabase)

**Primary Dependencies**: Next.js App Router, @supabase/ssr + supabase-js, Tailwind CSS + the slice-009 vendored shadcn/Radix primitives, next-intl (slice-010 i18n already in tree), lucide-react

**Storage**: Supabase Postgres — new tables `bracket_matchups`, `bracket_picks`, `bracket_submissions`; reuses existing `participants`, `teams`, `tournament_config`, `audit_log`

**Testing**: Playwright (e2e + API-boundary, the project's established harness) + pgTAP (SQL functions/RLS), authored RED-first per Constitution IX

**Target Platform**: Responsive web (desktop + mobile, 375px primary mobile width), served by Next.js; Supabase backend

**Project Type**: Web application (Next.js frontend + Supabase backend) — same monorepo `apps/web` + `supabase/`

**Performance Goals**: Bracket read (own) renders within standard web expectations (<1s perceived on warm cache); pick changes reflect status instantly (client-derived from the same shared calc, server is source of truth on submit/read)

**Constraints**: Server-side enforcement of completeness + privacy (Principle II/III); lock decisions read server/DB time only (Principle VI); no client-only gate; no coupling to slice-004 finals

**Scale/Scope**: One bracket per participant; 31 matchups × N participants; pool-sized (tens–hundreds of participants), not internet-scale. ~6 reusable UI components + 1 status function + 2 views + 1 submit RPC.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Plan compliance |
|---|-----------|-----------------|
| I | Technology Neutrality | Spec is tech-agnostic; this plan introduces the stack. Data model + contracts describe capabilities, not vendor specifics. ✅ |
| II | Security by Design | Completeness validation + edit-lock + cross-participant privacy enforced server-side via RLS + `submit_bracket` RPC, never client-only (FR-013, FR-018). ✅ |
| III | Rules Outside the UI | Bracket status, lock state, and visibility computed in one SQL layer (`bracket_status` fn + views); the client reuses the SAME shape but is not the authority (FR-014). ✅ |
| IV | Provider Abstraction | No external football provider involved this slice (fixed seed data). N/A. ✅ |
| V | Auditability | `submit_bracket` emits an `audit_log` row in the same transaction as the submit-state write (FR-012, Principle V). ✅ |
| VI | Time-Zone Correctness | Lock reads `tournament_config.first_kickoff_utc` via server/DB time; client clocks never authoritative (FR-020, edge: deadline race). ✅ |
| VII | Operational Resilience | Loading/empty/error states + retry (FR-021, FR-022); own-bracket read works independently of any provider. ✅ |
| VIII | Extensibility & Configuration | Bracket structure is data (`bracket_matchups` seed), not hard-coded; future group-stage prediction can extend without rework. ✅ |
| IX | TDD via BDD (NON-NEGOTIABLE) | Every user story ships RED-first Playwright/pgTAP specs before implementation. Encoded in tasks (Phase 2). ✅ |
| X | Vertical Slice Delivery | 5 independently-shippable stories (US1 teams → US2 select → US3 submit → US4 privacy → US5 status reuse). ✅ |
| XI | Regression-Gated Progress (NON-NEGOTIABLE) | New tables/views are additive; no slice-001–009 schema or contract is modified. Full prior suite must stay green. ✅ |

**Result**: PASS — no violations, no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/010-bracket-team-selection/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── bracket.read.md          # GET own bracket + status
│   ├── bracket.pick.write.md    # POST a winner pick (upsert + cascade)
│   ├── bracket.submit.write.md  # submit_bracket RPC
│   └── bracket-peer.read.md     # post-lock peer view
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
apps/web/
├── app/(participant)/bracket/
│   ├── page.tsx                 # own bracket: fill + status + submit
│   ├── BracketClient.tsx        # client island: pick state + cascade
│   └── review/page.tsx          # review / confirmation screen
├── app/api/
│   ├── bracket/route.ts                       # GET own bracket + status
│   ├── bracket/pick/route.ts                  # POST a winner pick (upsert)
│   ├── bracket/submit/route.ts                # POST submit (submit_bracket RPC)
│   └── bracket-peer/[participant_id]/route.ts # GET peer bracket (post-lock)
├── app/components/bracket/
│   ├── MatchupCard.tsx          # reuses TeamOption + FlagImage
│   ├── TeamOption.tsx
│   ├── FlagImage.tsx            # reuses slice-009 Flag.tsx where possible
│   ├── BracketProgressSummary.tsx
│   ├── BracketStatusBadge.tsx
│   └── SubmitBracketButton.tsx
├── lib/bracket/
│   ├── status.ts                # client mirror of bracket_status shape (display only)
│   └── cascade.ts               # downstream-pick invalidation on change
└── tests/playwright/slice-010-*.spec.ts   # RED-first acceptance specs (per story)

supabase/
├── migrations/
│   ├── 0084_bracket_matchups.sql      # structure table + R32 seed positions
│   ├── 0085_bracket_picks.sql         # picks table + RLS (self-only)
│   ├── 0086_bracket_submissions.sql   # submit-state table + RLS
│   ├── 0087_bracket_status_fn.sql     # single status calculation
│   ├── 0088_submit_bracket_rpc.sql    # server-side completeness + lock + audit
│   └── 0089_bracket_views.sql         # bracket_v (self) + bracket_peer_v (DEFINER)
├── seed/slice-010-fixture.sql         # R32 seeding + per-participant test picks
└── tests/pgtap/slice-010-*.sql        # status fn, submit RPC, RLS, peer view
```

**Structure decision**: Web application in the existing monorepo. Frontend under `apps/web/app/(participant)/bracket` (inherits the eligibility-gated participant layout + slice-009 TopNav/footer/i18n). Backend as additive Supabase migrations 0084–0089 (continuing the project's sequential slot convention; last used slot is 0083). No existing slice's schema is touched.

## Complexity Tracking

*No constitution violations — section intentionally empty.*
