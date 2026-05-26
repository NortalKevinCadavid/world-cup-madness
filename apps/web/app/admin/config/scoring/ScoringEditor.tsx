'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

/**
 * `ScoringEditor` — client companion to `/admin/config/scoring/page.tsx`
 * (Slice 008, Phase 5, T033, US3).
 *
 * Six independent edit-and-save flows on a single page, plus a read-only
 * "re-score pending" banner that mirrors what `/leaderboard` (Slice 005)
 * shows to participants. Each section has:
 *   - Its own input(s).
 *   - Its own validation error slot.
 *   - Its own Preview → <PreviewWarning> → Confirm → toast cycle.
 *   - Its own version_id (so a save to one key never collides with the
 *     `expected_version_id` guard on another).
 *
 * Sections:
 *   1. scoring.match_points.exact            (int 0..1000)
 *   2. scoring.match_points.correct_outcome  (int 0..1000)
 *   3. scoring.match_points.incorrect        (int 0..1000)
 *   4. scoring.final_pick_points             (int 0..1000)
 *   5. scoring.score_upper_bound             (int 0..999)
 *   6. scoring.tie_breaker_order             (string[] of 4 enum values,
 *                                             reordered via up/down buttons)
 *
 * Why a client component:
 *   T033 demands six interactive input/preview/confirm flows. The server
 *   page (page.tsx) just gates + hydrates initial state and computes
 *   `rescorePending`.
 *
 * Wire format (REUSES T027 routes — no new route handlers in this task):
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Error envelope (both routes): `{ error: { code, message, field? } }`
 *     where `code` is one of `WCG01`..`WCG07` or `INTERNAL`/`BAD_REQUEST`.
 *
 * DOM contract (T034 / T035 selectors):
 *   - `[data-testid="scoring-editor"]`
 *   - `[data-testid="scoring-rescore-pending-banner"]` (when rescorePending)
 *   - Per numeric key (testid alias used: 'match-points-exact',
 *     'match-points-correct-outcome', 'match-points-incorrect',
 *     'final-pick-points', 'score-upper-bound'):
 *       - `[data-testid="scoring-${alias}-input"]`
 *       - `[data-testid="scoring-${alias}-save"]`
 *       - `[data-testid="scoring-${alias}-error"]`
 *       - `[data-testid="scoring-${alias}-toast"]`
 *   - Tie-breaker:
 *       - `[data-testid="tie-breaker-list"]`
 *       - `[data-testid="tie-breaker-item"]` (with `data-rank` 1-based +
 *         `data-key`)
 *       - `[data-testid="tie-breaker-move-up"][data-key="..."]`
 *       - `[data-testid="tie-breaker-move-down"][data-key="..."]`
 *       - `[data-testid="tie-breaker-save"]`
 *       - `[data-testid="tie-breaker-error"]`
 *       - `[data-testid="tie-breaker-toast"]`
 *   - Shared (from <PreviewWarning>):
 *       - `[data-testid="config-preview-warning"]`
 *
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/lib/config-validators.ts
 * @see specs/008-configuration/tasks.md § T033
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NumericKey =
  | 'scoring.match_points.exact'
  | 'scoring.match_points.correct_outcome'
  | 'scoring.match_points.incorrect'
  | 'scoring.final_pick_points'
  | 'scoring.score_upper_bound';

/**
 * Short, hyphenated alias used for DOM `data-testid` suffixes. Matches the
 * T033 task body verbatim.
 */
const NUMERIC_TESTID_ALIAS: Record<NumericKey, string> = {
  'scoring.match_points.exact': 'match-points-exact',
  'scoring.match_points.correct_outcome': 'match-points-correct-outcome',
  'scoring.match_points.incorrect': 'match-points-incorrect',
  'scoring.final_pick_points': 'final-pick-points',
  'scoring.score_upper_bound': 'score-upper-bound',
};

