import 'server-only';

import { cache } from 'react';

import { requireEligible } from './requireEligible';
import type { Participant } from '../types/participant';

export type { Participant } from '../types/participant';
export { EligibilityError } from './requireEligible';

/**
 * Server-component / route-handler accessor for the current participant.
 *
 * Wraps `requireEligible` in React's `cache()` so that a single request
 * lifecycle (one render of a server component tree, or one route-handler
 * invocation) re-uses the same `Participant` resolution even if multiple
 * components call this independently. Cross-request memoization is NOT
 * provided — each request re-enters the guard so eligibility decisions stay
 * fresh (FR-007).
 *
 * Throws the same `EligibilityError` taxonomy as `requireEligible`. Callers
 * are responsible for translating to 401 / 403 / redirect.
 *
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 * @see specs/001-eligibility-login/research.md (R-009)
 */
export const getCurrentParticipant = cache(
  async (): Promise<Participant> => requireEligible(),
);
