import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';
import type {
  Match,
  MatchResult,
  MatchStage,
  MatchStatus,
  ResultStatus,
  Team,
} from '../../../lib/types/match';

/**
 * `GET /api/matches` — Match catalog read.
 *
 * Slice 002 (Phase 3, US1). Source of truth:
 * `specs/002-match-catalog/contracts/match-catalog.read.md`.
 *
 * Behaviour summary:
 *  - Query params are validated BEFORE eligibility check (avoids timing leak
 *    between "eligible but bad params" and "not eligible").
 *  - `requireEligible()` (Slice 001) gates the auth + eligibility check and
 *    writes the `access.denied` audit row for the 403 path.
 *  - The matches query runs through the user-JWT-bound Supabase client so
 *    `matches_eligible_read` / `match_results_eligible_read` / `teams_eligible_read`
 *    RLS policies apply on every read.
 *  - Response envelopes match `/api/me` byte-for-byte on the error paths.
 *  - `Cache-Control: private, max-age=10, must-revalidate` on the 200 path
 *    (per-user; brief client cache). All denial paths use `max-age=0` so an
 *    eligibility flip mid-session takes effect immediately.
 *
 * Field-name mapping (see D-007 in tasks.md): the `match_results` table
 * stores `home_score` / `away_score` / `extra_time_*` / `penalty_*` (T005
 * split-column shape per D-006). The contract requires
 * `home_score_official` / `away_score_official` — TS maps these on the way
 * out: `_official = regulation + ET + penalty`, where the `_for_scoring`
 * columns are passed through unchanged because T005 already stores them.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control headers
// ---------------------------------------------------------------------------

const CACHE_CONTROL_DENIAL = 'private, max-age=0, must-revalidate';
const CACHE_CONTROL_OK = 'private, max-age=10, must-revalidate';

// ---------------------------------------------------------------------------
// Error envelopes — must match /api/me byte-for-byte.
// ---------------------------------------------------------------------------

const ERROR_BODIES = {
  UNAUTHENTICATED: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
  DOMAIN_NOT_APPROVED: {
    code: 'DOMAIN_NOT_APPROVED',
    message:
      'This application is restricted to approved Nortal corporate identities.',
  },
  INTERNAL: { code: 'INTERNAL', message: 'Internal server error.' },
} as const;

function errorResponse(
  status: 400 | 401 | 403 | 500,
  code: 'BAD_REQUEST' | keyof typeof ERROR_BODIES,
  message?: string,
): NextResponse {
  const body =
    code === 'BAD_REQUEST'
      ? { error: { code: 'BAD_REQUEST', message: message ?? 'Bad request.' } }
      : { error: ERROR_BODIES[code] };
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': CACHE_CONTROL_DENIAL },
  });
}

// ---------------------------------------------------------------------------
// Enum allow-lists (mirror migrations 0020 + 0021).
// ---------------------------------------------------------------------------

const MATCH_STAGE_VALUES: ReadonlySet<MatchStage> = new Set<MatchStage>([
  'group',
  'r16',
  'qf',
  'sf',
  'final',
  'third_place',
]);

const MATCH_STATUS_VALUES: ReadonlySet<MatchStatus> = new Set<MatchStatus>([
  'scheduled',
  'in_progress',
  'finished',
  'postponed',
  'cancelled',
]);

/**
 * The contract documents `?sort=kickoff_utc_asc` / `kickoff_utc_desc` but
 * `MatchSort` (T019) names the values `kickoff_asc` / `kickoff_desc`. Accept
 * BOTH on the wire — the contract's wire name and the TS-type's short name —
 * mapping to the same internal direction.
 */
const SORT_DIRECTION: Record<string, 'asc' | 'desc'> = {
  kickoff_asc: 'asc',
  kickoff_desc: 'desc',
  kickoff_utc_asc: 'asc',
  kickoff_utc_desc: 'desc',
};

// ---------------------------------------------------------------------------
// Defaults / bounds (per contract § Query parameters)
// ---------------------------------------------------------------------------

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_MIN = 1;
const PAGE_SIZE_MAX = 200;

// ---------------------------------------------------------------------------
// UUID + ISO-8601 regexes (lightweight; full validation happens at the DB).
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIsoUtc(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Must end with Z or an explicit UTC offset (+00:00 / -00:00) — reject
  // bare local timestamps which would silently coerce to the server's TZ.
  return /(Z|[+-]\d{2}:?\d{2})$/.test(value);
}

