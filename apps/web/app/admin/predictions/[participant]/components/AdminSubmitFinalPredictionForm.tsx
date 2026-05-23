'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `AdminSubmitFinalPredictionForm` — admin-on-behalf-of final prediction form.
 *
 * Slice 006 (Phase 7, T039). POSTs to `/api/admin/final-predictions` which
 * calls `admin_submit_final_prediction`. The admin RPC owns the
 * lock-bypass decision per `admin-rpcs.write.md`.
 *
 * DOM contract:
 *   - Form root:  `[data-testid="admin-submit-final-prediction-form"]`
 *   - Item kind:  `select[name="item_kind"]`
 *   - Target id:  `input[name="target_id"]`
 *   - Reason:     `textarea[name="reason"]`
 *   - Source:     `input[name="source_citation"]`
 *   - Submit:     `[data-testid="admin-submit-final-prediction-submit"]`
 */

type ItemKind = 'champion' | 'runner_up' | 'top_scorer' | 'best_player';

interface AdminSubmitFinalPredictionFormProps {
  participantId: string;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

const ITEM_KIND_OPTIONS: ReadonlyArray<{ value: ItemKind; label: string }> = [
  { value: 'champion', label: 'Champion (team)' },
  { value: 'runner_up', label: 'Runner-up (team)' },
  { value: 'top_scorer', label: 'Top scorer (player)' },
  { value: 'best_player', label: 'Best player (player)' },
];

export function AdminSubmitFinalPredictionForm({
  participantId,
}: AdminSubmitFinalPredictionFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [itemKind, setItemKind] = useState<ItemKind>('champion');
  const [targetId, setTargetId] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setErrorField(null);
    setSuccess(null);

    startTransition(async () => {
      try {
        const response = await fetch('/api/admin/final-predictions', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            participant_id: participantId,
            item_kind: itemKind,
            target_id: targetId.trim(),
            reason,
            source_citation: source,
          }),
        });
        if (response.ok) {
          setReason('');
          setSource('');
          setSuccess('Final prediction submitted on behalf.');
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
    <form
      data-testid="admin-submit-final-prediction-form"
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-card p-6 flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold text-foreground">
        Submit final prediction on behalf
      </h2>
      <p className="text-xs text-muted-foreground">
        Lock-bypass is applied by the admin SP if the finals window has closed.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Item</span>
        <select
          name="item_kind"
          value={itemKind}
          onChange={(e) => setItemKind(e.target.value as ItemKind)}
          disabled={pending}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        >
          {ITEM_KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Target id (team uuid for champion/runner_up, player uuid for
          top_scorer/best_player)
        </span>
        <input
          name="target_id"
          type="text"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={pending}
          required
          aria-invalid={errorField === 'target_id' || undefined}
          className="rounded border border-border px-2 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="00000000-0000-0000-0000-000000000000"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Reason <span className="text-destructive">*</span>
        </span>
        <textarea
          name="reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'reason' || undefined}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="e.g. on-behalf-of override after participant unavailable"
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
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="https://internal.example/ticket/..."
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
          data-testid="admin-submit-final-prediction-form-error"
          role="alert"
          aria-live="polite"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      {success ? (
        <div
          data-testid="admin-submit-final-prediction-form-success"
          role="status"
          aria-live="polite"
          className="rounded border border-win/40 bg-win/10 px-3 py-2 text-sm text-win"
        >
          {success}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          data-testid="admin-submit-final-prediction-submit"
          className="rounded border border-blue-700 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Submitting…' : 'Submit final prediction'}
        </button>
      </div>
    </form>
  );
}
