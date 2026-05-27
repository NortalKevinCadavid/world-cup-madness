"use client";

// Slice 010 / T029 (US3) — progress summary. Consumes the single BracketStatus
// shape (R-004 / FR-014): "{completed} of {total}". No local completeness math.

import { useTranslations } from "next-intl";
import type { BracketStatus } from "@/lib/bracket/types";

export function BracketProgressSummary({ status }: { status: BracketStatus }) {
  const t = useTranslations("Bracket");
  return (
    <p className="text-sm font-medium" data-testid="bracket-progress">
      {t("progress", {
        completed: status.completed,
        total: status.total_required,
      })}
    </p>
  );
}
