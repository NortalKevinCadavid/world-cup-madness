-- action_label_catalog.sql
-- Slice 007 / T008 / US1
--
-- Spec anchors:
--   specs/007-audit-trail/data-model.md § "Action label catalog (final, frozen at end of this slice)"
--   specs/007-audit-trail/research.md § R-009 "Cross-slice action label catalog"
--   specs/007-audit-trail/tasks.md T008 (line 72)
--   specs/007-audit-trail/contracts/audit-log.schema.md "Action label catalog (LOCKED)"
--
-- Purpose:
--   Freeze the action-label namespace at this slice. Verifies that every
--   DISTINCT `audit_log.action` value present in the database is either
--     (a) enumerated in the frozen catalog table built below, OR
--     (b) prefixed by a documented reserved namespace:
--           - 'tournament_config.*'  (reserved for Slice 008 config-change audit)
--           - 'score_trigger.*'      (Slice 005 / 006 extension)
--
-- Failure mode:
--   If a prior-slice migration silently introduces a new action label that
--   is neither catalogued nor reserved-prefix-shaped, this test fails with
--   the offending labels in the diagnostic. That forces a coordinated
--   catalog-update PR to data-model.md + research.md R-009 + this file.
--
-- Approach:
--   Use a TEMP TABLE (`expected_catalog`) as the canonical SET. This is more
--   maintainable and diff-friendly than a giant NOT IN list, and keeps the
--   assertion query simple (anti-join against the temp table).
--
-- pgTAP harness convention (per Slice 001):
--   BEGIN; SELECT plan(N); ... SELECT * FROM finish(); ROLLBACK;
--   The ROLLBACK is cosmetic — this test only reads from `audit_log` and
--   only writes to a TEMP table (auto-dropped at session/tx end).

BEGIN;

SELECT plan(3);

-- ---------------------------------------------------------------------------
-- Build the frozen catalog as a TEMP table.
--
-- Sources of truth:
--   1. specs/007-audit-trail/data-model.md § "Action label catalog"
--   2. specs/007-audit-trail/research.md § R-009 table
--   3. Verified by grep across:
--        - supabase/migrations/*.sql (slices 001-006 writers, triggers, SPs)
--        - supabase/functions/sync-catalog/**/*.ts (Slice 002 Edge Function)
--
-- Reserved prefixes (NOT enumerated; validated via LIKE in Assertion 1):
--   - 'tournament_config.*'  : Slice 008 config-change audit trigger (one
--                              row per tournament_config key write).
--   - 'score_trigger.*'      : Slice 005's score-recalc trigger family +
--                              Slice 006's reaper/self-scan extension.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE expected_catalog (
  action text PRIMARY KEY,
  producer_slice text NOT NULL,
  notes text
) ON COMMIT DROP;

