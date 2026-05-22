---
description: "Task list for slice 001 (Eligibility & Login) — each task is a self-contained agent prompt"
---

# Tasks: Eligibility & Login (Slice 001)

**Input**: Design documents in `specs/001-eligibility-login/`

**Prerequisites**: `spec.md` (with Clarifications 2026-05-15), `plan.md`, `research.md`, `data-model.md`, all four files under `contracts/`, `quickstart.md` (all present).

**Test posture**: Tests are MANDATORY for this slice — Constitution Principle IX requires Given/When/Then scenarios committed RED before any production code that turns them GREEN. Principle XI requires the full regression suite to be GREEN before starting the next task or merging.

**Special status — Foundation slice**: This is the **first** slice in the codebase. It introduces the Next.js + Supabase repo layout, the OIDC stub for tests, and the **cross-slice locked contracts** (`is_eligible_nortal_participant(uuid)`, `participants` table shape, `audit_log` write pattern, `is_admin(uuid)` stub) that every subsequent slice (002–008) depends on. Changes to those contracts after this slice ships are constitutional-level coordinated changes per Principle XI.

## How to read this file

Each task below is a **self-contained agent prompt**. You can paste any single task into a fresh subagent (e.g., `Agent` tool with `subagent_type: general-purpose`) and it will have everything it needs — file paths to read, files to create or modify, acceptance criteria, dependencies, and a single-line "definition of done." Do not assume the subagent has any conversation state from this planning session.

Format conventions:

- **`[P]`** — the task is parallel-safe (no shared write paths with peers in the same phase that are also `[P]`).
- **`[US#]`** — the user story (from `spec.md`) the task belongs to. Phase-level tasks (Setup / Foundational / Polish) are unmarked.
- **`Blocked-by:`** — task IDs that MUST be `done` before this task can start. The orchestrator MUST honor these gates.
- **`Parallel-safe with:`** — task IDs that share no write paths with this task and can run concurrently.
- **`Definition of done:`** — exactly one checkable assertion. When that assertion holds, the task is done.

Path conventions match `plan.md` § Source Code:
- Migrations → `supabase/migrations/`
- Edge Functions (none in this slice) → `supabase/functions/`
- pgTAP → `supabase/tests/pgtap/`
- Web app (pages, API routes, libs) → `apps/web/`
- Playwright → `apps/web/tests/playwright/`

Constitution refresher (live during this slice):
- **II (Security by Design)**: domain eligibility enforced server-side at four layers (R-002).
- **III (Rules Outside the UI)**: `is_eligible_nortal_participant(auth.uid())` is the single named predicate; every slice from 002+ references it.
- **V (Auditability)**: every access decision (granted/denied) and every profile mutation writes an `audit_log` row in the same transaction.
- **VIII (Extensibility)**: approved-domain list lives in `tournament_config`; no hard-coded domains in code.
- **IX (TDD via BDD, NON-NEGOTIABLE)**: write the scenario, see it fail, then implement.
- **XI (Regression-Gated Progress, NON-NEGOTIABLE)**: full suite GREEN before next task starts or merge.

---

## Implementation deviations (running log — append-only)

Recorded as they arise during execution so downstream tasks stay aligned.

### D-005 (2026-05-19, surfaced in T038) — Supabase `custom_access_token` return shape (`claims` / `error`), not `decision`

- **Spec text**: `contracts/auth-hook.sql.md` § `handle_auth_user_signed_in` documents the return envelope as `{ "decision": "continue" }` on accept and `{ "decision": "reject", "message": "<text>" }` on reject — the same shape as `handle_auth_user_created`.
- **Reality**: per D-001, the returning-login hook is bound via `[auth.hook.custom_access_token]` (the only Supabase CLI v2.98.2 key that fires on every token issuance). The `custom_access_token` hook signature returns `jsonb_build_object('claims', <claims>)` on accept and `jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', '<reason>'))` on reject. Returning the `{decision,...}` shape from this hook would be silently ignored by Supabase Auth — the user would be admitted on a reject.
- **Decision**: `handle_auth_user_signed_in(event jsonb)` (T040) emits the `custom_access_token` envelope: success → `{"claims": {...}}` (claims passed through, possibly mutated for refresh purposes); reject → `{"error": {"http_code": 403, "message": "<reason>"}}`. `handle_auth_user_created(event jsonb)` (T024) keeps the `{decision,...}` shape because `before_user_created` is a Supabase v2 hook key in its own right and DOES respect that envelope. The two hooks are deliberately asymmetric in their return contract — they bind to different Supabase Auth hook keys.
- **Impact on later tasks**:
  - T038 (this task) — pgTAP for fail-closed asserts the `{decision,...}` shape against `handle_auth_user_created` (Scenario 1, 3) and the `{error,...}` shape against `handle_auth_user_signed_in` (Scenario 2).
  - T040 (`handle_auth_user_signed_in` body) — implement to the `custom_access_token` return shape; the contract document `contracts/auth-hook.sql.md` is the aspirational shape and is now superseded for this function by D-005 (the file will be updated when next opened).
  - T037 (`auth_hook_returning_login.sql`) — once authored, MUST assert the `{claims}` / `{error}` envelopes rather than the `{decision}` envelope referenced by the contract's text.

### D-004 (2026-05-19, surfaced in T034) — `participants` RLS tightening already shipped by T012

- **Spec text**: T034 (tasks.md lines 1277-1308) instructs the implementer to `DROP POLICY participants_self_read ON public.participants;` and `CREATE POLICY participants_self_read ... USING (auth_user_id = auth.uid() AND public.is_eligible_nortal_participant(auth.uid()))`. The data-model § RLS posture summary table also lists `participants_self_read` and `participants_admin_read` as two distinct policy names.
- **Initial state**: T012 (`supabase/migrations/0007_participants_rls.sql`) already ships a single combined policy named `participants_self_or_admin_read` whose USING clause **already embeds the eligibility predicate**: `(auth_user_id = auth.uid() AND public.is_eligible_nortal_participant(auth.uid())) OR public.is_admin(auth.uid())`. The tightening T034 was created to perform is therefore already live in migration 0007. Both pgTAP files gated on this behavior (`participants_rls_mid_session_deny.sql`, `slice-001-api-me-rls.sql`) explicitly call out in their header comments that T012's body alone is sufficient and that T034 is effectively a no-op for the predicate path — they reference the live policy by its actual name `participants_self_or_admin_read`.
- **Decision**: Migration `0011_participants_rls_eligibility_tighten.sql` is a header-only no-op that reserves slot 0011 to keep the migration sequence gap-free. The authoritative tightening remains in 0007 / T012. The data-model § RLS posture summary table's two-named-policies presentation is an aspirational decomposition (self-read + admin-read split into two policy rows) that the implementation collapsed into a single OR'd policy for efficiency and atomicity — the security posture is identical. No rename + split was performed because (a) no downstream test or contract requires the policy be named `participants_self_read` (both pgTAP files name `participants_self_or_admin_read`), (b) a DROP + CREATE on a correct live policy opens a brief no-policy window, and (c) duplicating policy ownership across two migrations violates Constitution Principle X (single-purpose migrations).
- **Impact on later tasks**:
  - T030's `participants_rls_mid_session_deny.sql` passes on T012's body alone — verified by its own header comment's "RED / GREEN expectation" section.
  - T030's `slice-001-api-me-rls.sql` likewise passes on T012's body alone.
  - T031's red-gate document and T035's regression checkpoint should both note that the predicate path of T034 is satisfied by 0007; only the no-op marker file 0011 is new.
  - If a future slice (likely Slice 006, when it hardens admin surfaces) needs the policy split into separately named `participants_self_read` + `participants_admin_read`, that work belongs in a new migration owned by that slice — not a retroactive edit to 0007 or 0011.

### D-003 (2026-05-19, surfaced in T028 regression checkpoint) — `/api/me` body shape reconciliation

- **Spec text**: `contracts/participant-me.read.md` pins 200 body as `{ "participant": {...} }` and error bodies as `{ "error": { "code", "message" } }` with `Cache-Control: private, max-age=0, must-revalidate`.
- **Initial implementation drift**: T027's dispatch prompt asked for raw `Participant` on 200 and `{ "error": "<short>" }` on errors with no Cache-Control header. T016's Playwright test (authored against the contract) used `body.participant.id`. T028 caught the mismatch.
- **Resolution**: `apps/web/app/api/me/route.ts` rewritten to the contract shape — `{ participant: {...} }` narrowed to the 8 contract fields (omits `auth_user_id`, `created_at`, `updated_at`), `{ error: { code, message } }` with codes `UNAUTHENTICATED` / `DOMAIN_NOT_APPROVED` / `INTERNAL`, and the prescribed `Cache-Control` header on every response. `tsc --noEmit` clean.
- **Impact on later tasks**:
  - T034 (API-guard audit write) — write `audit_log` rows on the 403 path per the contract; `requireEligible.ts` has a TODO marker pointing at this owner.

### D-002 (2026-05-19, surfaced in T019/T022) — `is_approved_domain` input shape

- **Spec text**: `contracts/eligibility-predicate.sql.md` line 104 locks `is_approved_domain(p_email text) RETURNS boolean` — accepts a FULL EMAIL, extracts the domain internally.
- **Initial drift**: T019's dispatch prompt told the subagent to test with bare-domain inputs (`'nortal.com'`). The subagent flagged it.
- **Resolution**: `supabase/tests/pgtap/is_approved_domain.sql` rewritten to use email inputs (`'alpha@nortal.com'`, etc.). T022's `is_approved_domain` migration accepts emails per the contract and trims whitespace before splitting.

### D-001 (2026-05-19, surfaced in T004) — Auth hook key rename

