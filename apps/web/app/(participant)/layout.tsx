import 'server-only';

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EligibilityError } from '../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../lib/auth/getCurrentParticipant';
import type { Participant } from '../../lib/types/participant';

/**
 * Participant-area layout — Slice 002 (T021).
 *
 * Server component. Runs `getCurrentParticipant()` (which calls
 * `requireEligible()` under React's `cache`) before rendering any
 * participant-scoped child. On any `EligibilityError` the layout redirects
 * to `/auth/denied`; the denial page itself owns the messaging so this
 * layout never reveals *why* the caller was denied (mirrors Slice 001's
 * dashboard pattern).
 *
 * The layout also renders a minimal nav header so every page in this
 * route group shares the "World Cup Madness | <name>" branding plus
 * pointers back to `/dashboard` and `/matches`.
 */
export default async function ParticipantLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 bg-white">
        <nav
          aria-label="Primary"
          className="max-w-6xl mx-auto flex items-center justify-between px-6 py-3"
        >
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold text-neutral-900">
              World Cup Madness
            </span>
            <span className="text-neutral-300" aria-hidden>
              |
            </span>
            <span className="text-neutral-600">
              {participant.display_name}
            </span>
          </div>
          <ul className="flex items-center gap-4 text-sm">
            <li>
              <Link
                href="/matches"
                className="text-neutral-700 hover:text-neutral-900 hover:underline"
              >
                Matches
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard"
                className="text-neutral-700 hover:text-neutral-900 hover:underline"
              >
                Dashboard
              </Link>
            </li>
          </ul>
        </nav>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
