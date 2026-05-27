import 'server-only';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
} from '../../../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../../../lib/auth/getCurrentParticipant';
import { getMyFinalPredictions } from '../../../../lib/final-predictions/client';
import { getTeams } from '../../../../lib/roster/client';
import type { FinalPrediction } from '../../../../lib/final-predictions/types';

import { FinalsForm } from './components/FinalsForm';
import { FinalsLockBanner } from './components/FinalsLockBanner';

/**
 * Participant final-predictions page — Slice 004 (T019), US1.
 *
 * Server component. Pattern mirrors slice 003's `/matches` page:
 *   1. Build a cookie-bound (anon-key) Supabase client. The route handlers
 *      we delegate to (`getMyFinalPredictions`, `getTeams`) own the SQL +
 *      RLS — this client only carries the session forward to keep the
 *      typed signatures honest. NEVER service-role.
 *   2. Call `getCurrentParticipant()` (Slice 001) for eligibility. On any
 *      `EligibilityError` redirect to `/auth/denied`. The participant-area
 *      layout already runs the same gate so this is defence in depth.
 *   3. Fetch in parallel:
 *      - `getMyFinalPredictions(client)` → `{ final_predictions, lock_state,
 *        first_kickoff_utc }`
 *      - `getTeams(client)` → `{ teams }`
 *      - For each filled player slot, a single-row server-side fetch of
 *        the player's display name so the picker can show "Lionel Messi"
 *        instead of just a UUID while the popover is closed. We use the
 *        same anon-key client so RLS still applies.
 *   4. Render the lock banner + `<FinalsForm>`. The form handles the four
 *      pickers, submits, and post-submit `router.refresh()`.
 *
 * Lock semantics are NEVER duplicated in JS (Constitution Principle III)
 * — the page passes `lock_state` straight through from the API.
 *
 * @see specs/004-final-predictions/research.md § R-011 (dedicated page)
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 */

// Force dynamic — cookies + per-user data make this non-cacheable, and
// without this Next's static-render pass would call `cookies()` outside
// a request context and crash.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Mirror of slice 003's session-bound client builder. The roster + final-
 * prediction client helpers (`getMyFinalPredictions`, `getTeams`) don't
 * actually query through this `SupabaseClient` instance today — they call
 * the route handlers via `fetch` — but they still demand one on the
 * signature so we keep an authenticated context threaded through. We
 * tolerate missing env so the Next.js build phase (which calls server
 * components with no request context) doesn't throw before the layout's
 * eligibility gate has a chance to redirect.
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

/**
 * Resolve display names for any pre-existing player picks. Returns a map
 * keyed by `players.id`. Only `id + full_name + team_id` are fetched — the
 * full `Player` shape is overkill for the closed-picker label and would
 * pay an extra LEFT JOIN we don't need until the popover opens.
 *
 * RLS-bound through the user's anon client. If the player has been removed
 * since the pick was submitted the row will be filtered out by the
 * `players_eligible_read` policy (or the `removed_at` check used elsewhere
 * in the codebase) and the form falls back to a "Selected player"
 * placeholder per FinalsForm.buildInitialRows.
 */
async function fetchInitialPlayerLabels(
  supabase: ReturnType<typeof createSessionBoundClient>,
  predictions: FinalPrediction[],
): Promise<Record<string, { id: string; full_name: string }>> {
  const ids: string[] = [];
  for (const p of predictions) {
    if (
      (p.item_kind === 'top_scorer' || p.item_kind === 'best_player') &&
      p.target_player_id !== null
    ) {
      ids.push(p.target_player_id);
    }
  }
  if (ids.length === 0) return {};

  const { data, error } = await supabase
    .from('players')
    .select('id, full_name')
    .in('id', ids);

  if (error || !data) {
    // Best-effort: if the lookup fails we fall through with no labels and
    // the form shows the "Selected player" placeholder. The lock banner +
    // form still render — slice 004's player-removed banner (T025) owns
    // the formal "this pick is no longer valid" surface.
    return {};
  }

  const labels: Record<string, { id: string; full_name: string }> = {};
  for (const row of data as Array<{ id: string; full_name: string }>) {
    labels[row.id] = { id: row.id, full_name: row.full_name };
  }
  return labels;
}

export default async function FinalsPage() {
  const t = await getTranslations('Finals');

  // ----- 1. Eligibility gate ------------------------------------------------
  try {
    await getCurrentParticipant();
  } catch (err) {
    if (err instanceof EligibilityError) {
      redirect('/auth/denied');
    }
    throw err;
  }

  // ----- 2. Session-bound Supabase client ----------------------------------
  const supabase = createSessionBoundClient();

  // ----- 3. Parallel fetch: predictions + teams ----------------------------
  const [meResp, teamsResp] = await Promise.all([
    getMyFinalPredictions(supabase),
    getTeams(supabase),
  ]);

  // ----- 4. Pre-load labels for any filled player slots --------------------
  const initialPlayerLabels = await fetchInitialPlayerLabels(
    supabase,
    meResp.final_predictions,
  );

  // ----- 5. Render ---------------------------------------------------------
  return (
    <main
      data-testid="finals-page"
      className="max-w-3xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      <FinalsLockBanner
        firstKickoffUtc={meResp.first_kickoff_utc}
        lockState={meResp.lock_state}
      />

      <FinalsForm
        initialPredictions={meResp.final_predictions}
        teams={teamsResp.teams}
        initialPlayerLabels={initialPlayerLabels}
        lockState={meResp.lock_state}
      />
    </main>
  );
}
