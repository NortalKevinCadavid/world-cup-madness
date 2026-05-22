import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const AUDIT_SOURCE_VALUES = [
  'auth_hook',
  'rls',
  'api_guard',
  'ui',
  'trigger',
  'admin_rpc',
  'system',
] as const;
export type AuditSource = (typeof AUDIT_SOURCE_VALUES)[number];

export const AuditSearchParamsSchema = z.object({
  actor: z.string().uuid().optional().nullable(),
  entity_type: z.string().optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  action_pattern: z.string().max(200).optional().nullable(),
  source: z.enum(AUDIT_SOURCE_VALUES).optional().nullable(),
  from: z.string().datetime({ offset: true }).optional().nullable(),
  to: z.string().datetime({ offset: true }).optional().nullable(),
  limit: z.number().int().min(1).max(500).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
});
export type AuditSearchParams = z.infer<typeof AuditSearchParamsSchema>;

export const AuditCountParamsSchema = AuditSearchParamsSchema.omit({
  limit: true,
  offset: true,
});
export type AuditCountParams = z.infer<typeof AuditCountParamsSchema>;

export const AuditRowSchema = z.object({
  id: z.string().uuid(),
  // sequence_id is `bigint` in Postgres; postgrest/supabase-js may serialize it
  // as either `number` (when safe) or `string` (when > Number.MAX_SAFE_INTEGER).
  // Normalize to a decimal string for callers.
  sequence_id: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? BigInt(v).toString() : String(v))),
  actor: z.string().uuid().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().uuid().nullable(),
  previous_value: z.unknown().nullable(),
  new_value: z.unknown().nullable(),
  reason: z.string().nullable(),
  source_citation: z.string().nullable(),
  source: z.string(),
  occurred_at: z.string(), // ISO timestamptz
});
export type AuditRow = z.infer<typeof AuditRowSchema>;

/**
 * Error thrown by {@link auditSearch} / {@link countAuditSearch} when the
 * underlying RPC returns a Postgres error. `code` is the raw Postgres
 * ERRCODE (e.g. `WAT01`, `WAT02`, `WAT03`) so callers can branch on it.
 */
export class AuditSearchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuditSearchError';
  }
}

function rpcParams(p: AuditSearchParams) {
  return {
    p_actor: p.actor ?? null,
    p_entity_type: p.entity_type ?? null,
    p_entity_id: p.entity_id ?? null,
    p_action_pattern: p.action_pattern ?? null,
    p_source: p.source ?? null,
    p_from: p.from ?? null,
    p_to: p.to ?? null,
    p_limit: p.limit ?? 50,
    p_offset: p.offset ?? 0,
  };
}

function countRpcParams(p: AuditCountParams) {
  return {
    p_actor: p.actor ?? null,
    p_entity_type: p.entity_type ?? null,
    p_entity_id: p.entity_id ?? null,
    p_action_pattern: p.action_pattern ?? null,
    p_source: p.source ?? null,
    p_from: p.from ?? null,
    p_to: p.to ?? null,
  };
}

/**
 * Calls `public.audit_search(...)` RPC.
 *
 * Surfaces Postgres ERRCODE (`WAT01` admin-only, `WAT02` invalid input,
 * `WAT03` unbounded count) as {@link AuditSearchError.code}; the error
 * message is passed through unchanged.
 *
 * @see specs/007-audit-trail/contracts/audit-search.read.md
 */
export async function auditSearch(
  supabase: SupabaseClient,
  params: AuditSearchParams,
): Promise<AuditRow[]> {
  const validated = AuditSearchParamsSchema.parse(params);
  const { data, error } = await supabase.rpc('audit_search', rpcParams(validated));
  if (error) {
    throw new AuditSearchError(error.code ?? 'INTERNAL', error.message);
  }
  return (data ?? []).map((row: unknown) => AuditRowSchema.parse(row));
}

/**
 * Calls `public.count_audit_search(...)` RPC. Returns the total matching
 * row count for the same filter set (without `limit` / `offset`).
 *
 * Surfaces Postgres ERRCODE the same way as {@link auditSearch}.
 */
export async function countAuditSearch(
  supabase: SupabaseClient,
  params: AuditCountParams,
): Promise<number> {
  const validated = AuditCountParamsSchema.parse(params);
  const { data, error } = await supabase.rpc(
    'count_audit_search',
    countRpcParams(validated),
  );
  if (error) {
    throw new AuditSearchError(error.code ?? 'INTERNAL', error.message);
  }
  return Number(data ?? 0);
}
