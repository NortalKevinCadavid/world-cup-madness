import 'server-only';

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  MePredictionsResponse,
  SubmitPredictionInput,
  SubmitPredictionResponse,
} from './types';

/**
 * Server-side wrappers around the prediction route handlers (T015):
 *   - `POST /api/predictions` (write)
 *   - `GET  /api/me/predictions` (read, active-only)
 *
 * Pattern mirrors `apps/web/lib/catalog/client.ts` (Slice 002): the route
 * handlers are the single source of truth for eligibility + RLS, so these
 * helpers exist purely to keep URL shape and the typed envelope in one
 * place. They MUST NOT receive or forward the service-role key.
 *
 * The `_client` parameter is the caller-bound Supabase server client. It is
 * unused today (the route handler reads the session from cookies via
 * Slice 001's `requireEligible`) but is retained on the signature so:
 *   1. Callers cannot forget to thread an authenticated context through.
 *   2. A future revision can attach the JWT directly without changing the
 *      call sites in the page / RSC tree.
 *
 * @see specs/003-match-predictions/contracts/predictions.write.md
 * @see specs/003-match-predictions/contracts/predictions.read.md
 */

const ROUTE_PREDICTIONS = '/api/predictions';
const ROUTE_ME_PREDICTIONS = '/api/me/predictions';

/**
 * POST a new (or replacement) prediction for the current participant.
 *
 * The route handler is responsible for:
 *   - Eligibility (`requireEligible`).
 *   - Server-side lock check via `public.is_prediction_locked()`.
 *   - Marking any prior active row for `(participant, match)` as
 *     `superseded_at = now()`.
 *
 * @throws Error with the route handler's status + body when the response
 *         is not 2xx. Error normalization (typed `EligibilityError` etc.)
 *         layers in later slices.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function submitPrediction(
  _client: SupabaseClient,
  input: SubmitPredictionInput,
): Promise<SubmitPredictionResponse> {
  const url = new URL(ROUTE_PREDICTIONS, resolveAppBaseUrl());

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...forwardCookieHeader(),
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      `POST /api/predictions failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as SubmitPredictionResponse;
}

/**
 * GET the current participant's active predictions, optionally filtered to
 * a single match. Returns only rows with `superseded_at IS NULL` (history
 * lives in Slice 005's personal-breakdown surface).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getMyPredictions(
  _client: SupabaseClient,
  matchId?: string,
): Promise<MePredictionsResponse> {
  const url = new URL(ROUTE_ME_PREDICTIONS, resolveAppBaseUrl());
  if (matchId) url.searchParams.set('match_id', matchId);

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
      `GET /api/me/predictions failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as MePredictionsResponse;
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
 * Mirrors `apps/web/lib/catalog/client.ts` so both wrappers agree on the
 * resolution order.
 */
function resolveAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}
