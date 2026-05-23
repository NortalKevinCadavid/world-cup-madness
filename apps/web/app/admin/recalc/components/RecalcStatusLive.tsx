'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

/**
 * `RecalcStatusLive` — client island that owns the trigger form + the live
 * status subscription for `/admin/recalc`.
 *
 * Slice 006, Phase 4, US2, T025. Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md § /admin/recalc
 *   - specs/006-admin-overrides/contracts/admin-rpcs.write.md § admin_trigger_recalc
 *
 * Behaviour:
 *   1. Renders a form (scope, reason, source_citation) gated by the
 *      `[data-testid="trigger-recalc-button"]` submit.
 *   2. On submit, POSTs to `/api/admin/recalc`. On 2xx the response carries
 *      a `run_id`; the component switches into "watching" mode and opens a
 *      Supabase Realtime `postgres_changes` channel filtered on
 *      `id=eq.<run_id>` against `public.score_calculation_runs`.
 *   3. Each UPDATE payload's `.new.status` is mirrored into
 *      `[data-testid="recalc-status-value"]`. When status reaches a terminal
 *      state ('succeeded' | 'failed'), the component triggers a server
 *      component refresh via `router.refresh()` so the "Recent runs" list
 *      (rendered server-side on `/admin/recalc/page.tsx`) re-fetches and
 *      reflects the freshly-completed run.
 *   4. Non-2xx responses surface an inline error in
 *      `[data-testid="recalc-error"]`. The 409 (WAR06) message matches the
 *      locked test contract `/concurrent|in flight|already.*running/i`.
 *
 * DOM contract (locked, from T019 Playwright specs):
 *   - `[data-testid="recalc-status-live"]`         — wrapper
 *   - `[data-testid="trigger-recalc-button"]`      — submit button
 *   - `[data-testid="recalc-error"]`               — error region (role=alert)
 *   - `[data-testid="recalc-run-id"]`              — just-triggered run_id
 *   - `[data-testid="recalc-status-value"]`        — live status text
 *
 * Realtime + RLS:
 *   `createBrowserClient` from `@supabase/ssr` is the cookie-aware browser
 *   flavor; using it keeps the user's JWT attached so RLS still applies to
 *   Realtime payloads — non-admins would see nothing on the channel even
 *   if they had the run_id (slice 005 RLS on `score_calculation_runs` is
 *   admin-scoped). The leaderboard refresher in slice 005 follows the same
 *   pattern (see `app/(participant)/leaderboard/components/LeaderboardRefresher.tsx`).
 *
 * Constitution Principle III: NO scoring math here — the component only
 * mirrors the DB's status field and triggers a server refetch on terminal
 * transitions.
 */
type Scope = 'all' | 'match' | 'finals';

interface RecalcErrorEnvelope {
  code?: string;
  reason?: string;
  message?: string;
  field?: string;
}

interface RecalcResponseBody {
  run_id?: string;
  error?: RecalcErrorEnvelope;
}

// The terminal states that should re-fetch the server component tree.
const TERMINAL_STATUSES = new Set(['succeeded', 'failed']);

