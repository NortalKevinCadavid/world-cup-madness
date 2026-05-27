"use client";

// Slice 010 / T012 — one matchup. Shows both competitors via TeamOption when
// resolved; shows a pending placeholder when a competitor is not yet known
// (FR-007). Allows exactly one winner when both teams are present (FR-004).
// Read-only when `disabled` (locked/submitted-post-lock).

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Card } from "@/app/components/ui/card";
import { TeamOption } from "@/app/components/bracket/TeamOption";
import type { BracketMatchup } from "@/lib/bracket/types";

export interface MatchupCardProps {
  matchup: BracketMatchup;
  disabled?: boolean;
  onPickWinner: (matchupId: string, teamId: string) => void;
}

function PendingSlot({ label }: { label: string }) {
  return (
    <div
      data-testid="bracket-pending-slot"
      className="flex h-9 items-center rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground"
    >
      {label}
    </div>
  );
}

export function MatchupCard({ matchup, disabled, onPickWinner }: MatchupCardProps) {
  const t = useTranslations("Bracket");
  const { team_a, team_b, winner_team_id } = matchup;
  const pending = !team_a || !team_b;

  return (
    <Card
      data-testid="bracket-matchup"
      data-matchup-id={matchup.id}
      data-round={matchup.round}
      data-pending={pending ? "true" : "false"}
      className={cn("flex flex-col gap-1 p-2", pending && "opacity-80")}
    >
      {team_a ? (
        <TeamOption
          team={team_a}
          selected={winner_team_id === team_a.id}
          disabled={disabled || pending}
          onSelect={(teamId) => onPickWinner(matchup.id, teamId)}
        />
      ) : (
        <PendingSlot label={t("awaitingWinner")} />
      )}
      {team_b ? (
        <TeamOption
          team={team_b}
          selected={winner_team_id === team_b.id}
          disabled={disabled || pending}
          onSelect={(teamId) => onPickWinner(matchup.id, teamId)}
        />
      ) : (
        <PendingSlot label={t("awaitingWinner")} />
      )}
    </Card>
  );
}
