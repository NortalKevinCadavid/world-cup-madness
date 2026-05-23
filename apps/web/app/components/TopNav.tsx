import 'server-only';

import Link from 'next/link';

import type { Participant } from '../../lib/types/participant';

interface TopNavProps {
  participant: Participant;
  isAdmin: boolean;
  /** Which top-level section the current page belongs to (used to highlight). */
  activeSection?: 'dashboard' | 'matches' | 'leaderboard' | 'me' | 'admin' | null;
}

const PARTICIPANT_LINKS: { href: string; label: string; section: NonNullable<TopNavProps['activeSection']> }[] = [
  { href: '/dashboard',   label: 'Dashboard',   section: 'dashboard'   },
  { href: '/matches',     label: 'Matches',     section: 'matches'     },
  { href: '/leaderboard', label: 'Leaderboard', section: 'leaderboard' },
  { href: '/me/finals',   label: 'My picks',    section: 'me'          },
];

export function TopNav({ participant, isAdmin, activeSection = null }: TopNavProps) {
  return (
    <header className="border-b border-neutral-200 bg-white">
      <nav
        aria-label="Primary"
        className="max-w-6xl mx-auto flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3"
      >
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold text-neutral-900 hover:text-neutral-700">
          <span className="text-lg">⚽</span>
          <span>World Cup Madness</span>
        </Link>

        <ul className="flex items-center gap-1 text-sm flex-1">
          {PARTICIPANT_LINKS.map(({ href, label, section }) => (
            <li key={href}>
              <Link
                href={href}
                className={
                  activeSection === section
                    ? 'rounded px-3 py-1.5 bg-neutral-900 text-white'
                    : 'rounded px-3 py-1.5 text-neutral-700 hover:bg-neutral-100'
                }
              >
                {label}
              </Link>
            </li>
          ))}
          {isAdmin ? (
            <li>
              <Link
                href="/admin"
                className={
                  activeSection === 'admin'
                    ? 'rounded px-3 py-1.5 bg-amber-600 text-white'
                    : 'rounded px-3 py-1.5 text-amber-700 hover:bg-amber-50'
                }
              >
                Admin
              </Link>
            </li>
          ) : null}
        </ul>

        <div className="flex items-center gap-3 text-sm">
          <span className="text-neutral-600 hidden sm:inline">{participant.display_name}</span>
          <form action="/api/auth/signout" method="post" className="m-0">
            <button
              type="submit"
              className="rounded px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </nav>
    </header>
  );
}
