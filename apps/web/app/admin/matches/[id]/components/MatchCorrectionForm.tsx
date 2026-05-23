'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { MatchResultsInitial } from '../page';

/**
 * `MatchCorrectionForm` — client-side correction form for
 * `/admin/matches/[id]` (Slice 006, Phase 3, US1, T016).
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/matches/[id]` — "Correct Score" form.
 *   - apps/web/app/api/admin/match-results/route.ts (T015) — POST body shape:
 *       { match_id, home_score, away_score,
 *         home_score_for_scoring, away_score_for_scoring,
 *         result_status, reason, source_citation }.
 *
 * DOM contract (locked by T011 Playwright specs):
 *   - Form root:   `[data-testid="admin-match-correct-score-form"]`
 *   - Inputs:      `input[name="home_score"]`, `input[name="away_score"]`,
 *                  `textarea[name="reason"]`, `input[name="source_citation"]`
 *   - Submit:      `[data-testid="admin-match-correct-score-submit"]`
 *                  (also a `button[type="submit"]` inside the form, which the
 *                  test's OR-selector accepts).
 *   - Field error: `[data-testid="field-error-reason"]` for the empty-reason
 *                  case; the test asserts `body.error.field === 'reason'`
 *                  on the network response so the inline DOM marker is for
 *                  UX, not for the test bytes per se.
 *
 * Behaviour:
 *   - On submit: POST to `/api/admin/match-results` with the locked body
 *     shape. The route handler (T015) does zod validation + admin gate +
 *     SP delegation; on 4xx with `error.field` we surface a field-level
 *     inline error; on success we `router.refresh()` so the server page
 *     refetches `match_results` + audit history.
 *   - `useTransition` keeps the rest of the page interactive during the
 *     in-flight POST.
 *   - Reason / source_citation are NOT pre-filled — admins must re-justify
 *     each correction (FR-002).
 *
 * Constitution Principle III: NO scoring math here. The form is a thin
 * wrapper over the route handler / SP.
 *
 * Accessibility:
 *   - Every input is wrapped in a `<label>` with visible text.
 *   - Field-level errors use `role="alert" aria-live="polite"` and the input
 *     carries `aria-invalid` when its field is the source of the error.
 *   - Submit button visibly transitions to "Submitting…" while pending.
 *
 * @see apps/web/app/admin/matches/[id]/page.tsx
 * @see apps/web/app/api/admin/match-results/route.ts
 */

interface MatchCorrectionFormProps {
  matchId: string;
  initial: MatchResultsInitial | null;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

const RESULT_STATUS_OPTIONS = [
  { value: 'regulation', label: 'Regulation (90 min)' },
  { value: 'extra_time', label: 'Extra time' },
  { value: 'penalties_shootout', label: 'Penalties / shootout' },
] as const;

export function MatchCorrectionForm({
  matchId,
  initial,
}: MatchCorrectionFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [homeScore, setHomeScore] = useState<number>(initial?.home_score ?? 0);
  const [awayScore, setAwayScore] = useState<number>(initial?.away_score ?? 0);
  const [homeScoreForScoring, setHomeScoreForScoring] = useState<number>(
    initial?.home_score_for_scoring ?? initial?.home_score ?? 0,
  );
  const [awayScoreForScoring, setAwayScoreForScoring] = useState<number>(
    initial?.away_score_for_scoring ?? initial?.away_score ?? 0,
  );
  const [resultStatus, setResultStatus] = useState<string>(
    initial?.result_status === 'extra_time' ||
      initial?.result_status === 'penalties_shootout'
      ? initial.result_status
      : 'regulation',
  );
  const [reason, setReason] = useState<string>('');
  const [sourceCitation, setSourceCitation] = useState<string>('');

  // Combined error state: `field` may be set to scope the message to one
  // input; otherwise it surfaces as a form-level banner.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setErrorField(null);

    startTransition(async () => {
      try {
        const response = await fetch('/api/admin/match-results', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            match_id: matchId,
            home_score: homeScore,
            away_score: awayScore,
            home_score_for_scoring: homeScoreForScoring,
            away_score_for_scoring: awayScoreForScoring,
            result_status: resultStatus,
            reason,
            source_citation: sourceCitation,
          }),
        });

        if (response.ok) {
          // Reset justification fields so a subsequent correction must be
          // re-justified per FR-002. Scores retain the just-submitted values
          // so a quick re-submit doesn't surprise the admin.
          setReason('');
          setSourceCitation('');
          router.refresh();
          return;
        }

        const body = (await response.json().catch(() => null)) as
          | ErrorEnvelope
          | null;
        const message =
          body?.error?.message ??
          body?.error?.reason ??
          `Submit failed (${response.status})`;
        setErrorMessage(message);
        setErrorField(body?.error?.field ?? null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Network error');
        setErrorField(null);
      }
    });
  }

  return (
    <form
      data-testid="admin-match-correct-score-form"
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-card p-6 flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold text-foreground">
        Correct match score
      </h2>
      <p className="text-xs text-muted-foreground">
        Every correction is captured in the audit log with the actor, the
        previous and new values, the reason, and the source citation.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Home score</span>
          <input
            name="home_score"
            type="number"
            min={0}
            max={99}
            step={1}
            value={homeScore}
            onChange={(e) =>
              setHomeScore(Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={pending}
            required
            aria-invalid={errorField === 'home_score' || undefined}
            className="rounded border border-border px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-muted"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Away score</span>
          <input
            name="away_score"
            type="number"
            min={0}
            max={99}
            step={1}
            value={awayScore}
            onChange={(e) =>
              setAwayScore(Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={pending}
            required
            aria-invalid={errorField === 'away_score' || undefined}
            className="rounded border border-border px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-muted"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">
            Home score (for scoring)
          </span>
          <input
            name="home_score_for_scoring"
            type="number"
            min={0}
            max={99}
            step={1}
            value={homeScoreForScoring}
            onChange={(e) =>
              setHomeScoreForScoring(Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={pending}
            required
            className="rounded border border-border px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-muted"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">
            Away score (for scoring)
          </span>
          <input
            name="away_score_for_scoring"
            type="number"
            min={0}
            max={99}
            step={1}
            value={awayScoreForScoring}
            onChange={(e) =>
              setAwayScoreForScoring(Number.parseInt(e.target.value, 10) || 0)
            }
            disabled={pending}
            required
            className="rounded border border-border px-2 py-1.5 tabular-nums focus:border-blue-500 focus:outline-none disabled:bg-muted"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Result status</span>
        <select
          name="result_status"
          value={resultStatus}
          onChange={(e) => setResultStatus(e.target.value)}
          disabled={pending}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        >
          {RESULT_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
            errorField === 'reason' ? 'field-error-reason' : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="e.g. FIFA Bureau decision overturning provider score"
        />
        {errorField === 'reason' && errorMessage ? (
          <span
            id="field-error-reason"
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
              ? 'field-error-source_citation'
              : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="https://fifa.example/m1"
        />
        {errorField === 'source_citation' && errorMessage ? (
          <span
            id="field-error-source_citation"
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
          data-testid="admin-match-correct-score-form-error"
          role="alert"
          aria-live="polite"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          data-testid="admin-match-correct-score-submit"
          className="rounded border border-blue-700 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Submitting…' : 'Apply correction'}
        </button>
      </div>
    </form>
  );
}
