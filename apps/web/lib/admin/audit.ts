import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AdminAuditRow } from './types';

/**
 * Read the admin-action audit log. Returns rows whose `action` starts with
 * `admin.` (slice 006's locked label prefix), newest first, paginated.
 *
 * Caller MUST have already passed `requireAdmin(client)`. RLS on
 * `audit_log` permits the admin role to read these rows; non-admins will
 * receive an empty array (RLS-filtered).
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/audit
 */
export async function getAdminAuditLog(
  client: SupabaseClient,
  opts: { limit?: number; offset?: number } = {},
): Promise<AdminAuditRow[]> {
  const { limit = 50, offset = 0 } = opts;
  const { data, error } = await client
    .from('audit_log')
    .select('*')
    .like('action', 'admin.%')
    .order('occurred_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    throw new Error(`getAdminAuditLog failed: ${error.message}`);
  }
  return (data ?? []) as AdminAuditRow[];
}

/**
 * Fetch a single `audit_log` row by primary key (admin detail page).
 *
 * Returns `null` if no row exists (or RLS-filtered out). Throws on
 * unexpected PostgREST errors.
 */
export async function getAuditDetail(
  client: SupabaseClient,
  id: string,
): Promise<AdminAuditRow | null> {
  const { data, error } = await client
    .from('audit_log')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    throw new Error(`getAuditDetail failed: ${error.message}`);
  }
  return (data as AdminAuditRow | null) ?? null;
}

/**
 * Fetch every `audit_log` row that targets a given entity (e.g. every action
 * against a single match, prediction, or tournament_award item). Newest
 * first; not paginated — entity-scoped logs are typically small.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/matches/[id]
 */
export async function getAuditByTarget(
  client: SupabaseClient,
  entity_type: string,
  entity_id: string,
): Promise<AdminAuditRow[]> {
  const { data, error } = await client
    .from('audit_log')
    .select('*')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('occurred_at', { ascending: false });
  if (error) {
    throw new Error(`getAuditByTarget failed: ${error.message}`);
  }
  return (data ?? []) as AdminAuditRow[];
}