// ---------------------------------------------------------------------------
// Validated query shape (used downstream by the query builder).
// ---------------------------------------------------------------------------

interface ValidatedQuery {
  stage: MatchStage[] | null;
  group: string[] | null;
  status: MatchStatus[] | null;
  team_id: string[] | null;
  from: string | null;
  to: string | null;
  page: number;
  page_size: number;
  sort: 'asc' | 'desc';
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function parseInteger(raw: string, label: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new BadRequestError(`${label} must be an integer`);
  }
  return Number.parseInt(raw, 10);
}

function parseMulti<T extends string>(
  raw: string,
  allowed: ReadonlySet<T>,
  label: string,
): T[] {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new BadRequestError(`${label} must not be empty`);
  }
  for (const p of parts) {
    if (!allowed.has(p as T)) {
      throw new BadRequestError(
        `${label} value "${p}" is not in the allowed enum`,
      );
    }
  }
  return parts as T[];
}

function parseGroupMulti(raw: string): string[] {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new BadRequestError('group must not be empty');
  }
  for (const p of parts) {
    if (!/^[A-L]$/.test(p)) {
      throw new BadRequestError(`group value "${p}" must be one of A..L`);
    }
  }
  return parts;
}

function parseTeamIdMulti(raw: string): string[] {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new BadRequestError('team_id must not be empty');
  }
  for (const p of parts) {
    if (!UUID_RE.test(p)) {
      throw new BadRequestError(`team_id value "${p}" must be a UUID`);
    }
  }
  return parts;
}

function validateQuery(url: URL): ValidatedQuery {
  const sp = url.searchParams;

  const stageRaw = sp.get('stage');
  const groupRaw = sp.get('group');
  const statusRaw = sp.get('status');
  const teamRaw = sp.get('team_id');
  const fromRaw = sp.get('from');
  const toRaw = sp.get('to');
  const pageRaw = sp.get('page');
  const pageSizeRaw = sp.get('page_size');
  const sortRaw = sp.get('sort');

  const stage = stageRaw
    ? parseMulti<MatchStage>(stageRaw, MATCH_STAGE_VALUES, 'stage')
    : null;
  const group = groupRaw ? parseGroupMulti(groupRaw) : null;
  const status = statusRaw
    ? parseMulti<MatchStatus>(statusRaw, MATCH_STATUS_VALUES, 'status')
    : null;
  const team_id = teamRaw ? parseTeamIdMulti(teamRaw) : null;

  let from: string | null = null;
  if (fromRaw) {
    if (!isIsoUtc(fromRaw)) {
      throw new BadRequestError('from must be an ISO-8601 UTC timestamp');
    }
    from = fromRaw;
  }
  let to: string | null = null;
  if (toRaw) {
    if (!isIsoUtc(toRaw)) {
      throw new BadRequestError('to must be an ISO-8601 UTC timestamp');
    }
    to = toRaw;
  }
  if (from !== null && to !== null) {
    if (Date.parse(from) > Date.parse(to)) {
      throw new BadRequestError('from must be <= to (window inverted)');
    }
  }

  let page = DEFAULT_PAGE;
  if (pageRaw !== null) {
    const parsed = parseInteger(pageRaw, 'page');
    if (parsed < 1) {
      throw new BadRequestError('page must be >= 1');
    }
    page = parsed;
  }

  let page_size = DEFAULT_PAGE_SIZE;
  if (pageSizeRaw !== null) {
    const parsed = parseInteger(pageSizeRaw, 'page_size');
    if (parsed < PAGE_SIZE_MIN || parsed > PAGE_SIZE_MAX) {
      throw new BadRequestError(
        `page_size must be between ${PAGE_SIZE_MIN} and ${PAGE_SIZE_MAX}`,
      );
    }
    page_size = parsed;
  }

  let sort: 'asc' | 'desc' = 'asc';
  if (sortRaw !== null) {
    const direction = SORT_DIRECTION[sortRaw];
    if (!direction) {
      throw new BadRequestError(
        `sort value "${sortRaw}" is not in the allowed enum`,
      );
    }
    sort = direction;
  }

  return {
    stage,
    group,
    status,
    team_id,
    from,
    to,
    page,
    page_size,
    sort,
  };
}

