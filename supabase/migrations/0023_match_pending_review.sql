-- Slice 002 / T007 / Clarifications Q2 / data-model.md § match_pending_review.
-- Per-row quarantine for sync anomalies. Slice 006 admin overrides will flip
-- 'resolution' from NULL/'pending' to 'accepted'/'rejected'/'superseded'.
-- NO RLS (T009), NO audit (T008), NO seed (T012).

BEGIN;

-- ---------------------------------------------------------------------------
-- public.match_pending_review
-- ---------------------------------------------------------------------------
-- data-model.md § Entity match_pending_review. Per-row quarantine queue: when
-- the sync coordinator detects a conflict it refuses to auto-apply (team
-- assignment change, status backward transition, score-before-finished,
-- kickoff change after lock, unknown team mapping), the offending provider row
-- lands here for human review (Clarifications 2026-05-15 Q2 — hybrid
-- abort/quarantine policy). Slice 006 (admin overrides) reads + resolves these
-- rows; the sync coordinator never auto-resolves.
CREATE TABLE public.match_pending_review (
  -- bigserial: pathological providers can produce a high volume of conflicts
  -- in a single run; the integer space is the cheap, monotonic choice.
  id                    bigserial PRIMARY KEY,

  -- NULL when the conflicting provider row did not map to an existing match —
  -- e.g., the provider tried to introduce a brand-new match with an unknown
  -- team mapping. ON DELETE SET NULL preserves the quarantine record even if
  -- the underlying match is later deleted by admin.
  match_id              uuid NULL
                          REFERENCES public.matches (id) ON DELETE SET NULL,

  -- Which provider produced the anomaly (e.g., 'footballdata'). Free text to
  -- match the sibling tables' provider columns (0021/0022).
  provider              text NOT NULL,

  -- The provider's native identifier for the conflicting row. Together with
  -- 'provider' this lets admins correlate the quarantine entry back to the
  -- upstream feed.
  provider_external_id  text NOT NULL,

  -- Which sync run produced this entry. ON DELETE RESTRICT: the run ledger is
  -- the audit trail for the quarantine; we never lose the run that emitted it.
  sync_run_id           bigint NOT NULL
                          REFERENCES public.provider_sync_runs (id) ON DELETE RESTRICT,

  -- The conflict classification — drives admin UI grouping and Slice 006's
  -- resolution affordances. Enforced by the CHECK below; free text (not a
  -- pg enum) so adding new classes later does not require a coordinated ALTER.
  conflict_class        text NOT NULL,

  -- The provider's row that was rejected, captured as received. Canonical
  -- record of what the provider tried to do — retained even after resolution
  -- so the resolution decision is always reconstructible.
  proposed_payload      jsonb NOT NULL,

  -- Snapshot of the existing matches row at the moment of the conflict, NULL
  -- when there was no existing row to conflict with (e.g., unknown_team on a
  -- new match introduction).
  current_value         jsonb NULL,

  -- When the sync coordinator detected the conflict.
  detected_at           timestamptz NOT NULL DEFAULT now(),

  -- NULL until reviewed; Slice 006 flips this to 'pending' on triage and then
  -- to 'accepted' / 'rejected' / 'superseded' on resolution. Enforced by the
  -- CHECK below.
  resolution            text NULL,

  -- When the admin closed the entry. Paired with 'resolution' by the
  -- consistency CHECK: if 'resolution' is set, 'resolved_at' must be set too.
  resolved_at           timestamptz NULL,

  -- Which admin resolved the entry. ON DELETE SET NULL preserves the
  -- resolution record if the participant row is later removed.
  resolved_by           uuid NULL
                          REFERENCES public.participants (id) ON DELETE SET NULL,

  -- Free-form admin commentary captured at resolution time.
  notes                 text NULL,

  -- Conflict classification whitelist. Mirrors the sync coordinator's
  -- detection branches (see contracts/sync-runner.scheduled.md § Quarantine flow).
  CONSTRAINT match_pending_review_conflict_class_enum
    CHECK (conflict_class IN (
      'team_assignment_change',
      'status_backward_transition',
      'score_before_finished',
      'kickoff_change_after_lock',
      'unknown_team',
      'other'
    )),

  -- Resolution whitelist. NULL is allowed (un-triaged); otherwise must be one
  -- of the four lifecycle states Slice 006 emits.
  CONSTRAINT match_pending_review_resolution_enum
    CHECK (resolution IS NULL OR resolution IN (
      'pending',
      'accepted',
      'rejected',
      'superseded'
    )),

  -- All-or-nothing pairing: an unresolved entry has resolution + resolved_at
  -- both NULL; a resolved entry has both set. resolved_by may still be NULL
  -- if the resolving participant was later deleted (ON DELETE SET NULL above).
  CONSTRAINT match_pending_review_resolved_consistency
    CHECK (
      (resolution IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
      OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- Indexes on public.match_pending_review
-- ---------------------------------------------------------------------------
-- Admin dashboard "all unresolved" query: filter on resolution status and
-- order by detected_at. Composite supports both the WHERE and the ORDER BY.
CREATE INDEX match_pending_review_resolution_detected_at_idx
  ON public.match_pending_review (resolution, detected_at);

-- Group-by-run query: "show me every conflict produced by run N" — used by
-- the sync coordinator's post-run summary and by Slice 006's per-run drilldown.
CREATE INDEX match_pending_review_sync_run_id_idx
  ON public.match_pending_review (sync_run_id);

-- Per-match conflict history: from a specific match, jump to its quarantined
-- rows. Partial index skips the NULL match_id rows (new-match-introduction
-- conflicts), keeping the index small and selective.
CREATE INDEX match_pending_review_match_id_idx
  ON public.match_pending_review (match_id)
  WHERE match_id IS NOT NULL;

COMMIT;
