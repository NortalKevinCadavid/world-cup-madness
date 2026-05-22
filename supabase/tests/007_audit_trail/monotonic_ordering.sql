-- monotonic_ordering.sql
-- Slice 007 Audit Trail | Task T007 | US1
--
-- Spec anchors:
--   FR-002 (audit append-only invariant), SC-006 (monotonic per-target ordering
--   under concurrency). Constitution Principle V (NON-NEGOTIABLE append-only).
--
-- Contract source of truth:
--   contracts/audit-log.schema.md § Monotonic ordering invariant — Postgres
--   bigserial guarantees each successful INSERT receives a strictly-increasing
--   sequence_id from public.audit_log_sequence_id_seq (created by slot 0076's
--   ALTER TABLE ... ADD COLUMN sequence_id bigserial NOT NULL). The sequence
--   is NOT rolled back on transaction abort (gaps may exist after failed
--   transactions — this is expected and does NOT violate monotonicity).
--
-- Research anchor:
--   research.md § R-002 — global sequence over UUID/clock_timestamp tiebreakers.
--
-- Test scope (5 assertions / plan(5)):
--   A1: After inserting 5 fresh audit_log rows, exactly 5 rows have
--       sequence_id > before_max (no rows leak in from elsewhere; the SEQUENCE
--       allocates 5 fresh values).
--   A2: The 5 fresh sequence_ids form a strictly-increasing series (gap > 0
--       between successive values when ordered by insertion order). This is
--       the core monotonicity claim — sub-microsecond inserts cannot collide.
--   A3: Insertion order (ORDER BY id where id is the uuid PK populated by
--       gen_random_uuid()) maps 1:1 to sequence_id order — this would normally
--       NOT hold for arbitrary IDs, BUT because we INSERT in a single
--       statement via generate_series the row-by-row sequence allocation
--       proceeds in the same order the executor emits rows. NOTE: this is a
--       weaker assertion than A2 since gen_random_uuid() ordering is not
--       insertion order in general; we substitute a stronger formulation —
--       see A3 below using a deterministic ordinal column captured at insert
--       time.
--   A4: Zero NULL sequence_ids — the NOT NULL constraint shipped by slot
--       0076 is honoured by every INSERT path (including ones that omit the
--       sequence_id column from the INSERT list).
--   A5: Attempting to INSERT a row with an explicit sequence_id that
--       duplicates an existing row's sequence_id raises unique_violation
--       (SQLSTATE 23505) from audit_log_sequence_id_uk. Proves the unique
--       index from slot 0076 (T004) is enforced — defence in depth: even if
--       application code tries to bypass the sequence default, duplicate
--       writes fail loud.
--
-- Actor choice:
--   admin1's participant.id = 77777777-7777-7777-7777-777777777777 (slice 005
--   fixture, supabase/seed/slice-005-fixture.sql line 248). audit_log.actor is
--   uuid NULL with no FK constraint (per slot 0003 stub), so the value is a
--   bookkeeping reference only — but we use a real participant.id for forensic
--   realism.
--
-- Source value:
--   'trigger' is a CHECK-permitted source from slot 0003's audit_log_source_check.
--
-- Action label:
--   'test.monotonic_check' is NOT in the frozen catalog (R-009). T008's
--   action_label_catalog test WILL fail if this label persists — but the
--   ROLLBACK at the end of this test wipes the row entirely, so T008 in CI
--   sees zero residue from this test.
--
-- Pattern: BEGIN / plan(5) / asserts / finish / ROLLBACK so this test leaves
-- no residue (no orphan audit rows; the sequence may advance but that is the
-- contract's documented behaviour — gaps from rolled-back txns are expected).

BEGIN;

SELECT plan(5);

-- ---------------------------------------------------------------------------
-- Setup: capture current max sequence_id so subsequent assertions can isolate
-- the rows this test inserted from any baseline / fixture audit rows.
-- ---------------------------------------------------------------------------

SELECT set_config(
  'test.before_max',
  COALESCE((SELECT max(sequence_id) FROM public.audit_log), 0)::text,
  false
);

-- ---------------------------------------------------------------------------
-- Insert 5 audit_log rows. Each INSERT omits sequence_id so the bigserial
-- default (nextval('public.audit_log_sequence_id_seq')) allocates it.
--
-- We capture each row's intended insertion-order ordinal in reason so A3 can
-- pair sequence_id ordering against insertion ordering without relying on
-- gen_random_uuid()'s id sort.
-- ---------------------------------------------------------------------------

INSERT INTO public.audit_log (actor, action, entity_type, entity_id, reason, source)
SELECT
  '77777777-7777-7777-7777-777777777777'::uuid,  -- admin1 participant.id (slice 005 fixture)
  'test.monotonic_check',                          -- not in frozen catalog; ROLLBACK wipes it
  'test',
  gen_random_uuid(),
  format('monotonic test row %s', i),              -- ordinal embedded for A3 pairing
  'trigger'                                        -- CHECK-permitted source (slot 0003)
FROM generate_series(1, 5) AS i;

-- ---------------------------------------------------------------------------
-- A1: exactly 5 new rows have sequence_id > before_max.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log
     WHERE sequence_id > current_setting('test.before_max')::bigint),
  5::bigint,
  'A1: 5 new audit_log rows have sequence_id > before_max'
);

