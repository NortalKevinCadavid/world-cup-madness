-- Slice 001 / data-model.md § RLS posture / depends on is_admin stub (T014)
-- and on is_eligible_nortal_participant (body lands in T023 — lazy-bound).
--
-- This migration owns the FULL RLS surface for the three foundational tables
-- shipped by Slice 001 (participants, audit_log, tournament_config). It is the
-- third of the four defense-in-depth layers documented in research.md § R-002:
--
--   1. UI guard ----------- the React/Next.js layer renders the denial state
--                           and never exposes participant data to anonymous
--                           callers. Permitted as UX only; never the sole gate.
--   2. API guard ---------- every state-changing handler invokes
--                           requireEligible(client) (R-009) which calls
--                           is_eligible_nortal_participant(auth.uid()) and
--                           returns 403 if false (T040 owns the helper).
--   3. Predicate function - public.is_eligible_nortal_participant(uuid)
--                           STABLE / SECURITY INVOKER (contract:
--                           contracts/eligibility-predicate.sql.md, body
--                           lands in T023).
--   4. RLS (THIS FILE) ---- ENABLE + FORCE row-level security on every
--                           participant-data table, with USING expressions
--                           that re-evaluate the predicate on every read so a
--                           caller whose domain was removed mid-session is
--                           denied immediately (spec FR-002 / Edge Cases).
--
-- FR-002 ("re-verify eligibility on every authenticated session and every
-- state-changing request") and R-009 ("session re-verification") drive the
-- decision to embed the eligibility predicate directly in the participants
-- SELECT policy rather than relying on a cheaper auth_user_id-only check.
-- The cost (one STABLE function call per row read, cached within a query) is
-- accepted in exchange for closing the mid-session-deny window.
--
-- Lazy binding note on is_eligible_nortal_participant:
--   Postgres validates policy expressions at policy-EVALUATION time, not at
--   CREATE POLICY time. T023 creates the function body BEFORE any RLS-gated
--   query is ever executed against this database. The forward reference is
--   therefore safe; supabase db reset will succeed even though the function
--   does not exist when this migration runs (T023 runs immediately after).
--
-- service_role bypass:
--   Supabase's service_role bypasses RLS by design. We deliberately do NOT
--   REVOKE on service_role: backend SECURITY DEFINER paths (auth hook T024,
--   audit trigger T013) and migrations themselves require that bypass.

BEGIN;

-- ===========================================================================
-- public.participants
-- ===========================================================================
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
-- FORCE so that owner-role queries (e.g. accidental psql-as-postgres reads in
-- ops contexts) also respect the policy. service_role still bypasses; this is
-- the stricter posture per Constitution Principle II.
ALTER TABLE public.participants FORCE ROW LEVEL SECURITY;

-- SELECT: a participant may read their own row IFF the eligibility predicate
-- re-evaluates to true on this read (closes the mid-session-deny window per
-- FR-002 / spec Edge Cases / R-009). Admins (is_admin stub, T014) may read
-- every row regardless of eligibility.
--
-- T023 provides the body of public.is_eligible_nortal_participant(uuid);
-- Postgres binds the reference lazily on first evaluation.
CREATE POLICY participants_self_or_admin_read
  ON public.participants
  FOR SELECT
  TO authenticated
  USING (
    (auth_user_id = auth.uid()
      AND public.is_eligible_nortal_participant(auth.uid()))
    OR public.is_admin(auth.uid())
  );

-- No INSERT / UPDATE / DELETE policies for authenticated. Writes are owned by:
--   * T024 / T041 — auth hook (SECURITY DEFINER, bypasses RLS)
--   * Slice 006   — admin override paths (SECURITY DEFINER, bypasses RLS)
-- Explicit REVOKE so that even if a future migration accidentally grants a
-- table-level INSERT/UPDATE/DELETE, this baseline reasserts the closed posture.
REVOKE INSERT, UPDATE, DELETE ON public.participants FROM authenticated, anon;

-- ===========================================================================
-- public.audit_log
-- ===========================================================================
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

-- SELECT: a participant may read audit rows where they are the actor
-- (supports user-facing "my access history" surfaces in later slices).
-- Admins (is_admin stub, T014) may read everything.
-- NOTE: data-model.md § RLS posture summary lists admin-only read; we extend
-- that minimum with a self-read carve-out (actor = auth.uid()) per this
-- task's prompt. Slice 007 may tighten further when it hardens audit posture.
CREATE POLICY audit_log_self_or_admin_read
  ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (
    actor = auth.uid()
    OR public.is_admin(auth.uid())
  );

-- No INSERT / UPDATE / DELETE policies for authenticated. Audit writes come
-- exclusively from SECURITY DEFINER paths:
--   * T024 / T041 — auth hook (access.granted / access.denied / email_drift)
--   * T013        — participants row trigger (participant.created/updated)
-- Append-only at the role layer; Slice 007 adds trigger-level immutability.
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated, anon;

-- ===========================================================================
-- public.tournament_config
-- ===========================================================================
ALTER TABLE public.tournament_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_config FORCE ROW LEVEL SECURITY;

-- SELECT: any authenticated user may read this slice's tournament_config
-- (it holds only eligibility.approved_domains in Slice 001 — a non-secret).
-- Slice 008 will tighten this to admin-only on rows flagged key_is_secret;
-- until then the broad read keeps the eligibility predicate's underlying
-- jsonb lookup recursion-free (data-model.md § 2 recursion-avoidance carve-out
-- is naturally satisfied because every key is readable to every authenticated
-- caller).
CREATE POLICY tournament_config_authenticated_read
  ON public.tournament_config
  FOR SELECT
  TO authenticated
  USING (true);

-- No write policies. Slice 008 owns admin writes.
REVOKE INSERT, UPDATE, DELETE ON public.tournament_config FROM authenticated, anon;

-- ===========================================================================
-- Function-grant hygiene
-- ===========================================================================
-- public.is_admin(uuid)                       — grant lives in 0006 (T014).
-- public.is_eligible_nortal_participant(uuid) — grant lives in T023 migration.
-- Do NOT re-grant here; ownership stays with the function-defining migration
-- to keep migration responsibilities single-purpose (Constitution Principle X).

COMMIT;
