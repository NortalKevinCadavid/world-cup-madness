-- is_approved_domain.sql
-- Slice 001-eligibility-login | Task T019 (corrected post-contract-review)
-- Functional requirements covered: FR-007, FR-008
--
-- Exercises the internal helper `public.is_approved_domain(p_email text)`
-- as locked by `specs/001-eligibility-login/contracts/eligibility-predicate.sql.md`
-- line 104. The helper accepts a FULL EMAIL (not a bare domain), extracts the
-- domain internally via split_part(lower(p_email),'@',2), and returns TRUE
-- iff that domain matches an entry in
-- `tournament_config.eligibility.approved_domains` (a jsonb array of lowercase
-- domain strings), case-insensitively, with surrounding whitespace tolerated.
-- Missing/empty config row MUST fail-closed (R-007).
--
-- Seed fixture: `tournament_config` row
--   key='eligibility.approved_domains', value='["nortal.com"]'::jsonb
-- (inserted by migration 0002_tournament_config_stub.sql).
--
-- RED expectation: authored BEFORE T022 implements the function body
-- (Constitution Principle IX). Until T022 ships, every assertion fails
-- with `function public.is_approved_domain(...) does not exist`.

BEGIN;

SELECT plan(9);

-- Case 1: exact lowercase email whose domain matches the seed.
SELECT is(
  public.is_approved_domain('alpha@nortal.com'),
  true,
  'exact-case approved domain in email returns true'
);

-- Case 2: fully upper-cased email still matches (case-insensitive).
SELECT is(
  public.is_approved_domain('ALPHA@NORTAL.COM'),
  true,
  'upper-case email returns true (case-insensitive domain match)'
);

-- Case 3: mixed-case email still matches.
SELECT is(
  public.is_approved_domain('Alpha@Nortal.com'),
  true,
  'mixed-case email returns true (case-insensitive)'
);

-- Case 4: leading and trailing whitespace tolerated and trimmed.
SELECT is(
  public.is_approved_domain('  alpha@nortal.com  '),
  true,
  'whitespace-padded email returns true (trimmed)'
);

-- Case 5: email whose domain is not in the approved list is rejected.
SELECT is(
  public.is_approved_domain('outsider@example.com'),
  false,
  'email with unapproved domain returns false'
);

-- Case 6: empty string returns false without raising.
SELECT is(
  public.is_approved_domain(''),
  false,
  'empty string returns false (no exception)'
);

-- Case 7: NULL input returns false (not NULL) without raising.
SELECT is(
  public.is_approved_domain(NULL),
  false,
  'NULL input returns false (no exception, not NULL)'
);

-- Case 8: exact-match required — superdomain / suffix expansion is NOT
-- allowed. An email at `nortal.co.uk` must not match a seed of `nortal.com`.
SELECT is(
  public.is_approved_domain('alpha@nortal.co.uk'),
  false,
  'email at similar-but-distinct domain returns false (no suffix expansion)'
);

-- Case 9: fail-closed when the config row is absent. We DELETE the seed
-- inside the open BEGIN; the ROLLBACK at file end restores it for the next
-- test. The helper MUST NOT raise; it MUST return false (R-007).
DELETE FROM public.tournament_config
 WHERE key = 'eligibility.approved_domains';

SELECT is(
  public.is_approved_domain('alpha@nortal.com'),
  false,
  'fail-closed: missing eligibility.approved_domains config row returns false'
);

SELECT * FROM finish();

ROLLBACK;
