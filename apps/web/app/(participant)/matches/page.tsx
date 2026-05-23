import 'server-only';

import { headers } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { getMatches } from '../../../lib/catalog/client';
import { formatKickoff, formatScore } from '../../../lib/catalog/format';
import { getMyPredictions } from '../../../lib/predictions/client';
import { formatRemainingUntilLock } from '../../../lib/predictions/countdown';
import type { Prediction } from '../../../lib/predictions/types';
import type {
  Match,
  MatchFilters,
  MatchStage,
  MatchStatus,
} from '../../../lib/types/match';

import { MatchListFilters } from './components/MatchListFilters';
import { PaginationControls } from './components/PaginationControls';
import { PredictionForm } from './components/PredictionForm';

/**
 * Display-only lock-window minutes. T016 hardcodes 60 so the countdown
 * label aligns with the default `tournament_config.lock_window_minutes`.
 *
 * TODO(T033, US4 polish): read this from `tournament_config` server-side
 * so a tournament-config change propagates within SC-005's 1-minute
 * budget. The hardcoded value is safe because the server (the SP +
 * `is_prediction_locked()`) is the only authoritative lock decision —
 * this constant only affects what the countdown label says.
 */
const DISPLAY_LOCK_WINDOW_MINUTES = 60;

/**
 * Participant match catalog page — Slice 002 (T021).
 *
 * Server component. Decodes filters + pagination from `searchParams`,
 * calls `getMatches(...)` (which fetches `GET /api/matches` server-side
 * with the caller's session cookies forwarded — see
 * `apps/web/lib/catalog/client.ts`), and renders the resulting list
 * grouped by stage, then sub-grouped by `group_id` for group-stage
 * fixtures, all sorted ascending by `kickoff_utc`.
 *
 * The page never talks to Supabase directly; the route handler owns the
 * eligibility gate (`requireEligible`), the SQL, and the response shape.
 * The participant-area layout (`../layout.tsx`) ALSO runs the eligibility
 * gate so the page is double-protected — and so an eligibility failure
 * redirects to `/auth/denied` before this page even runs.
 *
 * @see specs/002-match-catalog/spec.md § FR-012 and § Clarifications 2026-05-15 Q4
 * @see specs/002-match-catalog/contracts/match-catalog.read.md
 */

// Force dynamic rendering — searchParams + cookies inputs make this
// non-cacheable. Without this, Next.js's static-render pass attempts to
// render with no request context and `cookies()` throws.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STAGE_ORDER: readonly MatchStage[] = [
  'group',
  'r16',
  'qf',
  'sf',
  'final',
  'third_place',
] as const;

const STAGE_LABEL: Record<MatchStage, string> = {
  group: 'Group stage',
  r16: 'Round of 16',
  qf: 'Quarter-finals',
  sf: 'Semi-finals',
  final: 'Final',
  third_place: 'Third-place playoff',
};

const STATUS_LABEL: Record<MatchStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  finished: 'Finished',
  postponed: 'Postponed',
  cancelled: 'Cancelled',
};

// Slice 009 — restyled with semantic tokens. Mapping:
//   scheduled  → muted (neutral)
//   in_progress → open (festive accent — match is live, predictions still need watching)
//   finished   → scored (sky/blue — final result is in)
//   cancelled  → destructive
//   postponed  → muted with destructive-tinted text
const STATUS_PILL_CLASS: Record<MatchStatus, string> = {
  scheduled: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
  in_progress: 'bg-open/15 text-open ring-1 ring-inset ring-open/40',
  finished: 'bg-scored/15 text-scored ring-1 ring-inset ring-scored/40',
  cancelled: 'bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/40',
  postponed: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
};

const VALID_STAGES: ReadonlySet<MatchStage> = new Set(STAGE_ORDER);
const VALID_STATUSES: ReadonlySet<MatchStatus> = new Set<MatchStatus>([
  'scheduled',
  'in_progress',
  'finished',
  'postponed',
  'cancelled',
]);

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseStage(raw: string | undefined): MatchStage | undefined {
  if (!raw) return undefined;
  return VALID_STAGES.has(raw as MatchStage) ? (raw as MatchStage) : undefined;
}

