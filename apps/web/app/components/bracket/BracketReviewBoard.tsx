"use client";

// Slice 010 / T039 (US5) — read-only review of the caller's own bracket. Same
// single status shape feeds the progress summary + status badge as the editable
// board (FR-014), so the review screen can never disagree with the editor.

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { MatchupCard } from "@/app/components/bracket/MatchupCard";
import { BracketProgressSummary } from "@/app/components/bracket/BracketProgressSummary";
import { BracketStatusBadge } from "@/app/components/bracket/BracketStatusBadge";
import { ROUND_LABEL_KEY, ROUND_ORDER, type BracketResponse, type BracketStatus } from "@/lib/bracket/types";

export function BracketReviewBoard({
  matchups,
  status,
}: {
  matchups: BracketResponse["matchups"];
  status: BracketStatus;
}) {
  const t = useTranslations("Bracket");
  const noop = () => {};

  const columns = useMemo(
    () =>
      ROUND_ORDER.map((round) => ({
        round,
        matchups: matchups.filter((m) => m.round === round).sort((a, b) => a.position - b.position),
      })),
    [matchups],
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold">{t("reviewTitle")}</h1>
          <BracketStatusBadge status={status.submission_status} />
        </div>
        <BracketProgressSummary status={status} />
      </header>

      <div className="flex gap-6 overflow-x-auto pb-4">
        {columns.map(({ round, matchups: col }) => (
          <section
            key={round}
            data-testid="bracket-round-column"
            data-round={round}
            className="flex min-w-[14rem] flex-col"
          >
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t(ROUND_LABEL_KEY[round])}</h2>
            <div className="flex flex-1 flex-col justify-around gap-2">
              {col.map((m) => (
                <MatchupCard key={m.id} matchup={m} disabled onPickWinner={noop} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