const NUMERIC_LABELS: Record<NumericKey, { title: string; help: string }> = {
  'scoring.match_points.exact': {
    title: 'Exact score points',
    help: 'Points awarded when the predicted score matches the final score exactly. Allowed range: 0..1000.',
  },
  'scoring.match_points.correct_outcome': {
    title: 'Correct outcome points',
    help: 'Points awarded when the predicted winner is correct but the score is not exact. Allowed range: 0..1000.',
  },
  'scoring.match_points.incorrect': {
    title: 'Incorrect prediction points',
    help: 'Points awarded for a wrong prediction (typically 0). Allowed range: 0..1000.',
  },
  'scoring.final_pick_points': {
    title: 'Final pick bonus',
    help: 'Bonus awarded if a participant correctly predicted the tournament winner. Allowed range: 0..1000.',
  },
  'scoring.score_upper_bound': {
    title: 'Score upper bound',
    help: 'Maximum allowed value for a single team’s score in any prediction (used as a sanity cap by the prediction form). Allowed range: 0..999.',
  },
};

/** All four allowed tie-breaker enum values, in canonical default order. */
const TIE_BREAKER_LABELS: Record<string, string> = {
  points_total: 'Points total',
  exact_match_count: 'Exact match count',
  final_pick_correct: 'Final pick correct',
  earliest_submission: 'Earliest submission',
};

const TIE_BREAKER_ALLOWED = [
  'points_total',
  'exact_match_count',
  'final_pick_correct',
  'earliest_submission',
] as const;

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

/** Per-section state. Re-used for both numeric and tie-breaker sections
 *  (the value type differs: number vs string[]). */
type SectionState<V> = {
  value: V;
  versionId: string;
  reason: string;
  sourceCitation: string;
  validationError: string | null;
  preview: PreviewResult | null;
  pendingValue: V | null;
  error: string | null;
  toast: string | null;
};

export type ScoringInitialState = {
  numeric: Record<NumericKey, { value: number; versionId: string }>;
  tieBreaker: { value: string[]; versionId: string };
};