export function RecalcStatusLive(): JSX.Element {
  const router = useRouter();
  const [submitting, startTransition] = useTransition();

  // Form state.
  const [scope, setScope] = useState<Scope>('all');
  const [reason, setReason] = useState<string>('');
  const [sourceCitation, setSourceCitation] = useState<string>('');

  // Result state.
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the live channel so cleanup unsubscribes exactly the one we
  // created, even under React strict-mode double-effect.
  const supabaseRef = useRef<ReturnType<typeof createBrowserClient> | null>(
    null,
  );
  const channelRef = useRef<ReturnType<
    ReturnType<typeof createBrowserClient>['channel']
  > | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      const live = channelRef.current;
      const client = supabaseRef.current;
      channelRef.current = null;
      if (live && client) {
        void client.removeChannel(live);
      }
    };
  }, []);

  /**
   * Open (or re-open) a postgres_changes subscription on the given run_id.
   * The filter is PostgREST-style equality, exactly as documented for
   * Supabase Realtime.
   */
  function subscribeToRun(runIdToWatch: string): void {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      // Misconfigured env — silently bail. The status display still renders
      // its initial 'running' (or whatever the server response carried).
      return;
    }

    // Tear down any previous subscription before opening a new one.
    const prevChannel = channelRef.current;
    const prevClient = supabaseRef.current;
    if (prevChannel && prevClient) {
      void prevClient.removeChannel(prevChannel);
      channelRef.current = null;
    }

    const supabase = createBrowserClient(url, anonKey);
    supabaseRef.current = supabase;

    const channel = supabase
      .channel(`recalc-status-${runIdToWatch}`)
      .on(
        // The @supabase/realtime-js types accept the literal
        // 'postgres_changes' but the union in the SDK's `on` overload is
        // narrowed to a string-literal type. Cast through `as never` keeps
        // strict tsc happy without dropping out of strict mode.
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'score_calculation_runs',
          filter: `id=eq.${runIdToWatch}`,
        },
        (payload: { new?: { status?: string } }) => {
          const next = payload?.new?.status;
          if (typeof next === 'string') {
            setStatus(next);
            if (TERMINAL_STATUSES.has(next)) {
              // Reseat the "Recent runs" server fetch.
              router.refresh();
            }
          }
        },
      )
      .subscribe();

    channelRef.current = channel;
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    setStatus(null);
    setRunId(null);

    startTransition(async () => {
      const trimmedReason = reason.trim();
      const trimmedCitation = sourceCitation.trim();
      let res: Response;
      try {
        res = await fetch('/api/admin/recalc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            scope,
            reason: trimmedReason,
            source_citation: trimmedCitation.length > 0 ? trimmedCitation : null,
          }),
        });
      } catch (networkErr) {
        const msg =
          networkErr instanceof Error
            ? networkErr.message
            : 'Network error';
        setError(`Failed to trigger recalc: ${msg}`);
        return;
      }

      let body: RecalcResponseBody = {};
      try {
        body = (await res.json()) as RecalcResponseBody;
      } catch {
        // Body was not JSON.
      }

      if (!res.ok) {
        const msg =
          body.error?.message ??
          body.error?.reason ??
          body.error?.code ??
          `Request failed with status ${res.status}`;
        setError(msg);
        return;
      }

      const id = body.run_id;
      if (!id) {
        setError('Recalc triggered but no run_id was returned.');
        return;
      }

      setRunId(id);
      // The SP INSERTs the row with status='running' before returning, so
      // we initialize the display before the first Realtime UPDATE.
      setStatus('running');
      subscribeToRun(id);
      // Refresh the server tree so the "Recent runs" list picks up the
      // newly-inserted 'running' row immediately.
      router.refresh();
    });
  }

  return (
    <section
      data-testid="recalc-status-live"
      className="rounded-lg border border-border bg-card p-6 flex flex-col gap-4"
    >
      <header>
        <h2 className="text-lg font-semibold text-foreground">
          Trigger a recalculation
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reason is required and is written to the audit log. Source citation
          is optional but recommended when the trigger follows an external
          decision.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        data-testid="recalc-form"
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">Scope</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as Scope)}
            className="rounded border border-border bg-card px-2 py-2 text-sm"
            data-testid="recalc-scope-select"
          >
            <option value="all">All (full tournament)</option>
            <option value="match">Match (target_id required)</option>
            <option value="finals">Finals</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">Reason</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            required
            data-testid="recalc-reason-input"
            className="rounded border border-border bg-card px-2 py-2 text-sm"
            placeholder="Why is this recalculation needed?"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">
            Source citation (optional)
          </span>
          <input
            value={sourceCitation}
            onChange={(e) => setSourceCitation(e.target.value)}
            data-testid="recalc-source-citation-input"
            className="rounded border border-border bg-card px-2 py-2 text-sm"
            placeholder="e.g. FIFA bulletin URL"
          />
        </label>

        <div>
          <button
            type="submit"
            disabled={submitting}
            data-testid="trigger-recalc-button"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Triggering…' : 'Trigger Full Recalc'}
          </button>
        </div>

        {error ? (
          <div
            data-testid="recalc-error"
            role="alert"
            aria-live="polite"
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}
      </form>

      {runId ? (
        <div className="rounded border border-border bg-muted/30 p-3 text-sm">
          <p>
            Run ID:{' '}
            <span
              data-testid="recalc-run-id"
              className="font-mono text-xs text-foreground"
            >
              {runId}
            </span>
          </p>
          <p className="mt-1">
            Status:{' '}
            <span
              data-testid="recalc-status-value"
              className="font-mono text-xs text-foreground"
            >
              {status ?? 'pending'}
            </span>
          </p>
        </div>
      ) : null}
    </section>
  );
}
