/**
 * RankDelta — encode rank movement with text + icon + color.
 * Contract: specs/009-ui-beautification/contracts/component-api.md § RankDelta.
 *
 * NOTE (slice 009, mid-implementation 2026-05-23):
 *   The leaderboard data shape today (slice 005's leaderboard_v) does NOT
 *   expose `previous_rank`. This component is therefore unused by the
 *   redesigned /leaderboard route until a follow-up slice extends the read
 *   contract. It is exported here so:
 *     (a) the design-system page can document the component for future use.
 *     (b) once slice 005 (or a follow-up) exposes previous_rank, the
 *         leaderboard row can adopt it without re-implementing the
 *         encoding.
 */

import { ArrowDown, ArrowUp, Minus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export type RankDeltaProps = {
  current: number;
  previous: number | null;
  className?: string;
};

export function RankDelta({ current, previous, className }: RankDeltaProps) {
  if (previous === null) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs font-semibold text-accent",
          className,
        )}
        aria-label="New entry"
      >
        <Sparkles className="size-3" aria-hidden /> New
      </span>
    );
  }
  if (current < previous) {
    const delta = previous - current;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-rank-up",
          className,
        )}
        aria-label={`Up ${delta} rank${delta === 1 ? "" : "s"}`}
      >
        <ArrowUp className="size-3" aria-hidden /> {delta}
      </span>
    );
  }
  if (current > previous) {
    const delta = current - previous;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-rank-down",
          className,
        )}
        aria-label={`Down ${delta} rank${delta === 1 ? "" : "s"}`}
      >
        <ArrowDown className="size-3" aria-hidden /> {delta}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-semibold text-rank-same",
        className,
      )}
      aria-label="Unchanged"
    >
      <Minus className="size-3" aria-hidden />
    </span>
  );
}

export default RankDelta;
