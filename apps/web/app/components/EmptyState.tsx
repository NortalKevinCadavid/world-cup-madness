/**
 * EmptyState — shared empty-state for every data surface.
 * Contract: specs/009-ui-beautification/contracts/component-api.md § EmptyState.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/lib/utils";

type ActionOnClick = { label: string; onClick: () => void };
type ActionHref = { label: string; href: string };

export type EmptyStateProps = {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ActionOnClick | ActionHref;
  className?: string;
  headingLevel?: 2 | 3;
};

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  headingLevel = 2,
}: EmptyStateProps) {
  const Heading = (headingLevel === 2 ? "h2" : "h3") as
    | "h2"
    | "h3";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/50 p-8 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="rounded-full bg-muted p-3 text-muted-foreground" aria-hidden>
          {icon}
        </div>
      ) : null}
      <Heading className="font-display text-lg font-semibold text-foreground">
        {title}
      </Heading>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? (
        "href" in action ? (
          <Button asChild>
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : (
          <Button onClick={action.onClick}>{action.label}</Button>
        )
      ) : null}
    </div>
  );
}

export default EmptyState;