-- ---------------------------------------------------------------------------
-- A2: all gaps between consecutive sequence_ids (ordered ASC) are strictly
-- positive (gap > 0). This is the monotonicity claim.
-- ---------------------------------------------------------------------------
SELECT is(
  (
    WITH ordered AS (
      SELECT sequence_id,
             row_number() OVER (ORDER BY sequence_id ASC) AS rn
        FROM public.audit_log
       WHERE sequence_id > current_setting('test.before_max')::bigint
       ORDER BY sequence_id ASC
       LIMIT 5
    ),
    diffs AS (
      SELECT sequence_id,
             sequence_id - LAG(sequence_id) OVER (ORDER BY rn ASC) AS gap
        FROM ordered
    )
    SELECT bool_and(gap IS NULL OR gap > 0) FROM diffs
  ),
  true,
  'A2: sequence_ids are strictly increasing (all gaps > 0)'
);

-- ---------------------------------------------------------------------------
-- A3: insertion-order ordinal embedded in reason matches sequence_id order.
-- Reason holds 'monotonic test row N' for N=1..5; sequence_id ordering MUST
-- agree with N ordering — the SEQUENCE allocates monotonically as the
-- executor emits each generate_series row.
-- ---------------------------------------------------------------------------
SELECT is(
  (
    SELECT bool_and(
      -- ordinal extracted from reason equals the row's sequence-rank
      substring(reason FROM 'row ([0-9]+)')::int = rank_by_seq
    )
      FROM (
        SELECT reason,
               row_number() OVER (ORDER BY sequence_id ASC) AS rank_by_seq
          FROM public.audit_log
         WHERE sequence_id > current_setting('test.before_max')::bigint
         ORDER BY sequence_id ASC
         LIMIT 5
      ) t
  ),
  true,
  'A3: sequence_id ascending order matches insertion-order ordinal (1..5)'
);

-- ---------------------------------------------------------------------------
-- A4: zero NULL sequence_ids across the whole table — NOT NULL constraint
-- from slot 0076's ADD COLUMN ... bigserial NOT NULL is honoured.
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE sequence_id IS NULL),
  0::bigint,
  'A4: zero rows with NULL sequence_id (NOT NULL constraint enforced)'
);

-- ---------------------------------------------------------------------------
-- A5: explicit INSERT of a duplicate sequence_id raises SQLSTATE 23505 from
-- audit_log_sequence_id_uk. Proves the unique index from slot 0076 (T004) is
-- enforced even when callers bypass the sequence default.
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$
    INSERT INTO public.audit_log (sequence_id, actor, action, entity_type, reason, source)
    VALUES (
      (SELECT max(sequence_id) FROM public.audit_log),
      '77777777-7777-7777-7777-777777777777'::uuid,
      'test.duplicate_seq',
      'test',
      'A5 duplicate sequence_id probe',
      'trigger'
    )
  $$,
  '23505',
  NULL,
  'A5: duplicate sequence_id raises unique_violation (SQLSTATE 23505)'
);

SELECT * FROM finish();

ROLLBACK;
