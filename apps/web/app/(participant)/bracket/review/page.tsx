import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

import { EligibilityError, requireEligible } from "@/lib/auth/requireEligible";
import { readOwnBracket } from "@/lib/bracket/server-read";
import { BracketReviewBoard } from "@/app/components/bracket/BracketReviewBoard";

/**
 * `/bracket/review` — read-only confirmation of the caller's own bracket (US5,
 * T039). Renders the full tree with the SAME BracketProgressSummary +
 * BracketStatusBadge as the editor, sourced from the one bracket_status shape
 * (FR-014) — so the review can never disagree with the editing surface.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export default async function BracketReviewPage() {
  const t = await getTranslations("Bracket");

  let participantId: string;
  try {
    participantId = (await requireEligible()).id;
  } catch (err) {
    if (err instanceof EligibilityError) redirect("/auth/denied");
    throw err;
  }

  let data;
  try {
    data = await readOwnBracket(createSessionBoundClient(), participantId);
  } catch {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <p role="alert" className="text-sm text-destructive">{t("loadError")}</p>
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
      <BracketReviewBoard matchups={data.matchups} status={data.status} />
    </main>
  );
}