INSERT INTO expected_catalog (action, producer_slice, notes) VALUES
  -- ---- Slice 001: eligibility + auth-hook + participant lifecycle ----
  ('access.granted',                                  '001', 'Auth hook: eligibility check passed'),
  ('access.denied',                                   '001/003/006', 'Auth hook + RLS + API guards'),
  ('participant.created',                             '001', 'Auth hook first-login insert'),
  ('participant.updated',                             '001', 'Profile / drift correction'),
  ('participant.email_drift',                         '001', 'Auth hook detected JWT email drift'),

  -- ---- Slice 002: tournament catalog + match results + sync ----
  ('match.created',                                   '002', 'Trigger on matches insert'),
  ('match.updated',                                   '002', 'Trigger on matches update'),
  ('match.deleted',                                   '002', 'Trigger on matches delete (data-model lists)'),
  ('match.status_changed',                            '002', 'Trigger on matches.status transition'),
  ('match.conflict_quarantined',                      '002', 'Sync coordinator: conflict held for review'),
  ('match.conflict_resolved',                         '002', 'Sync coordinator: conflict resolved'),
  ('match_result.recorded',                           '002', 'record_match_result_sp'),
  ('match_result.updated',                            '002', 'record_match_result_sp re-record path'),
  ('match_result.corrected',                          '002/006', 'admin.record_match_result correction'),
  ('team.created',                                    '002', 'Trigger on teams insert'),
  ('team.updated',                                    '002', 'Trigger on teams update'),
  ('team.deleted',                                    '002', 'Trigger on teams delete'),
  ('provider.sync_no_changes',                        '002', 'Sync coordinator no-op tick'),
  ('provider.outage_alert_emitted',                   '002', 'Sync coordinator outage onset'),
  ('provider.recovered',                              '002', 'Sync coordinator recovery'),
  ('provider.conflict_quarantined',                   '002', 'Sync coordinator conflict path (Edge Function)'),
  ('provider.players_quarantined_undersized',         '002', 'Players ingest undersized payload'),
  ('provider.sync_rejected_empty',                    '002', 'payload_sanity reject: empty replacement'),
  ('provider.sync_rejected_undersized',               '002', 'payload_sanity reject: undersized'),
  ('provider.sync_rejected_duplicate',                '002', 'payload_sanity reject: duplicate external_id'),

  -- ---- Slice 003: predictions ----
  ('prediction.created',                              '003', 'Trigger / submit_prediction_sp insert'),
  ('prediction.superseded',                           '003', 'Trigger / submit_prediction_sp supersede'),
  ('prediction.rejected_locked',                      '003', 'submit_prediction_sp lock-window reject'),
  ('prediction.rejected_invalid_score',               '003', 'submit_prediction_sp invalid score'),
  ('prediction.rejected_invalid_match',               '003', 'submit_prediction_sp invalid match'),
  ('prediction.rejected_ineligible',                  '003', 'submit_prediction_sp ineligible actor'),
  ('prediction.kickoff_correction_crossed_lock',      '003', 'Kickoff correction crossed lock boundary'),

  -- ---- Slice 004: final predictions + players ----
  ('final_prediction.created',                        '004', 'Trigger / submit_final_prediction_sp'),
  ('final_prediction.superseded',                     '004', 'Trigger / submit_final_prediction_sp supersede'),
  ('final_prediction.rejected_locked',                '004', 'submit_final_prediction_sp lock reject'),
  ('final_prediction.rejected_invalid_target',        '004', 'submit_final_prediction_sp invalid target'),
  ('final_prediction.rejected_invalid_input',         '004', 'submit_final_prediction_sp invalid input'),
  ('final_prediction.rejected_ineligible',            '004', 'submit_final_prediction_sp ineligible'),
  ('final_prediction.rejected_identical_champion_runner_up', '004', 'submit_final_prediction_sp dup champion/RU'),
  ('final_prediction.target_player_removed',          '004', 'players-remove fan-out trigger'),
  ('final_prediction.first_kickoff_correction',       '004', 'Code-actual label (singular event)'),
  ('final_prediction.first_kickoff_corrected',        '004', 'Data-model label spelling (catalog tolerates both)'),
  ('tournament.first_kickoff_corrected',              '002/004', 'tournament_config fan-out trigger'),
  ('player.created',                                  '004', 'Sync coordinator players ingest'),
  ('player.updated',                                  '004', 'Sync coordinator players ingest'),
  ('player.removed',                                  '004', 'Sync coordinator soft-delete'),

  -- ---- Slice 005: scoring ----
  ('score_record.insert',                             '005', 'score_audit_trigger insert path'),
  ('score_record.update',                             '005', 'score_audit_trigger update path'),
  ('score_record.delete',                             '005', 'score_audit_trigger delete path'),
  ('tournament_award.set',                            '005', 'tournament_award trigger initial set'),
  ('tournament_award.confirmed',                      '005', 'tournament_award trigger confirmation'),
  ('tournament_award.changed',                        '005', 'tournament_award trigger change'),

  -- ---- Slice 006: admin RPCs + admin_roles + bootstrap ----
  ('admin.match_result_corrected',                    '006', 'admin_record_match_result body'),
  ('admin.match_updated',                             '006', 'admin_update_match body'),
  ('admin.prediction_submitted',                      '006', 'admin_submit_prediction body'),
  ('admin.final_prediction_submitted',                '006', 'admin_submit_final_prediction body'),
  ('admin.award_updated',                             '006', 'admin_update_tournament_award body'),
  ('admin.tournament_award_updated',                  '006', 'admin_update_tournament_award alt label seen in code'),
  ('admin.pending_review_resolved',                   '006', 'admin_resolve_match_pending_review body (actual code)'),
  ('admin.match_pending_review_resolved',             '006', 'Catalog tolerates verbose data-model spelling'),
  ('admin.recalc_triggered',                          '006', 'admin_trigger_recalc body'),
  ('admin.role_granted',                              '006', 'admin_roles audit trigger insert'),
  ('admin.role_revoked',                              '006', 'admin_roles audit trigger update→inactive'),
  ('admin.access_denied',                             '006', 'requireAdmin guard rejected non-admin caller'),
  ('admin.access_granted',                            '006', 'requireAdmin guard accepted admin caller'),
  ('admin.bootstrap_participant_email',               '006', 'admin_bootstrap (one-shot seed)'),

  -- ---- Slice 008: configuration management (T072 phase 8d) ----
  -- T072 (slice 008 phase 8d): added tournament_config.* + admin.config_* labels.
  -- Note: the ~24-30 'tournament_config.<key>' labels (one per config key seeded
  -- in 0028/0035/0047/0057/0074/0076/0077) are NOT enumerated here — they are
  -- covered by the reserved-prefix LIKE rule in Assertion 1. The three explicit
  -- entries below are the new admin RPC labels introduced by slice 008.
  -- Sorted alphabetically within this section.
  ('admin.config_exported',                           '008', 'admin_config_export body (T052)'),
  ('admin.config_imported',                           '008', 'admin_config_import body (T053)'),
  ('admin.config_secret_accessed',                    '008', 'admin_config_get_secret body (T037)');

