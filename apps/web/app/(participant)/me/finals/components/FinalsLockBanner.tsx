'use client';

import { useEffect, useState } from 'react';

import { formatRemainingUntilFirstKickoff } from '../../../../../lib/final-predictions/countdown';

/**
 * Display-only lock banner for the `/me/finals` picker page — Slice 004 (T019).
 *
 * Renders a single header strip with one of three states:
 *
 *   - `lockState === 'editable'`: live countdown "locks in 5d 2h" / "locks in
 *     30 min", refreshed once per second via `setInterval(1000)`. The text
 *     comes from `formatRemainingUntilFirstKickoff(firstKickoffUtc, now)`,
 *     which already collapses sub-minute deltas to "locks in 1 min" so the
 *     last visible label is never "locks in 0 min".
 *
 *   - `lockState === 'locked'`: a static "Picks are locked. First match has
 *     kicked off." message — no countdown.
 *
 *   - When the server says `editable` but the local clock has drifted past
 *     `firstKickoffUtc`, the helper returns the literal string `"locked"`.
 *     That is OK — the server is still authoritative (Constitution
 *     Principle III) and the next `router.refresh()` will flip
 *     `lockState` to `'locked'` from the API.
 *
 * Display-only — the actual lock decision lives in
 * `public.is_final_prediction_locked()` and is surfaced through the API's
 * `lock_state` field. Any client-side clock skew only affects the visible
 * countdown, NOT what the server will accept on submit.
 *
 * Hydration: the initial render uses `firstKickoffUtc` paired with `new
 * Date()` on the client mount. We avoid computing the countdown at SSR
 * time to prevent a hydration mismatch between server-rendered text and
 * the first client tick. Until the first effect runs the banner shows a
 * neutral "Loading countdown…" placeholder; for the `locked` branch the
 * server-rendered text is stable.
 *
 * @see specs/004-final-predictions/research.md § R-011 (dedicated page)
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 */
export interface FinalsLockBannerProps {
  /** ISO-8601 UTC kickoff of match #1, or null when not yet configured. */
  firstKickoffUtc: string | null;
  /** Server-authoritative lock state. Display only — re-checked on submit. */
  lockState: 'editable' | 'locked';
}

export function FinalsLockBanner({
  firstKickoffUtc,
  lockState,
}: FinalsLockBannerProps) {
  // `null` until the client mounts, then ticks every second. Keeping the
  // initial value `null` is what avoids the SSR/CSR text mismatch — the
  // server has no notion of "now" for the countdown.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    if (lockState !== 'editable') return;
    setNow(new Date());
    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [lockState]);

  if (lockState === 'locked') {
    return (
      <div
        data-testid="lock-banner"
        data-lock-state="locked"
        role="status"
        aria-live="polite"
        className="rounded-md border border-open/40 bg-open/10 px-4 py-3 text-sm text-open"
      >
        <span className="font-semibold">Picks are locked.</span>{' '}
        First match has kicked off.
      </div>
    );
  }

  const countdownLabel =
    now === null
      ? 'Loading countdown…'
      : formatRemainingUntilFirstKickoff(firstKickoffUtc, now);

  return (
    <div
      data-testid="lock-banner"
      data-lock-state="editable"
      role="status"
      aria-live="polite"
      className="rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-primary"
    >
      <span className="font-semibold">Final predictions are open.</span>{' '}
      <span data-testid="lock-banner-countdown">{countdownLabel}</span>
    </div>
  );
}
