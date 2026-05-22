import 'server-only';

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { PlayersResponse, TeamsResponse } from './types';

/**
 * Server-side wrappers around the roster read routes introduced by Slice
 * 004 to back the final-predictions picker UI:
 *   - `GET /api/teams`   — thin RLS-gated wrapper over `public.teams`.
 *   - `GET /api/players` — RLS-gated roster with `team_id` / `q` / `limit`
 *                          filters.
 *
 * Pattern mirrors `apps/web/lib/catalog/client.ts` (Slice 002) and
 * `apps/web/lib/predictions/client.ts` (Slice 003): the route handlers are
 * the single source of truth for eligibility + RLS, so these helpers exist
 * purely to keep URL shape and the typed envelopes in one place. They
 * MUST NOT receive or forward the service-role key.
 *
 * The `_client` parameter is the caller-bound Supabase server client. It is
 * unused today (route handlers read the session from cookies via
 * `requireEligible`) but is retained on the signature so:
 *   1. Callers cannot forget to thread an authenticated context through.
 *   2. A future revision can attach the JWT directly without changing the
 *      call sites in the page / RSC tree.
 *
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 */

const ROUTE_TEAMS = '/api/teams';
const ROUTE_PLAYERS = '/api/players';

/**
 * Options accepted by `searchPlayers`. Mirrors the query string of
 * `GET /api/players`:
 *   - `team_id` — restrict to a single team.
 *   - `q`       — case-insensitive substring search across `full_name`
 *                 and `aliases`.
 *   - `limit`   — clamped to `[1, 500]` server side; default 50.
 */
export interface SearchPlayersOptions {
  /** Restrict to players currently assigned to the given team. */
  team_id?: string;
  /** Substring search across `full_name` + `aliases` (case-insensitive). */
  q?: string;
  /** Max rows to return. Server clamps to `[1, 500]`. */
  limit?: number;
}

/**
 * GET the RLS-visible team set. Returns up to ~32 rows (no pagination).
 */
export async function getTeams(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
): Promise<TeamsResponse> {
  const url = new URL(ROUTE_TEAMS, resolveAppBaseUrl());

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...forwardCookieHeader(),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      `GET /api/teams failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as TeamsResponse;
}

/**
 * GET the RLS-visible active-player roster with optional team / search /
 * limit filters. Only players with `removed_at IS NULL` are returned;
 * results are sorted by `full_name` ASC for determinism.
 */
export async function searchPlayers(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
  opts: SearchPlayersOptions = {},
): Promise<PlayersResponse> {
  const url = new URL(ROUTE_PLAYERS, resolveAppBaseUrl());
  if (opts.team_id) url.searchParams.set('team_id', opts.team_id);
  if (opts.q) url.searchParams.set('q', opts.q);
  if (opts.limit !== undefined) {
    url.searchParams.set('limit', String(opts.limit));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...forwardCookieHeader(),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      `GET /api/players failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as PlayersResponse;
}

/**
 * Re-serialize the current request's cookie jar into a `cookie` header so
 * the in-process server→server fetch carries the Supabase session JWT.
 * (`credentials: 'include'` is a browser-fetch concept and has no effect
 * in a Next.js server runtime.)
 */
function forwardCookieHeader(): Record<string, string> {
  const jar = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return jar ? { cookie: jar } : {};
}

/**
 * Resolve the absolute base URL the server should call when fetching its
 * own route handlers. Honours the standard Vercel / Next.js env vars in
 * priority order, falling back to `http://localhost:3000` for local dev.
 * Mirrors the matching helper in the catalog / predictions / final-
 * predictions client modules so all wrappers agree on the resolution
 * order.
 */
function resolveAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}
