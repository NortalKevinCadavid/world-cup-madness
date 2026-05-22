'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Client island for the leaderboard page — Slice 005 (T031), US3.
 *
 * Subscribes to Supabase Realtime `postgres_changes` on the single
 * `tournament_config` row whose `key='current_calculation_version'`. Each
 * UPDATE event fires `router.refresh()`, which re-runs the server component
 * tree and re-reads `leaderboard_v` (the view's WHERE clause is now scoped
 * to the new calculation_version pointer).
 *
 * Per leaderboard.read.md § Realtime hint + spec FR-011 / SC-005, this is
 * the canonical UX path for "leaderboard reflects scoring runs within ~1
 * second of completion". We MUST NOT compute or cache ranking client-side
 * (Constitution Principle III) — this component is purely an invalidation
 * trigger.
 *
 * Renders nothing. The parent `<LeaderboardPage>` owns all visible DOM.
 *
 * Implementation notes:
 *   - `createBrowserClient` from `@supabase/ssr` is the cookie-aware
 *     browser-side flavor; using it keeps the user's JWT (set by the SSR
 *     callback flow) attached so RLS still applies to Realtime payloads.
 *   - The channel name is namespaced (`leaderboard-version`) so it doesn't
 *     collide with other slices' subscriptions.
 *   - The `filter` clause uses PostgREST-style equality:
 *       `key=eq.current_calculation_version`
 *     Supabase Realtime forwards only rows that match this filter.
 *   - Cleanup unsubscribes the channel on unmount. We also wrap the channel
 *     reference in a `useRef` so React's strict-mode double-invocation
 *     doesn't leave a dangling subscription in dev.
 */
export interface LeaderboardRefresherProps {
  /**
   * Last-rendered calculation_version. Surfaced as a dependency so a
   * `router.refresh()` that materially changes the version reseats the
   * subscription against the new server state. The actual filter doesn't
   * use this value — it's purely a hook trigger.
   */
  currentVersion: number;
}

export function LeaderboardRefresher({
  currentVersion,
}: LeaderboardRefresherProps): null {
  const router = useRouter();
  // Track the live channel so cleanup unsubscribes exactly the one we
  // created, even under React strict-mode double-effect.
  const channelRef = useRef<ReturnType<
    ReturnType<typeof createBrowserClient>['channel']
  > | null>(null);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // If env is missing (build-time or misconfigured preview) we silently
    // bail — the leaderboard still renders, just without auto-refresh.
    if (!url || !anonKey) {
      return;
    }

    const supabase = createBrowserClient(url, anonKey);

    const channel = supabase
      .channel('leaderboard-version')
      .on(
        // The @supabase/realtime-js types accept the literal
        // 'postgres_changes' but the union in the SDK's `on` overload is
        // narrowed to a string-literal type. Cast through `as never` keeps
        // strict tsc happy without dropping out of strict mode.
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tournament_config',
          filter: 'key=eq.current_calculation_version',
        },
        () => {
          // Drop the server component cache and re-render. The new render
          // hits `leaderboard_v` against the updated pointer.
          router.refresh();
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      const live = channelRef.current;
      channelRef.current = null;
      if (live) {
        // `removeChannel` is the documented teardown API; it tolerates
        // an already-disposed channel.
        void supabase.removeChannel(live);
      }
    };
  }, [currentVersion, router]);

  return null;
}