- **Spec text**: T004, T024, T040, T041, `plan.md`, `quickstart.md`, `contracts/auth-hook.sql.md` all reference a `[auth.hook.before_user_signed_in]` hook.
- **Reality**: Supabase CLI v2.98.2 does not support that key. Supported hook keys: `mfa_verification_attempt`, `password_verification_attempt`, `custom_access_token`, `send_sms`, `send_email`, `before_user_created`. Using the spec's key makes `supabase start` fail at config parse.
- **Decision**: Use `[auth.hook.custom_access_token]` instead. It fires on every token issuance (initial sign-in + refresh) — a tighter fit for FR-002 ("re-verify eligibility on every authenticated request") than a one-shot sign-in hook would be. The PG function name stays `public.handle_auth_user_signed_in`.
- **Impact on later tasks**:
  - T040 (`handle_auth_user_signed_in` body): implement to the `custom_access_token` signature — inputs `{user_id, claims, authentication_method}`, returns `{claims}` (or `{error}` envelope to deny). Use the claims-mutation path to refresh `participants` (display_name, region, last_login_at) and re-check eligibility; emit audit row in the same transaction.
  - T041 (the hook's regression checkpoint): expect re-verification on refresh-token issuance, not only on full re-login.
  - `contracts/auth-hook.sql.md`: when next opened, update the signature section to match.

---

## Phase 1: Setup (shared infrastructure)

This phase introduces the monorepo + Next.js + Supabase scaffolding. No business logic; no tests yet. All later phases assume the harness is functional.

- [X] T001 [P] Initialize pnpm workspace at repo root (`pnpm-workspace.yaml`, root `package.json`, `.npmrc`)

**Agent prompt:**

> **Goal**: Establish a pnpm-based monorepo at the repo root so `apps/web/` and any future packages share a single lockfile and node_modules.
>
> **Read first**:
> - `specs/001-eligibility-login/plan.md` § Source Code (for the `apps/` layout)
> - `README.md` (project overview — confirm the World Cup Madness identity and that no prior pnpm setup exists)
>
> **Files to create or modify**:
> - `pnpm-workspace.yaml` (new)
> - `package.json` (new — root manifest with `"private": true`, `"name": "world-cup-madness"`, `"packageManager": "pnpm@8.15.x"` or current)
> - `.npmrc` (new — `engine-strict=true`, `auto-install-peers=true`)
> - `.gitignore` — append `node_modules/`, `apps/web/.next/`, `apps/web/out/`, `.turbo/`, `*.tsbuildinfo`, `.env.local`, `.env*.local` (preserve existing `secrets/plain/` entry from current `.gitignore`)
>
> **What to do**:
> 1. `pnpm-workspace.yaml` declares `packages: ['apps/*']`.
> 2. Root `package.json` declares `scripts: { dev, build, test, typecheck, lint, e2e }` that delegate to workspace packages (`pnpm -r run <script>`). Do NOT add dependencies at the root — every dep is workspace-scoped.
> 3. Verify with `pnpm install` (creates lockfile, no installs since workspaces are empty until T002).
>
> **Acceptance criteria**:
> - `pnpm install` exits 0.
> - `pnpm-lock.yaml` exists at the repo root.
> - `git status` shows no surprise files (`.npmrc`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, updated `.gitignore`).
>
> **Do NOT**: install Next.js or any framework yet (T002 does that). Do NOT create `apps/web/` (T002 does that). Do NOT commit `node_modules/`.
>
> **Constitution**: foundation only — no principle directly applies.

**Blocked-by**: _(none)_
**Parallel-safe with**: T004
**Definition of done**: `pnpm install` succeeds at the repo root AND `pnpm-lock.yaml` is checked in.

---

- [X] T002 Bootstrap `apps/web/` Next.js App Router project (`apps/web/package.json`, TypeScript, Tailwind, Supabase SDK)

**Agent prompt:**

> **Goal**: Create the Next.js 14+ App Router project at `apps/web/` with TypeScript, Tailwind CSS, and `@supabase/supabase-js` + `@supabase/ssr` per `plan.md` § Technical Context.
>
> **Read first**:
> - `specs/001-eligibility-login/plan.md` § Technical Context (dependencies + versions)
> - `specs/001-eligibility-login/plan.md` § Source Code (the `apps/web/` tree)
> - The official Next.js + Supabase docs for the App Router auth-helpers pattern
>
> **Files to create or modify**:
> - `apps/web/package.json` (new)
> - `apps/web/tsconfig.json` (new)
> - `apps/web/next.config.mjs` (new)
> - `apps/web/tailwind.config.ts` (new)
> - `apps/web/postcss.config.mjs` (new)
> - `apps/web/app/layout.tsx` (new — minimal root layout)
> - `apps/web/app/page.tsx` (new — placeholder landing page with a "Sign in" link to `/auth/callback`)
> - `apps/web/app/globals.css` (new — Tailwind directives)
> - `apps/web/.env.example` (new — declares `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` placeholders + the OIDC stub vars `SUPABASE_AUTH_OIDC_ISSUER`, `SUPABASE_AUTH_OIDC_AUDIENCE`, etc., per T006)
> - `apps/web/.gitignore` (new — `.next/`, `out/`, `.env.local`)
>
> **What to do**:
> 1. Use `pnpm dlx create-next-app@latest apps/web --typescript --tailwind --app --eslint --no-src-dir --import-alias '@/*'` then edit `apps/web/package.json` to remove `eslint`-only flags if redundant and add `@supabase/supabase-js`, `@supabase/ssr` as deps.
> 2. Pin Next.js to `^14.2.0` (or current stable), React to `^18.3.0`, TypeScript to `^5.4.0`.
> 3. Add scripts: `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `lint`, `e2e` (placeholder for T003).
> 4. `apps/web/app/page.tsx` is a server component with a single `<a href="/auth/callback">Sign in</a>` link — purely a landing placeholder. Slices 002+ will replace it.
> 5. `apps/web/app/layout.tsx` defines `<html lang="en">` + `<body>` and imports Tailwind globals only.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` exits 0.
> - `pnpm -F web build` succeeds (empty placeholder build).
> - `pnpm -F web dev` boots and serves `http://localhost:3000` with the placeholder page.
>
> **Do NOT**: write any auth logic, any RLS-bound code, any `@supabase/supabase-js` clients yet (those go in T025+). Do NOT use the service-role key anywhere in this task.
>
> **Constitution**: I (Technology Neutrality at architectural layer; implementation layer is concrete here).

**Blocked-by**: T001
**Parallel-safe with**: T004
**Definition of done**: `pnpm -F web build` succeeds AND visiting `http://localhost:3000` in `pnpm -F web dev` shows the placeholder landing page.

---

- [X] T003 [P] Add Playwright harness to `apps/web/` (`apps/web/playwright.config.ts`, `@playwright/test` dep, `pnpm exec playwright install`)

**Agent prompt:**

> **Goal**: Wire Playwright into `apps/web/` so subsequent test-authoring tasks (T016, T017, T029, T036, etc.) can run scenarios against the Next.js dev server.
>
> **Read first**:
> - `specs/001-eligibility-login/plan.md` § Technical Context (Playwright is the E2E test framework of record per Constitution Principle IX)
> - `specs/001-eligibility-login/quickstart.md` § Run automated tests (for the exact commands)
> - Official Playwright + Next.js getting-started doc
>
> **Files to create or modify**:
> - `apps/web/package.json` — add `@playwright/test` to `devDependencies`; add scripts `e2e` (`playwright test`) and `e2e:ui` (`playwright test --ui`)
> - `apps/web/playwright.config.ts` (new) — config with `testDir: './tests/playwright'`, `use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' }`, `webServer: { command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 60_000 }`, projects for Chromium + Firefox + WebKit
> - `apps/web/tests/playwright/.gitkeep` (new — so the directory exists for later tasks)
> - `apps/web/tests/playwright/smoke.spec.ts` (new — a minimal `test('landing page loads', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle(/World Cup Madness/i); })` — exists ONLY so harness functionality is verifiable; T002 should set the title)
>
> **What to do**:
> 1. `pnpm -F web add -D @playwright/test`.
> 2. `pnpm -F web exec playwright install --with-deps` to download browsers (CI uses cached browsers).
> 3. Write the config + the smoke test.
> 4. Run `pnpm -F web e2e` and confirm the smoke test passes against `pnpm dev`.
>
> **Acceptance criteria**:
> - `pnpm -F web e2e` runs the smoke test to completion (pass).
> - `apps/web/tests/playwright/` exists with the smoke + .gitkeep.
>
> **Do NOT**: author any slice-001 scenarios yet — those are RED-first tasks in user-story phases. The smoke spec exists only as a harness-functioning probe.
>
> **Constitution**: IX (this task makes Principle IX runnable).

**Blocked-by**: T002
**Parallel-safe with**: T004, T005
**Definition of done**: `pnpm -F web e2e` runs the smoke test to GREEN against the Next.js dev server.

---

- [X] T004 [P] Bootstrap `supabase/` with `supabase init` (`supabase/config.toml`, `supabase/migrations/`, `supabase/seed/`, `supabase/tests/pgtap/`) — **artifacts only**; `supabase start` boot-verification deferred (Docker daemon was down at execution; user to verify locally). Hook key resolved per D-001.

**Agent prompt:**

> **Goal**: Create the Supabase local-dev scaffolding so migrations, seed scripts, and pgTAP tests have a canonical home and `supabase start` / `supabase db reset` work.
>
> **Read first**:
> - `specs/001-eligibility-login/plan.md` § Source Code (the `supabase/` tree)
> - `specs/001-eligibility-login/quickstart.md` § One-time setup
> - The official Supabase CLI docs for `supabase init`
>
> **Files to create or modify**:
> - `supabase/config.toml` (new — `supabase init` generates; manual edits below)
> - `supabase/migrations/.gitkeep` (new)
> - `supabase/seed/.gitkeep` (new)
> - `supabase/tests/pgtap/.gitkeep` (new)
> - `supabase/functions/.gitkeep` (new — empty for this slice but referenced by `plan.md`)
>
> **What to do**:
> 1. Run `supabase init` from the repo root (it scaffolds `supabase/config.toml`).
> 2. In `supabase/config.toml`:
>    - Set `[db]` `major_version = 15`.
>    - Set `[auth]` `enable_signup = false` (we only allow OIDC); `[auth.email]` `enable_signup = false`; `[auth.external.<provider>]` config — see T006 for the OIDC-stub binding.
>    - Set `[auth.hook.before_user_created]` and `[auth.hook.before_user_signed_in]` to point at `pg-functions://postgres/public/handle_auth_user_created` and `public/handle_auth_user_signed_in` respectively (the function bodies don't exist yet — T024 and T041 create them; this binding is the contract).
>    - Set `[db.seed]` `sql_paths = ['./supabase/seed/slice-001-fixture.sql']` (per T015 — the file doesn't exist yet but the path is reserved).
> 3. Create the four `.gitkeep` placeholders.
> 4. Run `supabase start` then `supabase status` to verify the local stack boots; then `supabase stop` to leave a clean baseline.
>
> **Acceptance criteria**:
> - `supabase start` boots all containers (Postgres, Auth, Studio) without error.
> - `supabase status` shows `API URL`, `DB URL`, `Studio URL` populated.
> - `supabase/config.toml` references both auth hooks even though the functions don't exist yet (graceful: Supabase Auth tolerates missing hook functions at boot; they error only on invocation).
>
> **Do NOT**: write any migrations, any seed SQL, any pgTAP tests in this task — those are dedicated tasks T009–T015. Do NOT enable email/password auth.
>
> **Constitution**: foundational — no principle directly applies.

**Blocked-by**: T001
**Parallel-safe with**: T002, T003, T005
**Definition of done**: `supabase start` succeeds AND `supabase/config.toml` declares both `before_user_created` and `before_user_signed_in` hooks even though their function bodies are not yet created.

---

- [ ] T005 [P] Verify pgTAP harness in the Supabase local stack (`supabase test db --help` succeeds; trivial test runs) — artifacts only; verification deferred (Docker daemon down)

**Agent prompt:**

> **Goal**: Confirm pgTAP is installed and `supabase test db --file <path>` works against the local Supabase stack so subsequent SQL-test tasks (T018, T019, T020, T030, T031, T037, T038, T039) can run.
>
> **Read first**:
> - `specs/001-eligibility-login/quickstart.md` § Run automated tests
> - The pgTAP docs (basic `BEGIN; SELECT plan(N); … SELECT * FROM finish(); ROLLBACK;` pattern)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/_harness_smoke.sql` (new — a one-assertion test: `BEGIN; SELECT plan(1); SELECT ok(true, 'pgtap harness boots'); SELECT * FROM finish(); ROLLBACK;`)
>
> **What to do**:
> 1. Ensure the Supabase stack is running (`supabase start`).
> 2. Verify pgTAP is available: `psql "$SUPABASE_DB_URL" -c "CREATE EXTENSION IF NOT EXISTS pgtap;"` should succeed (Supabase ships pgTAP).
> 3. Run `supabase test db --file supabase/tests/pgtap/_harness_smoke.sql` and confirm a single GREEN assertion.
>
> **Acceptance criteria**:
> - `supabase test db --file supabase/tests/pgtap/_harness_smoke.sql` exits 0 with `1..1` GREEN.
>
> **Do NOT**: author any slice-001 SQL tests in this task — those are RED-first tasks gated by red-gate verification. The smoke file is purely a harness probe.
>
> **Constitution**: IX (this task makes Principle IX runnable for SQL).

**Blocked-by**: T004
**Parallel-safe with**: T003
**Definition of done**: `supabase test db --file supabase/tests/pgtap/_harness_smoke.sql` is GREEN.

---

- [ ] T006 Configure OIDC stub provider sidecar for local + CI auth flows (`supabase/config.toml` `[auth.external.<stub>]`, Docker sidecar, signing keys) — artifacts only; supabase-start verification deferred (Docker daemon down)

**Agent prompt:**

> **Goal**: Stand up an OIDC-protocol fake-IdP sidecar (signing JWTs with a known keypair) so Playwright tests can synthesize arbitrary identity payloads (eligible, ineligible, missing-claims, email-drift, etc.) without depending on Microsoft Entra ID during dev/CI. Production uses Entra ID (R-001); this task is local-only infrastructure.
>
> **Read first**:
> - `specs/001-eligibility-login/research.md` § R-001 (provider abstraction)
> - `specs/001-eligibility-login/quickstart.md` § Auth provider setup (local stub)
> - Supabase's `[auth.external.<provider>]` config schema in `supabase/config.toml`
> - An off-the-shelf OIDC mock image such as `ghcr.io/oauth2-proxy/mockoidc` or `mock-oauth2-server` (Spotify's) — pick whichever has the simplest signed-token control API for tests
>
> **Files to create or modify**:
> - `supabase/config.toml` — add `[auth.external.<stub>]` block with `enabled = true`, `client_id`, `client_secret`, `url` (pointing at the sidecar at `http://host.docker.internal:<port>`), `redirect_uri = "http://localhost:54321/auth/v1/callback"`
> - `docker-compose.override.yml` (new at repo root — runs alongside `supabase start`) declaring the mock OIDC service with a deterministic RSA keypair mounted via volume + the issuer URL the Supabase Auth container can resolve
> - `infra/oidc-stub/keys/rsa-private.pem` and `infra/oidc-stub/keys/rsa-public.pem` (new — generated once, checked in since they are **dev-only**; production uses Entra ID's keys) — add a header comment in each file: `-- DEV-ONLY: not used in any production environment`
> - `infra/oidc-stub/README.md` (new — explains the stub, how to mint test JWTs, how Playwright fixtures use it)
> - `apps/web/.env.example` — extend with the stub's `SUPABASE_AUTH_OIDC_ISSUER`, `SUPABASE_AUTH_OIDC_AUDIENCE`, `SUPABASE_AUTH_OIDC_CLIENT_ID`, `SUPABASE_AUTH_OIDC_CLIENT_SECRET` envs
>
> **What to do**:
> 1. Pick the mock OIDC image (recommend `ghcr.io/navikt/mock-oauth2-server` — supports configurable issuer + token templates via HTTP). Pin to a specific version tag.
> 2. Author `docker-compose.override.yml` so `supabase start` also brings up the mock provider on a fixed port.
> 3. Generate the dev RSA keypair (`openssl genrsa -out infra/oidc-stub/keys/rsa-private.pem 2048; openssl rsa -in … -pubout > rsa-public.pem`). Add header comments marking them dev-only.
> 4. Wire Supabase `[auth.external.<stub>]` to the sidecar — verify `supabase start && supabase status` shows the provider as healthy.
> 5. Author a tiny TypeScript helper `apps/web/tests/playwright/fixtures/oidc.ts` (new) that posts to the mock provider's `/configuration` endpoint to register a one-shot identity payload, then drives the Next.js sign-in flow. Subsequent test-authoring tasks (T016, T017, etc.) consume this helper.
> 6. Add a one-paragraph note to `apps/web/.env.example` distinguishing the dev stub from production Entra ID.
>
> **Acceptance criteria**:
> - `supabase start` brings up Postgres, Auth, Studio, AND the OIDC stub.
> - `curl http://localhost:<stub-port>/.well-known/openid-configuration` returns a valid OIDC discovery document.
> - The `apps/web/tests/playwright/fixtures/oidc.ts` helper can mint a JWT for an eligible identity and the Supabase Auth callback exchanges it for a session (manual smoke check is sufficient; the formal test is in T016).
>
> **Do NOT**: ship any of these stub keys to production. Do NOT reuse the stub's `client_secret` in any non-dev env. Do NOT write the slice-001 Playwright scenarios in this task.
>
> **Constitution**: IV (Provider Abstraction — the stub treats the IdP as one OIDC provider behind Supabase Auth; production swap is config-only).

**Blocked-by**: T004
**Parallel-safe with**: T003, T005
**Definition of done**: `curl http://localhost:<stub-port>/.well-known/openid-configuration` returns a valid OIDC discovery document AND the Playwright `fixtures/oidc.ts` helper exists and is importable.

---

- [ ] T007 Wire CI: GitHub Actions workflow that runs Playwright + pgTAP + typecheck on every PR (`.github/workflows/ci.yml`) — workflow file written; PR-trigger verification deferred (no GitHub remote push yet)

**Agent prompt:**

> **Goal**: Set up the CI gate that future regression checkpoints (T028, T035, T042, T046) rely on. Without CI, Constitution Principle XI ("regression suite GREEN before next task starts or merge") is not enforceable.
>
> **Read first**:
> - `specs/001-eligibility-login/plan.md` § Testing
> - `.specify/memory/constitution.md` § Principle XI
> - The repo's `.githooks/` directory (verify it's not already running CI-equivalent locally — it isn't; `.githooks/` is just bootstrap hooks)
>
> **Files to create or modify**:
> - `.github/workflows/ci.yml` (new)
>
> **What to do**:
> 1. Define three jobs: `typecheck`, `playwright`, `pgtap`.
> 2. `typecheck`: ubuntu-latest, checkout, pnpm setup, `pnpm install`, `pnpm -F web typecheck`.
> 3. `playwright`: ubuntu-latest, checkout, pnpm setup, install browsers (cached), bring up Supabase local stack via `supabase start` (uses Docker), run `pnpm -F web e2e`.
> 4. `pgtap`: ubuntu-latest, checkout, bring up Supabase, loop over every `*.sql` under `supabase/tests/pgtap/` and run `supabase test db --file <each>`; aggregate pass/fail. (Or use a single `supabase test db` invocation that runs the whole dir if the CLI supports it.)
> 5. Add a final `regression-gate` job that requires the three above to pass.
> 6. Trigger: `on: { pull_request: { branches: [main] }, push: { branches: [main] } }`.
>
> **Acceptance criteria**:
> - A trivial PR against this branch triggers the workflow.
> - All three jobs complete (the test ones will be near-empty until T016+ author scenarios; the workflow itself must succeed).
>
> **Do NOT**: bypass any job with `continue-on-error`. Do NOT skip tests on `main` pushes. Do NOT cache Playwright browsers in a way that masks version drift between runs.
>
> **Constitution**: XI (NON-NEGOTIABLE — this workflow is the regression gate).

**Blocked-by**: T003, T005
**Parallel-safe with**: T006
**Definition of done**: A PR triggers the workflow AND all three jobs report GREEN against an empty-or-smoke-only test surface.

---

- [X] T008 Update `INDEX.md` and `CLAUDE_START.md` to reflect the new `apps/`, `supabase/`, and `.github/` directories

**Agent prompt:**

> **Goal**: Keep the repo's navigational artifacts (`INDEX.md`, `CLAUDE_START.md`) consistent with the new layout this slice introduces. Per `CLAUDE.md` "Important Rules" #4, INDEX.md is updated after structural changes.
>
> **Read first**:
> - `INDEX.md` (current state)
> - `CLAUDE_START.md` (current state)
> - `scripts/index/generate.sh` (if it auto-generates — use it instead of hand-editing)
> - `specs/001-eligibility-login/plan.md` § Source Code (the canonical directory tree)
>
> **Files to create or modify**:
> - `INDEX.md` (modify — add `apps/`, `supabase/`, `.github/`, `infra/oidc-stub/` entries)
> - `CLAUDE_START.md` (modify — add a section "Slice 001 introduces the app skeleton at `apps/web/` and the Supabase backend at `supabase/`")
>
> **What to do**:
> 1. If `scripts/index/generate.sh` exists and produces `INDEX.md`, run it and commit the result.
> 2. Otherwise hand-edit `INDEX.md` to list the new top-level directories with one-line descriptions.
> 3. Add a brief Slice 001 note to `CLAUDE_START.md` pointing readers at `specs/001-eligibility-login/plan.md`.
>
> **Acceptance criteria**:
> - `INDEX.md` lists `apps/web/`, `supabase/`, `.github/`, `infra/oidc-stub/`.
> - `CLAUDE_START.md` mentions the Slice 001 introduction.
>
> **Do NOT**: rewrite `CLAUDE.md` (the SPECKIT marker was already updated by `/speckit-plan`).
>
> **Constitution**: foundational hygiene.

**Blocked-by**: T002, T004, T006, T007
**Parallel-safe with**: _(none — touches shared docs)_
**Definition of done**: `INDEX.md` and `CLAUDE_START.md` reflect the new directory layout.

---

**Setup checkpoint**: T001–T008 done. Monorepo is scaffolded, Next.js app boots, Supabase local stack runs, Playwright + pgTAP harnesses functional, OIDC stub available, CI green-on-empty. Foundational schema phase can now start.

---

## Phase 2: Foundational (BLOCKING — no user story may start until this phase completes)

This phase creates the schema, RLS scaffolding, helper stubs, and seed fixture. It deliberately does NOT create the eligibility predicate's body, the `is_approved_domain` body, or the auth hooks' bodies — those are owned by per-story tasks so that Principle IX's red-first ordering is preserved.

- [X] T009 [P] Migration 0001: `participants` table + indexes + `updated_at` trigger (`supabase/migrations/0001_participants.sql`)

**Agent prompt:**

> **Goal**: Create the Postgres migration that defines the `public.participants` table per `data-model.md` § Entity 1, with all indexes, the `citext` email extension, the generated `domain` column, and the `updated_at`-maintenance trigger. NO RLS (T012 owns RLS). NO audit trigger (T013 owns that).
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 1 (Participant) — all attributes, validation rules, indexes
> - `specs/001-eligibility-login/research.md` § R-003 (identifier strategy)
> - `specs/001-eligibility-login/plan.md` § Source Code (filename: `0001_participants.sql`)
> - Spec Clarifications 2026-05-15 — the `participation_status` enum is exactly `{active, deactivated}`
>
> **Files to create or modify**:
> - `supabase/migrations/0001_participants.sql` (new)
>
> **What to do**:
> 1. Wrap in `BEGIN; … COMMIT;`.
> 2. `CREATE EXTENSION IF NOT EXISTS citext;`
> 3. `CREATE TYPE public.participation_status AS ENUM ('active', 'deactivated');` (exactly two values per spec Clarifications 2026-05-15).
> 4. `CREATE TABLE public.participants (...)` with the column set from `data-model.md` § Entity 1. `email citext NOT NULL`, `domain citext GENERATED ALWAYS AS (lower(split_part(email::text, '@', 2))) STORED NOT NULL`, `auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT`.
> 5. Add UNIQUE constraints: `participants_auth_user_id_uk` on `(auth_user_id)`, `participants_email_uk` on `(email)`.
> 6. Add CHECK constraints: `email LIKE '%@%'`, `length(trim(display_name)) > 0`.
> 7. Add indexes: `participants_domain_status_idx` on `(domain, status)`, `participants_last_login_at_idx` on `(last_login_at DESC)`.
> 8. Create the `updated_at` maintenance trigger: `BEFORE UPDATE` → `NEW.updated_at = now()`.
> 9. Header comment: `-- Slice 001 / FR-003 / data-model.md § Entity 1 / spec.md Clarifications 2026-05-15`.
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds locally with this migration in place.
> - `\d+ participants` shows all columns, the two UNIQUEs, the two indexes, and the trigger.
> - `SELECT enum_range(NULL::public.participation_status)` returns `{active, deactivated}`.
>
> **Do NOT**: add RLS, add an audit trigger, add the `is_*` functions. Do NOT add any extra enum values "for the future" — Clarifications 2026-05-15 locks the enum to exactly two.
>
> **Constitution**: I (Technology-neutral at spec layer; concrete here), IX (locked enum supports testable scenarios).

**Blocked-by**: T008
**Parallel-safe with**: T010, T011
**Definition of done**: `supabase db reset` succeeds AND `\d+ participants` shows the full shape AND `enum_range(NULL::public.participation_status)` returns exactly `{active, deactivated}`.

---

- [X] T010 [P] Migration 0002: `tournament_config` stub + seed `eligibility.approved_domains = ["nortal.com"]` (`supabase/migrations/0002_tournament_config_stub.sql`)

**Agent prompt:**

> **Goal**: Create the minimal `tournament_config` table (Slice 008 will own and extend it) and seed the `eligibility.approved_domains` key with `["nortal.com"]` per `research.md` § R-005.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 2 (Approved Domain reference)
> - `specs/001-eligibility-login/research.md` § R-005 (configuration source)
> - The Slice 005 research § R-014 for the canonical `tournament_config` shape — this slice's stub MUST be a strict subset
>
> **Files to create or modify**:
> - `supabase/migrations/0002_tournament_config_stub.sql` (new)
>
> **What to do**:
> 1. `CREATE TABLE IF NOT EXISTS public.tournament_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NULL);`
> 2. `INSERT INTO public.tournament_config (key, value) VALUES ('eligibility.approved_domains', '["nortal.com"]'::jsonb) ON CONFLICT (key) DO NOTHING;`
> 3. Add a SQL comment header: `-- Slice 001 stubs the tournament_config table that Slice 008 will own. The eligibility.approved_domains key is the only one this slice writes; Slice 008 may add others. OD-001 (the actual approved-domain list for production launch) is tracked separately and will be set via Slice 008's admin UI.`
> 4. Add a comment near the INSERT noting `value` is jsonb — downstream readers MUST cast (`(value)::text[]`, `jsonb_array_elements_text(value)`, etc.).
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `SELECT value FROM public.tournament_config WHERE key = 'eligibility.approved_domains'` returns `["nortal.com"]`.
>
> **Do NOT**: add RLS in this migration (T012 owns it). Do NOT seed any other keys — Slice 008 owns those. Do NOT hard-code domain strings anywhere except this seed line.
>
> **Constitution**: VIII (Extensibility & Configuration — rule values live in config).

**Blocked-by**: T008
**Parallel-safe with**: T009, T011
**Definition of done**: `supabase db reset` succeeds AND `SELECT count(*) FROM tournament_config WHERE key = 'eligibility.approved_domains'` returns `1`.

---

- [X] T011 [P] Migration 0003: `audit_log` stub (`supabase/migrations/0003_audit_log_stub.sql`)

**Agent prompt:**

> **Goal**: Create the minimal `audit_log` table that Slice 007 will own and harden. This slice writes to it from the auth hook (T024, T041) and the participants trigger (T013). The shape MUST exactly match `data-model.md` § Entity 3 so Slice 007's migration only extends, never alters.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 3 (Access Decision Event)
> - `specs/001-eligibility-login/research.md` § R-008 (audit integration)
> - Slice 005 research § R-012 — same audit-table contract pattern
>
> **Files to create or modify**:
> - `supabase/migrations/0003_audit_log_stub.sql` (new)
>
> **What to do**:
> 1. `CREATE TABLE IF NOT EXISTS public.audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NULL, action text NOT NULL, entity_type text NULL, entity_id uuid NULL, previous_value jsonb NULL, new_value jsonb NULL, reason text NULL, source text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());`
> 2. Add a CHECK constraint: `source IN ('auth_hook', 'rls', 'api_guard', 'ui', 'trigger')`.
> 3. Add an index on `(occurred_at DESC)` for retention queries; an index on `(action, occurred_at DESC)` for forensic searches.
> 4. Header comment: `-- Slice 001 stubs audit_log; Slice 007 will harden retention + tamper-resistance + search. The columns defined here are LOCKED — Slice 007 may add columns but MUST NOT alter or drop any of these.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds.
> - `INSERT INTO audit_log(action, source) VALUES ('access.denied', 'auth_hook')` succeeds (defaults populate the rest).
> - Trying `INSERT INTO audit_log(action, source) VALUES ('x', 'wrong_source')` fails the CHECK.
>
> **Do NOT**: add RLS here (T012 owns it). Do NOT add UPDATE/DELETE triggers (Slice 007 owns append-only enforcement). Do NOT write any test rows here — fixture (T015) handles seed.
>
> **Constitution**: V (NON-NEGOTIABLE: audit shape is locked).

**Blocked-by**: T008
**Parallel-safe with**: T009, T010
**Definition of done**: `supabase db reset` succeeds AND a sample INSERT with a valid `source` works AND an INSERT with an unknown `source` raises the CHECK.

---

- [X] T012 Migration 0007: RLS on `participants`, `audit_log`, `tournament_config` (`supabase/migrations/0007_participants_rls.sql`)

**Agent prompt:**

> **Goal**: Enable RLS on the three foundational tables and define the policies per `data-model.md` § RLS posture summary. Views and helper-function calls in RLS are NOT in scope here — they're added in T022 (is_approved_domain) and T023 (is_eligible_nortal_participant).
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § RLS posture summary
> - `specs/001-eligibility-login/plan.md` § Constitution Check (Principle II)
> - `specs/001-eligibility-login/research.md` § R-002, R-009 (the four-layer enforcement)
>
> **Files to create or modify**:
> - `supabase/migrations/0007_participants_rls.sql` (new)
>
> **What to do**:
> 1. `ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;`
>    - Policy `participants_self_read` (SELECT): `USING (auth_user_id = auth.uid())`. **Note**: this is the "minimum viable" predicate. T023 will introduce `is_eligible_nortal_participant(auth.uid())` and a later migration in this slice (T034) will REPLACE this policy with `USING (auth_user_id = auth.uid() AND is_eligible_nortal_participant(auth.uid()))` to enforce the mid-session-deny invariant from spec Clarifications 2026-05-15. Add a SQL comment in this migration: `-- T034 will tighten this with the eligibility predicate once T023 ships it.`
>    - Policy `participants_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))` — the `is_admin` stub is owned by T014, so this migration must run after T014.
>    - No INSERT/UPDATE/DELETE policies — writes go through the auth hook's `SECURITY DEFINER` path (T024, T041).
> 2. `ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;`
>    - Policy `audit_log_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))`.
>    - No INSERT policy at the row level (writes use `SECURITY DEFINER` functions in T024, T013, T041).
> 3. `ALTER TABLE public.tournament_config ENABLE ROW LEVEL SECURITY;`
>    - Policy `tournament_config_eligibility_anon_read` (SELECT): `USING (key = 'eligibility.approved_domains')`. **Important**: this is the recursion-avoidance carve-out documented in `data-model.md` § 2 — `is_approved_domain` reads this row when called from any RLS context.
>    - Policy `tournament_config_admin_read` (SELECT): `USING (public.is_admin(auth.uid()))` for the rest.
>    - No write policies — Slice 008 owns writes.
> 4. Header comment: `-- Slice 001 / data-model.md § RLS posture / depends on is_admin stub (T014). Participant policy gets tightened by T034 once is_eligible_nortal_participant ships.`
>
> **Acceptance criteria**:
> - `supabase db reset` succeeds with this migration in place.
> - With a participant JWT, `SELECT * FROM public.participants` returns only that participant's row (once T015 fixture populates rows).
> - With a participant JWT, `SELECT * FROM public.audit_log` returns zero rows.
> - With a participant JWT, `SELECT * FROM public.tournament_config` returns exactly one row (the `eligibility.approved_domains` row).
> - With an admin JWT (`auth.jwt() ->> 'role' = 'admin'`), all three queries return all rows.
>
> **Do NOT**: weaken RLS to make tests easier — JWTs in tests must satisfy these predicates. Do NOT call `is_eligible_nortal_participant` here yet (it doesn't exist).
>
> **Constitution**: II (Security by Design), III (Rules at the data boundary).

**Blocked-by**: T009, T010, T011, T014
**Parallel-safe with**: _(none — sequential after T014)_
**Definition of done**: RLS is enabled on all three tables AND a participant JWT scopes each query to its own row(s) AND an admin JWT sees all rows.

---

- [X] T013 Migration 0008: `participants` audit trigger (`supabase/migrations/0008_participants_audit_trigger.sql`)

**Agent prompt:**

> **Goal**: Create the `AFTER INSERT OR UPDATE OR DELETE` trigger on `participants` that emits one row per change into `audit_log`, in the same transaction. Captures `previous_value` (NULL on INSERT) and `new_value` (NULL on DELETE) as full-row jsonb.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 3 (Access Decision Event — § Write paths)
> - `specs/001-eligibility-login/research.md` § R-008
> - `specs/001-eligibility-login/spec.md` US1 Acceptance Scenario 1 (which audit fields are required)
>
> **Files to create or modify**:
> - `supabase/migrations/0008_participants_audit_trigger.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.log_participant_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$`.
> 2. Body:
>    - On INSERT: `INSERT INTO audit_log(actor, action, entity_type, entity_id, previous_value, new_value, source) VALUES (NEW.id, 'participant.created', 'participant', NEW.id, NULL, to_jsonb(NEW), 'trigger');`
>    - On UPDATE: log `participant.updated` with both `previous_value = to_jsonb(OLD)` and `new_value = to_jsonb(NEW)`. **Skip** if `pg_trigger_depth() > 1` (recursion guard from `data-model.md` § Entity 3).
>    - On DELETE: log `participant.deleted` with `previous_value = to_jsonb(OLD)`, `new_value = NULL` — though no normal write path DELETEs participants, the trigger covers admin/manual paths.
> 3. `CREATE TRIGGER log_participants_change AFTER INSERT OR UPDATE OR DELETE ON public.participants FOR EACH ROW EXECUTE FUNCTION public.log_participant_change();`
> 4. Header comment: `-- Slice 001 / FR-018 / V (NON-NEGOTIABLE). Defensive duplicate of the auth-hook's audit row — guarantees audit_log never lags behind data even if the hook is mis-wired.`
>
> **Acceptance criteria**:
> - `INSERT INTO participants(...)` produces exactly one new `audit_log` row with `action='participant.created'`, `actor = new participants.id`, `source='trigger'`.
> - `UPDATE participants SET display_name='X' WHERE id=...` produces `action='participant.updated'` with both `previous_value` and `new_value` populated.
>
> **Do NOT**: skip the recursion guard — without it, `audit_log` could be written into a chain of triggers in a future slice and recursively re-log itself. Do NOT use `SECURITY INVOKER` — the trigger needs to write `audit_log` regardless of the calling user's RLS on it.
>
> **Constitution**: V (NON-NEGOTIABLE).

