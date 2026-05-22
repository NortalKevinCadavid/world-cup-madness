import 'server-only';

import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  MeFinalPredictionsResponse,
  SubmitFinalPredictionInput,
  SubmitFinalPredictionResponse,
} from './types';

/**
 * Server-side wrappers around the final-prediction route handlers (T015):
 *   - `POST /api/final-predictions` (write)
 *   - `GET  /api/me/final-predictions` (read, active-only)
 *
 * Pattern mirrors `apps/web/lib/predictions/client.ts` (Slice 003) and
 * `apps/web/lib/catalog/client.ts` (Slice 002): the route handlers are the
 * single source of truth for eligibility, target-existence checks, and
 * lock semantics, so these helpers exist purely to keep the URL shape and
 * the typed envelope in one place. They MUST NOT receive or forward the
 * service-role key.
 *
 * The `_client` parameter is the caller-bound Supabase server client. It is
 * unused today (the route handler reads the session from cookies via
 * Slice 001's `requireEligible`) but is retained on the signature so:
 *   1. Callers cannot forget to thread an authenticated context through.
 *   2. A future revision can attach the JWT directly without changing the
 *      call sites in the page / RSC tree.
 *
 * @see specs/004-final-predictions/contracts/final-predictions.write.md
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 */

const ROUTE_FINAL_PREDICTIONS = '/api/final-predictions';
const ROUTE_ME_FINAL_PREDICTIONS = '/api/me/final-predictions';

/**
 * POST a new (or replacement) final prediction for the current participant.
 *
 * The route handler is responsible for:
 *   - Eligibility (`requireEligible`).
 *   - Zod validation of `item_kind` ↔ `target_*` consistency.
 *   - Target-existence checks (team / active player).
 *   - Server-side lock check via `public.is_final_prediction_locked()`.
 *   - Marking any prior active row for `(participant, item_kind)` as
 *     `superseded_at = now()`.
 *
 * @throws Error with the route handler's status + body when the response
 *         is not 2xx. Error normalization (typed `EligibilityError` etc.)
 *         layers in later slices.
 */
export async function submitFinalPrediction(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
  input: SubmitFinalPredictionInput,
): Promise<SubmitFinalPredictionResponse> {
  const url = new URL(ROUTE_FINAL_PREDICTIONS, resolveAppBaseUrl());

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
      `POST /api/final-predictions failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as SubmitFinalPredictionResponse;
}

/**
 * GET the current participant's active final predictions plus the
 * tournament-wide lock state and `first_kickoff_utc`. Returns only rows
 * with `superseded_at IS NULL` (history lives in Slice 005's
 * personal-breakdown surface).
 */
export async function getMyFinalPredictions(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: SupabaseClient,
): Promise<MeFinalPredictionsResponse> {
  const url = new URL(ROUTE_ME_FINAL_PREDICTIONS, resolveAppBaseUrl());

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
      `GET /api/me/final-predictions failed: ${response.status} ${JSON.stringify(
        (body as { error?: unknown } | null)?.error ?? body,
      )}`,
    );
  }

  return (await response.json()) as MeFinalPredictionsResponse;
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
 * Mirrors `apps/web/lib/predictions/client.ts` and
 * `apps/web/lib/catalog/client.ts` so all wrappers agree on the
 * resolution order.
 */
function resolveAppBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return 'http://localhost:3000';
}