function parseStatus(raw: string | undefined): MatchStatus | undefined {
  if (!raw) return undefined;
  return VALID_STATUSES.has(raw as MatchStatus)
    ? (raw as MatchStatus)
    : undefined;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Decode the URL search params into a typed `MatchFilters`. Invalid
 * values are silently dropped rather than thrown — the route handler is
 * the authoritative validator and returns a 400 on bad input. Dropping
 * here just keeps the UI rendering with whatever the user can still
 * filter on.
 */
function decodeFilters(
  sp: Record<string, string | string[] | undefined> | undefined,
): MatchFilters {
  if (!sp) return {};
  return {
    stage: parseStage(firstString(sp.stage)),
    group: firstString(sp.group),
    status: parseStatus(firstString(sp.status)),
    team_id: firstString(sp.team_id),
    from: firstString(sp.from),
    to: firstString(sp.to),
    page: parsePositiveInt(firstString(sp.page), 1),
    page_size: parsePositiveInt(firstString(sp.page_size), 50),
  };
}

/**
 * Build a session-bound Supabase client purely to satisfy `getMatches`'s
 * signature — the helper does not actually issue queries through it
 * (slice 002 minimum: the route handler owns the SQL). The client carries
 * the caller's cookies in case a future revision attaches the JWT
 * directly. The mirror of this builder lives in `requireEligible.ts`;
 * duplicating it here avoids exporting a server-only primitive.
 */
function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Tolerate missing env in the build phase — `getMatches` does not
  // actually call through this client, and the layout's eligibility
  // gate will have already thrown if the runtime env is wrong.
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
 * Group matches first by stage (in `STAGE_ORDER`), then within each
 * stage by `group_id` (NULL group_ids sort last under a "—" key).
 * Within every leaf bucket the input order is preserved — the route
 * handler returns matches sorted ascending by `kickoff_utc`, so we keep
 * that order verbatim instead of sorting again here.
 */
interface StageBucket {
  stage: MatchStage;
  /** Map of `group_id` (or '__none__' for NULL) → ordered match list. */
  groups: Map<string, Match[]>;
}

function groupMatches(matches: Match[]): StageBucket[] {
  const buckets = new Map<MatchStage, StageBucket>();
  for (const stage of STAGE_ORDER) {
    buckets.set(stage, { stage, groups: new Map() });
  }
  for (const m of matches) {
    const bucket = buckets.get(m.stage);
    if (!bucket) continue; // defensive — unknown stage value
    const key = m.group_id ?? '__none__';
    const list = bucket.groups.get(key);
    if (list) {
      list.push(m);
    } else {
      bucket.groups.set(key, [m]);
    }
  }
  // Drop empty stages so the UI is not littered with empty section
  // headings on filtered views.
  return STAGE_ORDER.map((s) => buckets.get(s) as StageBucket).filter(
    (b) => b.groups.size > 0,
  );
}

/**
 * Sort group-id keys alphabetically (A, B, … L) and float the "no group"
 * bucket to the end. Used for knockout-stage rendering (`group_id` is
 * always NULL there) and for group-stage rendering (where group_id is
 * the letter).
 */
function sortedGroupKeys(groups: Map<string, Match[]>): string[] {
  const keys = Array.from(groups.keys());
  keys.sort((a, b) => {
    if (a === '__none__') return 1;
    if (b === '__none__') return -1;
    return a.localeCompare(b);
  });
  return keys;
}

/**
 * Compute the display lock-state hint for a single match row. Mirrors the
 * Postgres `public.is_prediction_locked()` logic (BR-LOCK-002 strict
 * boundary, BR-LOCK-004 non-scheduled-locks-always) so the UI renders
 * the right control, but is **not** load-bearing: every write goes
 * through the route handler + SP which re-evaluates against the database
 * clock (Constitution Principle VI). If a client-server clock skew or
 * stale render slips an `'editable'` row past the boundary, the server
 * still rejects the POST.
 *
 * TODO(T031, US4): replace this inline computation by reading
 * `Match.lock_state` directly off the API response.
 */
function computeLockState(
  match: Match,
  now: Date,
  lockWindowMinutes: number,
): 'editable' | 'locked' {
  if (match.status !== 'scheduled') return 'locked';
  const kickoffMs = new Date(match.kickoff_utc).getTime();
  const lockBoundaryMs = kickoffMs - lockWindowMinutes * 60_000;
  return now.getTime() >= lockBoundaryMs ? 'locked' : 'editable';
}

export default async function MatchesPage({ searchParams }: PageProps) {
  const filters = decodeFilters(searchParams);
  const locale = headers().get('accept-language')?.split(',')[0]?.trim() || 'en-US';

  const supabase = createSessionBoundClient();
  const [page, myPredictions] = await Promise.all([
    getMatches(supabase, filters),
    getMyPredictions(supabase),
  ]);

  const predictionsByMatch = new Map<string, Prediction>();
  for (const p of myPredictions.predictions) {
    predictionsByMatch.set(p.match_id, p);
  }

  // Single timestamp for every row on this render so countdowns + lock
  // hints agree within the page (no jitter from per-row `new Date()`).
  const renderNow = new Date();

  const stageBuckets = groupMatches(page.matches);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Matches
        </h1>
        <p className="text-sm text-muted-foreground">
          FIFA World Cup 2026 fixtures, grouped by stage. Kickoff times are
          localized to your browser; the canonical schedule remains in UTC.
        </p>
      </header>

      <section
        aria-label="Filters"
        className="rounded-lg border border-border bg-card p-4 shadow-sm"
      >
        <MatchListFilters currentFilters={filters} />
      </section>

      {stageBuckets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
          No matches for the current filters.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {stageBuckets.map((bucket) => (
            <section
              key={bucket.stage}
              aria-labelledby={`stage-${bucket.stage}`}
              className="flex flex-col gap-4"
            >
              <h2
                id={`stage-${bucket.stage}`}
                className="font-display text-lg font-semibold text-foreground"
              >
                {STAGE_LABEL[bucket.stage]}
              </h2>
              {sortedGroupKeys(bucket.groups).map((groupKey) => {
                const rows = bucket.groups.get(groupKey) ?? [];
                const showSubheading =
                  bucket.stage === 'group' && groupKey !== '__none__';
                return (
                  <div key={groupKey} className="flex flex-col gap-2">
                    {showSubheading ? (
                      <h3 className="font-display text-sm font-semibold text-muted-foreground">
                        Group {groupKey}
                      </h3>
                    ) : null}
                    <MatchTable
                      rows={rows}
                      locale={locale}
                      predictionsByMatch={predictionsByMatch}
                      now={renderNow}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      <footer className="border-t border-border pt-4">
        <PaginationControls
          page={page.page}
          page_size={page.page_size}
          total={page.total}
        />
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Match table — pure server-rendered presentation. Kept inline because it is
// trivial and only this page uses it.
// ---------------------------------------------------------------------------

interface MatchTableProps {
  rows: Match[];
  locale: string;
  /** Map of `match_id → active Prediction` for the current participant. */
  predictionsByMatch: Map<string, Prediction>;
  /** Snapshot of "now" used for the lock-state hint + countdown label. */
  now: Date;
}

function MatchTable({ rows, locale, predictionsByMatch, now }: MatchTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Home
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-center font-medium text-muted-foreground"
            >
              Score
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Away
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Kickoff
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Venue
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Status
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-left font-medium text-muted-foreground"
            >
              Your pick
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {rows.map((row) => {
            // Slice 003 / T033 — prefer the server-computed lock_state (added
            // to /api/matches by T031 / migration 0038) over the local client
            // computation. The local computeLockState() is a fallback for the
            // transition window where the server might omit lock_state (e.g.,
            // bulk RPC failure — see D-015 fail-soft contract); per the
            // additive-extension contract, missing lock_state means
            // 'editable'. Constitution Principle III: the *authoritative*
            // lock decision lives in submit_prediction's SP, not here.
            const lockState: 'editable' | 'locked' =
              row.lock_state ??
              computeLockState(row, now, DISPLAY_LOCK_WINDOW_MINUTES);
            const countdownLabel =
              lockState === 'editable'
                ? formatRemainingUntilLock(
                    row.kickoff_utc,
                    DISPLAY_LOCK_WINDOW_MINUTES,
                    now,
                  )
                : undefined;
            const existingPrediction = predictionsByMatch.get(row.id) ?? null;
            return (
              <tr
                key={row.id}
                data-match-id={row.id}
                className="hover:bg-muted/30"
              >
                <td className="px-3 py-2">
                  <TeamCell team={row.home_team} />
                </td>
                <td className="px-3 py-2 text-center font-mono text-foreground">
                  {row.status === 'finished' && row.match_result
                    ? formatScore(row.match_result)
                    : <span className="text-muted-foreground/40" aria-hidden>—</span>}
                </td>
                <td className="px-3 py-2">
                  <TeamCell team={row.away_team} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  <time dateTime={row.kickoff_utc}>
                    {formatKickoff(row.kickoff_utc, locale)}
                  </time>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.venue ?? <span className="text-muted-foreground/60">—</span>}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-3 py-2">
                  <PredictionForm
                    matchId={row.id}
                    existingPrediction={existingPrediction}
                    lockState={lockState}
                    countdownLabel={countdownLabel}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TeamCell({ team }: { team: Match['home_team'] }) {
  return (
    <div className="flex items-center gap-2">
      {team.flag_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={team.flag_url}
          alt=""
          aria-hidden
          width={20}
          height={14}
          className="h-3.5 w-5 rounded-sm border border-border object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="inline-block h-3.5 w-5 rounded-sm border border-dashed border-border bg-muted/30"
        />
      )}
      <span className="font-medium text-foreground">{team.short_code}</span>
      <span className="text-muted-foreground">{team.name}</span>
    </div>
  );
}

function StatusPill({ status }: { status: MatchStatus }) {
  const label = STATUS_LABEL[status];
  return (
    <span
      aria-label={`status: ${status}`}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL_CLASS[status]}`}
    >
      {label}
    </span>
  );
}