**Blocked-by**: T009, T011
**Parallel-safe with**: T014
**Definition of done**: A single `INSERT INTO participants(...)` produces exactly one `audit_log` row with `action='participant.created'` and matching `entity_id`.

---

- [X] T014 [P] Migration 0006: `is_admin(uuid)` stub (`supabase/migrations/0006_is_admin_stub.sql`)

**Agent prompt:**

> **Goal**: Define the permissive `is_admin(uuid) RETURNS boolean STABLE` function that Slice 006 will later replace with the real admin-role check. The signature is a cross-slice locked contract.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Cross-slice ownership map and § RLS posture summary
> - `specs/001-eligibility-login/research.md` § R-006 (cross-slice predicate pattern)
>
> **Files to create or modify**:
> - `supabase/migrations/0006_is_admin_stub.sql` (new)
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$ SELECT COALESCE(auth.jwt() ->> 'role' = 'admin', false); $$;`
> 2. Header comment (verbatim, this exact wording — Slice 006 will read it): `-- STUB owned by Slice 005's pattern; Slice 001 ships it because RLS in T012 references it. Slice 006 (admin overrides) MUST replace the body with the real role check WITHOUT changing the signature (uuid → boolean STABLE). Tests in this slice synthesize JWTs whose 'role' claim = 'admin' to satisfy this stub; Slice 006 tests will use whatever mechanism it introduces.`
>
> **Acceptance criteria**:
> - `SELECT is_admin('00000000-0000-0000-0000-000000000000')` returns `false`.
> - A psql session with `SET LOCAL request.jwt.claims = '{"role":"admin"}'` and `SELECT is_admin(auth.uid())` returns `true`.
>
> **Do NOT**: hard-code any specific admin UUID. Do NOT add an `is_admin` policy override. Do NOT replace the function body — that's Slice 006's job.
>
> **Constitution**: III (locked signature for cross-slice reuse), XI (signature change requires coordinating Slice 006 tests).

