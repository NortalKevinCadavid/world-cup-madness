'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `AdminSubmitPredictionForm` — admin-on-behalf-of match prediction form.
 *
 * Slice 006 (Phase 7, T039). POSTs to `/api/admin/predictions` which calls
 * `admin_submit_prediction`. The admin RPC owns the lock-bypass decision
 * (per `admin-rpcs.write.md` § admin_submit_prediction Step 3).
 *
 * DOM contract:
 *   - Form root:  `[data-testid="admin-submit-prediction-form"]`
 *   - Match id:   `input[name="match_id"]`
 *   - Home:       `input[name="home_score"]`
 *   - Away:       `input[name="away_score"]`
 *   - Reason:     `textarea[name="reason"]`
 *   - Source:     `input[name="source_citation"]`
 *   - Submit:     `[data-testid="admin-submit-prediction-submit"]`
 */

interface AdminSubmitPredictionFormProps {
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

export function AdminSubmitPredictionForm({
  participantId,
}: AdminSubmitPredictionFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [matchId, setMatchId] = useState<string>('');
  const [home, setHome] = useState<number>(0);
  const [away, setAway] = useState<number>(0);
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
        const response = await fetch('/api/admin/predictions', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            participant_id: participantId,
            match_id: matchId.trim(),
            home_score: home,
            away_score: away,
            reason,
            source_citation: source,
          }),
        });

        if (response.ok) {
          setReason('');
          setSource('');
          setSuccess('Prediction submitted on behalf.');
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
      data-testid="admin-submit-prediction-form"
      onSubmit={handleSubmit}
      className="rounded-lg border border-neutral-200 bg-white p-6 flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold text-neutral-900">
        Submit prediction on behalf
      </h2>
      <p className="text-xs text-neutral-500">
        Every admin-submitted prediction is captured in the audit log with
        actor, target, previous &amp; new value, reason, and source citation.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-800">Match id</span>
        <input
          name="match_id"
          type="text"
          value={matchId}
          onChange={(e) => setMatchId(e.target.value)}
          disabled={pending}
          required
          aria-invalid={errorField === 'match_id' || undefined}
          className="rounded border border-neutral-300 px-2 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none disabled:bg-neutral-100"
          placeholder="00000000-0000-0000-0000-000000000000"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800">Home score</span>
          <input
            name="home_score"
            type="number"
            min={0}
            max={99}
            step={1}
            value={home}
            onChange={(e) => setHome(Number.parseInt(e.target.value, 10) || 0)}
            disabled={pending}
            required
            className="rounded border border-neutral-300 px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-800">Away score</span>
          <input
            name="away_score"
            type="number"
            min={0}
            max={99}
            step={1}
            value={away}
            onChange={(e) => setAway(Number.parseInt(e.target.value, 10) || 0)}
            disabled={pending}
            required
            className="rounded border border-neutral-300 px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-neutral-100"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-800">
          Reason <span className="text-red-600">*</span>
        </span>
        <textarea
          name="reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'reason' || undefined}
          className="rounded border border-neutral-300 px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-neutral-100"
          placeholder="e.g. submitted on behalf — participant unavailable during open window"
        />
        {errorField === 'reason' && errorMessage ? (
          <span
            data-testid="field-error-reason"
            role="alert"
            aria-live="polite"
            className="text-sm text-red-600"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-neutral-800">
          Source citation <span className="text-red-600">*</span>
        </span>
        <input
          name="source_citation"
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'source_citation' || undefined}
          className="rounded border border-neutral-300 px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-neutral-100"
          placeholder="https://internal.example/ticket/..."
        />
        {errorField === 'source_citation' && errorMessage ? (
          <span
            data-testid="field-error-source_citation"
            role="alert"
            aria-live="polite"
            className="text-sm text-red-600"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      {errorMessage && !errorField ? (
        <div
          data-testid="admin-submit-prediction-form-error"
          role="alert"
          aria-live="polite"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}

      {success ? (
        <div
          data-testid="admin-submit-prediction-form-success"
          role="status"
          aria-live="polite"
          className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {success}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          data-testid="admin-submit-prediction-submit"
          className="rounded border border-blue-700 bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Submitting…' : 'Submit prediction'}
        </button>
      </div>
    </form>
  );
}