interface ScoringEditorProps {
  initialState: ScoringInitialState;
  rescorePending: boolean;
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export function ScoringEditor({
  initialState,
  rescorePending,
}: ScoringEditorProps): JSX.Element {
  const router = useRouter();

  // --- Numeric section state (five independent slices). -----------------------
  const [numericState, setNumericState] = useState<
    Record<NumericKey, SectionState<number>>
  >(() => {
    const init = {} as Record<NumericKey, SectionState<number>>;
    (Object.keys(NUMERIC_TESTID_ALIAS) as NumericKey[]).forEach((k) => {
      init[k] = {
        value: initialState.numeric[k].value,
        versionId: initialState.numeric[k].versionId,
        reason: '',
        sourceCitation: '',
        validationError: null,
        preview: null,
        pendingValue: null,
        error: null,
        toast: null,
      };
    });
    return init;
  });

  // --- Tie-breaker section state. --------------------------------------------
  const [tieBreaker, setTieBreaker] = useState<SectionState<string[]>>({
    value: [...initialState.tieBreaker.value],
    versionId: initialState.tieBreaker.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
  });

  const [pending, startTransition] = useTransition();

  // --- Helper: shallow-patch a single numeric section. -----------------------
  function patchNumeric(
    key: NumericKey,
    patch: Partial<SectionState<number>>,
  ): void {
    setNumericState((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function patchTieBreaker(patch: Partial<SectionState<string[]>>): void {
    setTieBreaker((prev) => ({ ...prev, ...patch }));
  }

  // ---------------------------------------------------------------------------
  // Numeric: input change → validate locally.
  // ---------------------------------------------------------------------------
  function handleNumericChange(key: NumericKey, raw: string): void {
    if (raw === '') {
      patchNumeric(key, { validationError: 'Value required' });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      patchNumeric(key, { validationError: 'Must be an integer' });
      return;
    }
    const result = validateConfigValue(key, parsed);
    if (!result.ok) {
      patchNumeric(key, { value: parsed, validationError: result.error });
    } else {
      patchNumeric(key, { value: parsed, validationError: null });
    }
  }

  // ---------------------------------------------------------------------------
  // Numeric: Save (per-section). Runs Preview → PreviewWarning gates →
  // Confirm. Each Save uses its own version_id + reason/citation/state.
  // ---------------------------------------------------------------------------
  async function handleNumericPreview(key: NumericKey): Promise<void> {
    const section = numericState[key];
    if (!section.reason.trim()) {
      patchNumeric(key, {
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (section.validationError) {
      patchNumeric(key, {
        error: section.validationError,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (section.value === initialState.numeric[key].value) {
      // No-op vs the originally hydrated row → block, mirror T030.
      patchNumeric(key, {
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const localCheck = validateConfigValue(key, section.value);
    if (!localCheck.ok) {
      patchNumeric(key, {
        validationError: localCheck.error,
        error: localCheck.error,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patchNumeric(key, { error: null, toast: null });

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key, value: section.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchNumeric(key, {
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchNumeric(key, {
        preview: previewResult,
        pendingValue: section.value,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchNumeric(key, {
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleNumericConfirm(key: NumericKey, token: string | null): void {
    const section = numericState[key];
    if (section.pendingValue === null) return;
    const pendingValue = section.pendingValue;
    patchNumeric(key, { error: null });

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key,
            value: pendingValue,
            expected_version_id: section.versionId,
            reason: section.reason.trim(),
            source_citation: section.sourceCitation.trim() || null,
            acknowledge_token: token,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          // Snap initialState to the new value so further "no-op" checks key
          // off the latest server state (matches T030 single-save UX).
          initialState.numeric[key] = {
            value: pendingValue,
            versionId: newVersionId,
          };
          patchNumeric(key, {
            value: pendingValue,
            versionId: newVersionId,
            preview: null,
            pendingValue: null,
            reason: '',
            sourceCitation: '',
            toast: `Updated to version ${newVersionId}`,
          });
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          const code =
            (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
          const message =
            (body as { error?: { message?: string } })?.error?.message ??
            'Update failed';
          patchNumeric(key, {
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchNumeric(key, {
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  function handleNumericCancel(key: NumericKey): void {
    patchNumeric(key, { preview: null, pendingValue: null });
  }

  // ---------------------------------------------------------------------------
  // Tie-breaker: reordering via up/down buttons.
  // ---------------------------------------------------------------------------
  function handleMove(idx: number, dir: -1 | 1): void {
    const next = [...tieBreaker.value];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target] as string, next[idx] as string];
    const validation = validateConfigValue(
      'scoring.tie_breaker_order',
      next,
    );
    patchTieBreaker({
      value: next,
      // Reset preview/pendingValue on any reorder so the user must re-preview
      // before confirming.
      preview: null,
      pendingValue: null,
      validationError: validation.ok ? null : validation.error,
    });
  }

  async function handleTieBreakerPreview(): Promise<void> {
    if (!tieBreaker.reason.trim()) {
      patchTieBreaker({
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (tieBreaker.validationError) {
      patchTieBreaker({
        error: tieBreaker.validationError,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const noChange =
      tieBreaker.value.length === initialState.tieBreaker.value.length &&
      tieBreaker.value.every(
        (v, i) => v === initialState.tieBreaker.value[i],
      );
    if (noChange) {
      patchTieBreaker({
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const localCheck = validateConfigValue(
      'scoring.tie_breaker_order',
      tieBreaker.value,
    );
    if (!localCheck.ok) {
      patchTieBreaker({
        validationError: localCheck.error,
        error: localCheck.error,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patchTieBreaker({ error: null, toast: null });

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: 'scoring.tie_breaker_order',
          value: tieBreaker.value,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchTieBreaker({
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchTieBreaker({
        preview: previewResult,
        pendingValue: [...tieBreaker.value],
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchTieBreaker({
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleTieBreakerConfirm(token: string | null): void {
    const pendingValue = tieBreaker.pendingValue;
    if (!pendingValue) return;
    patchTieBreaker({ error: null });

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'scoring.tie_breaker_order',
            value: pendingValue,
            expected_version_id: tieBreaker.versionId,
            reason: tieBreaker.reason.trim(),
            source_citation: tieBreaker.sourceCitation.trim() || null,
            acknowledge_token: token,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          initialState.tieBreaker = {
            value: [...pendingValue],
            versionId: newVersionId,
          };
          patchTieBreaker({
            value: [...pendingValue],
            versionId: newVersionId,
            preview: null,
            pendingValue: null,
            reason: '',
            sourceCitation: '',
            toast: `Updated to version ${newVersionId}`,
          });
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          const code =
            (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
          const message =
            (body as { error?: { message?: string } })?.error?.message ??
            'Update failed';
          patchTieBreaker({
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchTieBreaker({
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  function handleTieBreakerCancel(): void {
    patchTieBreaker({ preview: null, pendingValue: null });
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <div data-testid="scoring-editor" className="flex flex-col gap-8">
      {rescorePending && (
        <div
          data-testid="scoring-rescore-pending-banner"
          role="status"
          className="rounded-lg border border-amber-400 bg-open/10 p-4 text-sm text-open"
        >
          <p className="font-semibold">Re-score pending</p>
          <p className="mt-1">
            One or more scoring values have been edited since the last full
            recalc. Visit{' '}
            <code className="font-mono text-xs">/admin/recalc</code> to
            apply the new scoring rules to existing score_records.
          </p>
        </div>
      )}

      {/* Five numeric sections. */}
      {(Object.keys(NUMERIC_TESTID_ALIAS) as NumericKey[]).map((key) => {
        const alias = NUMERIC_TESTID_ALIAS[key];
        const label = NUMERIC_LABELS[key];
        const section = numericState[key];
        const isUpper = key === 'scoring.score_upper_bound';
        const max = isUpper ? 999 : 1000;
        const hasValidationError = section.validationError !== null;
        const hasError = section.error !== null;
        const hasToast = section.toast !== null;

        return (
          <section
            key={key}
            data-section-key={key}
            className="flex flex-col gap-3 rounded border border-border bg-card p-4"
          >
            <header className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-foreground">
                {label.title}
              </h2>
              <p className="text-xs font-mono text-muted-foreground">{key}</p>
              <p className="text-sm text-muted-foreground">{label.help}</p>
            </header>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-muted-foreground">
                Value
              </span>
              <input
                type="number"
                min={0}
                max={max}
                step={1}
                value={section.value}
                onChange={(e) => handleNumericChange(key, e.target.value)}
                data-testid={`scoring-${alias}-input`}
                aria-invalid={hasValidationError ? true : undefined}
                disabled={pending}
                className="w-40 rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-muted-foreground">
                Reason (required)
              </span>
              <textarea
                value={section.reason}
                onChange={(e) =>
                  patchNumeric(key, { reason: e.target.value })
                }
                data-testid={`scoring-${alias}-reason`}
                rows={2}
                required
                disabled={pending}
                className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium text-muted-foreground">
                Source citation (optional)
              </span>
              <input
                type="text"
                value={section.sourceCitation}
                onChange={(e) =>
                  patchNumeric(key, { sourceCitation: e.target.value })
                }
                data-testid={`scoring-${alias}-source-citation`}
                disabled={pending}
                className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
              />
            </label>

            <div>
              <button
                type="button"
                onClick={() => void handleNumericPreview(key)}
                disabled={pending || hasValidationError}
                data-testid={`scoring-${alias}-save`}
                className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
            </div>

            {section.preview && (
              <PreviewWarning
                preview={section.preview}
                onConfirm={(token) => handleNumericConfirm(key, token)}
                onCancel={() => handleNumericCancel(key)}
              />
            )}

            {hasError && (
              <div
                data-testid={`scoring-${alias}-error`}
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {section.error}
              </div>
            )}
            {hasToast && (
              <div
                data-testid={`scoring-${alias}-toast`}
                role="status"
                className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
              >
                {section.toast}
              </div>
            )}

            <p className="text-xs text-muted-foreground/60">
              Current version: <span className="font-mono">{section.versionId}</span>
            </p>
          </section>
        );
      })}

      {/* Tie-breaker section. */}
      <section
        data-section-key="scoring.tie_breaker_order"
        className="flex flex-col gap-3 rounded border border-border bg-card p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">
            Tie-breaker order
          </h2>
          <p className="text-xs font-mono text-muted-foreground">
            scoring.tie_breaker_order
          </p>
          <p className="text-sm text-muted-foreground">
            Order in which tie-breakers are applied to rank participants with
            identical point totals. Use the up/down arrows to reorder, then
            press Save. The list must contain all four allowed values
            ({TIE_BREAKER_ALLOWED.join(', ')}).
          </p>
        </header>

        <ol
          data-testid="tie-breaker-list"
          aria-label="Tie-breaker order"
          className="flex flex-col gap-2"
        >
          {tieBreaker.value.map((key, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === tieBreaker.value.length - 1;
            const label = TIE_BREAKER_LABELS[key] ?? key;
            return (
              <li
                key={`${idx}-${key}`}
                data-testid="tie-breaker-item"
                data-rank={idx + 1}
                data-key={key}
                className="flex items-center justify-between rounded border border-border bg-muted/30 p-2"
              >
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <span className="inline-block w-6 text-right font-mono text-muted-foreground">
                    {idx + 1}.
                  </span>
                  <span className="font-medium">{label}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    ({key})
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleMove(idx, -1)}
                    data-testid="tie-breaker-move-up"
                    data-key={key}
                    aria-label={`Move ${label} up`}
                    disabled={pending || isFirst}
                    className="rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {'↑'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMove(idx, 1)}
                    data-testid="tie-breaker-move-down"
                    data-key={key}
                    aria-label={`Move ${label} down`}
                    disabled={pending || isLast}
                    className="rounded border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {'↓'}
                  </button>
                </span>
              </li>
            );
          })}
        </ol>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Reason (required)
          </span>
          <textarea
            value={tieBreaker.reason}
            onChange={(e) =>
              patchTieBreaker({ reason: e.target.value })
            }
            data-testid="tie-breaker-reason"
            rows={2}
            required
            disabled={pending}
            className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Source citation (optional)
          </span>
          <input
            type="text"
            value={tieBreaker.sourceCitation}
            onChange={(e) =>
              patchTieBreaker({ sourceCitation: e.target.value })
            }
            data-testid="tie-breaker-source-citation"
            disabled={pending}
            className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handleTieBreakerPreview()}
            disabled={pending || tieBreaker.validationError !== null}
            data-testid="tie-breaker-save"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {tieBreaker.preview && (
          <PreviewWarning
            preview={tieBreaker.preview}
            onConfirm={(token) => handleTieBreakerConfirm(token)}
            onCancel={() => handleTieBreakerCancel()}
          />
        )}

        {tieBreaker.error && (
          <div
            data-testid="tie-breaker-error"
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {tieBreaker.error}
          </div>
        )}
        {tieBreaker.toast && (
          <div
            data-testid="tie-breaker-toast"
            role="status"
            className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
          >
            {tieBreaker.toast}
          </div>
        )}

        <p className="text-xs text-muted-foreground/60">
          Current version:{' '}
          <span className="font-mono">{tieBreaker.versionId}</span>
        </p>
      </section>

      {pending && (
        <div className="text-sm text-muted-foreground">Submitting…</div>
      )}
    </div>
  );
}
