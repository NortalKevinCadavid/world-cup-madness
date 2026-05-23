import 'server-only';

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EligibilityError } from '../../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../../lib/auth/getCurrentParticipant';
import type { Participant } from '../../../lib/types/participant';

/**
 * Participant dashboard — the post-sign-in landing page. Renders a welcome
 * header, the participant's identity badge, and quick-link cards to the
 * primary prediction-pool surfaces (Matches, Leaderboard, My picks,
 * Breakdown).
 *
 * Server component. Any thrown EligibilityError is translated to a redirect
 * to /auth/denied (mirrors the participant-layout gate as defense-in-depth).
 */
export const dynamic = 'force-dynamic';

interface CardProps {
  href: string;
  title: string;
  description: string;
  emoji: string;
}

function Card({ href, title, description, emoji }: CardProps) {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-neutral-200 bg-white p-5 transition hover:border-neutral-400 hover:shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden>{emoji}</span>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-neutral-900 group-hover:text-neutral-700">
            {title}
          </h2>
          <p className="mt-1 text-sm text-neutral-600">{description}</p>
        </div>
        <span aria-hidden className="text-neutral-400 group-hover:text-neutral-700">→</span>
      </div>
    </Link>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

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
    <main className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-neutral-900">
          Welcome, {participant.display_name}
        </h1>
        <p className="text-sm text-neutral-600">
          FIFA World Cup 2026 prediction pool — Nortal internal. Submit your match predictions, pick your finalists, and chase the leaderboard.
        </p>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card
          href="/matches"
          title="Matches"
          emoji="⚽"
          description="Browse the fixture catalog and submit score predictions for upcoming matches."
        />
        <Card
          href="/leaderboard"
          title="Leaderboard"
          emoji="🏆"
          description="See the tournament-wide ranking and how you stack up against your peers."
        />
        <Card
          href="/me/finals"
          title="My picks"
          emoji="🥇"
          description="Pick the champion, runner-up, top scorer, and best player before kickoff."
        />
        <Card
          href="/me/breakdown"
          title="My breakdown"
          emoji="📊"
          description="See exactly how your points were earned, match by match."
        />
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-500 uppercase tracking-wide mb-3">
          Your account
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-neutral-600">Email</dt>
          <dd className="text-neutral-900">{participant.email}</dd>
          <dt className="font-medium text-neutral-600">Domain</dt>
          <dd className="text-neutral-900">{participant.domain}</dd>
          {participant.region ? (
            <>
              <dt className="font-medium text-neutral-600">Region</dt>
              <dd className="text-neutral-900">{participant.region}</dd>
            </>
          ) : null}
          <dt className="font-medium text-neutral-600">Status</dt>
          <dd className="text-neutral-900 capitalize">{participant.status}</dd>
          <dt className="font-medium text-neutral-600">Last sign-in</dt>
          <dd className="text-neutral-900">{formatRelative(participant.last_login_at)}</dd>
        </dl>
      </section>
    </main>
  );
}
