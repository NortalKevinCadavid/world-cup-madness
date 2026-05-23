import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { getAuditByTarget } from '../../../lib/admin/audit';

import { AwardCorrectionForm } from './components/AwardCorrectionForm';

/**
 * `/admin/finals` — tournament_award correction page (Slice 006, Phase 5,
 * US3, T031).
 *
 * Server component. The admin gate runs in `app/admin/layout.tsx` (T015);
 * RLS provides defence-in-depth for the data fetches below.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/finals` — tournament_award correction.
 *
 * Server-side data fetches (2 parallel reads):
 *   1. Single `tournament_award` row. Single-tournament posture (matching
 *      slot 0068 `admin_update_tournament_award`'s LIMIT 1 lookup) — we
 *      order by `set_at ASC` and take the first row.
 *   2. Recent `audit_log` rows targeting `entity_type='tournament_award'`.
 *      The slot 0068 SP writes audit rows with that entity_type, so
 *      `getAuditByTarget` is the right helper.
 *
 * The page renders one `AwardCorrectionForm` (client component) that drives
 * all four item kinds via a select; admins choose item_kind + target_id +
 * status + reason + source_citation and submit. The route handler at
 * `/api/admin/tournament-award` does the heavy lifting.
 *
 * Constitution Principle III: NO scoring math in TS — every value rendered
 * here is a pass-through from the DB.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/admin/audit.ts
 * @see apps/web/app/api/admin/tournament-award/route.ts
 * @see apps/web/tests/playwright/slice-006-admin-finals-correct-top-scorer.spec.ts
 * @see apps/web/tests/playwright/slice-006-admin-finals-confirm-pending.spec.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in slice 006's other admin server components. Never uses the
// service-role key.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Build-time / misconfigured env: return a stub so the page can still
    // render. The admin layout would have already redirected to
    // /admin/denied before reaching here under real traffic.
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

interface TournamentAwardRow {
  tournament_id: string;
  champion_team_id: string | null;
  champion_status: string;
  runner_up_team_id: string | null;
  runner_up_status: string;
  top_scorer_player_id: string | null;
  top_scorer_status: string;
  best_player_player_id: string | null;
  best_player_status: string;
  set_at: string | null;
  set_by: string | null;
}

interface AwardSlot {
  label: string;
  kind: 'champion' | 'runner_up' | 'top_scorer' | 'best_player';
  currentId: string | null;
  currentStatus: string;
  idColumnNote: string;
}

function buildSlots(row: TournamentAwardRow | null): AwardSlot[] {
  return [
    {
      label: 'Champion',
      kind: 'champion',
      currentId: row?.champion_team_id ?? null,
      currentStatus: row?.champion_status ?? 'pending',
      idColumnNote: 'team_id',
    },
    {
      label: 'Runner-up',
      kind: 'runner_up',
      currentId: row?.runner_up_team_id ?? null,
      currentStatus: row?.runner_up_status ?? 'pending',
      idColumnNote: 'team_id',
    },
    {
      label: 'Top scorer',
      kind: 'top_scorer',
      currentId: row?.top_scorer_player_id ?? null,
      currentStatus: row?.top_scorer_status ?? 'pending',
      idColumnNote: 'player_id',
    },
    {
      label: 'Best player',
      kind: 'best_player',
      currentId: row?.best_player_player_id ?? null,
      currentStatus: row?.best_player_status ?? 'pending',
      idColumnNote: 'player_id',
    },
  ];
}

export default async function AdminFinalsPage() {
  const supabase = createSessionBoundClient();

  // The single-tournament posture means there's one tournament_award row;
  // ORDER BY set_at ASC + LIMIT 1 is the deterministic lookup matching the
  // SP. The fetch is best-effort: if the row is unavailable (e.g. RLS
  // mis-config in a build sanity render), the page still renders the form
  // with empty current state.
  const awardRes = await supabase
    .from('tournament_award')
    .select(
      'tournament_id,champion_team_id,champion_status,runner_up_team_id,runner_up_status,top_scorer_player_id,top_scorer_status,best_player_player_id,best_player_status,set_at,set_by',
    )
    .order('set_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const award = (awardRes.data as TournamentAwardRow | null) ?? null;

  // Audit history scoped to the tournament_award entity. If the read fails
  // (RLS or missing entity_id), default to an empty array — the form still
  // renders.
  const auditRows = award
    ? await getAuditByTarget(
        supabase,
        'tournament_award',
        award.tournament_id,
      ).catch(() => [])
    : [];

  const slots = buildSlots(award);

  return (
    <main
      data-testid="admin-finals-page"
      className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Tournament awards
        </h1>
        <p className="text-xs font-mono text-muted-foreground">/admin/finals</p>
      </header>

      <section
        data-testid="admin-finals-current-state"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">
          Current awards
        </h2>
        {award ? (
          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {slots.map((slot) => (
              <div
                key={slot.kind}
                data-testid={`admin-finals-slot-${slot.kind}`}
                className="flex flex-col gap-0.5"
              >
                <dt className="font-medium text-foreground">{slot.label}</dt>
                <dd
                  className="font-mono text-xs text-muted-foreground"
                  data-field={`${slot.kind}-id`}
                >
                  {slot.currentId ?? '(not set)'}
                </dd>
                <dd
                  className="text-xs text-muted-foreground"
                  data-field={`${slot.kind}-status`}
                >
                  <span className="uppercase tracking-wide">
                    {slot.currentStatus}
                  </span>
                  <span className="ml-2 text-muted-foreground/60">
                    {slot.idColumnNote}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No tournament_award row found.
          </p>
        )}
      </section>

      <AwardCorrectionForm />

      <section
        data-testid="admin-finals-history"
        className="rounded-lg border border-border bg-card p-6"
      >
        <h2 className="text-lg font-semibold text-foreground">
          Recent award updates
        </h2>
        {auditRows.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No prior admin actions against the tournament awards.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {auditRows.map((row) => (
              <li
                key={row.id}
                data-testid="admin-finals-audit-row"
                className="text-sm text-foreground"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {row.occurred_at}
                </span>
                <span className="ml-2 font-mono text-xs">{row.action}</span>
                {row.reason ? (
                  <span className="ml-2 text-muted-foreground">— {row.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
