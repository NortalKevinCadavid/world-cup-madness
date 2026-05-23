"use client";

/**
 * ScoreReveal — staggered reveal for a list of scored predictions.
 *
 * Contract: specs/009-ui-beautification/contracts/component-api.md § ScoreReveal.
 *
 * Each prediction enters the viewport with a 150ms stagger. Correct/incorrect
 * cues use both color (win/loss tokens) AND an icon — never color-only
 * (FR-UI-018 / SC-001).
 *
 * Under reduced motion, ALL items render at once with no animation and no
 * stagger — the same information is presented, just statically.
 */

import { Check, X as XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMotion } from "@/app/components/MotionProvider";

export type ScoreRevealItem = {
  id: string;
  label: string;
  /** Correct = exact-result hit; partial = outcome-only; incorrect = miss. */
  outcome: "exact" | "outcome" | "miss";
  points: number;
};

export type ScoreRevealProps = {
  items: ScoreRevealItem[];
  className?: string;
};

const OUTCOME_STYLES: Record<
  ScoreRevealItem["outcome"],
  { ring: string; icon: typeof Check; tone: string; label: string }
> = {
  exact: {
    ring: "border-win/60 bg-win/10",
    icon: Check,
    tone: "text-win",
    label: "Exact",
  },
  outcome: {
    ring: "border-accent/60 bg-accent/10",
    icon: Check,
    tone: "text-accent",
    label: "Outcome",
  },
  miss: {
    ring: "border-loss/40 bg-loss/5",
    icon: XIcon,
    tone: "text-loss",
    label: "Miss",
  },
};

export function ScoreReveal({ items, className }: ScoreRevealProps) {
  const { effective } = useMotion();
  const animate = effective !== "reduce";

  return (
    <ol className={cn("space-y-2", className)}>
      {items.map((item, i) => {
        const style = OUTCOME_STYLES[item.outcome];
        const Icon = style.icon;
        return (
          <li
            key={item.id}
            data-motion-decorative={animate ? "" : undefined}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border px-3 py-2",
              style.ring,
              animate &&
                "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
            )}
            style={
              animate
                ? ({
                    animationDelay: `${i * 150}ms`,
                    animationDuration: "var(--motion-duration-base, 150ms)",
                    animationFillMode: "both",
                  } as React.CSSProperties)
                : undefined
            }
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4 shrink-0", style.tone)} aria-hidden />
              <span className="font-medium text-foreground">{item.label}</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className={cn("font-semibold", style.tone)} aria-label={style.label}>
                {style.label}
              </span>
              <span className="font-display font-semibold tabular-nums text-foreground">
                +{item.points}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default ScoreReveal;
