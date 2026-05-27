"use client";

// Slice 010 / T029 (US3) — status badge derived solely from the single
// BracketStatus shape (R-004). draft → complete → submitted → locked.

import { useTranslations } from "next-intl";
import { Badge, type BadgeProps } from "@/app/components/ui/badge";
import type { BracketSubmissionStatus } from "@/lib/bracket/types";

const VARIANT: Record<BracketSubmissionStatus, BadgeProps["variant"]> = {
  draft: "outline",
  complete: "open",
  submitted: "scored",
  locked: "locked",
};

const LABEL_KEY: Record<BracketSubmissionStatus, string> = {
  draft: "statusDraft",
  complete: "statusComplete",
  submitted: "statusSubmitted",
  locked: "statusLocked",
};

export function BracketStatusBadge({ status }: { status: BracketSubmissionStatus }) {
  const t = useTranslations("Bracket");
  return (
    <Badge variant={VARIANT[status]} data-testid="bracket-status-badge" data-status={status}>
      {t(LABEL_KEY[status])}
    </Badge>
  );
}
