import 'server-only';

import type {
  RealtimeChannel,
  SupabaseClient,
} from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * Typed RPC wrappers + per-process LRU cache for the Slice 008 configuration
 * surface (`tournament_config` + `tournament_config_versions`).
 *
 * Wraps:
 *   - `admin_config_upsert`   (T0077 — locked)
 *   - `admin_config_preview`  (T0077 — locked)
 *   - `admin_config_rollback` (T040+ — STUBBED here; surfaces RPC error
 *     unchanged if not yet shipped)
 *   - `admin_config_get_secret` (T040+ — STUBBED here; surfaces RPC error
 *     unchanged if not yet shipped)
 *   - direct SELECT FROM `tournament_config_versions` for history (no RPC
 *     required by T017's contract)
 *
 * Errors raised by these calls surface `error.code` (WCG01..WCG08) unchanged
 * via {@link ConfigClientError.code}.
 *
 * Cache (R-009):
 *   In-memory `Map<key, {value, cached_at}>` per Node.js process, 60-second
 *   TTL. Subscribes once to the Postgres `tournament_config_changed`
 *   broadcast channel via Supabase Realtime and invalidates a matching cache
 *   entry on receipt. Edge runtimes (where `process.env.NEXT_RUNTIME ===
 *   'edge'` or `process` is undefined) skip the subscription — they are
 *   short-lived per-request and the per-process cache buys nothing.
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md
 * @see specs/008-configuration/research.md § R-009
 */

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Error thrown by every wrapper in this module when the underlying RPC (or
 * direct SELECT) returns a Postgres error. `code` is the raw Postgres
 * ERRCODE (`WCG01`..`WCG08`) so callers can branch on it. The error message
 * is passed through unchanged.
 */
export class ConfigClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigClientError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConfigPreviewResult {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
}

export const ConfigVersionSchema = z.object({
  // `version_id` is `bigint` in Postgres; postgrest may serialise as `number`
  // or `string`. Normalise to a decimal string so callers don't have to
  // worry about precision loss.
  version_id: z
    .union([z.number(), z.string()])
    .transform((v) =>
      typeof v === 'string' ? BigInt(v).toString() : String(v),
    ),
  key: z.string(),
  previous_value: z.unknown().nullable(),
  new_value: z.unknown(),
  change_kind: z.enum([
    'initial_seed',
    'admin_upsert',
    'admin_rollback',
    'import_bulk',
  ]),
  actor: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  source_citation: z.string().nullable(),
  audit_log_id: z.string().uuid().nullable(),
  parent_version_id: z
    .union([z.number(), z.string()])
    .nullable()
    .transform((v) =>
      v === null
        ? null
        : typeof v === 'string'
          ? BigInt(v).toString()
          : String(v),
    ),
  acknowledge_token_used: z.string().uuid().nullable(),
  created_at: z.string(), // ISO timestamptz
});
export type ConfigVersion = z.infer<typeof ConfigVersionSchema>;

// ---------------------------------------------------------------------------
// Input schemas (zod). Per-key value validation lives in T018's
// `config-validators.ts`; here we only enforce the wire-shape requirements
// of each RPC. Callers are expected to run the per-key validator first.
// ---------------------------------------------------------------------------

const UpsertParamsSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
  expected_version_id: z
    .union([z.number().int(), z.string()])
    .transform((v) => (typeof v === 'string' ? BigInt(v).toString() : String(v))),
  reason: z.string().min(1).max(2000),
  source_citation: z.string().min(1).max(1000).optional().nullable(),
  acknowledge_token: z.string().uuid().optional().nullable(),
});
export type ConfigUpsertParams = z.infer<typeof UpsertParamsSchema>;

const PreviewParamsSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});
export type ConfigPreviewParams = z.infer<typeof PreviewParamsSchema>;

const RollbackParamsSchema = z.object({
  // `key` is OPTIONAL: it isn't part of the wire RPC (the SP looks the key up
  // from `tournament_config_versions` itself), but if the caller has it they
  // can pass it for eager cache invalidation. Routes that come from the
  // history page only know `target_version_id` and so omit it; the SP's own
  // `pg_notify('tournament_config_changed', NEW.key)` trigger handles cache
  // invalidation via the realtime LISTEN channel either way.
  key: z.string().min(1).max(200).optional(),
  target_version_id: z
    .union([z.number().int(), z.string()])
    .transform((v) => (typeof v === 'string' ? BigInt(v).toString() : String(v))),
  reason: z.string().min(1).max(2000),
  source_citation: z.string().min(1).max(1000).optional().nullable(),
});
export type ConfigRollbackParams = z.infer<typeof RollbackParamsSchema>;

const GetSecretParamsSchema = z.object({
  key: z.string().min(1).max(200),
});
export type ConfigGetSecretParams = z.infer<typeof GetSecretParamsSchema>;

