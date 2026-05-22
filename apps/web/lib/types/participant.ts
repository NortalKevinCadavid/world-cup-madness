/**
 * Participant — cross-slice TypeScript shape mirroring the `public.participants`
 * table (T009) and the 200-OK body of `GET /api/me`.
 *
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 * @see specs/001-eligibility-login/data-model.md (Entity 1)
 *
 * This is a **cross-slice contract** (Constitution Principle XI):
 * - Additive fields are allowed.
 * - Renames or removals require a coordinated change set across slices 002–005.
 */

/**
 * Lifecycle state of a participant row. Mirrors the `participant_status` enum
 * defined in the Slice 001 migration (T009).
 */
export type ParticipationStatus = 'active' | 'deactivated';

/**
 * A row of `public.participants`, as visible to the participant themself
 * through RLS (self-only). Timestamps are ISO-8601 strings (Postgres
 * `timestamptz` serialized by PostgREST).
 */
export interface Participant {
  /** `participants.id` — the cross-slice primary key. */
  id: string;
  /** FK to `auth.users.id`. */
  auth_user_id: string;
  /** Stored email, lowercased by the auth hook (citext). Self-only. */
  email: string;
  /** Display name claimed at first login (`name` claim from the IdP). */
  display_name: string;
  /** Lowercased domain portion of `email`. Derived; convenient for the UI. */
  domain: string;
  /** Optional region tag (e.g. "EE-North"). NULL until set by an admin. */
  region: string | null;
  /** `active` until an admin deactivates per Slice 006. */
  status: ParticipationStatus;
  /** ISO-8601 timestamp of first successful login (set by auth hook). */
  first_login_at: string;
  /** ISO-8601 timestamp of most recent successful login (owned by R-010). */
  last_login_at: string;
  /** Row insert timestamp. */
  created_at: string;
  /** Row last-update timestamp. */
  updated_at: string;
}