-- Sanity: confirm the catalog itself is non-empty (defends against accidental
-- truncation of the INSERT block above). Bumped from 40 → 43 after T072
-- appended the three slice-008 admin.config_* labels.
SELECT cmp_ok(
  (SELECT count(*) FROM expected_catalog)::int,
  '>=',
  43,
  'A0 (preflight): frozen catalog has at least 43 enumerated labels'
);

-- ---------------------------------------------------------------------------
-- Assertion 1 — namespace freeze.
--
-- For every DISTINCT `action` value currently in `audit_log`, it must be
-- either (a) an exact match against `expected_catalog`, or (b) match one of
-- the documented reserved prefixes.
--
-- Expected: zero unknown labels => array_agg(...) over an empty filter set
-- returns NULL. If even one unknown label is found, the result is a sorted
-- text[] of offenders — which `is()` will diff against NULL and surface in
-- the test failure for the catalog-update PR.
-- ---------------------------------------------------------------------------

SELECT is(
  (
    SELECT array_agg(DISTINCT al.action ORDER BY al.action)
      FROM public.audit_log al
     WHERE al.action NOT IN (SELECT ec.action FROM expected_catalog ec)
       AND al.action NOT LIKE 'tournament_config.%'
       AND al.action NOT LIKE 'score_trigger.%'
  ),
  NULL::text[],
  'A1: every distinct audit_log.action is in the frozen catalog OR matches a reserved prefix '
  || '(tournament_config.* / score_trigger.*); offenders force a catalog-update PR per R-009'
);

-- ---------------------------------------------------------------------------
-- Assertion 2 — no empty or NULL action labels.
--
-- `audit_log.action` is NOT NULL at the schema level (data-model.md row),
-- but we also defensively assert no zero-length strings have leaked in via
-- a misconfigured SECURITY DEFINER writer.
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT count(*) FROM public.audit_log WHERE action IS NULL OR action = '')::bigint,
  0::bigint,
  'A2: no empty or NULL action labels in audit_log'
);

SELECT * FROM finish();

ROLLBACK;