const GrantAdminRoleParamsSchema = z.object({
  participant_id: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  source_citation: z.string().min(1).max(1000),
});
export type ConfigGrantAdminRoleParams = z.infer<
  typeof GrantAdminRoleParamsSchema
>;

const RevokeAdminRoleParamsSchema = z.object({
  participant_id: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  source_citation: z.string().min(1).max(1000),
});
export type ConfigRevokeAdminRoleParams = z.infer<
  typeof RevokeAdminRoleParamsSchema
>;

/**
 * Wire types for the `/api/admin/participants/search` endpoint (T040). The
 * browser-side fetch is inlined in `AdminRolesEditor.tsx` (this module is
 * `server-only`); these types are exported for callers that want shared
 * compile-time guarantees on the request/response shape.
 */
export interface ParticipantsSearchParams {
  q: string;
  limit?: number;
}

export interface ParticipantsSearchResult {
  id: string;
  email: string;
  display_name: string;
}

const VersionHistoryParamsSchema = z.object({
  key: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ConfigVersionHistoryParams = z.infer<
  typeof VersionHistoryParamsSchema
>;

// ---------------------------------------------------------------------------
// Per-process LRU cache + LISTEN invalidation
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: unknown;
  cached_at: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 64;

const cache: Map<string, CacheEntry> = new Map();

/**
 * Insert (or refresh) a cache entry. Evicts the oldest entry when the LRU
 * cap is hit. Exported so consumers that read via direct `config_read` RPC
 * can warm the cache from outside this module.
 */
export function cacheSet(key: string, value: unknown): void {
  if (cache.has(key)) {
    cache.delete(key); // re-insert to move to the back (LRU semantics)
  } else if (cache.size >= CACHE_MAX_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, { value, cached_at: Date.now() });
}

/**
 * Lookup; returns `undefined` if absent or expired. Side-effect: expired
 * entries are evicted on read.
 */
export function cacheGet(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cached_at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

/**
 * Drop a single cache entry. Invoked by the LISTEN handler on receipt of
 * `tournament_config_changed`. Exported for tests / explicit invalidation.
 */
export function cacheInvalidate(key: string): void {
  cache.delete(key);
}

/**
 * Drop every cached entry. Used when the realtime channel disconnects and
 * cannot guarantee delivery — the next read of any key will round-trip.
 */
export function cacheClear(): void {
  cache.clear();
}

/**
 * Detects whether we're running inside the Edge runtime, where long-lived
 * LISTEN subscriptions are inappropriate (processes are short-lived). We
 * check `NEXT_RUNTIME === 'edge'` (Next.js exposes this) AND we also treat
 * the absence of a `process` global as edge-like (defensive).
 */
function isEdgeRuntime(): boolean {
  if (typeof process === 'undefined') return true;
  return process.env.NEXT_RUNTIME === 'edge';
}

let listenChannel: RealtimeChannel | null = null;
let listenClientRef: SupabaseClient | null = null;

/**
 * Idempotently subscribe to the `tournament_config_changed` broadcast on
 * the given Supabase client. The trigger function in slot 0077 emits
 * `pg_notify('tournament_config_changed', NEW.key)`; Supabase Realtime
 * surfaces that as a `broadcast` event on a channel of the same name (the
 * trigger is wired to forward via `realtime.broadcast_changes`). The
 * received payload's `key` field identifies which entry to invalidate.
 *
 * In Edge runtimes this is a no-op (cache is per-request anyway).
 *
 * Callers that have multiple Supabase clients in flight only ever attach
 * ONE listener — the first call wins; subsequent calls are no-ops. If the
 * underlying client changes (e.g. user signs in), call
 * {@link resetListenChannel} explicitly.
 */
export function ensureConfigChangeListener(supabase: SupabaseClient): void {
  if (isEdgeRuntime()) return;
  if (listenChannel !== null) return;

  listenClientRef = supabase;
  const channel = supabase.channel('tournament_config_changed');

  // Payload shape: `{ key: string }`. The Postgres trigger's pg_notify body
  // is just the key text; Supabase wraps it under `payload.key` when
  // forwarded via `realtime.broadcast_changes`. We also accept a raw string
  // payload for robustness against future trigger-side changes.
  channel.on(
    'broadcast' as never,
    { event: 'tournament_config_changed' },
    (payload: unknown) => {
      let changedKey: string | null = null;
      if (typeof payload === 'string') {
        changedKey = payload;
      } else if (payload && typeof payload === 'object') {
        const p = payload as { key?: unknown; payload?: { key?: unknown } };
        if (typeof p.key === 'string') changedKey = p.key;
        else if (p.payload && typeof p.payload.key === 'string') {
          changedKey = p.payload.key;
        }
      }
      if (changedKey) cacheInvalidate(changedKey);
      else cacheClear(); // unknown payload shape — be conservative
    },
  );

  channel.subscribe();
  listenChannel = channel;
}

/**
 * Tear down the active listener (if any). Test/teardown helper; also used
 * when the bound client rotates.
 */
export function resetListenChannel(): void {
  if (listenChannel && listenClientRef) {
    void listenClientRef.removeChannel(listenChannel);
  }
  listenChannel = null;
  listenClientRef = null;
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps `admin_config_upsert(p_key, p_value, p_expected_version_id,
 * p_reason, p_source_citation, p_acknowledge_token)`.
 *
 * Returns the new `version_id` (Postgres bigint) as a JavaScript number.
 * For configurations where the version_id might exceed
 * `Number.MAX_SAFE_INTEGER`, callers should switch to a string-returning
 * variant; today's volumes are far below that threshold.
 *
 * Surfaces `error.code` (WCG01..WCG07) via {@link ConfigClientError}.
 */
export async function configUpsert(
  supabase: SupabaseClient,
  params: ConfigUpsertParams,
): Promise<number> {
  const validated = UpsertParamsSchema.parse(params);
  ensureConfigChangeListener(supabase);

  const { data, error } = await supabase.rpc('admin_config_upsert', {
    p_key: validated.key,
    p_value: validated.value as never,
    p_expected_version_id: validated.expected_version_id,
    p_reason: validated.reason,
    p_source_citation: validated.source_citation ?? null,
    p_acknowledge_token: validated.acknowledge_token ?? null,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  // Eagerly invalidate so the very next read on this process picks up the
  // new value even if the LISTEN broadcast is delayed.
  cacheInvalidate(validated.key);

  return Number(data);
}

/**
 * Wraps `admin_config_preview(p_key, p_value)`. Returns the preview body
 * (`{ affecting, summary, sample, acknowledge_token }`) unchanged.
 *
 * Surfaces `error.code` via {@link ConfigClientError}.
 */
export async function configPreview(
  supabase: SupabaseClient,
  params: ConfigPreviewParams,
): Promise<ConfigPreviewResult> {
  const validated = PreviewParamsSchema.parse(params);

  const { data, error } = await supabase.rpc('admin_config_preview', {
    p_key: validated.key,
    p_value: validated.value as never,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  // Defensive: the RPC contract guarantees the four fields, but normalise
  // shape so callers get a typed object even if the RPC returns nulls.
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    affecting: Boolean(raw.affecting),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    sample: raw.sample ?? null,
    acknowledge_token:
      typeof raw.acknowledge_token === 'string' ? raw.acknowledge_token : null,
  };
}

/**
 * Wraps `admin_config_rollback(p_target_version_id, p_reason,
 * p_source_citation)` (slot 0077 § T046 — SHIPPED).
 *
 * The wire RPC takes (`p_target_version_id`, `p_reason`,
 * optional `p_source_citation`) per `admin-config-rpcs.write.md`. The wrapper
 * accepts the same plus an OPTIONAL `key` solely for eager local-process
 * cache invalidation; callers that don't know the key (e.g. the history
 * page, which only has the target's `version_id` from a SELECT) may omit
 * it — the LISTEN channel on `tournament_config_changed` will still
 * invalidate other processes' caches when the SP's UPDATE on
 * `tournament_config` fires the trigger.
 *
 * Returns the new `version_id` (the rollback's own row in
 * `tournament_config_versions`) as a JavaScript number. Same precision
 * caveat as {@link configUpsert} — fine for today's volumes.
 *
 * Surfaces `error.code` (WCG02, WCG03, WCG04, WCG07) via
 * {@link ConfigClientError}; callers map to HTTP per T048's contract
 * (WCG07→403, WCG02→400, WCG03→404, WCG04→410).
 */
export async function configRollback(
  supabase: SupabaseClient,
  params: ConfigRollbackParams,
): Promise<number> {
  const validated = RollbackParamsSchema.parse(params);
  ensureConfigChangeListener(supabase);

  const { data, error } = await supabase.rpc('admin_config_rollback', {
    p_target_version_id: validated.target_version_id,
    p_reason: validated.reason,
    p_source_citation: validated.source_citation ?? null,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  if (validated.key) {
    cacheInvalidate(validated.key);
  }

  return Number(data);
}

/**
 * Wraps `admin_config_get_secret(p_key)`. Returns the raw secret string the
 * RPC produced. Used by the admin UI's "reveal secret" path; every
 * invocation writes an `admin.config_secret_accessed` audit row server-side.
 *
 * STUB note: like {@link configRollback}, this RPC ships in T040+. If the
 * RPC is absent the supabase-js client returns `PGRST202`; we surface that
 * code unchanged so callers can render a "not yet available" affordance.
 *
 * The RPC body returns a jsonb `{secret: true, value: <plain>}`. This
 * wrapper extracts the inner `value` string for convenience.
 */
export async function configGetSecret(
  supabase: SupabaseClient,
  params: ConfigGetSecretParams,
): Promise<string> {
  const validated = GetSecretParamsSchema.parse(params);

  const { data, error } = await supabase.rpc('admin_config_get_secret', {
    p_key: validated.key,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  // RPC contract: returns jsonb `{secret: true, value: "<plain>"}`. Be
  // defensive: also accept a raw string payload.
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const v = (data as { value?: unknown }).value;
    if (typeof v === 'string') return v;
  }

  // Empty/unexpected shape — surface as INTERNAL.
  throw new ConfigClientError(
    'INTERNAL',
    'admin_config_get_secret returned an unexpected payload shape',
  );
}

/**
 * Read the version history for a single key via direct SELECT against
 * `tournament_config_versions`. RLS (`tournament_config_versions_admin_read`)
 * enforces admin-only access; non-admin callers will receive an empty list.
 *
 * Ordered by `created_at DESC` (newest first), with limit + offset
 * pagination (defaults: limit=50, offset=0).
 *
 * NOTE: T017 explicitly calls for a direct SELECT here rather than the
 * `config_version_history` RPC; the RPC remains the preferred surface for
 * cross-key timelines (it adds pagination + ORDER BY version_id DESC), but
 * for per-key views the direct SELECT keeps the wrapper trivially typed.
 *
 * Surfaces postgrest's `error.code` unchanged via {@link ConfigClientError}.
 */
export async function configVersionHistory(
  supabase: SupabaseClient,
  params: ConfigVersionHistoryParams,
): Promise<ConfigVersion[]> {
  const validated = VersionHistoryParamsSchema.parse(params);
  const limit = validated.limit ?? 50;
  const offset = validated.offset ?? 0;

  const { data, error } = await supabase
    .from('tournament_config_versions')
    .select(
      'version_id,key,previous_value,new_value,change_kind,actor,reason,source_citation,audit_log_id,parent_version_id,acknowledge_token_used,created_at',
    )
    .eq('key', validated.key)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  return (data ?? []).map((row: unknown) => ConfigVersionSchema.parse(row));
}

/**
 * Wraps `admin_config_grant_admin_role(p_participant_id uuid, p_reason text,
 * p_source_citation text)` (slot 0077, T038). Returns the granted
 * participant's id (uuid) on success.
 *
 * Surfaces `error.code` (WCG07, WCG02) via {@link ConfigClientError} —
 * callers map to HTTP per T040's contract (WCG07→403, WCG02→400).
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin role wrappers
 * @see apps/web/app/api/admin/config/grant-admin-role/route.ts
 */
export async function configGrantAdminRole(
  supabase: SupabaseClient,
  params: ConfigGrantAdminRoleParams,
): Promise<string> {
  const validated = GrantAdminRoleParamsSchema.parse(params);

  const { data, error } = await supabase.rpc('admin_config_grant_admin_role', {
    p_participant_id: validated.participant_id,
    p_reason: validated.reason,
    p_source_citation: validated.source_citation,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }

  // RPC returns uuid (the granted participant_id, echoed). Surface as string
  // regardless of how postgrest serialised it.
  return typeof data === 'string' ? data : String(data ?? validated.participant_id);
}

/**
 * Wraps `admin_config_revoke_admin_role(p_participant_id uuid, p_reason text,
 * p_source_citation text)` (slot 0077, T038). Returns void.
 *
 * Surfaces `error.code` (WCG07, WCG02, WCG03) via {@link ConfigClientError}
 * — callers map to HTTP per T040 (WCG07→403, WCG02→400, WCG03→404).
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin role wrappers
 * @see apps/web/app/api/admin/config/revoke-admin-role/route.ts
 */
export async function configRevokeAdminRole(
  supabase: SupabaseClient,
  params: ConfigRevokeAdminRoleParams,
): Promise<void> {
  const validated = RevokeAdminRoleParamsSchema.parse(params);

  const { error } = await supabase.rpc('admin_config_revoke_admin_role', {
    p_participant_id: validated.participant_id,
    p_reason: validated.reason,
    p_source_citation: validated.source_citation,
  });

  if (error) {
    throw new ConfigClientError(error.code ?? 'INTERNAL', error.message);
  }
}

/**
 * NOTE: a browser-side `searchParticipants` wrapper is intentionally NOT
 * exported here — this module is `server-only` (line 1). The client editor
 * for /admin/config/admin-roles (T040) inlines a `fetch('/api/admin/...')`
 * call instead, mirroring the inline-fetch pattern in ScoringEditor /
 * ProvidersEditor / LockingEditor. The matching wire types
 * (`ParticipantsSearchParams`, `ParticipantsSearchResult`) live here and are
 * imported via `import type` from the client file.
 */
