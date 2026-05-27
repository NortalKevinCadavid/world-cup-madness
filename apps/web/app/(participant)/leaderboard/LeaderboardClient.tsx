"use client";

/**
 * LeaderboardClient — client island that wraps the leaderboard table with:
 *   - Tie marking (when two or more rows share the same rank).
 *   - Highlight of the current participant's row (aria-current=true + accent tint).
 *   - "Jump to my row" sticky toolbar.
 *   - Tie-breaker disclosure (Popover) for tied positions per
 *     docs/architecture/scoring-model.md.
 *
 * Movement indicator (RankDelta) is intentionally NOT wired here — the
 * underlying leaderboard view does not expose previous_rank. The component
 * exists and is documented on /design-system; this will adopt it once the
 * data shape grows.
 *
 * Contract: specs/009-ui-beautification/contracts/component-api.md § LeaderboardRow.
 */

import { useMemo, useRef } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowDownToLine, Info } from "lucide-react";

import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { Confetti } from "@/app/components/Confetti";
import { cn } from "@/lib/utils";

export type LeaderboardEntry = {
  participant_id: string;
  display_name: string;
  rank: number;
  total_points: number;
  exact_count: number;
  outcome_count: number;
  final_points: number;
};

type Props = {
  rows: LeaderboardEntry[];
  currentParticipantId: string | null;
  /** Post-lock only: enables per-row "View bracket" peer links (FR-019). */
  peerBracketEnabled?: boolean;
};

