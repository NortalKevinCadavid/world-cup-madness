'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { Prediction } from '../../../../lib/predictions/types';

/**
 * Inline prediction-entry form — Slice 003 (T016).
 *
 * Client component embedded into each editable row on `/matches`. Submits
 * to `POST /api/predictions` (the route handler from T015 runs the
 * SECURITY DEFINER stored procedure which is the authoritative gate for
 * eligibility, validation, and the lock check). On success it calls
 * `router.refresh()` so the server component re-renders the new active
 * prediction and (potentially) any updated lock state.
 *
 * NEVER duplicates the lock check in JS — Constitution Principle III
 * keeps the rule in SQL. The `lockState` prop here is a **server-computed
 * hint** the parent server component derives from `kickoff_utc + status`;
 * it controls whether to render the form vs. a read-only "your pick"
 * pill, but the server still rejects late submissions on its own clock
 * (Principle VI).
 *
 * The countdown label is display-only and non-load-bearing (Principle
 * III): if the client clock is wrong, the visible string drifts but the
 * server's lock decision is unaffected.
 *
 * Accessibility:
 *   - `aria-label` on each numeric input (visually-hidden label via
 *     `sr-only`).
 *   - Error and countdown text use `aria-live="polite"` so a screen
 *     reader announces them when they change.
 *
 * @see specs/003-match-predictions/research.md § R-014
 * @see specs/003-match-predictions/contracts/predictions.write.md
 */

interface PredictionFormProps {
  /** `matches.id` this row is for. */
  matchId: string;
  /** Current active prediction for this match (or `null` if none yet). */
  existingPrediction: Prediction | null;
  /**
   * Server-computed display hint. `'locked'` → render read-only pill;
   * `'editable'` → render the input form. This is NOT a security gate —
   * the route handler re-checks against the database clock.
   *
   * TODO(T031, US4): replace with the actual `lock_state` field once it
   * lands on the `Match` shape from `/api/matches`.
   */
  lockState: 'editable' | 'locked';
  /**
   * Optional locale-aware countdown ("locks in 2h 15m") rendered next to
   * the submit button. Computed by the parent server component via
   * `formatRemainingUntilLock(...)`. Display only.
   */
  countdownLabel?: string;
}

export function PredictionForm({
  matchId,
  existingPrediction,
  lockState,
  countdownLabel,
}: PredictionFormProps) {
  const router = useRouter();
  const [home, setHome] = useState<string>(
    existingPrediction ? existingPrediction.predicted_home.toString() : '',
  );
  const [away, setAway] = useState<string>(
    existingPrediction ? existingPrediction.predicted_away.toString() : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (lockState === 'locked') {
    if (existingPrediction) {
      return (
        <div className="text-sm text-slate-600">
          Your pick:{' '}
          <span className="font-semibold">
            {existingPrediction.predicted_home}-{existingPrediction.predicted_away}
          </span>{' '}
          <span className="text-locked">(locked)</span>
        </div>
      );
    }
    return (
      <div className="text-sm italic text-slate-500">No pick — locked</div>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const homeNum = Number.parseInt(home, 10);
    const awayNum = Number.parseInt(away, 10);
    if (Number.isNaN(homeNum) || Number.isNaN(awayNum)) {
      setError('Enter both scores as integers');
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch('/api/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            match_id: matchId,
            home: homeNum,
            away: awayNum,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: { message?: string } }
            | null;
          setError(
            body?.error?.message ?? `Submit failed (${response.status})`,
          );
          return;
        }

        // Server has persisted the new active row. Trigger an SSR
        // re-render so the parent picks up the latest prediction and
        // (if the match just locked) the updated lock_state.
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Home score</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          value={home}
          onChange={(e) => setHome(e.target.value)}
          disabled={isPending}
          aria-label="Home score"
          className="w-12 rounded border border-border px-1 py-0.5 text-center focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <span aria-hidden>-</span>
      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only">Away score</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          value={away}
          onChange={(e) => setAway(e.target.value)}
          disabled={isPending}
          aria-label="Away score"
          className="w-12 rounded border border-border px-1 py-0.5 text-center focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="rounded border border-blue-700 bg-primary px-2 py-0.5 text-sm font-medium text-white hover:bg-primary disabled:opacity-50"
      >
        {existingPrediction ? 'Update' : 'Submit'}
      </button>
      {countdownLabel ? (
        <span className="text-xs text-slate-500" aria-live="polite">
          {countdownLabel}
        </span>
      ) : null}
      {error ? (
        <span className="text-xs text-destructive" role="alert" aria-live="polite">
          {error}
        </span>
      ) : null}
    </form>
  );
}
