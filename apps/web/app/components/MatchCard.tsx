/**
 * MatchCard — presentation-only component used by participant + admin surfaces.
 *
 * Contract: specs/009-ui-beautification/contracts/component-api.md § MatchCard
 *
 * This component is purely presentational. It accepts already-fetched Match +
 * Prediction shapes from slices 002 / 003 and renders them. It does NOT call
 * any API directly — `onSubmit` / `onLock` are wired by the consuming page
 * (which owns the existing slice 002/003 mutation logic) so we preserve every
 * existing functional behavior (FR-UI-017).
 *
 * Locking semantics are read from `match.lock_state` (slice 003 additive
 * extension). The component never derives lock state itself.
 */

"use client";

import { useState, type ReactNode } from "react";
import { Lock, Unlock, Check, Clock } from "lucide-react";

import type { Match } from "@/lib/types/match";
import type { Prediction } from "@/lib/predictions/types";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardFooter, CardHeader } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Flag } from "@/app/components/Flag";

export type MatchCardMode = "view" | "edit" | "admin";

export type MatchCardProps = {
  match: Match;
  prediction?: Prediction;
  mode: MatchCardMode;
  onSubmit?: (homeScore: number, awayScore: number) => Promise<void>;
  onLock?: () => Promise<void>;
  className?: string;
};

export function MatchCard({
  match,
  prediction,
  mode,
  onSubmit,
  className,
}: MatchCardProps) {
  const lockState = match.lock_state ?? "editable";
  const status = deriveStatus(match.status, lockState, !!prediction);
  const titleId = `match-${match.id}-title`;

  const [home, setHome] = useState<string>(
    prediction ? String(prediction.predicted_home) : "",
  );
  const [away, setAway] = useState<string>(
    prediction ? String(prediction.predicted_away) : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const editable = mode === "edit" && status === "open";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!onSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    const h = Number.parseInt(home, 10);
    const a = Number.parseInt(away, 10);
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(a) ||
      h < 0 ||
      a < 0 ||
      h > 20 ||
      a > 20
    ) {
      setSubmitError("Scores must be whole numbers between 0 and 20.");
      setSubmitting(false);
      return;
    }
    try {
      await onSubmit(h, a);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Couldn't save your pick. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      role="article"
      aria-labelledby={titleId}
      className={cn(
        "transition-shadow duration-base ease-standard motion-safe:hover:shadow-md",
        status === "locked" && "border-locked/40",
        status === "scored" && "border-scored/40",
        className,
      )}
    >
      <CardHeader className="gap-2 pb-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3.5" aria-hidden />
            <KickoffTime kickoffUtc={match.kickoff_utc} />
          </span>
          <span>
            {match.stage === "group"
              ? `Group ${match.group_id ?? "?"}`
              : stageLabel(match.stage)}
          </span>
        </div>
        <h3
          id={titleId}
          className="flex items-center justify-between gap-3 font-display text-lg font-semibold"
        >
          <TeamCell team={match.home_team} side="home" />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            vs
          </span>
          <TeamCell team={match.away_team} side="away" />
        </h3>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {mode === "view" || !editable ? (
          <ScoreDisplay
            prediction={prediction}
            match={match}
            status={status}
          />
        ) : (
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2"
            aria-label="Score prediction"
          >
            <ScoreInput
              label={`${match.home_team.short_code} score`}
              value={home}
              onChange={setHome}
              disabled={submitting}
            />
            <span className="pb-2 font-display text-muted-foreground">–</span>
            <ScoreInput
              label={`${match.away_team.short_code} score`}
              value={away}
              onChange={setAway}
              disabled={submitting}
            />
            <Button
              type="submit"
              size="sm"
              className="ml-auto"
              disabled={submitting || !home || !away}
            >
              {submitting ? "Saving…" : prediction ? "Update" : "Lock pick"}
            </Button>
          </form>
        )}
        {submitError ? (
          <p role="alert" className="text-xs text-destructive">
            {submitError}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="justify-between gap-2 pt-0 text-xs text-muted-foreground">
        <StatusBadge status={status} />
        {prediction ? <PredictionSource source={prediction.source} /> : null}
      </CardFooter>
    </Card>
  );
}

function deriveStatus(
  matchStatus: Match["status"],
  lockState: "editable" | "locked",
  hasPrediction: boolean,
): "open" | "locked" | "scored" {
  if (matchStatus === "finished") return "scored";
  if (lockState === "locked") return "locked";
  return "open";
  // `hasPrediction` is currently unused but kept in the signature so future
  // distinctions (e.g. "saved-but-still-editable") can branch on it.
  void hasPrediction;
}

function StatusBadge({ status }: { status: "open" | "locked" | "scored" }) {
  if (status === "locked") {
    return (
      <Badge variant="locked">
        <Lock className="size-3" aria-hidden />
        Locked
      </Badge>
    );
  }
  if (status === "scored") {
    return (
      <Badge variant="scored">
        <Check className="size-3" aria-hidden />
        Scored
      </Badge>
    );
  }
  return (
    <Badge variant="open">
      <Unlock className="size-3" aria-hidden />
      Open
    </Badge>
  );
}

function KickoffTime({ kickoffUtc }: { kickoffUtc: string }) {
  const date = new Date(kickoffUtc);
  if (Number.isNaN(date.getTime())) return <>{kickoffUtc}</>;
  return (
    <time dateTime={kickoffUtc} suppressHydrationWarning>
      {date.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}
    </time>
  );
}

function TeamCell({
  team,
  side,
}: {
  team: Match["home_team"];
  side: "home" | "away";
}) {
  const alignment = side === "home" ? "flex-row" : "flex-row-reverse";
  return (
    <span className={cn("flex flex-1 items-center gap-2 text-base", alignment)}>
      <Flag code={team.short_code} size="md" />
      <span className="font-display font-semibold">{team.name}</span>
    </span>
  );
}

function ScoreInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
      <span className="sr-only">{label}</span>
      <Input
        inputMode="numeric"
        pattern="[0-9]*"
        type="number"
        min={0}
        max={20}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="h-11 text-center font-display tabular-nums text-xl"
      />
    </label>
  );
}

function ScoreDisplay({
  prediction,
  match,
  status,
}: {
  prediction?: Prediction;
  match: Match;
  status: "open" | "locked" | "scored";
}) {
  const official =
    match.match_result &&
    `${match.match_result.home_score_official} – ${match.match_result.away_score_official}`;

  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      <div className="rounded-md bg-muted/30 p-2 text-center">
        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
          Your pick
        </span>
        <span className="font-display text-xl font-semibold tabular-nums">
          {prediction
            ? `${prediction.predicted_home} – ${prediction.predicted_away}`
            : status === "open"
              ? "—"
              : "no pick"}
        </span>
      </div>
      <div className="rounded-md bg-muted/30 p-2 text-center">
        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
          Final
        </span>
        <span className="font-display text-xl font-semibold tabular-nums">
          {official ?? "—"}
        </span>
      </div>
    </div>
  );
}

function PredictionSource({ source }: { source: Prediction["source"] }) {
  if (source === "admin_override") {
    return <span className="text-[10px] uppercase">Admin override</span>;
  }
  return null;
}

function stageLabel(stage: Match["stage"]): ReactNode {
  switch (stage) {
    case "r16":
      return "Round of 16";
    case "qf":
      return "Quarter-final";
    case "sf":
      return "Semi-final";
    case "final":
      return "Final";
    case "third_place":
      return "Third place";
    default:
      return stage;
  }
}

export default MatchCard;
