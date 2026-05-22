import 'server-only';

import { NextResponse } from 'next/server';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';

/**
 * `GET /api/me` — Current-participant read.
 *
 * Slice 001 (Phase 3, US1). Reconciled to the locked contract in
 * `specs/001-eligibility-login/contracts/participant-me.read.md`:
 *
 * - 200 body: `{ participant: { id, display_name, email, domain, region, status,
 *   first_login_at, last_login_at } }` — narrower than the full `Participant`
 *   type (omits `auth_user_id`, `created_at`, `updated_at`).
 * - 401 / 403 / 500 body: `{ error: { code, message } }` with codes
 *   `UNAUTHENTICATED`, `DOMAIN_NOT_APPROVED`, `INTERNAL`. The 403 body is
 *   identical to the auth-hook denial body (US2 acceptance scenario 1: no
 *   leak about other accounts or domains).
 * - `Cache-Control: private, max-age=0, must-revalidate` on every response.
 *
 * Eligibility audit row on the 403 path is owned by T034 (the API-guard
 * layer); see TODO in `requireEligible.ts`. Not implemented here.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=0, must-revalidate';

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
  status: 401 | 403 | 500,
  code: keyof typeof ERROR_BODIES,
): NextResponse {
  return NextResponse.json(
    { error: ERROR_BODIES[code] },
    { status, headers: { 'Cache-Control': CACHE_CONTROL } },
  );
}

export async function GET(): Promise<NextResponse> {
  try {
    const p = await requireEligible();
    return NextResponse.json(
      {
        participant: {
          id: p.id,
          display_name: p.display_name,
          email: p.email,
          domain: p.domain,
          region: p.region,
          status: p.status,
          first_login_at: p.first_login_at,
          last_login_at: p.last_login_at,
        },
      },
      { status: 200, headers: { 'Cache-Control': CACHE_CONTROL } },
    );
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
}
