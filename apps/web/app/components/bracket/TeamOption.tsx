"use client";

// Slice 010 / T011 — one selectable team inside a matchup.
// Keyboard-accessible (it is a <button>), selected state conveyed by an
// explicit ✓ marker + aria-pressed (not color alone — FR-023). Reuses
// FlagImage. Disabled when the matchup is locked/read-only.

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FlagImage } from "@/app/components/bracket/FlagImage";
import type { BracketTeam } from "@/lib/bracket/types";

export interface TeamOptionProps {
  team: BracketTeam;
  selected: boolean;
  disabled?: boolean;
  onSelect: (teamId: string) => void;
}

export function TeamOption({ team, selected, disabled, onSelect }: TeamOptionProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      data-testid="bracket-team-option"
      data-team-id={team.id}
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect(team.id)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm",
        "transition-colors duration-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-primary bg-primary/10 font-semibold text-foreground"
          : "border-border hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <FlagImage team={team} size="sm" />
      <span className="flex-1 truncate">{team.name}</span>
      {selected ? (
        <Check className="size-4 text-primary" aria-hidden />
      ) : null}
    </button>
  );
}
