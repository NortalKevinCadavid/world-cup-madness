/**
 * Shared per-provider key segments for the `/admin/config/providers` editor
 * (Slice 008, Phase 6, T039, US4).
 *
 * Lives in its own module (not in `page.tsx`) because `page.tsx` is marked
 * `import 'server-only'`; the `ProvidersEditor` client component cannot
 * re-import a server-only module without breaking the Next.js client/server
 * boundary. This file is plain TypeScript so both server + client may import.
 *
 * Mirrors the authoritative seed in `supabase/migrations/0077_configuration.sql`
 * (~ line 354 — `providers.<id>.retry.max_attempts`,
 * `providers.<id>.retry.backoff_seconds_base`,
 * `providers.<id>.alert.threshold_consecutive_failures`).
 *
 * Catalog drift note (D-T039-A): the T039 task body cited shorter aliases
 * (`backoff_seconds`, `failure_threshold`). The seed/validator are the
 * single source of truth; the editor uses the longer forms here and exposes
 * the shorter aliases ONLY as `data-testid` suffixes (`retry-backoff-seconds`,
 * `alert-failure-threshold`).
 *
 * @see specs/008-configuration/contracts/tournament-config.schema.md § providers namespace
 * @see apps/web/lib/config-validators.ts § providers
 */

export const PROVIDER_NUMERIC_SEGMENTS = [
  'retry.max_attempts',
  'retry.backoff_seconds_base',
  'alert.threshold_consecutive_failures',
] as const;

export type ProviderNumericSegment = (typeof PROVIDER_NUMERIC_SEGMENTS)[number];
