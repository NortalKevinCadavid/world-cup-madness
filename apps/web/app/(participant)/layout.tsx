import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import { EligibilityError } from '../../lib/auth/requireEligible';
import { getCurrentParticipant } from '../../lib/auth/getCurrentParticipant';
import type { Participant } from '../../lib/types/participant';
import { TopNav } from '../components/TopNav';

/**
 * Participant-area layout — wraps every page in the `(participant)`
 * route group with the eligibility gate and the shared top navigation.
 * The layout runs `getCurrentParticipant()` first and redirects to
 * `/auth/denied` on any `EligibilityError`. Once we have a participant,
 * we ask Postgres whether they're also an admin (so the nav can show
 * the Admin link to admins only).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function createReadOnlyClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase environment variables are not configured.');
  }
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only.
      },
    },
  });
}

async function isCallerAdmin(participantAuthUserId: string): Promise<boolean> {
  try {
    const supabase = createReadOnlyClient();
    const { data, error } = await supabase.rpc('is_admin', {
      p_user_id: participantAuthUserId,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

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

  const isAdmin = await isCallerAdmin(participant.auth_user_id);

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <TopNav participant={participant} isAdmin={isAdmin} />
      <div className="flex-1">{children}</div>
      <footer className="border-t border-border bg-card/50">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <span>World Cup Madness — Nortal prediction pool</span>
          <a
            href="/design-system"
            className="rounded text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Design system
          </a>
        </div>
      </footer>
    </div>
  );
}
