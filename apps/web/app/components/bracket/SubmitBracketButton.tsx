"use client";

// Slice 010 / T029 (US3) — submit control. Consumes the single BracketStatus
// shape (R-004). Disabled when incomplete or locked; labelled submit-vs-resubmit
// once a submission exists (FR-010). The disabled reason is exposed for a11y
// (FR-023). The server (submit_bracket RPC) is authoritative — a client
// is_complete is never trusted to bypass the server gate.

import { useTranslations } from "next-intl";
import { Button } from "@/app/components/ui/button";
import type { BracketStatus } from "@/lib/bracket/types";

export interface SubmitBracketButtonProps {
  status: BracketStatus;
  pending?: boolean;
  onSubmit: () => void;
  /** testid for the button; override so multiple instances stay unique. */
  testId?: string;
}

export function SubmitBracketButton({
  status,
  pending,
  onSubmit,
  testId = "bracket-submit",
}: SubmitBracketButtonProps) {
  const t = useTranslations("Bracket");

  const isLocked =
    status.submission_status === "locked" ||
    status.submission_status === "submitted";
  const hasSubmitted = status.submission_status === "submitted";
  const disabled = !status.is_complete || isLocked || Boolean(pending);

  const label = hasSubmitted ? t("resubmit") : t("submit");
  // Spoken/visible reason when the control is disabled because it is incomplete.
  const disabledReason = !status.is_complete ? t("submitDisabledIncomplete") : undefined;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        data-testid={testId}
        disabled={disabled}
        aria-disabled={disabled}
        aria-describedby={disabledReason ? "bracket-submit-reason" : undefined}
        onClick={onSubmit}
      >
        {label}
      </Button>
      {disabledReason ? (
        <p id="bracket-submit-reason" className="text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}
