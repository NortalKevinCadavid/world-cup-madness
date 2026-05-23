'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `MatchUpdateForm` — client-side form for updating `matches.status` and/or
 * `matches.kickoff_utc` on `/admin/matches/[id]` (Slice 006, Phase 5, US3,
 * T031). Sibling to T016's `MatchCorrectionForm`; lives on the same page.
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/matches/[id]` — "Update Status / Kickoff" form.
 *   - apps/web/app/api/admin/matches/[id]/route.ts (T031) — POST body shape:
 *       { status?, kickoff_utc?, reason, source_citation }.
 *
 * DOM contract (locked by T028 Playwright spec
 * slice-006-admin-match-update-status-postponed.spec.ts):
 *   - Status:      `select[name="status"]`
 *                  options: scheduled | in_progress | finished | postponed |
 *                  cancelled.
 *   - Kickoff:     `input[name="kickoff_utc"][type="datetime-local"]`
 *                  (left blank if no change).
 *   - Reason:      `textarea[name="reason"]`
 *   - Source:      `input[name="source_citation"]`
 *   - Submit:      `[data-testid="admin-match-update-submit"]`
 *                  Distinct from `[data-testid="admin-match-correct-score-submit"]`
 *                  which belongs to the sibling MatchCorrectionForm.
 *
 * The test's xpath ancestor lookup
 * (`updateSubmit.locator("xpath=ancestor::form[1]")`) requires that this
 * component renders a `<form>` element wrapping the submit button — keep
 * the immediate <form> wrapper to satisfy that selector.
 *
 * Behaviour:
 *   - On submit: POST to `/api/admin/matches/[matchId]` with the body shape
 *     above. The route handler does zod validation + admin gate + SP
 *     dispatch; on 4xx with `error.field` we surface a field-level inline
 *     error; on success we `router.refresh()` so the server page refetches
 *     the matches row + audit history + the sibling MatchCorrectionForm
 *     picks up any score-related state.
 *   - `useTransition` keeps the rest of the page interactive while the
 *     POST is in flight.
 *   - Reason / source_citation are NOT pre-filled — admins must re-justify
 *     each update (FR-002).
 *   - kickoff_utc is provided as a `datetime-local` input which yields a
 *     local-time string like '2026-06-01T20:00'. We convert that to ISO
 *     UTC via Date#toISOString() before POSTing so the SP receives a
 *     timestamptz-parseable string.
 *
 * Constitution Principle III: NO scoring math here.
 */

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

interface MatchUpdateFormProps {
  matchId: string;
  initial: {
    status: string;
    kickoff_utc: string;
  };
}

type MatchStatus =
  | 'scheduled'
  | 'in_progress'
  | 'finished'
  | 'postponed'
  | 'cancelled';

const MATCH_STATUS_OPTIONS: ReadonlyArray<{
  value: MatchStatus;
  label: string;
}> = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'postponed', label: 'Postponed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function coerceInitialStatus(value: string): MatchStatus {
  if (
    value === 'scheduled' ||
    value === 'in_progress' ||
    value === 'finished' ||
    value === 'postponed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  return 'scheduled';
}

export function MatchUpdateForm({ matchId, initial }: MatchUpdateFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [status, setStatus] = useState<MatchStatus>(
    coerceInitialStatus(initial.status),
  );
  // datetime-local takes 'YYYY-MM-DDTHH:MM' (no seconds, no timezone). We
  // intentionally start empty so an unmodified submission omits kickoff
  // (yielding partial-update semantics in the SP).
  const [kickoffLocal, setKickoffLocal] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [sourceCitation, setSourceCitation] = useState<string>('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setErrorField(null);
    setSuccessMessage(null);

    // Build the body. Only send `status` if it differs from the initial
    // value (partial-update semantics in the SP via NULL = no change).
    // Only send `kickoff_utc` if the admin typed a value.
    const statusChanged = status !== coerceInitialStatus(initial.status);
    let kickoffIso: string | null = null;
    if (kickoffLocal.length > 0) {
      // datetime-local yields a local-time string; Date#toISOString() emits
      // a UTC ISO. This is what the SP's timestamptz coercion expects.
      const parsed = new Date(kickoffLocal);
      if (Number.isNaN(parsed.getTime())) {
        setErrorMessage('Invalid kickoff time.');
        setErrorField('kickoff_utc');
        return;
      }
      kickoffIso = parsed.toISOString();
    }

    const body: Record<string, unknown> = {
      reason,
      source_citation: sourceCitation,
    };
    if (statusChanged) body.status = status;
    if (kickoffIso !== null) body.kickoff_utc = kickoffIso;

    startTransition(async () => {
      try {
        const response = await fetch(`/api/admin/matches/${matchId}`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(body),
        });

        if (response.ok) {
          setReason('');
          setSourceCitation('');
          setKickoffLocal('');
          setSuccessMessage('Match updated.');
          router.refresh();
          return;
        }

        const respBody = (await response.json().catch(() => null)) as
          | ErrorEnvelope
          | null;
        const message =
          respBody?.error?.message ??
          respBody?.error?.reason ??
          `Submit failed (${response.status})`;
        setErrorMessage(message);
        setErrorField(respBody?.error?.field ?? null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Network error');
        setErrorField(null);
      }
    });
  }

  return (
    <form
      data-testid="admin-match-update-form"
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-card p-6 flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold text-foreground">
        Update status / kickoff
      </h2>
      <p className="text-xs text-muted-foreground">
        Either field may be left unchanged. Slice 003&apos;s kickoff-correction
        fan-out and Slice 004&apos;s first-kickoff-correction triggers fire
        automatically when the relevant column changes.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Status</span>
        <select
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as MatchStatus)}
          disabled={pending}
          aria-invalid={errorField === 'status' || undefined}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        >
          {MATCH_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Kickoff (UTC — leave blank for no change)
        </span>
        <input
          name="kickoff_utc"
          type="datetime-local"
          value={kickoffLocal}
          onChange={(e) => setKickoffLocal(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'kickoff_utc' || undefined}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        />
        {errorField === 'kickoff_utc' && errorMessage ? (
          <span
            id="field-error-kickoff_utc"
            data-testid="field-error-kickoff_utc"
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
          Reason <span className="text-destructive">*</span>
        </span>
        <textarea
          name="reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'reason' || undefined}
          aria-describedby={
            errorField === 'reason' ? 'field-error-match-update-reason' : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="e.g. Match postponed pending weather review"
        />
        {errorField === 'reason' && errorMessage ? (
          <span
            id="field-error-match-update-reason"
            data-testid="field-error-match-update-reason"
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
          Source citation (URL or document reference){' '}
          <span className="text-destructive">*</span>
        </span>
        <input
          name="source_citation"
          type="text"
          value={sourceCitation}
          onChange={(e) => setSourceCitation(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'source_citation' || undefined}
          aria-describedby={
            errorField === 'source_citation'
              ? 'field-error-match-update-source_citation'
              : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="https://fifa.example/notices/..."
        />
        {errorField === 'source_citation' && errorMessage ? (
          <span
            id="field-error-match-update-source_citation"
            data-testid="field-error-match-update-source_citation"
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
          data-testid="admin-match-update-form-error"
          role="alert"
          aria-live="polite"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      {successMessage ? (
        <div
          data-testid="admin-match-update-form-success"
          role="status"
          aria-live="polite"
          className="rounded border border-win/40 bg-win/10 px-3 py-2 text-sm text-win"
        >
          {successMessage}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          data-testid="admin-match-update-submit"
          className="rounded border border-blue-700 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Submitting…' : 'Apply update'}
        </button>
      </div>
    </form>
  );
}