// ---------------------------------------------------------------------------
// Session-bound Supabase client (mirrors requireEligible.ts).
// Re-created locally because requireEligible.ts intentionally keeps its
// helper private. This client uses the SAME cookies + anon key, so RLS is
// enforced against the caller's JWT.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new EligibilityError(
      'internal',
      'Supabase environment variables are not configured.',
    );
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only: cookie refresh is owned by the middleware.
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Row shapes returned by Supabase's PostgREST select with embedded joins.
// PostgREST returns embedded foreign-key targets as arrays when the FK is
// composite or when multiple rows could match, and as a single object (or
// null) when the FK is unique. The two team embeds are 1:1 (FK to teams.id)
// so PostgREST returns objects; match_results is 1:1 on match_id (PK) so it
// also returns an object (or null when absent).
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

interface MatchResultRow {
  home_score: number;
  away_score: number;
  extra_time_home_score: number | null;
  extra_time_away_score: number | null;
  penalty_home_score: number | null;
  penalty_away_score: number | null;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status: string;
  recorded_at: string | null;
}

interface MatchRow {
  id: string;
  stage: MatchStage;
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: MatchStatus;
  home_team: TeamRow | TeamRow[] | null;
  away_team: TeamRow | TeamRow[] | null;
  match_results: MatchResultRow | MatchResultRow[] | null;
}

/**
 * PostgREST's TypeScript surface declares embedded foreign-key joins as
 * arrays when the cardinality is ambiguous to the client schema. The actual
 * runtime payload for these embeds is a single object (1:1 FK relationship)
 * or null. Normalize defensively to keep TS happy under strict mode.
 */
function unwrapOne<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? (value[0] ?? null) : null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Map DB result-status (singular `penalty_shootout`) to the contract's
// (plural `penalties_shootout`). All other values pass through.
// ---------------------------------------------------------------------------

function mapResultStatus(raw: string): ResultStatus {
  switch (raw) {
    case 'regulation':
      return 'regulation';
    case 'extra_time':
      return 'extra_time';
    case 'penalty_shootout':
    case 'penalties_shootout':
      return 'penalties_shootout';
    default:
      // 'walkover' / 'no_result' / unknown — surface as regulation so the
      // wire type stays valid; the contract example only mentions the three
      // canonical statuses. Slice 005 will reconcile this if it ships
      // walkover handling.
      return 'regulation';
  }
}

// ---------------------------------------------------------------------------
// Convert a DB MatchRow to the contract's Match shape.
// ---------------------------------------------------------------------------

function projectMatchResult(
  row: MatchResultRow | null,
  status: MatchStatus,
): MatchResult | null {
  // The contract: match_result is null unless status === 'finished'.
  if (status !== 'finished' || row === null) return null;

  const home_score_official =
    row.home_score +
    (row.extra_time_home_score ?? 0) +
    (row.penalty_home_score ?? 0);
  const away_score_official =
    row.away_score +
    (row.extra_time_away_score ?? 0) +
    (row.penalty_away_score ?? 0);

  return {
    home_score_official,
    away_score_official,
    home_score_for_scoring: row.home_score_for_scoring,
    away_score_for_scoring: row.away_score_for_scoring,
    result_status: mapResultStatus(row.result_status),
    approved_at: row.recorded_at,
  };
}

function projectTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    short_code: row.short_code,
    flag_url: row.flag_url,
  };
}

