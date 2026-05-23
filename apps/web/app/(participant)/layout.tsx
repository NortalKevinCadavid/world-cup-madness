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
    <div className="min-h-screen flex flex-col bg-neutral-50">
      <TopNav participant={participant} isAdmin={isAdmin} />
      <div className="flex-1">{children}</div>
    </div>
  );
}
