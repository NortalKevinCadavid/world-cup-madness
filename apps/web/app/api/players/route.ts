import 'server-only';

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';

/**
 * `GET /api/players` — RLS-gated player roster with `team_id` / `q` /
 * `limit` filters for the final-prediction picker UI.
 *
 * Slice 004 (Phase 3, US1, T018). Source of truth:
 *   `specs/004-final-predictions/contracts/final-predictions.read.md`
 *   § Endpoint GET /api/players.
 *
 * Behaviour summary:
 *   - Query params validated BEFORE the eligibility check (per
 *     /api/matches + /api/predictions pattern — avoids timing leak between
 *     "eligible-but-bad-input" and "not eligible").
 *   - `requireEligible()` (Slice 001) gates auth + eligibility; writes the
 *     `access.denied` audit row for the 403 path.
 *   - Only active players (`removed_at IS NULL`) are returned (slice 002
 *     RLS already enforces eligibility-gated read; this filter prunes
 *     soft-deleted rows per Clarifications 2026-05-17 Q1).
 *   - Sorted by `full_name` ASC for deterministic typeahead output.
 *   - `total_matching` is the COUNT before LIMIT, so the picker can render
 *     "and N more" annotations.
 *   - `team_short_code` is LEFT JOINed from `public.teams` so the picker
 *     can display "Messi (ARG)" without a separate teams fetch.
 *   - `Cache-Control: private, max-age=60` — roster is largely static
 *     during the tournament; brief per-user cache reduces typeahead
 *     chatter (per contract § Cache-Control headers).
 *   - NEVER uses the service-role key.
 *
 * Query params:
 *   - `team_id` (optional UUID)            — restrict to one team
 *   - `q`       (optional string ≤ 100)    — full_name substring (ci)
 *   - `limit`   (optional int 1..500, default 100) — page size; OOB → 400
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Cache-Control — 60-second private cache for the success path; denial
// paths revalidate immediately.
// ---------------------------------------------------------------------------

const CACHE_CONTROL_OK = 'private, max-age=60';
const CACHE_CONTROL_DENIAL = 'private, max-age=0, must-revalidate';

// ---------------------------------------------------------------------------
// Defaults / bounds (per contract § Request).
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 100;
const LIMIT_MIN = 1;
const LIMIT_MAX = 500;
const Q_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// UUID regex (lightweight; DB is authoritative).
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Error helpers.
// ---------------------------------------------------------------------------

interface ErrorPayload {
  code: string;
  message: string;
}

function errorResponse(
  status: number,
  payload: ErrorPayload,
  cacheControl: string = CACHE_CONTROL_DENIAL,
): NextResponse {
  return NextResponse.json(
    { error: payload },
    {
      status,
      headers: { 'Cache-Control': cacheControl },
    },
  );
}

const UNAUTHENTICATED_BODY: ErrorPayload = {
  code: 'UNAUTHENTICATED',
  message: 'Sign in to continue.',
};

const DOMAIN_NOT_APPROVED_BODY: ErrorPayload = {
  code: 'DOMAIN_NOT_APPROVED',
  message:
    'This application is restricted to approved Nortal corporate identities.',
};

const INTERNAL_BODY: ErrorPayload = {
  code: 'INTERNAL',
  message: 'Internal server error.',
};

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

// ---------------------------------------------------------------------------
// Query validation.
// ---------------------------------------------------------------------------

interface ValidatedQuery {
  team_id: string | null;
  q: string | null;
  limit: number;
}

function validateQuery(url: URL): ValidatedQuery {
  const sp = url.searchParams;

  // team_id ---------------------------------------------------------------
  let team_id: string | null = null;
  const teamRaw = sp.get('team_id');
  if (teamRaw !== null) {
    if (!UUID_RE.test(teamRaw)) {
      throw new BadRequestError('team_id must be a valid UUID');
    }
    team_id = teamRaw;
  }

  // q ---------------------------------------------------------------------
  let q: string | null = null;
  const qRaw = sp.get('q');
  if (qRaw !== null) {
    const trimmed = qRaw.trim();
    if (trimmed.length > Q_MAX_LENGTH) {
      throw new BadRequestError(
        `q must be ${Q_MAX_LENGTH} characters or fewer after trim`,
      );
    }
    // Empty string after trim → treat as absent rather than rejecting.
    q = trimmed.length > 0 ? trimmed : null;
  }

  // limit -----------------------------------------------------------------
  let limit = DEFAULT_LIMIT;
  const limitRaw = sp.get('limit');
  if (limitRaw !== null) {
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new BadRequestError('limit must be an integer');
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (parsed < LIMIT_MIN || parsed > LIMIT_MAX) {
      throw new BadRequestError(
        `limit must be between ${LIMIT_MIN} and ${LIMIT_MAX}`,
      );
    }
    limit = parsed;
  }

  return { team_id, q, limit };
}

// ---------------------------------------------------------------------------
// Session-bound Supabase client.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only: cookie refresh is owned by middleware.
      },
    },
  });
}

// ---------------------------------------------------------------------------
// PostgREST embedded-team join shape. PostgREST may surface a 1:1 FK as a
// single object or as an array depending on its inference; unwrapOne()
// normalizes defensively (mirrors /api/matches).
// ---------------------------------------------------------------------------

interface TeamEmbed {
  short_code: string;
}

interface PlayerRow {
  id: string;
  full_name: string;
  display_name: string | null;
  team_id: string | null;
  country_code: string | null;
  position: string | null;
  team: TeamEmbed | TeamEmbed[] | null;
}

function unwrapOne<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? (value[0] ?? null) : null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// PostgreSQL ILIKE escaping — the `q` substring may contain `%` or `_`
// metacharacters. Escape them so the user's literal string is matched
// (e.g. `q=50%` searches for the literal "50%" not "anything 50 anything").
// ---------------------------------------------------------------------------

function escapeIlikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// GET handler.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------------
  // 1. Validate query params FIRST. Avoids timing leak between
  //    "eligible-but-bad-input" and "not eligible".
  // -------------------------------------------------------------------------
  let validated: ValidatedQuery;
  try {
    validated = validateQuery(new URL(request.url));
  } catch (err) {
    if (err instanceof BadRequestError) {
      return errorResponse(400, { code: 'BAD_REQUEST', message: err.message });
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 2. Auth + eligibility gate.
  // -------------------------------------------------------------------------
  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) {
      switch (err.reason) {
        case 'no_session':
          return errorResponse(401, UNAUTHENTICATED_BODY);
        case 'not_eligible':
        case 'participant_not_provisioned':
          return errorResponse(403, DOMAIN_NOT_APPROVED_BODY);
        case 'internal':
          return errorResponse(500, INTERNAL_BODY);
      }
    }
    return errorResponse(500, INTERNAL_BODY);
  }

  // -------------------------------------------------------------------------
  // 3. Build the query. RLS-bound; `players_eligible_read` (slot 0042)
  //    gates visibility, this filter prunes removed rows + applies user
  //    filters.
  //
  //    We use { count: 'exact' } so the COUNT runs alongside the SELECT and
  //    populates `total_matching` for the typeahead "and N more" surface.
  //    The COUNT respects every WHERE filter except LIMIT (PostgREST does
  //    not include the range in the count).
  // -------------------------------------------------------------------------
  let supabase: ReturnType<typeof createSessionBoundClient>;
  try {
    supabase = createSessionBoundClient();
  } catch {
    return errorResponse(500, INTERNAL_BODY);
  }

  let query = supabase
    .from('players')
    .select(
      'id, full_name, display_name, team_id, country_code, position, team:teams(short_code)',
      { count: 'exact' },
    )
    .is('removed_at', null);

  if (validated.team_id !== null) {
    query = query.eq('team_id', validated.team_id);
  }
  if (validated.q !== null) {
    // Case-insensitive substring match on full_name. Aliases mentioned in
    // the contract are not present in the slice-004 schema (migration 0039
    // ships only full_name + display_name), so we extend the OR to also
    // cover display_name — a no-op when display_name is NULL.
    const pattern = `%${escapeIlikePattern(validated.q)}%`;
    query = query.or(
      `full_name.ilike.${pattern},display_name.ilike.${pattern}`,
    );
  }

  query = query
    .order('full_name', { ascending: true })
    .range(0, validated.limit - 1);

  const { data, error, count } = await query;
  if (error) {
    return errorResponse(500, INTERNAL_BODY);
  }

  const rows = (data ?? []) as unknown as PlayerRow[];
  const players = rows.map((r) => {
    const team = unwrapOne(r.team);
    return {
      id: r.id,
      full_name: r.full_name,
      display_name: r.display_name,
      team_id: r.team_id,
      team_short_code: team?.short_code ?? null,
      country_code: r.country_code,
      position: r.position,
    };
  });

  return NextResponse.json(
    {
      players,
      total_matching: count ?? players.length,
    },
    {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL_OK },
    },
  );
}
