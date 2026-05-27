"use client";

// Slice 010 / T036 (US4) — read-only peer bracket. Renders another
// participant's locked bracket (post-lock only; the server gate decides
// visibility). No pick interaction; MatchupCard is rendered disabled.

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { MatchupCard } from "@/app/components/bracket/MatchupCard";
import { BracketStatusBadge } from "@/app/components/bracket/BracketStatusBadge";
import { ROUND_LABEL_KEY, ROUND_ORDER, type BracketResponse, type BracketStatus } from "@/lib/bracket/types";

export interface PeerBracketBoardProps {
  participant: { id: string; display_name: string };
  matchups: BracketResponse["matchups"];
  status: BracketStatus;
}

export function PeerBracketBoard({ participant, matchups, status }: PeerBracketBoardProps) {
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
          <h1 className="font-display text-2xl font-bold">{participant.display_name}</h1>
          <BracketStatusBadge status={status.submission_status} />
        </div>
        <p className="text-sm text-muted-foreground" data-testid="peer-bracket-progress">
          {t("progress", { completed: status.completed, total: status.total_required })}
        </p>
      </header>

      <div className="flex gap-6 overflow-x-auto pb-4">
        {columns.map(({ round, matchups: col }) => (
          <section
            key={round}
            data-testid="bracket-round-column"
            data-round={round}
            className="flex min-w-[14rem] flex-col gap-2"
          >
            <h2 className="text-sm font-semibold text-muted-foreground">{t(ROUND_LABEL_KEY[round])}</h2>
            {col.map((m) => (
              <MatchupCard key={m.id} matchup={m} disabled onPickWinner={noop} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
