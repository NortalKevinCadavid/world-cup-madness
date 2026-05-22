import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AdminRecalcRequest } from './types';

/**
 * Trigger a manual recalculation by POSTing to `/api/admin/recalc`, which
 * (in T025) proxies through to `admin_trigger_recalc(...)` + Slice 005's
 * `score-trigger` Edge Function.
 *
 * The Supabase client is currently unused (T025 will wire the actual proxy
 * route handler); it is kept on the signature so future revisions can switch
 * to a direct `client.rpc('admin_trigger_recalc', ...)` call without
 * touching callers.
 *
 * `baseUrl` defaults to empty (relative path) for browser callers. Server-
 * side callers MUST pass an absolute URL (Next.js does not resolve relative
 * fetch URLs from server components).
 *
 * Throws on any non-2xx response. Returns the freshly-inserted
 * `score_calculation_runs.id` on success.
 *
 * @see specs/006-admin-overrides/contracts/admin-rpcs.write.md § admin_trigger_recalc
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/recalc
 */
export async function triggerRecalc(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
  input: AdminRecalcRequest,
  baseUrl?: string,
): Promise<{ run_id: string }> {
  const url = (baseUrl ?? '') + '/api/admin/recalc';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `triggerRecalc failed: ${res.status} ${JSON.stringify(body)}`,
    );
  }
  return (await res.json()) as { run_id: string };
}

/**
 * Subscribes to Supabase Realtime updates on `score_calculation_runs` for a
 * given `run_id`. Returns an unsubscribe function.
 *
 * Stub for T014 — T025 wires the actual `postgres_changes` subscription. The
 * stub returns a no-op unsubscribe so callers can use it in `useEffect`
 * cleanup paths without conditional branches.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/recalc
 */
export function subscribeRecalcStatus(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _runId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _onUpdate: (status: string) => void,
): () => void {
  // T025 will implement: client.channel(`run:${_runId}`).on('postgres_changes',
  //   { event: 'UPDATE', schema: 'public', table: 'score_calculation_runs',
  //     filter: `id=eq.${_runId}` }, payload => _onUpdate(payload.new.status))
  //   .subscribe(); return () => client.removeChannel(...).
  return () => {};
}