export function LeaderboardClient({
  rows,
  currentParticipantId,
  peerBracketEnabled = false,
}: Props) {
  const tBracket = useTranslations("Bracket");
  const t = useTranslations("Leaderboard");
  const myRowRef = useRef<HTMLTableRowElement | null>(null);

  // Detect tied positions: any rank value that appears more than once.
  const tiedRanks = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) {
      counts.set(r.rank, (counts.get(r.rank) ?? 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, c]) => c > 1)
        .map(([rank]) => rank),
    );
  }, [rows]);

  const myRow = useMemo(
    () => rows.find((r) => r.participant_id === currentParticipantId) ?? null,
    [rows, currentParticipantId],
  );

  function jumpToMyRow() {
    myRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Focus for keyboard users; row receives focus visually via aria-current
    // styling so a sighted user sees the same position cue.
    myRowRef.current?.focus({ preventScroll: true });
  }

  // US5 — fire a one-shot top-3 celebration the first time the current user
  // sees themselves at rank <= 3. Deduped via `wcm.celebrations.top3-<id>`
  // so it never replays on subsequent visits, even across reloads.
  const inTopThree = myRow !== null && myRow.rank <= 3;

  return (
    <div className="space-y-3">
      {inTopThree && myRow ? (
        <Confetti celebrationKey={`top3-${myRow.participant_id}`} />
      ) : null}
      {myRow ? (
        <div className="sticky top-16 z-20 flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          <span className="text-foreground">
            {t.rich("yourRank", {
              rank: myRow.rank,
              points: myRow.total_points,
              b: (chunks) => (
                <span className="font-display font-semibold tabular-nums">{chunks}</span>
              ),
            })}
          </span>
          <Button size="sm" variant="outline" onClick={jumpToMyRow}>
            <ArrowDownToLine className="size-4" aria-hidden /> {t("jumpToMyRow")}
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-muted/30 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2">
                {t("colRank")}
              </th>
              <th scope="col" className="px-4 py-2">
                {t("colParticipant")}
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                {t("colTotal")}
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                {t("colExact")}
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                {t("colOutcome")}
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                {t("colFinals")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rows.map((row) => {
              const isMe = row.participant_id === currentParticipantId;
              const tied = tiedRanks.has(row.rank);
              return (
                <tr
                  key={row.participant_id}
                  ref={isMe ? myRowRef : undefined}
                  tabIndex={isMe ? -1 : undefined}
                  data-testid="leaderboard-row"
                  data-rank={row.rank}
                  data-participant-id={row.participant_id}
                  data-me-row={isMe ? "true" : undefined}
                  aria-current={isMe ? "true" : undefined}
                  className={cn(
                    "transition-colors duration-base",
                    isMe ? "bg-accent/15 outline outline-2 outline-accent/40" : "hover:bg-muted/30",
                  )}
                >
                  <td
                    data-field="rank"
                    className="px-4 py-2 align-middle"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-display font-semibold tabular-nums text-foreground">
                        {row.rank}
                      </span>
                      {row.rank <= 3 ? (
                        <Badge variant="gold" className="px-1.5 py-0">
                          {row.rank === 1
                            ? t("first")
                            : row.rank === 2
                              ? t("second")
                              : t("third")}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td
                    data-field="display_name"
                    className="px-4 py-2 text-foreground"
                  >
                    <span className="font-medium">
                      {isMe ? <>{row.display_name} <span className="text-xs text-muted-foreground">({t("you")})</span></> : row.display_name}
                    </span>
                    {peerBracketEnabled && !isMe ? (
                      <Link
                        href={`/bracket/peer/${row.participant_id}`}
                        data-testid="peer-bracket-link"
                        className="ml-2 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {tBracket("viewBracket")}
                      </Link>
                    ) : null}
                  </td>
                  <td
                    data-field="total_points"
                    className="px-4 py-2 text-right align-middle"
                  >
                    <div className="inline-flex items-center justify-end gap-2">
                      <span className="font-display font-semibold tabular-nums text-foreground">
                        {row.total_points}
                      </span>
                      {tied ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground",
                                "transition-colors duration-fast hover:bg-muted",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                              )}
                              aria-label={t("tieAria")}
                            >
                              <Info className="size-3" aria-hidden /> {t("tie")}
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="end" className="w-80">
                            <TieBreakerChain entry={row} />
                          </PopoverContent>
                        </Popover>
                      ) : null}
                    </div>
                  </td>
                  <td
                    data-field="exact_count"
                    className="px-4 py-2 text-right tabular-nums text-muted-foreground"
                  >
                    {row.exact_count}
                  </td>
                  <td
                    data-field="outcome_count"
                    className="px-4 py-2 text-right tabular-nums text-muted-foreground"
                  >
                    {row.outcome_count}
                  </td>
                  <td
                    data-field="final_points"
                    className="px-4 py-2 text-right tabular-nums text-muted-foreground"
                  >
                    {row.final_points}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Tie-breaker chain renderer — shows the §7.4 ordering applied to the
 * current entry. Per docs/architecture/scoring-model.md the chain is:
 *   1. total_points
 *   2. exact_count
 *   3. outcome_count
 *   4. final_points
 * If two participants are tied at the displayed rank, ALL the above
 * comparisons resulted in equality. The renderer surfaces those values so
 * the user can verify visually.
 */
function TieBreakerChain({ entry }: { entry: LeaderboardEntry }) {
  const t = useTranslations("Leaderboard");
  const criteria: { label: string; value: number; note?: string }[] = [
    { label: t("tierTotal"), value: entry.total_points },
    { label: t("tierExact"), value: entry.exact_count },
    { label: t("tierOutcome"), value: entry.outcome_count },
    { label: t("tierFinal"), value: entry.final_points },
  ];
  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-display text-sm font-semibold">{t("tieChainTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("tieChainIntro", { rank: entry.rank })}
        </p>
      </div>
      <ol className="space-y-1.5 text-sm">
        {criteria.map((c, i) => (
          <li
            key={c.label}
            className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1 last:border-0"
          >
            <span className="text-muted-foreground">
              <span className="font-mono text-xs text-muted-foreground/70">
                {i + 1}.
              </span>{" "}
              {c.label}
            </span>
            <span className="font-display font-semibold tabular-nums text-foreground">
              {c.value}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] text-muted-foreground/80">
        Source: <code>docs/architecture/scoring-model.md</code> § 7.4.
      </p>
    </div>
  );
}

export default LeaderboardClient;
