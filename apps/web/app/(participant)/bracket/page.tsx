import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import {
  EligibilityError,
  requireEligible,
} from "@/lib/auth/requireEligible";
import { readOwnBracket } from "@/lib/bracket/server-read";
import { BracketClient } from "./BracketClient";

/**
 * `/bracket` — the participant's own knockout bracket (US1: view teams).
 *
 * Slice 010 (US1, T016). Eligibility is already enforced by the
 * (participant) layout, but we re-resolve the participant here for the
 * bracket_status call (defense in depth + we need participant.id).
 * Renders the full bracket read-only via <BracketClient>; pick interactivity
 * lands in US2. Loading is handled by the server render; empty/error states
 * are rendered inline.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase environment variables are not configured.");
  }
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_c: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only.
      },
    },
  });
}

export default async function BracketPage() {
  const t = await getTranslations("Bracket");

  let participantId: string;
  try {
    const participant = await requireEligible();
    participantId = participant.id;
  } catch (err) {
    if (err instanceof EligibilityError) redirect("/auth/denied");
    throw err;
  }

  let data;
  try {
    const supabase = createSessionBoundClient();
    data = await readOwnBracket(supabase, participantId);
  } catch {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      </main>
    );
  }

  if (data.matchups.length === 0) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p className="text-sm text-muted-foreground">{t("emptyState")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <BracketClient initial={data} />
    </main>
  );
}
