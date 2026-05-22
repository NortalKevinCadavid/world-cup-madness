/**
 * Final-prediction — cross-slice TypeScript shapes mirroring the
 * `public.final_predictions` table and the JSON envelopes documented in:
 *   - `specs/004-final-predictions/contracts/final-predictions.write.md` § Response shapes
 *   - `specs/004-final-predictions/contracts/final-predictions.read.md`  § Response shapes
 *
 * This module is **type-only** — no runtime side effects — and is safe to
 * import from server components, route handlers, and browser bundles.
 *
 * Cross-slice contract (Constitution Principle XI):
 *   - Additive fields are allowed.
 *   - Renames or removals require a coordinated change set with Slices 005
 *     (peer visibility / breakdown) and 006 (admin override), which both
 *     consume these shapes.
 *
 * No `server-only` import here: types compile away, and downstream client
 * components (e.g. the picker forms in T018/T019) need to type their props
 * against this module.
 */

/**
 * Four item kinds a participant predicts. Locked enum — the SP signature in
 * `final-predictions.write.md` reflects the same set, so adding a fifth
 * kind is a coordinated cross-slice change.
 */
export type ItemKind =
  | 'champion'
  | 'runner_up'
  | 'top_scorer'
  | 'best_player';

/**
 * Source of truth for a final-prediction row.
 *
 * - `ui`              — submitted by the participant through the picker UI.
 * - `api`             — submitted programmatically (integration tests,
 *                       future mobile client). Same RLS predicate as `ui`.
 * - `admin_override`  — written by an admin on behalf of a participant
 *                       (Slice 006). Surfaced so the UI can render a
 *                       "Set by administrator" annotation.
 */
export type FinalPredictionSource = 'ui' | 'api' | 'admin_override';

/**
 * A single active final-prediction row, as visible to its owner through RLS.
 * Mirrors the SELECT projection used by `GET /api/me/final-predictions` and
 * the `final_prediction` envelope returned by `POST /api/final-predictions`.
 *
 * `superseded_at` is intentionally OMITTED from the active-only read
 * envelope (only `superseded_at IS NULL` rows are returned). History
 * exposure is deferred to Slice 005's personal-breakdown surface.
 *
 * Exactly one of `target_team_id` / `target_player_id` is non-null per row:
 *   - `champion` / `runner_up` → `target_team_id` set, `target_player_id` null.
 *   - `top_scorer` / `best_player` → `target_player_id` set, `target_team_id` null.
 */
export interface FinalPrediction {
  /** `final_predictions.id` — UUID primary key. */
  id: string;
  /** Which of the four tournament-wide picks this row represents. */
  item_kind: ItemKind;
  /** FK → `teams.id`. Non-null iff `item_kind ∈ {champion, runner_up}`. */
  target_team_id: string | null;
  /** FK → `players.id`. Non-null iff `item_kind ∈ {top_scorer, best_player}`. */
  target_player_id: string | null;
  /** How the row arrived in the table. */
  source: FinalPredictionSource;
  /** ISO-8601 UTC timestamp the row was inserted. */
  submitted_at: string;
}

/**
 * Request body for `POST /api/final-predictions`. The route handler
 * validates kind/target consistency via a Zod schema BEFORE the eligibility
 * check (per contract § Server behavior step 2):
 *   - `item_kind = champion | runner_up` → `target_team_id` required, `target_player_id` absent / null.
 *   - `item_kind = top_scorer | best_player` → `target_player_id` required, `target_team_id` absent / null.
 */
export interface SubmitFinalPredictionInput {
  /** Which of the four tournament-wide picks the caller is submitting. */
  item_kind: ItemKind;
  /** Required for `champion` / `runner_up`; null or absent for player kinds. */
  target_team_id?: string | null;
  /** Required for `top_scorer` / `best_player`; null or absent for team kinds. */
  target_player_id?: string | null;
}

/**
 * 200-OK envelope of `POST /api/final-predictions`. The `final_prediction`
 * field is the freshly-inserted active row (any prior row for the same
 * `(participant, item_kind)` has been marked `superseded_at = now()` by
 * the server).
 */
export interface SubmitFinalPredictionResponse {
  final_prediction: FinalPrediction;
}

/**
 * 200-OK envelope of `GET /api/me/final-predictions`. Returns ONLY active
 * rows (`superseded_at IS NULL`); the array is empty for a participant who
 * has not yet submitted any of the four picks.
 *
 * `lock_state` is server-computed via `public.is_final_prediction_locked()`
 * — the API is authoritative. `first_kickoff_utc` is exposed so the UI can
 * render its own countdown indicator (display-only); see
 * `formatRemainingUntilFirstKickoff` in `./countdown.ts`.
 */
export interface MeFinalPredictionsResponse {
  /**
   * Active final-prediction rows for the calling participant.
   *
   * Naming note: the wire key is `final_predictions` (matches the T014
   * Playwright fixtures + the read-contract example envelope in
   * `final-predictions.read.md`). The disambiguated name avoids any
   * collision with Slice 003's match-level `predictions` array for clients
   * that compose both responses.
   */
  final_predictions: FinalPrediction[];
  /** Tournament-wide lock state for final predictions. */
  lock_state: 'editable' | 'locked';
  /** ISO-8601 UTC kickoff of match #1; null if not yet configured. */
  first_kickoff_utc: string | null;
}
