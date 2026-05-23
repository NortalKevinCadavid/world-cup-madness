import 'server-only';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { EligibilityError } from '../../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../../lib/auth/getCurrentParticipant';
import { getLeaderboard } from '../../../lib/scoring/leaderboard';

import { LeaderboardRefresher } from './components/LeaderboardRefresher';
import { LeaderboardClient } from './LeaderboardClient';

/**
 * Participant leaderboard page — Slice 005 (T031), US3.
 *
 * Server component. Pattern mirrors slice 004's `/me/finals` page:
 *   1. Build a cookie-bound (anon-key) Supabase client. RLS on
 *      `leaderboard_v` (security_invoker=true) flows through the user's JWT
 *      so non-Nortal-domain identities see zero rows. NEVER service-role.
 *   2. Call `getCurrentParticipant()` (Slice 001) for eligibility. On any
 *      `EligibilityError` redirect to `/auth/denied`. The participant-area
 *      layout already runs the same gate so this is defence in depth.
 *   3. Call `getLeaderboard(client)` (T030) which reads `leaderboard_v` and
 *      returns `{ leaderboard, calculation_version }`. The view owns:
 *        - §7.4 tier ordering (total → exact → outcome → final).
 *        - RANK() shared-rank pattern (R-004 "1, 2, 2, 4").
 *        - calculation_version filtering (R-003 reader pointer).
 *        - display_name masking per FR-014.
 *      Constitution Principle III: NO ranking or scoring math in TypeScript.
 *   4. Render a table with one row per participant. Every row carries the
 *      `data-testid="leaderboard-row"` + `data-rank` + `data-participant-id`
 *      contract that Playwright (T022) asserts against, and each cell
 *      carries a `data-field="<column>"` attribute matching the column
 *      names that the test reads (`total_points`, `exact_count`,
 *      `outcome_count`, `final_points`).
 *   5. Mount a client island (`<LeaderboardRefresher>`) that subscribes to
 *      Realtime postgres_changes on
 *      `tournament_config.current_calculation_version` and calls
 *      `router.refresh()` on each change so the next render picks up the
 *      new calculation_version (FR-011, SC-005).
 *
 * @see specs/005-scoring-leaderboard/spec.md § US3
 * @see specs/005-scoring-leaderboard/contracts/leaderboard.read.md
 * @see apps/web/tests/playwright/slice-005-leaderboard.spec.ts (T022)
 */

// Force dynamic — cookies + per-user data make this non-cacheable, and
// without this Next's static-render pass would call `cookies()` outside a
// request context and crash.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Mirror of slice 003 / 004's session-bound client builder. The leaderboard
 * read flows through this anon-key + cookie-bound `SupabaseClient` so RLS on
 * `leaderboard_v` is enforced by the user's JWT. We tolerate missing env so
 * the Next.js build phase (which calls server components with no request
 * context) doesn't throw before the layout's eligibility gate has a chance
 * to redirect.
 */
function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return createServerClient('http://localhost', 'placeholder', {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {
          /* noop */
        },
      },
    });
  }
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        /* read-only: middleware refreshes cookies */
      },
    },
  });
}

export default async function LeaderboardPage() {
  // ----- 1. Eligibility gate ------------------------------------------------
  let me: Awaited<ReturnType<typeof getCurrentParticipant>>;
  try {
    me = await getCurrentParticipant();
  } catch (err) {
    if (err instanceof EligibilityError) {
      redirect('/auth/denied');
    }
    throw err;
  }

  // ----- 2. Session-bound Supabase client + leaderboard read ----------------
  const supabase = createSessionBoundClient();
  const { leaderboard, calculation_version } = await getLeaderboard(supabase);

  // The empty/zero state is its own surface per spec § Edge Cases
  // ("leaderboard requested before any matches have finished" → all tied at
  // 0). We STILL render every row in the table because Playwright (T022 Test
  // 7) asserts that 6 rows are visible with rank=1 and totals=0 in that
  // state. The view itself returns those zero-rows; we just add a contextual
  // banner above the table.
  const isEmptyState =
    leaderboard.length === 0 ||
    leaderboard.every((r) => r.total_points === 0);

  return (
    <main
      data-testid="leaderboard-page"
      className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8"
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Leaderboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Standings refresh automatically as matches finish. Ties break by
          exact-result count, then outcome-only count, then final-predictions
          points.
        </p>
        <p
          data-testid="calculation-version-indicator"
          className="text-xs text-muted-foreground"
        >
          Calculation v{calculation_version}
        </p>
      </header>

      {isEmptyState ? (
        <div
          data-testid="leaderboard-empty"
          role="status"
          className="rounded-lg border border-dashed border-border bg-card/50 p-6 text-center text-sm text-muted-foreground"
        >
          The leaderboard will populate once matches finish. Until then, all
          participants are tied at zero.
        </div>
      ) : null}

      <LeaderboardClient rows={leaderboard} currentParticipantId={me.id} />

      {/*
        Client island: subscribes to `tournament_config` postgres_changes
        filtered to key=current_calculation_version and calls
        router.refresh() on each change. Renders nothing visible.
      */}
      <LeaderboardRefresher currentVersion={calculation_version} />
    </main>
  );
}
