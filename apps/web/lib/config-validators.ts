import { z } from 'zod';

/**
 * Per-key zod validators for `tournament_config.value`.
 *
 * Mirrors the frozen namespace catalog in
 * `specs/008-configuration/data-model.md` § "Configuration namespace catalog".
 *
 * Owner: slice 008 (Configuration). Importable by both server- and client-side
 * code (no `server-only` boundary) so the admin UI can render inline validation
 * errors identical to those enforced by `admin_config_upsert` SQL body.
 *
 * Forward-compat: unknown keys pass validation (the RPC body still enforces
 * type-level invariants via `value_type`). A `console.warn` is emitted in
 * non-production environments so accidental typos surface in dev.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * RFC 1123-ish hostname matcher used for `eligibility.allowed_domains`. We
 * deliberately keep it permissive (lowercase letters, digits, dots, hyphens,
 * with at least one dot and a 2+ char TLD) so non-ASCII IDN domains can be
 * added later via a forward-compatible relaxation of the regex.
 */
const HOSTNAME_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

const tieBreakerKey = z.enum([
  'points_total',
  'exact_match_count',
  'final_pick_correct',
  'earliest_submission',
]);

const tournamentPhase = z.enum([
  'pre_tournament',
  'group_stage',
  'knockout',
  'completed',
]);

// ---------------------------------------------------------------------------
// Per-key schemas (keyed by `tournament_config.key`)
// ---------------------------------------------------------------------------

export const configSchemas = {
  // Eligibility
  'eligibility.allowed_domains': z.array(z.string().regex(HOSTNAME_RE)).min(1),

  // Locking
  'locking.match_prediction_window_minutes': z.number().int().min(1).max(1440),
  'locking.final_prediction_anchor': z.string().min(1),

  // Scoring (per-match)
  'scoring.match_points.exact': z.number().int().min(0).max(1000),
  'scoring.match_points.correct_outcome': z.number().int().min(0).max(1000),
  'scoring.match_points.incorrect': z.number().int().min(0).max(1000),

  // Scoring (final pick + bounds + tie-breakers)
  'scoring.final_pick_points': z.number().int().min(0).max(1000),
  'scoring.score_upper_bound': z.number().int().min(0).max(999),
  'scoring.tie_breaker_order': z.array(tieBreakerKey).min(1),

  // Scoring (open-decision keys; default-seeded, free-text until OD resolves)
  'scoring.knockout_match_basis': z.string().min(1),
  'scoring.top_scorer_tie_policy': z.string().min(1),
  'scoring.best_player_source': z.string().min(1),

  // Leaderboard
  'leaderboard.visibility_policy': z.string().min(1),

  // Tournament phase / kickoff
  'tournament.phase.current': tournamentPhase,
  'tournament.first_kickoff_at_utc': z
    .string()
    .datetime({ offset: true })
    .nullable(),

  // Providers
  'providers.active': z.string().min(1),
  'providers.registered.football_data_org': z.object({
    display_name: z.string().min(1),
    contract_version: z.string().min(1),
  }),
  'providers.football_data_org.retry.max_attempts': z
    .number()
    .int()
    .min(1)
    .max(100),
  'providers.football_data_org.retry.backoff_seconds_base': z
    .number()
    .int()
    .min(1)
    .max(3600),
  'providers.football_data_org.alert.threshold_consecutive_failures': z
    .number()
    .int()
    .min(1)
    .max(1000),
  // Secret envelope; the cleartext is only revealed via `admin_config_get_secret`.
  'providers.football_data_org.credentials.api_key': z.object({
    secret: z.literal(true),
    value: z.string().nullable(),
  }),

  // Audit retention (slice 007-seeded; this slice exposes the UI)
  'audit.retention.policy_kind': z.enum(['keep', 'delete']),
  'audit.retention.tournament_end_buffer_months': z
    .number()
    .int()
    .min(0)
    .max(120),

  // Notifications
  'notifications.audit_failure_webhook_url': z.string().url().nullable(),
  'notifications.deadline_reminders.enabled': z.boolean(),
} as const;

export type ConfigKey = keyof typeof configSchemas;

/**
 * Result returned by {@link validateConfigValue}. `ok: true` covers both
 * "validated against a known schema" and "unknown key, forward-compat pass".
 */
export type ConfigValidationResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Look up the schema for `key` and run it against `value`.
 *
 * - Known key + valid value → `{ ok: true, data }` (where `data` is the
 *   parsed/normalized value).
 * - Known key + invalid value → `{ ok: false, error }` with a flattened
 *   zod error message.
 * - Unknown key → `{ ok: true, data: value }` (forward-compat, per slice 008
 *   contract; the SQL `admin_config_upsert` body still enforces type-level
 *   invariants via `value_type`). A `console.warn` is emitted in non-prod
 *   environments to surface accidental typos.
 */
export function validateConfigValue(
  key: string,
  value: unknown,
): ConfigValidationResult {
  const schema = (configSchemas as Record<string, z.ZodTypeAny | undefined>)[key];
  if (!schema) {
    if (
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production'
    ) {
      console.warn(
        `[config-validators] no per-key schema for "${key}" — falling back to forward-compat pass-through. Add an entry to configSchemas if this key is part of the frozen namespace catalog.`,
      );
    }
    return { ok: true, data: value };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const message = parsed.error.issues
    .map((iss) => {
      const path = iss.path.length ? iss.path.join('.') : '(root)';
      return `${path}: ${iss.message}`;
    })
    .join('; ');
  return { ok: false, error: message };
}

/**
 * Type guard: does the namespace catalog know about this key?
 *
 * Useful for the admin UI's "this key has a typed validator" badge.
 */
export function isKnownConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(configSchemas, key);
}
