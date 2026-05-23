/**
 * ErrorState — shared error state replacing blank pages on data
 * fetch failure (FR-UI-013).
 * Contract: specs/009-ui-beautification/contracts/component-api.md § ErrorState.
 */

"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorStateProps = {
  title?: string;
  description: string;
  onRetry?: () => void;
  correlationId?: string;
  className?: string;
};

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  correlationId,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center",
        className,
      )}
    >
      <AlertCircle className="size-8 text-destructive" aria-hidden />
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {correlationId ? (
        <p className="font-mono text-xs text-muted-foreground/70">
          Reference: {correlationId}
        </p>
      ) : null}
    </div>
  );
}

export default ErrorState;
