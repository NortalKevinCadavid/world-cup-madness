/**
 * Prediction — cross-slice TypeScript shapes mirroring the `public.predictions`
 * table and the JSON envelopes documented in:
 *   - `specs/003-match-predictions/contracts/predictions.write.md` § Response shapes
 *   - `specs/003-match-predictions/contracts/predictions.read.md` § Response
 *
 * This module is **type-only** — it has no runtime side effects and is safe to
 * import from both server components / route handlers and browser bundles.
 *
 * Cross-slice contract (Constitution Principle XI):
 *   - Additive fields are allowed.
 *   - Renames or removals require a coordinated change set across slices
 *     004 (scoring) and 005 (personal breakdown), which both consume this
 *     shape.
 *
 * No `server-only` import here: types compile away, and downstream client
 * components (e.g. the prediction form in T016) need to type their props
 * against this module.
 */

/**
 * Source of truth for a prediction row.
 *
 * - `ui`  — submitted by the participant through the web UI (default path).
 * - `api` — submitted programmatically via `/api/predictions` (e.g. an
 *   integration test, future mobile client). Same RLS predicate as `ui`.
 * - `admin_override` — written by an admin on behalf of a participant
 *   (Slice 006). Surfaced so the UI can render a "Set by administrator"
 *   note (see `predictions.read.md` § Response notes).
 */
export type PredictionSource = 'ui' | 'api' | 'admin_override';

/**
 * A single active prediction row, as visible to its owner through RLS.
 * Mirrors the SELECT projection used by `/api/me/predictions` and the
 * `prediction` envelope returned by `POST /api/predictions`.
 *
 * `superseded_at` is intentionally OMITTED from the active-only read
 * envelope (per `predictions.read.md` — only `superseded_at IS NULL` rows
 * are returned). The write envelope echoes `"superseded_at": null` but
 * adding it to the active-only shape would imply history exposure that
 * this slice deliberately defers to Slice 005.
 */
export interface Prediction {
  /** `predictions.id`. */
  id: string;
  /** FK → `matches.id`. */
  match_id: string;
  /** Predicted goals for the home team. Integer in [0, 20]. */
  predicted_home: number;
  /** Predicted goals for the away team. Integer in [0, 20]. */
  predicted_away: number;
  /** ISO-8601 UTC timestamp the row was inserted. */
  submitted_at: string;
  /** How the row arrived in the table. */
  source: PredictionSource;
}

/**
 * Request body for `POST /api/predictions`. The route handler validates:
 *   - `match_id` is a uuid string
 *   - `home` and `away` are integers in [0, 20]
 *   - the match is currently editable (server-side lock check)
 */
export interface SubmitPredictionInput {
  /** Match the participant is predicting. */
  match_id: string;
  /** Goals predicted for the home team. */
  home: number;
  /** Goals predicted for the away team. */
  away: number;
}

/**
 * 200-OK envelope of `POST /api/predictions`. The `prediction` field is the
 * freshly-inserted active row (any prior row for the same `match_id` has
 * been marked `superseded_at = now()` by the server).
 */
export interface SubmitPredictionResponse {
  prediction: Prediction;
}

/**
 * 200-OK envelope of `GET /api/me/predictions[?match_id=...]`. Returns ONLY
 * active rows (`superseded_at IS NULL`); the array is empty when the
 * participant has not predicted any (or the filtered) match.
 */
export interface MePredictionsResponse {
  predictions: Prediction[];
}
