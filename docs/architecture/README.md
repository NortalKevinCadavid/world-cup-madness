# World Cup Madness — Architecture & Product Context

An internal Nortal prediction pool for the FIFA World Cup 2026 — a "March Madness for soccer." Eligible Nortal employees sign in via corporate identity, predict match scores (locked one hour before kickoff) plus four tournament-wide picks (champion, runner-up, top scorer, best player; locked at first kickoff), and compete on a live leaderboard scored automatically as official results come in.

## Authoritative source

**[`Nortal_World_Cup_2026_Prediction_Pool_High_Level_Architecture_EN.docx`](Nortal_World_Cup_2026_Prediction_Pool_High_Level_Architecture_EN.docx)** is the Nortal-produced high-level architecture document. It is the source of truth. The `.md` files in this folder are derived from it for grep-ability and quick reference; if they ever disagree with the `.docx`, the `.docx` wins.

## Files in this folder

| File | Purpose |
|---|---|
| `Nortal_World_Cup_2026_Prediction_Pool_High_Level_Architecture_EN.docx` | Original Nortal architecture document (includes Figure 1: Logical High-Level Architecture Diagram, embedded in the docx only) |
| [`high-level-architecture.md`](high-level-architecture.md) | Pandoc-converted Markdown rendering of the docx (~1,170 lines). Tables and section structure preserved; embedded diagrams are not converted — refer to the docx for Figure 1. |
| [`acceptance-criteria.md`](acceptance-criteria.md) | The 14 core test scenarios (§15.1) + 8 acceptance criteria (§15.2) as a flat checklist, tagged with the FR(s) each scenario validates |
| [`open-decisions.md`](open-decisions.md) | OD-001 → OD-008 as a tracked log: question, owner, status, affected FRs. All currently **Open**. |
| [`scoring-model.md`](scoring-model.md) | Extracted §7: time/locking rules (BR-LOCK-001…006), match scoring (10/5/0), final-tournament scoring (20s), tie-breaker order, important clarifications |
| [`stack-decision.md`](stack-decision.md) | Draft ADR proposing Next.js + Tailwind on Vercel + Supabase. Status: **Proposed, not approved**. OD-007 remains formally open. |

## Document at a glance

The Nortal architecture document is intentionally technology-agnostic. Its main sections:

- **§1–2** Executive summary, vision, success criteria
- **§3** Eight architecture principles (technology neutrality, security by design, rules outside the UI, provider abstraction, auditability, time-zone correctness, operational resilience, extensibility)
- **§4–5** Stakeholders, scope, assumptions, constraints
- **§6** Functional requirements (FR-001 … FR-020) + participant and admin journeys
- **§7** Business rules and scoring model — *extracted into [`scoring-model.md`](scoring-model.md)*
- **§8–9** Logical architecture and data architecture (12 entities, ownership rules)
- **§10** Integration architecture (provider-agnostic, football-data.org as example)
- **§11** Security and privacy (domain restriction, data minimization)
- **§12** Non-functional requirements (NFR-001 … NFR-012)
- **§13** Administration, operations, observability
- **§14** UX and engagement (participant requirements, optional engagement enhancements, accessibility)
- **§15** Quality assurance — *extracted into [`acceptance-criteria.md`](acceptance-criteria.md)*
- **§16** 7-phase delivery roadmap
- **§17** Risks and open decisions — *extracted into [`open-decisions.md`](open-decisions.md)*
- **§18** Glossary and references
- **Appendices** Requirements traceability matrix, implementation evaluation scorecard, pre-launch checklist
