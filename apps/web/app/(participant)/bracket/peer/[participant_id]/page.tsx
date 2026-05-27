import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import { EligibilityError, requireEligible } from "@/lib/auth/requireEligible";
import { readPeerBracket } from "@/lib/bracket/server-read";
import { PeerBracketBoard } from "@/app/components/bracket/PeerBracketBoard";

/**
 * `/bracket/peer/[participant_id]` — read-only view of another participant's
 * bracket (US4, T036). The visibility gate lives in `bracket_peer_v` (DEFINER +
 * lock + self-exclusion): pre-lock / self / unknown all return null here and we
 * render the non-leaking "not available" state. No 404-vs-200 existence oracle.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase environment variables are not configured.");
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {},
    },
  });
}

export default async function PeerBracketPage({ params }: { params: { participant_id: string } }) {
  const t = await getTranslations("Bracket");

  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) redirect("/auth/denied");
    throw err;
  }

  const notAvailable = (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <p className="text-sm text-muted-foreground" data-testid="peer-bracket-unavailable">
        {t("accessDenied")}
      </p>
    </main>
  );

  if (!UUID_RE.test(params.participant_id)) return notAvailable;

  let peer;
  try {
    peer = await readPeerBracket(createSessionBoundClient(), params.participant_id);
  } catch {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p role="alert" className="text-sm text-destructive">{t("loadError")}</p>
      </main>
    );
  }

  if (!peer) return notAvailable;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PeerBracketBoard participant={peer.participant} matchups={peer.matchups} status={peer.status} />
    </main>
  );
}
