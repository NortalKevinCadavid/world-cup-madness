"use client";

// Slice 010 / T022 (US2) — interactive bracket board.
// Holds pick state, applies an optimistic winner + cascade for instant UX
// (lib/bracket/cascade.ts), POSTs the pick, then refetches the authoritative
// re-resolved tree + status from GET /api/bracket (server is the source of
// truth — Constitution III). Read-only when locked or submitted.

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { MatchupCard } from "@/app/components/bracket/MatchupCard";
import { BracketProgressSummary } from "@/app/components/bracket/BracketProgressSummary";
import { BracketStatusBadge } from "@/app/components/bracket/BracketStatusBadge";
import { SubmitBracketButton } from "@/app/components/bracket/SubmitBracketButton";
import { computeClearedMatchups } from "@/lib/bracket/cascade";
import { deriveBracketCounts } from "@/lib/bracket/status";
import {
  ROUND_LABEL_KEY,
  ROUND_ORDER,
  type BracketResponse,
} from "@/lib/bracket/types";

export function BracketClient({ initial }: { initial: BracketResponse }) {
  const t = useTranslations("Bracket");
  const [data, setData] = useState<BracketResponse>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const status = data.status;
  const isLocked = status.submission_status === "locked";
  // Read-only once locked or already submitted (re-submit re-opens via edit flow
  // server-side, but the board itself is frozen while submitted/locked).
  const locked = isLocked || status.submission_status === "submitted";

  // FR-029 — post-lock display: a complete bracket is accepted (auto-submit at
  // lock); an incomplete one is frozen as-is. While submitted (pre-lock) the
  // player may still update until lock.
  const lockedNote = isLocked
    ? status.is_complete
      ? t("lockedComplete")
      : t("lockedIncomplete")
    : status.submission_status === "submitted"
      ? t("submittedNote")
      : null;

  const refetch = useCallback(async () => {
    const res = await fetch("/api/bracket", { credentials: "include", cache: "no-store" });
    if (res.ok) setData((await res.json()) as BracketResponse);
  }, []);

  const handleSubmit = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/bracket/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ run_token: crypto.randomUUID() }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: { code?: string } }
            | null;
          setError(
            body?.error?.code === "BRACKET_INCOMPLETE"
              ? t("submitDisabledIncomplete")
              : t("loadError"),
          );
        }
        await refetch();
      } catch {
        setError(t("loadError"));
        await refetch();
      }
    });
  }, [refetch, t]);

  const handlePick = useCallback(
    (matchupId: string, teamId: string) => {
      if (locked) return;
      setError(null);

      // Optimistic: set the winner locally + clear now-impossible downstream
      // checkmarks. The refetch reconciles competitor resolution + status.
      setData((prev) => {
        const pickMap: Record<string, string | undefined> = {};
        for (const m of prev.matchups) if (m.winner_team_id) pickMap[m.id] = m.winner_team_id;
        pickMap[matchupId] = teamId;
        const cleared = new Set(computeClearedMatchups(prev.matchups, pickMap));
        const nextMatchups = prev.matchups.map((m) =>
          m.id === matchupId
            ? { ...m, winner_team_id: teamId }
            : cleared.has(m.id)
              ? { ...m, winner_team_id: null }
              : m,
        );
        // Recompute the displayed counts from the single client mirror so every
        // surface (header, footer, badge, submit) updates instantly + in sync.
        // submission_status stays server-owned (refetch reconciles it).
        return {
          ...prev,
          matchups: nextMatchups,
          status: { ...prev.status, ...deriveBracketCounts(nextMatchups) },
        };
      });

      startTransition(async () => {
        try {
          const res = await fetch("/api/bracket/pick", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ matchup_id: matchupId, winner_team_id: teamId }),
          });
          if (!res.ok) setError(t("loadError"));
          await refetch();
        } catch {
          setError(t("loadError"));
          await refetch();
        }
      });
    },
    [locked, refetch, t],
  );

  const columns = useMemo(
    () =>
      ROUND_ORDER.map((round) => ({
        round,
        matchups: data.matchups
          .filter((m) => m.round === round)
          .sort((a, b) => a.position - b.position),
      })),
    [data.matchups],
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-bold">{t("title")}</h1>
          <BracketStatusBadge status={status.submission_status} />
        </div>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BracketProgressSummary status={status} />
          <div className="flex items-center gap-3">
            <Link
              href="/bracket/review"
              data-testid="bracket-review-link"
              className="text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {t("reviewTitle")}
            </Link>
            {!locked ? (
              <SubmitBracketButton status={status} pending={pending} onSubmit={handleSubmit} />
            ) : null}
          </div>
        </div>
        {lockedNote ? (
          <p className="text-sm text-muted-foreground" data-testid="bracket-locked-note">
            {lockedNote}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : null}
      </header>

      <div className="flex gap-6 overflow-x-auto pb-4 md:pb-4 max-md:pb-24">
        {columns.map(({ round, matchups }) => (
          <section
            key={round}
            data-testid="bracket-round-column"
            data-round={round}
            className="flex min-w-[14rem] flex-col"
          >
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
              {t(ROUND_LABEL_KEY[round])}
            </h2>
            {/* Distribute matchups evenly over the (stretched) column height so
                each later-round matchup centers between its two feeders. */}
            <div className="flex flex-1 flex-col justify-around gap-2">
              {matchups.map((m) => (
                <MatchupCard
                  key={m.id}
                  matchup={m}
                  disabled={locked || pending}
                  onPickWinner={handlePick}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Mobile sticky footer — same single status source as the header. */}
      <div
        data-testid="bracket-mobile-footer"
        className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-3 backdrop-blur md:hidden"
      >
        <span className="text-sm font-medium" data-testid="bracket-mobile-progress">
          {t("progress", { completed: status.completed, total: status.total_required })}
        </span>
        {locked ? (
          <BracketStatusBadge status={status.submission_status} />
        ) : (
          <SubmitBracketButton status={status} pending={pending} onSubmit={handleSubmit} testId="bracket-submit-mobile" />
        )}
      </div>
    </div>
  );
}
