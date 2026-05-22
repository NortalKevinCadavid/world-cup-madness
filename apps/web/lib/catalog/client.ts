import 'server-only';

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { MatchFilters, MatchesPage } from '../types/match';

/**
 * Server-side wrapper around `GET /api/matches`. Server components and
 * route handlers call this helper instead of building fetch URLs by hand
 * so the query-string shape stays in one place and the typed
 * `MatchesPage` envelope is preserved end-to-end.
 *
 * Slice 002 minimum: this is the thin happy-path wrapper. It does NOT
 * implement filtering or pagination in TypeScript — the route handler
 * (T020) + Postgres own that logic. Error normalization (401 / 403 / 400
 * → typed error) layers in later slices as the consumer set grows.
 *
 * The `client` parameter is the caller-bound Supabase client (slice 001
 * `createServerClient` flavor). It is currently used only to derive the
 * base URL of the running app — the route handler reads the session
 * itself from cookies via `requireEligible` — but is kept on the
 * signature so callers cannot forget to thread an authenticated context
 * through, and so a future revision can attach the JWT directly.
 *
 * SECURITY: this helper MUST NOT receive or forward the service-role
 * key. Eligibility is enforced inside the route handler against the
 * caller's own JWT (slice 001's `requireEligible`).
 *
 * @see specs/002-match-catalog/contracts/match-catalog.read.md
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getMatches(
  _client: SupabaseClient,
  filters: MatchFilters = {},
): Promise<MatchesPage> {
  const base = resolveAppBaseUrl();
  const url = new URL('/api/matches', base);
  applyFilters(url.searchParams, filters);

  // Node's `fetch` from a server component does NOT automatically forward
  // the incoming request's cookies, so the route handler would see an
  // unauthenticated request and return 401. Re-serialize the cookie jar
  // from `next/headers` so the route handler can read the Supabase
  // session JWT just like a browser-originated request. This is safe in
  // a Next.js server component / route handler context where `cookies()`
  // resolves to the current request's jar.
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    // Server-to-server fetch in the same Next.js process. We deliberately
    // do NOT pass `credentials: 'include'` because that flag applies to
    // browser fetch semantics only; instead we forward the cookie header
    // explicitly above.
    cache: 'no-store',
  });

  if (!response.ok) {
    // Slice 002 minimum: surface a typed Error. Richer error
    // taxonomization (`EligibilityError`-style) lands when slice 003+
    // consume this helper.
    throw new Error(
      `GET /api/matches failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as MatchesPage;
}

/**
 * Resolve the absolute base URL the server should call when fetching its
 * own route handlers. Honours the standard Vercel / Next.js env vars in
 * priority order, falling back to `http://localhost:3000` for local dev.
 */
function resolveAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}

/**
 * Apply `MatchFilters` to a `URLSearchParams` instance using the
 * comma-separated convention documented in the contract (e.g.
 * `?stage=group,r16`). Undefined / empty fields are skipped — the route
 * handler treats absent params as "no filter".
 */
function applyFilters(
  params: URLSearchParams,
  filters: MatchFilters,
): void {
  appendMulti(params, 'stage', filters.stage);
  appendMulti(params, 'status', filters.status);
  if (filters.group) params.set('group', filters.group);
  if (filters.team_id) params.set('team_id', filters.team_id);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.page !== undefined) params.set('page', String(filters.page));
  if (filters.page_size !== undefined) {
    params.set('page_size', String(filters.page_size));
  }
  if (filters.sort) params.set('sort', filters.sort);
}

function appendMulti(
  params: URLSearchParams,
  key: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    params.set(key, value.join(','));
    return;
  }
  params.set(key, value);
}