**Blocked-by**: T011
**Parallel-safe with**: T013
**Definition of done**: `SELECT is_admin('any-uuid')` returns `false` AND under a JWT with `role=admin` claim it returns `true`.

---

- [X] T015 Seed fixture `slice-001-fixture.sql` (`supabase/seed/slice-001-fixture.sql`)

**Agent prompt:**

> **Goal**: Create the deterministic seed described in `quickstart.md` § Seed data so per-story tests can predict exact outcomes. Tests MUST read identities from this fixture; they MUST NOT create ad-hoc accounts inline.
>
> **Read first**:
> - `specs/001-eligibility-login/quickstart.md` § Seed data (lists what the fixture must contain)
> - `specs/001-eligibility-login/spec.md` Acceptance Scenarios (US1, US2, US3) and Edge Cases — fixture must cover every path
> - `specs/001-eligibility-login/data-model.md` § Entity 1 (Participant column semantics)
>
> **Files to create or modify**:
> - `supabase/seed/slice-001-fixture.sql` (new)
>
> **What to do**:
> 1. Wrap in `BEGIN; … COMMIT;`. Use `INSERT … ON CONFLICT DO NOTHING` everywhere so re-running is safe.
> 2. Stage 3 eligible `auth.users` rows: `alpha@nortal.com`, `bravo@nortal.com`, `charlie@nortal.com`. Use stable UUIDs (`00000000-0000-0000-0000-00000000000A` etc.). Each row needs `email_confirmed_at = now()`.
> 3. Provision corresponding `public.participants` rows with `status='active'`, `display_name` matching the email's local part (`Alpha`, `Bravo`, `Charlie`), `region = 'EE-North'` for Alpha and Bravo, `region = NULL` for Charlie.
> 4. Stage 1 deactivated participant: `zulu@nortal.com` with `status='deactivated'`.
> 5. Stage 1 ineligible `auth.users` row: `outsider@example.com`. **Do NOT** insert into `participants` — the auth-hook would reject it; this stub exists only so the API-guard path is testable in T029.
> 6. Confirm `tournament_config.eligibility.approved_domains` already contains `["nortal.com"]` (T010's seed); the fixture does NOT re-seed it.
> 7. Top-of-file comment block: "Hand-verified scenario coverage" listing every test scenario (US1 / US2 / US3 / E-1 / E-2 / E-3 / E-5 / E-6) and which fixture row exercises it.
>
> **Acceptance criteria**:
> - `psql "$SUPABASE_DB_URL" -f supabase/seed/slice-001-fixture.sql` succeeds against a freshly-reset DB.
> - The seed produces exactly 5 `auth.users` rows and exactly 4 `participants` rows (3 active + 1 deactivated).
> - Re-running the fixture produces no new rows (ON CONFLICT DO NOTHING).
>
> **Do NOT**: insert directly into `audit_log` (let triggers + hooks do that during tests). Do NOT depend on any not-yet-created table.
>
> **Constitution**: IX (fixture exists so scenarios can assert deterministic outcomes).

**Blocked-by**: T012, T013, T014
**Parallel-safe with**: _(none — depends on all foundational schema being done)_
**Definition of done**: The fixture loads cleanly, produces 5 auth users + 4 participants, and the embedded scenario-coverage comment block covers every spec Acceptance Scenario and the seven Edge Cases.

---

**Foundational checkpoint**: T001–T015 done. Schema, RLS scaffolding, stubs, and seed exist. No user-story logic yet. User-story phases below can now start.

---

## Phase 3: User Story 1 — Eligible employee signs in (Priority: P1)

**Story goal**: A Nortal employee opens the app, authenticates via the corporate IdP, is recognized as eligible, gets a provisioned profile, and lands on the dashboard. On subsequent visits the same profile is re-used and `last_login_at` updates (`spec.md` US1).

**Story-independent test** (`spec.md` US1 § Independent Test): Sign in as a user whose email domain is on the approved list, verify the dashboard renders and `participants` has a single matching row with all FR-003 fields; sign out and back in, verify same row + `last_login_at` updated.

- [X] T016 [P] [US1] Author Playwright `slice-001-login-approved.spec.ts` (RED) — `apps/web/tests/playwright/slice-001-login-approved.spec.ts`

**Agent prompt:**

> **Goal**: Author Playwright BDD scenarios for US1's three Acceptance Scenarios. The file MUST be RED — T022/T023/T024/T026/T027 will turn it GREEN.
>
> **Read first**:
> - `specs/001-eligibility-login/spec.md` § User Story 1 (all 3 Acceptance Scenarios)
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § Decision matrix
> - `specs/001-eligibility-login/contracts/auth-callback.page.md` § Behavior — `/auth/callback`
> - `specs/001-eligibility-login/contracts/participant-me.read.md` § Response shape
> - `supabase/seed/slice-001-fixture.sql` (fixture rows your tests reference)
> - `apps/web/tests/playwright/fixtures/oidc.ts` (the OIDC-stub helper from T006)
> - `.specify/memory/constitution.md` § Principle IX ("every Then-clause MUST be a checkable assertion")
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-001-login-approved.spec.ts` (new)
>
> **What to do**:
> 1. `test.describe('US1 — Eligible employee signs in')`.
> 2. Test 1 (Scenario 1, first-time eligible): mint OIDC JWT for `newuser@nortal.com` via stub; visit `/auth/callback`; assert redirect to `/dashboard`; assert page renders "Welcome, New User" (or equivalent placeholder); assert `participants` table has a single row for that email with all FR-003 attributes populated and `participation_status='active'`; assert `audit_log` has `access.granted` and `participant.created` rows in the same transaction (both `occurred_at` within milliseconds).
> 3. Test 2 (Scenario 2, returning eligible): use existing `alpha@nortal.com` fixture; capture `participants.last_login_at` before; sign in via stub with same identity; assert dashboard reached within 10s; assert single `participants` row (no duplicate); assert `last_login_at` advanced; assert no `participant.created` row in this transaction (only `access.granted` and possibly `participant.updated`).
> 4. Test 3 (Scenario 3, state-changing request re-verifies eligibility): sign in as eligible; pre-`fetch('/api/me')` returns 200; admin removes domain via `psql -c "UPDATE tournament_config SET value = '[]'::jsonb WHERE key='eligibility.approved_domains'"`; next `fetch('/api/me')` returns 403; restore config; assert behavior matches Clarifications 2026-05-15.
> 5. Every Then-clause MUST assert specific values or status codes — no "should be reasonable" language.
>
> **Acceptance criteria**:
> - File compiles under `pnpm -F web typecheck`.
> - `pnpm -F web e2e slice-001-login-approved.spec.ts` shows 3 tests RED for assertion-level reasons (404 on `/auth/callback`, missing `participants` row, etc. — NOT for infrastructure errors).
>
> **Do NOT**: implement any production code. Do NOT modify migrations. Do NOT seed any data inline.
>
> **Constitution**: IX (NON-NEGOTIABLE) — must be checked into git and CI must run them RED before T022–T027 begin.

**Blocked-by**: T015
**Parallel-safe with**: T017, T018, T019, T020
**Definition of done**: 3 RED Playwright tests exist in `slice-001-login-approved.spec.ts` and CI reports them failing for assertion reasons.

---

- [X] T017 [P] [US1] Author Playwright `slice-001-login-missing-claims.spec.ts` (RED) — `apps/web/tests/playwright/slice-001-login-missing-claims.spec.ts`

**Agent prompt:**

> **Goal**: Author the Edge Case E-1 scenario (IdP payload missing `email` or `display_name` claim → deny + audit).
>
> **Read first**:
> - `specs/001-eligibility-login/spec.md` § Edge Cases (E-1 row)
> - `specs/001-eligibility-login/research.md` § R-011 (E-1 mapping)
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § Steps 1 (claim-missing path)
> - `apps/web/tests/playwright/fixtures/oidc.ts`
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-001-login-missing-claims.spec.ts` (new)
>
> **What to do**:
> 1. Test 1 (missing email): mint OIDC JWT with no `email` claim; visit `/auth/callback`; assert redirect to `/auth/denied?reason=missing_claims`; assert no new `auth.users` row was created; assert `audit_log` has `access.denied` with `reason='missing_claims'`, `source='auth_hook'`.
> 2. Test 2 (missing display_name): same shape, missing display_name; same expectations.
>
> **Acceptance criteria**: 2 RED tests in this file.
>
> **Do NOT**: implement anything. Do NOT relax the contract's "no auth.users row created" assertion — it's load-bearing for Constitution Principle II.
>
> **Constitution**: IX.

**Blocked-by**: T015
**Parallel-safe with**: T016, T018, T019, T020
**Definition of done**: 2 RED Playwright tests in `slice-001-login-missing-claims.spec.ts`.

---

- [X] T018 [P] [US1] Author pgTAP `is_eligible_active_approved.sql` + companion negatives (RED) — `supabase/tests/pgtap/is_eligible_active_approved.sql`, `is_eligible_deactivated.sql`, `is_eligible_unknown_uid.sql`, `is_eligible_null_uid.sql`

**Agent prompt:**

> **Goal**: Author the four base pgTAP tests for `is_eligible_nortal_participant(uuid)` per `contracts/eligibility-predicate.sql.md` § Test surface. All RED until T023 implements the function.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/eligibility-predicate.sql.md` § Test surface
> - `supabase/seed/slice-001-fixture.sql` (fixture UUIDs your assertions reference)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/is_eligible_active_approved.sql` (new)
> - `supabase/tests/pgtap/is_eligible_deactivated.sql` (new)
> - `supabase/tests/pgtap/is_eligible_unknown_uid.sql` (new)
> - `supabase/tests/pgtap/is_eligible_null_uid.sql` (new)
>
> **What to do**:
> 1. Each file: `BEGIN; SELECT plan(1); … SELECT * FROM finish(); ROLLBACK;` pattern.
> 2. `is_eligible_active_approved.sql`: `SELECT is(public.is_eligible_nortal_participant(<alpha-auth-uuid>), true, 'active approved-domain participant is eligible')`.
> 3. `is_eligible_deactivated.sql`: `SELECT is(public.is_eligible_nortal_participant(<zulu-auth-uuid>), false, 'deactivated participant is not eligible')`.
> 4. `is_eligible_unknown_uid.sql`: `SELECT is(public.is_eligible_nortal_participant(gen_random_uuid()), false, 'unknown uid is not eligible')`.
> 5. `is_eligible_null_uid.sql`: `SELECT is(public.is_eligible_nortal_participant(NULL), false, 'NULL uid returns false (not NULL)')`.
>
> **Acceptance criteria**: All four files run and FAIL with "function public.is_eligible_nortal_participant does not exist" or "0 of 1 tests passing".
>
> **Do NOT**: implement the function. Do NOT modify the fixture.
>
> **Constitution**: IX.

**Blocked-by**: T015
**Parallel-safe with**: T016, T017, T019, T020
**Definition of done**: Four pgTAP files exist; each fails RED for the documented reason.

---

- [X] T019 [P] [US1] Author pgTAP for `is_approved_domain` (RED) — `supabase/tests/pgtap/is_approved_domain.sql`

**Agent prompt:**

> **Goal**: Author pgTAP tests for the `is_approved_domain(text)` helper per `data-model.md` § Entity 2.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 2 (function body specification)
> - `specs/001-eligibility-login/research.md` § R-005, § R-007
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/is_approved_domain.sql` (new)
>
> **What to do**:
> 1. Plan 6 assertions:
>    - `is(public.is_approved_domain('foo@nortal.com'), true, 'approved')` — seed contains `nortal.com`.
>    - `is(public.is_approved_domain('FOO@NORTAL.COM'), true, 'case-insensitive')`.
>    - `is(public.is_approved_domain('foo@example.com'), false, 'unapproved domain')`.
>    - `is(public.is_approved_domain(NULL), false, 'NULL email returns false')`.
>    - `is(public.is_approved_domain('no-at-sign'), false, 'malformed email returns false')` — split_part on absent `@` returns empty string; verify lower('') doesn't match.
>    - Setup-then-assert: `DELETE FROM tournament_config WHERE key='eligibility.approved_domains'; SELECT is(public.is_approved_domain('foo@nortal.com'), false, 'fail-closed when config row missing')` (R-007).
>
> **Acceptance criteria**: RED — function doesn't exist yet.
>
> **Do NOT**: implement the function. Do NOT alter the fixture's `tournament_config` row (test rolls back).
>
> **Constitution**: IX, II (fail-closed), VIII.

**Blocked-by**: T015
**Parallel-safe with**: T016, T017, T018, T020
**Definition of done**: 6 RED pgTAP assertions in `is_approved_domain.sql`.

---

- [X] T020 [P] [US1] Author pgTAP for auth-hook first-login (RED) — `supabase/tests/pgtap/auth_hook_first_login.sql`

**Agent prompt:**

> **Goal**: Author the pgTAP test for `handle_auth_user_created(event jsonb)` happy + denied paths per `contracts/auth-hook.sql.md`.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § Decision matrix + § `handle_auth_user_created` steps
> - `specs/001-eligibility-login/spec.md` US1 Acceptance Scenario 1, US2 Acceptance Scenario 1
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/auth_hook_first_login.sql` (new)
>
> **What to do**:
> 1. Plan ~8 assertions:
>    - **Approved + first login**: invoke `public.handle_auth_user_created` with a synthetic event for `newuser@nortal.com`; assert return jsonb contains `{"decision": "continue"}`; assert exactly one new `participants` row with the expected attributes; assert exactly two `audit_log` rows: one `access.granted` (from hook) + one `participant.created` (from trigger T013); both share `occurred_at` within 1ms (same transaction).
>    - **Denied domain + first login**: invoke for `outsider@example.com`; assert return jsonb is `{"decision": "reject", "message": "..."}`; assert zero new `participants` rows; assert one `access.denied` row with `reason='domain_not_approved'`, `source='auth_hook'`.
>    - **Missing email claim**: assert `{"decision": "reject"}` and `audit_log` row with `reason='missing_claims'`.
>    - **Config unavailable (E-5)**: `DELETE FROM tournament_config WHERE key='eligibility.approved_domains'`; invoke for `alpha@nortal.com`; assert `{"decision": "reject"}` and `audit_log` row with `reason='config_unavailable'` (fail-closed per R-007).
>
> **Acceptance criteria**: RED — `handle_auth_user_created` doesn't exist.
>
> **Do NOT**: implement the hook. Do NOT skip the config-unavailable assertion (R-007 is part of the slice's security posture).
>
> **Constitution**: IX, II (fail-closed), V (audit-in-same-transaction).

**Blocked-by**: T015
**Parallel-safe with**: T016, T017, T018, T019
**Definition of done**: pgTAP file plans ~8 tests, all RED.

---

- [X] T021 [US1] Verify all US1 RED tests are RED before implementation — `specs/001-eligibility-login/red-gate-us1.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down). User must run the verification commands in red-gate-us1.md before merge.

**Agent prompt:**

> **Goal**: The explicit Principle IX gate. Run T016 + T017 + T018 + T019 + T020 and confirm each test fails for an assertion-level reason (not for a syntax error in the test itself). Log to `red-gate-us1.md`.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle IX final paragraph
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/red-gate-us1.md` (new) — one-page log of test names and their RED status
>
> **What to do**:
> 1. Run `pnpm -F web e2e slice-001-login-approved.spec.ts slice-001-login-missing-claims.spec.ts` and capture output.
> 2. Run each pgTAP file individually via `supabase test db --file <path>` and capture.
> 3. Confirm each test fails for the documented assertion-level reason.
> 4. Write the log to `red-gate-us1.md` with columns: file, test, RED reason.
>
> **Acceptance criteria**:
> - All Playwright tests RED.
> - All pgTAP assertions RED.
> - `red-gate-us1.md` exists.
>
> **Do NOT**: edit any test to "make it run" — if a test is GREEN that shouldn't be, surface it and stop.
>
> **Constitution**: IX (gate).

**Blocked-by**: T016, T017, T018, T019, T020
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us1.md` exists listing every US1 test as RED with documented reasons.

---

- [X] T022 [US1] Migration 0004: `is_approved_domain(text)` function body — `supabase/migrations/0004_is_approved_domain.sql`

**Agent prompt:**

> **Goal**: Implement `public.is_approved_domain(p_email text) RETURNS boolean STABLE` per `data-model.md` § Entity 2.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § Entity 2 (the function body spec)
> - `specs/001-eligibility-login/research.md` § R-005, R-007 (fail-closed via COALESCE)
> - `supabase/tests/pgtap/is_approved_domain.sql` (the assertions you must satisfy)
>
> **Files to create or modify**:
> - `supabase/migrations/0004_is_approved_domain.sql` (new)
>
> **What to do**:
> 1. Write the function exactly as specified in `data-model.md` § Entity 2 (the SQL body is reproduced there for reference; do not invent variations).
> 2. `LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp`.
> 3. Wrap the `EXISTS` in `COALESCE(..., false)` so a missing `tournament_config` row evaluates to `false` (R-007 fail-closed).
> 4. Header comment: `-- Slice 001 / FR-001 / FR-007 / FR-008 / data-model.md § Entity 2 / research.md § R-005 / R-007`.
>
> **Acceptance criteria**:
> - `supabase test db --file supabase/tests/pgtap/is_approved_domain.sql` is GREEN (all 6 assertions).
>
> **Do NOT**: hard-code `nortal.com` anywhere — it stays only in T010's seed row.
>
> **Constitution**: VIII (no constants), II (fail-closed).

**Blocked-by**: T021
**Parallel-safe with**: _(none — T023 depends on this)_
**Definition of done**: `is_approved_domain.sql` pgTAP file is GREEN.

---

- [X] T023 [US1] Migration 0005: `is_eligible_nortal_participant(uuid)` function body — `supabase/migrations/0005_is_eligible_nortal_participant.sql`

**Agent prompt:**

> **Goal**: Implement the **locked cross-slice contract** function `public.is_eligible_nortal_participant(p_uid uuid) RETURNS boolean STABLE` per `contracts/eligibility-predicate.sql.md`.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/eligibility-predicate.sql.md` (entire file — this contract is what you're satisfying)
> - `specs/001-eligibility-login/data-model.md` § Cross-slice ownership map
> - `supabase/tests/pgtap/is_eligible_*.sql` (the four assertions from T018)
>
> **Files to create or modify**:
> - `supabase/migrations/0005_is_eligible_nortal_participant.sql` (new)
>
> **What to do**:
> 1. Write the function body exactly as the contract specifies. `LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp`.
> 2. Body: `SELECT EXISTS (SELECT 1 FROM public.participants p WHERE p.auth_user_id = p_uid AND p.status = 'active' AND public.is_approved_domain(p.email))`.
> 3. Header comment (verbatim — this is the cross-slice locked contract): `-- Slice 001 / FR-001 / data-model.md § Cross-slice ownership map / contracts/eligibility-predicate.sql.md — LOCKED CROSS-SLICE CONTRACT: signature (p_uid uuid) RETURNS boolean STABLE. Slices 002–008 reference this function in their RLS. Body changes require coordinating regression tests in every consuming slice (Constitution Principle XI).`
>
> **Acceptance criteria**:
> - All four pgTAP files from T018 GREEN: `is_eligible_active_approved.sql`, `is_eligible_deactivated.sql`, `is_eligible_unknown_uid.sql`, `is_eligible_null_uid.sql`.
>
> **Do NOT**: change the function signature. Do NOT use `SECURITY DEFINER`. Do NOT call any function that doesn't already exist.
>
> **Constitution**: III, XI (cross-slice locked).

**Blocked-by**: T022
**Parallel-safe with**: _(none)_
**Definition of done**: All four `is_eligible_*.sql` pgTAP files GREEN.

---

- [X] T024 [US1] Migration 0009a: `handle_auth_user_created(jsonb)` auth hook — `supabase/migrations/0009_auth_hooks.sql`

**Agent prompt:**

> **Goal**: Implement the `before_user_created` Supabase Auth hook per `contracts/auth-hook.sql.md` § `handle_auth_user_created` steps. NOT including `handle_auth_user_signed_in` (T041 owns the returning-login hook).
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` (entire file — focus on the first-login function)
> - `specs/001-eligibility-login/research.md` § R-004, R-007, R-008
> - `supabase/tests/pgtap/auth_hook_first_login.sql` (the assertions you must satisfy)
>
> **Files to create or modify**:
> - `supabase/migrations/0009_auth_hooks.sql` (new) — will also house `handle_auth_user_signed_in` after T041; this task writes only the first function plus a placeholder comment `-- handle_auth_user_signed_in is added by T041`
>
> **What to do**:
> 1. `CREATE OR REPLACE FUNCTION public.handle_auth_user_created(event jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$`.
> 2. Body steps exactly per the contract:
>    a. Extract `email`, `display_name`, `region` from `event->user_metadata`.
>    b. If `email IS NULL` OR `display_name IS NULL` → write audit row (`access.denied`, `missing_claims`), RETURN reject jsonb.
>    c. If NOT `is_approved_domain(email)` → write audit row (`access.denied`, `domain_not_approved` if config exists else `config_unavailable`), RETURN reject jsonb.
>    d. INSERT INTO `participants(auth_user_id, email, display_name, region, status, first_login_at, last_login_at)` — the audit trigger (T013) emits `participant.created` automatically.
>    e. Write the `access.granted` audit row with `actor=<new participants.id>`.
>    f. RETURN `{"decision":"continue"}`.
> 3. Header comment: `-- Slice 001 / FR-001 / FR-002 / FR-003 / FR-006 / contracts/auth-hook.sql.md / spec Clarifications 2026-05-15 (status enum, email-drift handling — drift code lives in T041)`.
>
> **Acceptance criteria**:
> - `supabase test db --file supabase/tests/pgtap/auth_hook_first_login.sql` is GREEN (all ~8 assertions including the fail-closed-on-missing-config assertion).
>
> **Do NOT**: write to `audit_log` from this function for the `participant.created` event (the trigger does it). Do NOT include returning-login logic (T041 does). Do NOT bypass `is_approved_domain` — call it; never duplicate the lookup inline.
>
> **Constitution**: II, III, V (NON-NEGOTIABLE), VII.

**Blocked-by**: T023
**Parallel-safe with**: T025
**Definition of done**: `auth_hook_first_login.sql` pgTAP file is GREEN.

---

- [X] T025 [P] [US1] Implement `apps/web/lib/types/participant.ts` + `requireEligible.ts` + `getCurrentParticipant.ts`

**Agent prompt:**

> **Goal**: Create the cross-slice TypeScript scaffolding: the `Participant` type, the per-handler `requireEligible(client)` guard, and the thin `getCurrentParticipant()` helper.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/participant-me.read.md` § Response shape + § Frontend contract
> - `specs/001-eligibility-login/research.md` § R-009 (per-handler guard)
> - `specs/001-eligibility-login/data-model.md` § Entity 1
>
> **Files to create or modify**:
> - `apps/web/lib/types/participant.ts` (new) — exports `Participant` interface with all fields from `contracts/participant-me.read.md` § 200 OK response shape
> - `apps/web/lib/auth/requireEligible.ts` (new) — async function that takes a Supabase client (bound to user JWT), calls `is_eligible_nortal_participant(auth.uid())` via `client.rpc('is_eligible_nortal_participant', { p_uid: <uid> })`, returns the matching `Participant` row on success or throws a typed `EligibilityDeniedError` with `reason` field
> - `apps/web/lib/auth/getCurrentParticipant.ts` (new) — fetches `/api/me`, returns `Participant | null` (null on 401 / 403)
> - `apps/web/lib/auth/index.ts` (new) — barrel export
>
> **What to do**:
> 1. Type exports match the API contract exactly. Any field added later goes through a contract update first.
> 2. `requireEligible` writes the API-guard audit row on denial via a server-side INSERT (using the same user JWT — there's a special grant in T034 letting the user write a single `access.denied` row about themselves). If `audit_log` write fails, log to server stderr and proceed with the 403 — never swallow the denial.
> 3. `getCurrentParticipant` is browser-safe (no service-role); uses `fetch('/api/me', { credentials: 'include' })`.
> 4. Add a JSDoc note on each function pointing at the contract file: `@see specs/001-eligibility-login/contracts/...`.
>
> **Acceptance criteria**:
> - `pnpm -F web typecheck` GREEN.
> - Unit test (or simple `import` smoke test) confirms the modules export the expected symbols.
>
> **Do NOT**: re-implement the eligibility predicate in TypeScript. The RPC must be the only path. Do NOT use the service-role key.
>
> **Constitution**: III (no rule duplication in TS), II.

**Blocked-by**: T023
**Parallel-safe with**: T024
**Definition of done**: All three files exist, `pnpm typecheck` passes, and a smoke `import` from a test file succeeds.

---

- [X] T026 [US1] Implement `apps/web/app/auth/callback/page.tsx` + `apps/web/app/dashboard/page.tsx` (placeholder)

**Agent prompt:**

> **Goal**: Server-component `/auth/callback` page that exchanges the OAuth code for a Supabase session and redirects to `/dashboard`, plus a minimal `/dashboard` placeholder.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-callback.page.md` § Behavior — `/auth/callback`
> - `specs/001-eligibility-login/research.md` § R-004
>
> **Files to create or modify**:
> - `apps/web/app/auth/callback/page.tsx` (new) — server component
> - `apps/web/app/dashboard/page.tsx` (new) — server component
> - `apps/web/app/dashboard/layout.tsx` (new) — root layout for the participant area
>
> **What to do**:
> 1. `/auth/callback`: read `?code=` from `searchParams`; call `supabase.auth.exchangeCodeForSession(code)` server-side using the anon key; on success → `redirect('/dashboard')`; on auth-hook denial (error message contains `decision: reject`) → `redirect('/auth/denied?reason=<parsed>')`; on any other error → `redirect('/auth/denied?reason=unknown')`.
> 2. `/dashboard`: call `requireEligible(client)` via the user JWT; render `<h1>Welcome, {participant.display_name}</h1>`; that's it — Slices 002+ replace this page.
> 3. The dashboard layout includes only a `<header>` with a "Sign out" form-button (POST to `/auth/signout` placeholder — out of scope for this slice; the page just shows the link).
>
> **Acceptance criteria**:
> - All three Playwright tests in `slice-001-login-approved.spec.ts` GREEN.
> - Visiting `/dashboard` without a session redirects to `/` (Next.js's standard behavior given RLS denies).
>
> **Do NOT**: implement `/auth/denied` here (T033). Do NOT do any business logic on the dashboard.
>
> **Constitution**: III (no rule logic in pages), II.

**Blocked-by**: T024, T025
**Parallel-safe with**: T027
**Definition of done**: `slice-001-login-approved.spec.ts` all 3 tests GREEN.

---

- [X] T027 [US1] Implement `apps/web/app/api/me/route.ts` — `GET /api/me`

**Agent prompt:**

> **Goal**: The `/api/me` route handler per `contracts/participant-me.read.md`.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/participant-me.read.md` (entire file)
> - `apps/web/lib/auth/requireEligible.ts` (T025) — your handler delegates to this
>
> **Files to create or modify**:
> - `apps/web/app/api/me/route.ts` (new)
>
> **What to do**:
> 1. Export `GET` handler. Bind the Supabase client to the user JWT via `@supabase/ssr`'s cookie-based session.
> 2. If no session cookie → return `Response.json({error:{code:'UNAUTHENTICATED', message:'Sign in to continue.'}}, {status: 401})`.
> 3. Try `requireEligible(client)`; on `EligibilityDeniedError` → return 403 with `{error:{code:'DOMAIN_NOT_APPROVED', message: '...'}}` (the eligibility helper already wrote the audit row).
> 4. On success → `SELECT id, display_name, email, domain, region, status, first_login_at, last_login_at FROM participants WHERE auth_user_id = auth.uid()` (RLS scopes to caller); return 200 with `{participant: <row>}`.
> 5. Set `Cache-Control: private, max-age=0, must-revalidate` on every response.
>
> **Acceptance criteria**:
> - Playwright `slice-001-login-approved.spec.ts` Test 3 (state-changing re-verification) GREEN.
> - Manually: `curl -i http://localhost:3000/api/me` with no cookie returns 401.
>
> **Do NOT**: use the service-role key. Do NOT write `last_login_at` here (auth-hook owns it). Do NOT leak existence info in the 403 body.
>
> **Constitution**: II, III, IX.

**Blocked-by**: T025
**Parallel-safe with**: T026
**Definition of done**: `curl -i http://localhost:3000/api/me` without a session returns 401 AND with an eligible session returns 200 with the expected JSON shape.

---

- [X] T028 [US1] Regression checkpoint after US1 — `specs/001-eligibility-login/regression-checkpoint-us1.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). User must run the verification commands in regression-checkpoint-us1.md before merge.

**Agent prompt:**

> **Goal**: Run the slice-001-so-far test suite end-to-end and confirm GREEN. Per Constitution Principle XI, US2 cannot start until this passes.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/regression-checkpoint-us1.md` (new) — table of every test run + status + duration
>
> **What to do**:
> 1. Run `pnpm -F web e2e` for `slice-001-login-approved.spec.ts` and `slice-001-login-missing-claims.spec.ts`.
> 2. Run all pgTAP files committed so far: `is_eligible_active_approved.sql`, `is_eligible_deactivated.sql`, `is_eligible_unknown_uid.sql`, `is_eligible_null_uid.sql`, `is_approved_domain.sql`, `auth_hook_first_login.sql`.
> 3. Run `pnpm -F web typecheck`.
> 4. Tabulate results; STOP if anything is red.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Do NOT**: quarantine, skip, or `xfail` any failure. If something is red, file a bug task and pause.
>
> **Constitution**: XI (NON-NEGOTIABLE).

**Blocked-by**: T026, T027
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us1.md` exists with all tests GREEN.

---

**US1 CHECKPOINT**: First-time eligible login works end-to-end. Slice is independently demonstrable at this point (Principle X — MVP scope).

---

## Phase 4: User Story 2 — Ineligible domain is rejected (Priority: P1)

**Story goal**: A user with a non-approved domain is denied at the UI AND at the API; no participant profile is created; the denial is audited (`spec.md` US2).

- [X] T029 [P] [US2] Author Playwright `slice-001-login-denied-domain.spec.ts` + `slice-001-api-me-401.spec.ts` + `slice-001-api-me-403-domain-removed.spec.ts` + `slice-001-api-me-no-leak.spec.ts` + `slice-001-callback-denied-domain.spec.ts` + `slice-001-denied-no-leak.spec.ts` + `slice-001-denied-renders-without-session.spec.ts` + `slice-001-callback-no-code.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author all Playwright BDD tests for US2 (denial paths) per `spec.md` US2 Acceptance Scenarios 1–3 and `contracts/auth-callback.page.md` § Test surface + `contracts/participant-me.read.md` § Test surface. All RED — T033 + T034 turn them GREEN.
>
> **Read first**:
> - `specs/001-eligibility-login/spec.md` § User Story 2 (all 3 Acceptance Scenarios) and § Edge Cases (E-4, E-7)
> - `specs/001-eligibility-login/contracts/auth-callback.page.md` § Behavior — `/auth/denied`, § Test surface
> - `specs/001-eligibility-login/contracts/participant-me.read.md` § Test surface
> - `specs/001-eligibility-login/spec.md` Clarifications 2026-05-15 (mid-session deny — informs `slice-001-api-me-403-domain-removed.spec.ts`)
>
> **Files to create or modify** (eight new Playwright specs):
> - `apps/web/tests/playwright/slice-001-login-denied-domain.spec.ts` (UI denial path)
> - `apps/web/tests/playwright/slice-001-api-me-401.spec.ts` (no JWT)
> - `apps/web/tests/playwright/slice-001-api-me-403-domain-removed.spec.ts` (mid-session removal)
> - `apps/web/tests/playwright/slice-001-api-me-no-leak.spec.ts` (response body has no info-leak)
> - `apps/web/tests/playwright/slice-001-callback-denied-domain.spec.ts` (callback redirect on denial)
> - `apps/web/tests/playwright/slice-001-denied-no-leak.spec.ts` (denial page unknown `reason=` renders generic)
> - `apps/web/tests/playwright/slice-001-denied-renders-without-session.spec.ts` (page reachable cookieless)
> - `apps/web/tests/playwright/slice-001-callback-no-code.spec.ts` (callback robustness)
>
> **What to do**:
> 1. Each file: one focused `test.describe()` with 1–3 `test()` blocks per the contract's Test surface tables. Every Then-clause is a specific assertion (status code, body shape, audit row presence/absence).
> 2. `slice-001-login-denied-domain.spec.ts` (US2 AS1): sign-in via stub with `outsider@example.com`; assert redirect to `/auth/denied?reason=domain_not_approved`; assert exact denial message rendered; assert no new `participants` row; assert one `audit_log` row with `action='access.denied', reason='domain_not_approved', source='auth_hook'`.
> 3. `slice-001-api-me-403-domain-removed.spec.ts` (US2 AS2 + Clarifications 2026-05-15): sign in as `alpha@nortal.com`; immediately `psql -c "UPDATE tournament_config SET value = '[]'::jsonb WHERE key='eligibility.approved_domains'"`; `fetch('/api/me')` — assert 403 with `{error:{code:'DOMAIN_NOT_APPROVED', ...}}`; assert `audit_log` row with `action='access.denied', reason='domain_not_approved', source='api_guard'`; restore config.
> 4. `slice-001-api-me-no-leak.spec.ts` (US2 AS1): for the 403 above, assert response body contains zero references to other participants, no `X-Debug-*` headers, no stack trace.
> 5. Etc. for remaining six per contract test surface.
>
> **Acceptance criteria**: ~12 RED Playwright tests across the eight files.
>
> **Do NOT**: implement `/auth/denied`. Do NOT relax the no-info-leak assertion.
>
> **Constitution**: IX, II.

**Blocked-by**: T028
**Parallel-safe with**: T030, T031
**Definition of done**: ~12 RED Playwright tests across eight files; CI reports them failing for assertion reasons.

---

- [X] T030 [P] [US2] Author pgTAP `slice-001-api-me-rls.sql` + mid-session deny (RED) — `supabase/tests/pgtap/slice-001-api-me-rls.sql`, `supabase/tests/pgtap/participants_rls_mid_session_deny.sql`

**Agent prompt:**

> **Goal**: SQL-level tests asserting RLS isolation on `participants` AND the mid-session deny behavior (Clarifications 2026-05-15) — that an authenticated participant whose domain was just removed sees zero rows under RLS even with a valid JWT.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/participant-me.read.md` § Test surface — `slice-001-api-me-rls.sql`
> - `specs/001-eligibility-login/spec.md` Clarifications 2026-05-15 (mid-session deny)
> - `specs/001-eligibility-login/data-model.md` § RLS posture summary
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/slice-001-api-me-rls.sql` (new)
> - `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` (new)
>
> **What to do**:
> 1. `slice-001-api-me-rls.sql`: simulate Alpha's JWT via `SET LOCAL request.jwt.claims`; assert `SELECT count(*) FROM participants` returns 1; assert the one row is Alpha's. Then switch JWT to Bravo; assert 1 row, Bravo's. Confirm cross-leakage is impossible.
> 2. `participants_rls_mid_session_deny.sql`: simulate Alpha's JWT; assert `SELECT count(*) FROM participants` returns 1 (baseline). DELETE the `eligibility.approved_domains` row from `tournament_config`. Re-run `SELECT count(*) FROM participants` under same JWT; **expected after T034 ships**: 0 rows. (Until T034 ships, T012's policy only checks `auth_user_id = auth.uid()` so this test will be RED for the right reason — it MUST be RED here.) Assert 0.
>
> **Acceptance criteria**: RED — the second file fails because T012's RLS doesn't yet include the eligibility predicate.
>
> **Do NOT**: alter T012's RLS to make this pass — that's T034's job. Do NOT bypass via service-role.
>
> **Constitution**: II, III, IX.

**Blocked-by**: T028
**Parallel-safe with**: T029, T031
**Definition of done**: Both pgTAP files exist; the first is RED for the right reason (post-T033 ship will GREEN it); the second is RED until T034.

---

- [X] T031 [P] [US2] Verify all US2 RED tests RED before implementation — `specs/001-eligibility-login/red-gate-us2.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Same shape as T021 but for US2. Confirm every test from T029 + T030 is RED for an assertion-level reason.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle IX
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/red-gate-us2.md` (new)
>
> **What to do**: Run T029 and T030, capture, tabulate, log.
>
> **Acceptance criteria**: All ~14 tests RED.
>
> **Do NOT**: edit any test.
>
> **Constitution**: IX (gate).

**Blocked-by**: T029, T030
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us2.md` exists; every test listed as RED.

---

- [X] T032 [US2] Implement `apps/web/app/auth/denied/page.tsx` — denial screen

**Agent prompt:**

> **Goal**: Static denial screen per `contracts/auth-callback.page.md` § Behavior — `/auth/denied`. Renders the matching message keyed by `?reason=`.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-callback.page.md` § Behavior — `/auth/denied`, § Test surface
>
> **Files to create or modify**:
> - `apps/web/app/auth/denied/page.tsx` (new) — server component
>
> **What to do**:
> 1. Server component reads `searchParams.reason` (string). Resolves to one of: `domain_not_approved`, `missing_claims`, `config_unavailable`, `deactivated`, or falls back to a generic message for any other value.
> 2. Renders an `<h1>` with the standardized denial title and a `<p>` with the reason-specific message — exactly per the contract's behavior matrix.
> 3. Renders a "Sign in with a different account" link that clears the Supabase session cookie and redirects to `/`.
> 4. No JavaScript needed — plain HTML/CSS so users with strict browser policies still see it.
> 5. No information leakage: page renders identically regardless of whether any session exists.
>
> **Acceptance criteria**:
> - Playwright tests `slice-001-login-denied-domain.spec.ts`, `slice-001-callback-denied-domain.spec.ts`, `slice-001-denied-no-leak.spec.ts`, `slice-001-denied-renders-without-session.spec.ts` all GREEN.
>
> **Do NOT**: query `participants` from this page. Do NOT log session details. Do NOT expose the approved-domain list anywhere in the body or HTML.
>
> **Constitution**: II, III.

**Blocked-by**: T031
**Parallel-safe with**: T033, T034
**Definition of done**: All four Playwright denial-page tests GREEN.

---

- [X] T033 [US2] Wire 403 + audit on `/api/me` when caller is no longer eligible — modify `apps/web/lib/auth/requireEligible.ts` and `apps/web/app/api/me/route.ts`

**Agent prompt:**

> **Goal**: Ensure the API-guard path (`requireEligible` in `/api/me`) writes the `access.denied` audit row with `source='api_guard'` and returns 403 — per US2 AS2 and Clarifications 2026-05-15.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/participant-me.read.md` § Server behavior step 2
> - `specs/001-eligibility-login/research.md` § R-009
> - `specs/001-eligibility-login/data-model.md` § Entity 3 (Access Decision Event — write paths owned by this slice)
>
> **Files to create or modify**:
> - `apps/web/lib/auth/requireEligible.ts` (modify — add the audit-write side effect on denial)
> - `apps/web/app/api/me/route.ts` (modify — adjust response shape to match contract on 403; add 401 path if not already)
> - `supabase/migrations/0010_audit_log_api_guard_insert.sql` (new) — grants the `authenticated` role permission to INSERT a single `access.denied` row about its own session into `audit_log`. Without this grant, the user-JWT-bound `requireEligible` cannot write the audit row. Use a strict RLS-style policy: `WITH CHECK (action = 'access.denied' AND source = 'api_guard' AND actor = (SELECT id FROM participants WHERE auth_user_id = auth.uid()))` — narrow enough that no other audit-row class can be inserted by the user.
>
> **What to do**:
> 1. The new migration adds the narrow INSERT policy on `audit_log` for `authenticated`. Verify no broader path opens up.
> 2. `requireEligible.ts`: on denial path, call `client.from('audit_log').insert({...})` with the constrained shape BEFORE throwing `EligibilityDeniedError`. Best-effort: if the insert fails (e.g., RLS denies), log the failure to server stderr and proceed with the throw — never swallow the denial.
> 3. `/api/me/route.ts`: confirm 401 body matches contract; confirm 403 body matches contract; confirm `Cache-Control` header is set on every response.
>
> **Acceptance criteria**:
> - Playwright tests `slice-001-api-me-401.spec.ts`, `slice-001-api-me-403-domain-removed.spec.ts`, `slice-001-api-me-no-leak.spec.ts`, `slice-001-callback-no-code.spec.ts` (this last one only needs the route's 401 to be correct) all GREEN.
> - `slice-001-api-me-rls.sql` GREEN (the basic RLS isolation test from T030).
>
> **Do NOT**: broaden the audit-log INSERT policy. Do NOT use service-role for the audit write.
>
> **Constitution**: II, V (audit), III.

**Blocked-by**: T031
**Parallel-safe with**: T032, T034
**Definition of done**: All four API-related Playwright tests GREEN AND `slice-001-api-me-rls.sql` pgTAP GREEN.

---

- [X] T034 [US2] Migration 0011: tighten `participants` RLS to include eligibility predicate — `supabase/migrations/0011_participants_rls_eligibility_tighten.sql`

**Agent prompt:**

> **Goal**: REPLACE T012's `participants_self_read` policy with the tighter form that requires `is_eligible_nortal_participant(auth.uid())` to be true. This is the safety-net for Clarifications 2026-05-15 — when an admin removes a participant's domain, RLS independently denies reads on the next query, even if some handler forgets to call `requireEligible`.
>
> **Read first**:
> - `specs/001-eligibility-login/data-model.md` § RLS posture summary
> - `specs/001-eligibility-login/spec.md` Clarifications 2026-05-15 (mid-session deny)
> - T012's migration (the comment in there explicitly flags that T034 will tighten it)
> - `supabase/tests/pgtap/participants_rls_mid_session_deny.sql` (the test that must GREEN as a result)
>
> **Files to create or modify**:
> - `supabase/migrations/0011_participants_rls_eligibility_tighten.sql` (new)
>
> **What to do**:
> 1. `DROP POLICY participants_self_read ON public.participants;`
> 2. `CREATE POLICY participants_self_read ON public.participants FOR SELECT USING (auth_user_id = auth.uid() AND public.is_eligible_nortal_participant(auth.uid()));`
> 3. Header comment: `-- Slice 001 / spec Clarifications 2026-05-15 (mid-session deny safety net) / cross-references T012`.
>
> **Acceptance criteria**:
> - `participants_rls_mid_session_deny.sql` pgTAP GREEN.
> - `slice-001-api-me-rls.sql` STILL GREEN (no regression on the basic isolation case).
> - `slice-001-api-me-403-domain-removed.spec.ts` Playwright GREEN (defense in depth — both `requireEligible` AND RLS deny).
>
> **Do NOT**: alter T012's `audit_log_*` or `tournament_config_*` policies — they're correct as-is.
>
> **Constitution**: II (defense in depth), III.

**Blocked-by**: T031, T023
**Parallel-safe with**: T032, T033
**Definition of done**: `participants_rls_mid_session_deny.sql` GREEN AND `slice-001-api-me-rls.sql` STILL GREEN AND `slice-001-api-me-403-domain-removed.spec.ts` GREEN.

---

- [X] T035 [US2] Regression checkpoint after US2 — `specs/001-eligibility-login/regression-checkpoint-us2.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). User must run the verification commands in regression-checkpoint-us2.md before merge.

**Agent prompt:**

> **Goal**: Same shape as T028. Run every slice-001-so-far test, confirm GREEN. US3 cannot start until this passes.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/regression-checkpoint-us2.md` (new)
>
> **What to do**: Run all Playwright + all pgTAP + `pnpm typecheck`. Tabulate.
>
> **Acceptance criteria**: 100% GREEN.
>
> **Constitution**: XI.

**Blocked-by**: T032, T033, T034
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us2.md` shows everything GREEN.

---

## Phase 5: User Story 3 — Returning user with changed attributes (Priority: P2)

**Story goal**: An existing eligible participant signs in again; refreshable attributes update; no duplicate row; email-drift is audited but stored email stays; missing optional claim retains stored value (`spec.md` US3 + Clarifications 2026-05-15).

- [X] T036 [P] [US3] Author Playwright `slice-001-returning-login-refresh.spec.ts` + `slice-001-email-drift.spec.ts` + `slice-001-domain-removed-mid-session.spec.ts` + `slice-001-missing-optional-claim.spec.ts` (RED)

**Agent prompt:**

> **Goal**: Author the four Playwright BDD specs for US3 plus the related Edge Cases (E-2/E-3 already covered partially by T029, but the long-running-session variant is here).
>
> **Read first**:
> - `specs/001-eligibility-login/spec.md` § User Story 3 (Acceptance Scenarios 1, 2, 3 — note Scenario 3 is the new missing-optional-claim case from Clarifications 2026-05-15)
> - `specs/001-eligibility-login/spec.md` Clarifications 2026-05-15 (email drift, missing claim)
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § `handle_auth_user_signed_in` + § Decision matrix
> - `specs/001-eligibility-login/research.md` § R-010
>
> **Files to create or modify**:
> - `apps/web/tests/playwright/slice-001-returning-login-refresh.spec.ts` (new)
> - `apps/web/tests/playwright/slice-001-email-drift.spec.ts` (new)
> - `apps/web/tests/playwright/slice-001-domain-removed-mid-session.spec.ts` (new)
> - `apps/web/tests/playwright/slice-001-missing-optional-claim.spec.ts` (new)
>
> **What to do**:
> 1. `slice-001-returning-login-refresh.spec.ts` (US3 AS1): pre-state Alpha provisioned with `display_name='Alpha'`; OIDC stub returns Alpha's `sub` with `display_name='Alpha (Updated)'`; sign in; assert dashboard renders new display name; assert single `participants` row; assert `last_login_at > first_login_at`; assert `audit_log` has `participant.updated` row capturing the display_name diff.
> 2. `slice-001-email-drift.spec.ts` (US3 AS2 from Clarifications): pre-state Alpha with `email='alpha@nortal.com'`; OIDC stub returns Alpha's `sub` with `email='alpha-aka@nortal.com'`; sign in; assert sign-in succeeds; assert stored `participants.email` is STILL `alpha@nortal.com`; assert `audit_log` has `participant.email_drift` row with `previous_value->>'email'='alpha@nortal.com'` and `new_value->>'email'='alpha-aka@nortal.com'`.
> 3. `slice-001-domain-removed-mid-session.spec.ts` (Edge E-3 long-running variant): Alpha is signed in; admin removes `nortal.com` from approved list; Alpha refreshes the dashboard; assert redirect to `/auth/denied?reason=domain_not_approved`; assert Alpha's `participants` row still exists (data preserved); assert audit shows the access denial; restore config + re-sign-in works.
> 4. `slice-001-missing-optional-claim.spec.ts` (US3 AS3 from Clarifications): pre-state Alpha with `region='EE-North'`; OIDC stub returns Alpha's `sub` WITHOUT a `region` claim; sign in; assert stored `participants.region` is STILL `'EE-North'`; assert sign-in succeeds; assert no audit row for region "deletion".
>
> **Acceptance criteria**: ~5 RED Playwright tests across four files.
>
> **Do NOT**: implement anything. Do NOT relax the email-drift "stored email unchanged" assertion.
>
> **Constitution**: IX.

**Blocked-by**: T035
**Parallel-safe with**: T037, T038, T039
**Definition of done**: ~5 RED Playwright tests across four files.

---

- [X] T037 [P] [US3] Author pgTAP for auth-hook returning-login (RED) — `supabase/tests/pgtap/auth_hook_returning_login.sql`

**Agent prompt:**

> **Goal**: Author the pgTAP test for `handle_auth_user_signed_in(event jsonb)`.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § `handle_auth_user_signed_in` steps + § Decision matrix
> - `specs/001-eligibility-login/research.md` § R-010
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/auth_hook_returning_login.sql` (new)
>
> **What to do**:
> 1. Plan ~10 assertions:
>    - **Approved + returning**: invoke `handle_auth_user_signed_in` for Alpha; assert single `participants` row (no duplicate); assert `last_login_at` advanced; assert `audit_log` row `access.granted`; assert `participant.updated` (from trigger) only if `display_name` or `region` changed.
>    - **Refresh whitelist enforced**: invoke with a payload that includes `email='alpha-newalias@nortal.com'`; assert stored email UNCHANGED; assert `participant.email_drift` audit row written.
>    - **Missing optional region claim**: invoke with no `region` field; assert stored `region` UNCHANGED.
>    - **Deactivated participant**: invoke for Zulu (`status='deactivated'`); assert `{"decision":"reject"}` with reason `deactivated`; assert `access.denied` audit row.
>    - **Domain removed since last login**: DELETE Nortal from approved list; invoke for Alpha; assert `{"decision":"reject"}` with reason `domain_not_approved`.
> 2. All assertions use `BEGIN; … ROLLBACK;` pattern.
>
> **Acceptance criteria**: RED — function doesn't exist yet.
>
> **Do NOT**: implement the function.
>
> **Constitution**: IX, V (email-drift audit-only — Clarifications 2026-05-15).

**Blocked-by**: T035
**Parallel-safe with**: T036, T038, T039
**Definition of done**: ~10 RED pgTAP assertions in `auth_hook_returning_login.sql`.

---

- [X] T038 [P] [US3] Author pgTAP for fail-closed on missing config (RED) — `supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql`

**Agent prompt:**

> **Goal**: Author the explicit fail-closed pgTAP per `contracts/auth-hook.sql.md` § Decision matrix (Config unreachable row).
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § Decision matrix
> - `specs/001-eligibility-login/research.md` § R-007
> - `specs/001-eligibility-login/spec.md` § Edge Cases (E-5)
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql` (new)
>
> **What to do**:
> 1. Plan ~3 assertions:
>    - DELETE `tournament_config` row for `eligibility.approved_domains`; invoke `handle_auth_user_created` for `newuser@nortal.com`; assert `{"decision":"reject"}` with reason `config_unavailable`.
>    - Same setup; invoke `handle_auth_user_signed_in` for Alpha; assert reject; assert no `last_login_at` update on Alpha's row.
>    - Setup: tournament_config exists but `eligibility.approved_domains` value is `'[]'::jsonb` (empty array); invoke `handle_auth_user_created` for `alpha@nortal.com`; assert reject with reason `domain_not_approved`.
>
> **Acceptance criteria**: RED.
>
> **Constitution**: II, IX.

**Blocked-by**: T035
**Parallel-safe with**: T036, T037, T039
**Definition of done**: 3 RED pgTAP assertions.

---

- [X] T039 [US3] Verify all US3 RED tests RED — `specs/001-eligibility-login/red-gate-us3.md` — red-gate documentation produced; runtime verification deferred (Docker daemon down).

**Agent prompt:**

> **Goal**: Same shape as T021 / T031. Confirm every test from T036 + T037 + T038 is RED.
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/red-gate-us3.md` (new)
>
> **Acceptance criteria**: All ~18 tests RED.
>
> **Constitution**: IX (gate).

**Blocked-by**: T036, T037, T038
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `red-gate-us3.md` lists every US3 test as RED.

---

- [X] T040 [US3] Extend `0009_auth_hooks.sql` with `handle_auth_user_signed_in(jsonb)` — `supabase/migrations/0009_auth_hooks.sql`

**Agent prompt:**

> **Goal**: Add the `before_user_signed_in` hook body per `contracts/auth-hook.sql.md` § `handle_auth_user_signed_in` steps + Clarifications 2026-05-15.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/auth-hook.sql.md` § `handle_auth_user_signed_in` (entire section)
> - `specs/001-eligibility-login/research.md` § R-010 (whitelist refresh + email-drift)
> - `specs/001-eligibility-login/spec.md` Clarifications 2026-05-15 (Q2: email-drift; Q4: missing claim)
> - The existing T024 implementation in `0009_auth_hooks.sql` (don't duplicate the function — extend the file)
> - `supabase/tests/pgtap/auth_hook_returning_login.sql` + `auth_hook_fails_closed_on_missing_config.sql` (the assertions you must satisfy)
>
> **Files to create or modify**:
> - `supabase/migrations/0009_auth_hooks.sql` (modify — append `handle_auth_user_signed_in`)
>
> **What to do**:
> 1. Append `CREATE OR REPLACE FUNCTION public.handle_auth_user_signed_in(event jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$`.
> 2. Body steps exactly per the contract:
>    a. Lookup participant by `auth_user_id`. If not found → delegate to `handle_auth_user_created` (defensive).
>    b. If `participants.status = 'deactivated'` → audit `access.denied` with reason `deactivated`; return reject.
>    c. If NOT `is_approved_domain(participants.email)` → audit `access.denied`, return reject.
>    d. **Refresh whitelist**: only update `display_name`, `region`, `last_login_at`. Only update each field if the IdP payload's corresponding key is non-NULL (per Clarifications 2026-05-15 Q4 — missing claim = no signal). The audit trigger emits `participant.updated`.
>    e. **Email-drift check** (per Clarifications 2026-05-15 Q2): if `event->user_metadata->>'email' IS NOT NULL AND lower(event->user_metadata->>'email') != lower(participants.email)`, INSERT `audit_log` row with `action='participant.email_drift'`, `previous_value=jsonb_build_object('email', participants.email)`, `new_value=jsonb_build_object('email', event->user_metadata->>'email')`. Do NOT update `participants.email`.
>    f. Write `access.granted` audit row.
>    g. Return `{"decision":"continue"}`.
> 3. Header comment: `-- Slice 001 / FR-004 / US3 / spec Clarifications 2026-05-15 Q2 + Q4 / contracts/auth-hook.sql.md`.
>
> **Acceptance criteria**:
> - `supabase test db --file supabase/tests/pgtap/auth_hook_returning_login.sql` GREEN (all ~10 assertions).
> - `supabase test db --file supabase/tests/pgtap/auth_hook_fails_closed_on_missing_config.sql` GREEN.
> - All four US3 Playwright specs GREEN.
>
> **Do NOT**: overwrite `participants.email` ever (Clarifications 2026-05-15 Q2). Do NOT clear `region` on missing claim (Clarifications 2026-05-15 Q4). Do NOT skip the audit row in any branch.
>
> **Constitution**: II, V (NON-NEGOTIABLE — audit), VIII.

**Blocked-by**: T039
**Parallel-safe with**: _(none)_
**Definition of done**: `auth_hook_returning_login.sql` GREEN, `auth_hook_fails_closed_on_missing_config.sql` GREEN, all four US3 Playwright tests GREEN.

---

- [X] T041 [US3] Regression checkpoint after US3 — `specs/001-eligibility-login/regression-checkpoint-us3.md` — regression-checkpoint documentation produced; runtime verification deferred (Docker daemon down). User must run the verification commands in regression-checkpoint-us3.md before merge.

**Agent prompt:**

> **Goal**: Same shape as T028 / T035. Run every slice-001 test, confirm GREEN.
>
> **Read first**:
> - `.specify/memory/constitution.md` § Principle XI
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/regression-checkpoint-us3.md` (new)
>
> **What to do**: Run all Playwright + all pgTAP + typecheck. Tabulate.
>
> **Acceptance criteria**: 100% GREEN across every Slice 001 test asset.
>
> **Constitution**: XI.

**Blocked-by**: T040
**Parallel-safe with**: _(none — gate)_
**Definition of done**: `regression-checkpoint-us3.md` exists; all tests GREEN.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T042 [P] Author perf pgTAP `is_eligible_perf.sql` (`supabase/tests/pgtap/is_eligible_perf.sql`)

**Agent prompt:**

> **Goal**: Validate the cross-slice-contract performance budget — `is_eligible_nortal_participant(uuid)` p95 < 5 ms over 1,000 invocations against a 500-row `participants` table. Every other slice's RLS calls this inline; if it regresses, every slice's request latency suffers.
>
> **Read first**:
> - `specs/001-eligibility-login/contracts/eligibility-predicate.sql.md` § Performance
> - `specs/001-eligibility-login/research.md` § R-012
>
> **Files to create or modify**:
> - `supabase/tests/pgtap/is_eligible_perf.sql` (new)
>
> **What to do**:
> 1. Setup: bulk-insert 500 `auth.users` rows + 500 `participants` rows (use `generate_series`).
> 2. Run `SELECT count(*) FROM (SELECT public.is_eligible_nortal_participant(auth_user_id) FROM participants ORDER BY random() LIMIT 1000) t;` and time it via `clock_timestamp()` deltas captured per-row in a temp table.
> 3. Assert p95 < 5 ms via percentile calculation on the temp table.
> 4. ROLLBACK so the bulk fixture doesn't persist.
>
> **Acceptance criteria**:
> - `supabase test db --file supabase/tests/pgtap/is_eligible_perf.sql` GREEN under local Postgres on standard dev hardware.
>
> **Do NOT**: weaken the threshold — if the slice fails this, every other slice's SLA is at risk.
>
> **Constitution**: VII (Operational Resilience), XI (cross-slice contract preservation).

**Blocked-by**: T041
**Parallel-safe with**: T043, T044
**Definition of done**: `is_eligible_perf.sql` GREEN with p95 < 5 ms on local Postgres.

---

- [X] T043 [P] Sync docs — note OD-001's status in `docs/architecture/open-decisions.md`

**Agent prompt:**

> **Goal**: Update OD-001 in `docs/architecture/open-decisions.md` to reflect that the **mechanism** is resolved (the approved-domain list is stored in `tournament_config`) even though the actual list of domains remains tracked for Slice 008 to set at production launch.
>
> **Read first**:
> - `docs/architecture/open-decisions.md` (current OD-001 entry)
> - `specs/001-eligibility-login/research.md` § R-005, § R-013
>
> **Files to create or modify**:
> - `docs/architecture/open-decisions.md` (modify the OD-001 row only — leave other ODs untouched; Slice 005 will flip OD-002…006 separately)
>
> **What to do**:
> 1. Add a `**Status update (2026-05-15).**` block to the OD-001 entry: "Mechanism resolved by Slice 001: the approved-domain list lives in `tournament_config.eligibility.approved_domains` (jsonb array). The **actual list** for production launch remains an Open decision until Slice 008's admin UI ships and Security signs off on the final set of domains. Pointer: `specs/001-eligibility-login/research.md` § R-005."
> 2. Leave the OD-001 Status header as `Open` — the *content* (list of domains) is still pending.
>
> **Acceptance criteria**:
> - Diff is exactly the OD-001 entry; no other entries changed.
>
> **Constitution**: V (audit traceability via doc).

**Blocked-by**: T041
**Parallel-safe with**: T042, T044
**Definition of done**: Diff shows OD-001 entry edited; no other OD touched.

---

- [X] T044 Run `quickstart.md` end-to-end manually — `specs/001-eligibility-login/quickstart-verification.md` — quickstart-verification template produced; manual execution deferred (Docker daemon down). User must replace each DEFERRED row with PASS/FAIL output before merge.

**Agent prompt:**

> **Goal**: Execute every step in `specs/001-eligibility-login/quickstart.md` § Manual verification checklist (steps 1–8) and record results.
>
> **Read first**:
> - `specs/001-eligibility-login/quickstart.md` § Manual verification checklist (all 8 steps)
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/quickstart-verification.md` (new) — one row per step with pass/fail + exact terminal output or screenshot path
>
> **What to do**:
> 1. Reset local stack: `supabase db reset && psql -f supabase/seed/slice-001-fixture.sql`.
> 2. Start `pnpm -F web dev` and `supabase start`.
> 3. Execute steps 1–8 of `quickstart.md` § Manual verification checklist exactly as written.
> 4. For each step, paste the exact `psql` output / `curl` output / page text. If a step fails, STOP — file a bug task and pause this task.
>
> **Acceptance criteria**:
> - 8/8 PASS in `quickstart-verification.md`.
>
> **Do NOT**: edit code to make a step pass. Quickstart is the user's contract.
>
> **Constitution**: X (Vertical Slice Delivery — quickstart confirms the slice runs end-to-end).

**Blocked-by**: T041
**Parallel-safe with**: T042, T043
**Definition of done**: 8/8 PASS in `quickstart-verification.md`.

---

- [X] T045 Final regression gate — `specs/001-eligibility-login/regression-final.md` — final-gate documentation produced; runtime verification deferred (Docker daemon down). Pre-merge checklist in regression-final.md MUST be completed before merge.

**Agent prompt:**

> **Goal**: One last full-suite GREEN check across every Slice 001 artifact before merge. If anything is red, the slice cannot merge per Principle XI. After this passes, slices 002–008 can build on top of the locked cross-slice contracts (`participants` shape, `is_eligible_nortal_participant`, `is_admin` stub, `audit_log` shape, `tournament_config` stub).
>
> **Read first**:
> - All prior regression-checkpoint files (`regression-checkpoint-us1.md`, `regression-checkpoint-us2.md`, `regression-checkpoint-us3.md`)
> - `.specify/memory/constitution.md` § Principle XI
> - `specs/001-eligibility-login/quickstart-verification.md` (from T044)
>
> **Files to create or modify**:
> - `specs/001-eligibility-login/regression-final.md` (new)
>
> **What to do**:
> 1. Run every Playwright spec under `apps/web/tests/playwright/slice-001-*.spec.ts` plus the harness smoke spec.
> 2. Run every `*.sql` under `supabase/tests/pgtap/` (the slice's nine pgTAP files plus the harness smoke).
> 3. Run `pnpm -F web typecheck`, `pnpm -F web build`, `pnpm -F web lint`.
> 4. Confirm CI on the most recent PR is GREEN.
> 5. Confirm `quickstart-verification.md` is 8/8 PASS.
> 6. Tabulate: row per test surface (Playwright / pgTAP / typecheck / build / lint / CI / quickstart) with status + count.
>
> **Acceptance criteria**: 100% GREEN across all seven surfaces.
>
> **Do NOT**: skip, quarantine, or `xfail` any failure.
>
> **Constitution**: XI (NON-NEGOTIABLE — final gate).

**Blocked-by**: T042, T043, T044
**Parallel-safe with**: _(none — final gate)_
**Definition of done**: `regression-final.md` shows 100% GREEN across all surfaces.

---

## Dependency graph (terse)

```
T001 → T002 → T003 ∥ T004 (start after T001) → T005, T006 (after T004) → T007 → T008
T008 → T009 ∥ T010 ∥ T011 → T014 → T012 → T013 → T015 (after T012,T013,T014)
T015 → T016 ∥ T017 ∥ T018 ∥ T019 ∥ T020 → T021 → T022 → T023 → T024 ∥ T025 → T026, T027 → T028
T028 → T029 ∥ T030 → T031 → T032 ∥ T033 ∥ T034 → T035
T035 → T036 ∥ T037 ∥ T038 → T039 → T040 → T041
T041 → T042 ∥ T043 ∥ T044 → T045 (final gate)
```

## Parallel-execution recipes

Dispatch any block whose tasks share no write paths to parallel subagents. Concrete recipes:

**Setup harnesses (after T002):** run T003, T004 in parallel (after T002 and T001 respectively); then T005, T006 in parallel after T004.

**Foundational schema (after T008):** run T009, T010, T011 in parallel — three different migration files.

**US1 test authoring (after T015):** run T016, T017, T018, T019, T020 in parallel — five different test files; biggest fan-out in this slice.

**US2 test authoring (after T028):** run T029, T030 in parallel — Playwright vs pgTAP.

**US2 implementation (after T031):** run T032, T033, T034 in parallel — denied page + API guard wire + RLS tighten touch disjoint files.

**US3 test authoring (after T035):** run T036, T037, T038 in parallel.

**Polish (after T041):** run T042, T043, T044 in parallel.

Tasks NOT marked `[P]` must run sequentially with their listed `Blocked-by`.

## Implementation strategy

- **MVP scope = Phase 1 + Phase 2 + Phase 3 (US1).** After T028, the slice scores at the demo gate: an eligible Nortal employee can sign in, get a profile, and reach `/dashboard`. Stop here to demo.
- **P1 trio = Phases 4 + 5.** US2 adds the denial UX + API-guard + RLS tightening; US3 adds the returning-login refresh + email-drift + missing-claim + deactivation handling. After T041, the slice satisfies every P1 + P2 user story plus all seven Edge Cases plus all four spec Clarifications from 2026-05-15.
- **Polish + ship = Phase 6.** Perf assertion, doc sync, manual quickstart, final regression gate. After T045, slices 002–008 can start without risk of foundation drift.

## Notes for the orchestrator

- The five `[P]` US1 test-author tasks (T016–T020) are the highest fan-out in this slice. Spawn five subagents in one batch after T015.
- Every red-gate task (T021, T031, T039) is intentionally sequential — these gates verify that the prior `[P]` test-author tasks all left their tests genuinely RED.
- T034 (RLS tightening) is subtle: it REPLACES T012's `participants_self_read` policy. The pre-existing policy is intentionally weaker so that T012's tests can run before T023's eligibility predicate exists. T034's GREEN gate proves the safety-net works.
- **Cross-slice contract locks** ship at T023 (`is_eligible_nortal_participant`), T014 (`is_admin` stub), T009 (`participants` shape), T011 (`audit_log` shape). After T045, any change to these is a coordinated-cross-slice change set requiring regression updates across slices 002–008 (Constitution Principle XI).
- This file MUST NOT be edited to "make things work" — if any task's acceptance criteria appears impossible to satisfy, file a bug or revise the plan; do not silently weaken a criterion.
- Spec Clarifications 2026-05-15 (Q1–Q4) are first-class test cases: Q1 covered by the `participation_status` enum lock in T009; Q2 (email drift) by T036's email-drift spec + T037 pgTAP + T040 implementation; Q3 (mid-session deny) by T030's `participants_rls_mid_session_deny.sql` + T036's domain-removed spec + T034's RLS tighten; Q4 (missing optional claim) by T036's missing-claim spec + T037 + T040.
