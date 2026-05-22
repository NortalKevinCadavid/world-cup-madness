import 'server-only';

import { redirect } from 'next/navigation';

import { EligibilityError } from '../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../lib/auth/getCurrentParticipant';
import type { Participant } from '../../lib/types/participant';

/**
 * Participant dashboard — PLACEHOLDER for Slice 001.
 *
 * Slices 002+ replace the body of this page with the prediction-pool UI. For
 * Slice 001 the only requirement is that an eligible participant lands here
 * after sign-in (SC-002) and sees their identity confirmed.
 *
 * Server component. Any thrown `EligibilityError` is translated to a
 * redirect to `/auth/denied` — the dashboard never leaks why a caller was
 * denied (see auth-callback.page.md § "MUST NOT reveal").
 *
 * @see specs/001-eligibility-login/contracts/auth-callback.page.md
 * @see specs/001-eligibility-login/contracts/participant-me.read.md
 */
export default async function DashboardPage() {
  let participant: Participant;
  try {
    participant = await getCurrentParticipant();
  } catch (err) {
    if (err instanceof EligibilityError) {
      redirect('/auth/denied');
    }
    throw err;
  }

  return (
    <main className="min-h-screen flex flex-col items-start gap-6 p-6 max-w-2xl mx-auto">
      <h1 className="text-3xl font-semibold">
        Welcome, {participant.display_name}
      </h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="font-medium text-neutral-600">Email</dt>
        <dd>{participant.email}</dd>

        <dt className="font-medium text-neutral-600">Domain</dt>
        <dd>{participant.domain}</dd>

        {participant.region ? (
          <>
            <dt className="font-medium text-neutral-600">Region</dt>
            <dd>{participant.region}</dd>
          </>
        ) : null}

        <dt className="font-medium text-neutral-600">Status</dt>
        <dd>{participant.status}</dd>
      </dl>
      <p className="text-xs text-neutral-500">
        Slice 001 placeholder. Prediction-pool UI ships in later slices.
      </p>
    </main>
  );
}