function projectMatch(row: MatchRow): Match | null {
  const home = unwrapOne(row.home_team);
  const away = unwrapOne(row.away_team);
  if (home === null || away === null) {
    // Should be impossible: home_team_id / away_team_id are NOT NULL FKs.
    // Skip the row defensively rather than throwing — a missing team would
    // indicate either RLS denying the team read (would be surprising; the
    // teams policy is the same as matches) or a corrupt row.
    return null;
  }
  const matchResultRow = unwrapOne(row.match_results);
  return {
    id: row.id,
    home_team: projectTeam(home),
    away_team: projectTeam(away),
    stage: row.stage,
    group_id: row.group_id,
    kickoff_utc: row.kickoff_utc,
    venue: row.venue,
    status: row.status,
    match_result: projectMatchResult(matchResultRow, row.status),
  };
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Validate query params FIRST (before eligibility check).
  //    Per contract § Server behavior step 2 — avoids timing leak on
  //    "eligible-but-bad-input" vs "not-eligible".
  // -------------------------------------------------------------------------
  let validated: ValidatedQuery;
  try {
    validated = validateQuery(new URL(request.url));
  } catch (err) {
    if (err instanceof BadRequestError) {
      return errorResponse(400, 'BAD_REQUEST', err.message);
    }
    return errorResponse(500, 'INTERNAL');
  }

  // -------------------------------------------------------------------------
  // 2. Auth + eligibility gate. requireEligible() writes the access.denied
  //    audit row for the 403 paths.
  // -------------------------------------------------------------------------
  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) {
      switch (err.reason) {
        case 'no_session':
          return errorResponse(401, 'UNAUTHENTICATED');
        case 'not_eligible':
        case 'participant_not_provisioned':
          return errorResponse(403, 'DOMAIN_NOT_APPROVED');
        case 'internal':
          return errorResponse(500, 'INTERNAL');
      }
    }
    return errorResponse(500, 'INTERNAL');
  }

  // -------------------------------------------------------------------------
  // 3. Build + run the catalog query through the user-JWT client. RLS
  //    (matches_eligible_read / match_results_eligible_read /
  //    teams_eligible_read) applies automatically.
  // -------------------------------------------------------------------------
  try {
    const supabase = createSessionBoundClient();

    const selectExpression = [
      'id',
      'stage',
      'group_id',
      'kickoff_utc',
      'venue',
      'status',
      'home_team:teams!matches_home_team_id_fkey(id, name, short_code, flag_url)',
      'away_team:teams!matches_away_team_id_fkey(id, name, short_code, flag_url)',
      'match_results(home_score, away_score, extra_time_home_score, extra_time_away_score, penalty_home_score, penalty_away_score, home_score_for_scoring, away_score_for_scoring, result_status, recorded_at)',
    ].join(', ');

    let query = supabase
      .from('matches')
      .select(selectExpression, { count: 'exact' });

    if (validated.stage !== null) {
      query = query.in('stage', validated.stage);
    }
    if (validated.group !== null) {
      query = query.in('group_id', validated.group);
    }
    if (validated.status !== null) {
      query = query.in('status', validated.status);
    }
    if (validated.team_id !== null) {
      // home_team_id IN (...) OR away_team_id IN (...)
      const csv = validated.team_id.map((id) => `"${id}"`).join(',');
      query = query.or(
        `home_team_id.in.(${csv}),away_team_id.in.(${csv})`,
      );
    }
    if (validated.from !== null) {
      query = query.gte('kickoff_utc', validated.from);
    }
    if (validated.to !== null) {
      query = query.lt('kickoff_utc', validated.to);
    }

    query = query
      .order('kickoff_utc', { ascending: validated.sort === 'asc' })
      .order('id', { ascending: true });

    const start = (validated.page - 1) * validated.page_size;
    const end = start + validated.page_size - 1;
    query = query.range(start, end);

    const { data, error, count } = await query;
    if (error) {
      return errorResponse(500, 'INTERNAL');
    }

    const rows = (data ?? []) as unknown as MatchRow[];
    const matches: Match[] = [];
    for (const row of rows) {
      const projected = projectMatch(row);
      if (projected !== null) matches.push(projected);
    }

    // ---------------------------------------------------------------------
    // Slice 003 / T031 — populate the additive `lock_state` field via one
    // bulk RPC call (D-015 helper `public.get_lock_states(uuid[])`). This
    // avoids N+1 round trips to is_prediction_locked() and keeps the
    // predicate authoritative (Constitution Principle III — UI does not
    // re-implement the lock decision).
    //
    // If the RPC fails the field is left undefined (clients SHOULD treat
    // missing lock_state as 'editable' per the additive-extension contract
    // — failing closed in the UI would surprise participants who can
    // legitimately submit predictions).
    // ---------------------------------------------------------------------
    if (matches.length > 0) {
      const ids = matches.map((m) => m.id);
      const { data: lockData, error: lockError } = await supabase.rpc(
        'get_lock_states',
        { p_match_ids: ids },
      );
      if (!lockError && Array.isArray(lockData)) {
        const lockByMatch = new Map<string, 'editable' | 'locked'>();
        for (const r of lockData as Array<{ match_id: string; lock_state: string }>) {
          if (r.lock_state === 'locked' || r.lock_state === 'editable') {
            lockByMatch.set(r.match_id, r.lock_state);
          }
        }
        for (const m of matches) {
          const ls = lockByMatch.get(m.id);
          if (ls !== undefined) m.lock_state = ls;
        }
      }
      // If lockError is non-null we deliberately leave lock_state undefined.
    }

    return NextResponse.json(
      {
        matches,
        page: validated.page,
        page_size: validated.page_size,
        total: count ?? matches.length,
      },
      {
        status: 200,
        headers: { 'Cache-Control': CACHE_CONTROL_OK },
      },
    );
  } catch {
    return errorResponse(500, 'INTERNAL');
  }
}
