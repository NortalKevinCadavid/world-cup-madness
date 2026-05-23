'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `PendingReviewActions` — per-row resolution buttons + reason + source form.
 *
 * Slice 006 (Phase 7, T039). POSTs to `/api/admin/pending-review/[id]` which
 * calls `admin_resolve_match_pending_review` (slot 0069).
 *
 * DOM contract (one component per pending review row):
 *   - Form root:   `[data-testid="admin-pending-review-actions"]`
 *   - Reason:      `textarea[name="reason"]`
 *   - Source:      `input[name="source_citation"]`
 *   - Accept:      `[data-testid="admin-pending-review-accept-provider"]`
 *   - Reject:      `[data-testid="admin-pending-review-reject-provider"]`
 *   - Manual:      `[data-testid="admin-pending-review-manual-override"]`
 */

interface PendingReviewActionsProps {
  reviewId: string;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

type Resolution = 'accept_provider' | 'reject_provider' | 'manual_override';

export function PendingReviewActions({ reviewId }: PendingReviewActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function submit(resolution: Resolution) {
    setErrorMessage(null);
    setErrorField(null);
    setSuccess(null);
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/admin/pending-review/${reviewId}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
              resolution,
              reason,
              source_citation: source,
            }),
          },
        );
        if (response.ok) {
          setSuccess(`Resolved as ${resolution}.`);
          setReason('');
          setSource('');
          router.refresh();
          return;
        }
        const body = (await response.json().catch(() => null)) as
          | ErrorEnvelope
          | null;
        setErrorMessage(
          body?.error?.message ??
            body?.error?.reason ??
            `Submit failed (${response.status})`,
        );
        setErrorField(body?.error?.field ?? null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Network error');
        setErrorField(null);
      }
    });
  }

  return (
    <div
      data-testid="admin-pending-review-actions"
      className="mt-3 flex flex-col gap-3"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Reason <span className="text-destructive">*</span>
        </span>
        <textarea
          name="reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'reason' || undefined}
          className="rounded border border-border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="e.g. provider observation matches official scorecard"
        />
        {errorField === 'reason' && errorMessage ? (
          <span
            data-testid="field-error-reason"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Source citation <span className="text-destructive">*</span>
        </span>
        <input
          name="source_citation"
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'source_citation' || undefined}
          className="rounded border border-border px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="https://fifa.example/..."
        />
        {errorField === 'source_citation' && errorMessage ? (
          <span
            data-testid="field-error-source_citation"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      {errorMessage && !errorField ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      {success ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded border border-win/40 bg-win/10 px-3 py-2 text-sm text-win"
        >
          {success}
        </div>
      ) : null}

      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          disabled={pending}
          onClick={() => submit('accept_provider')}
          data-testid="admin-pending-review-accept-provider"
          className="rounded border border-blue-700 bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Accept provider
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => submit('reject_provider')}
          data-testid="admin-pending-review-reject-provider"
          className="rounded border border-muted-foreground bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Reject provider
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => submit('manual_override')}
          data-testid="admin-pending-review-manual-override"
          className="rounded border border-muted-foreground bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Manual override
        </button>
      </div>
    </div>
  );
}
