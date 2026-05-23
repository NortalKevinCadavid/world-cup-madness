'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

/**
 * `PhasesEditor` — client companion to `/admin/config/phases/page.tsx`
 * (Slice 008, Phase 6, T041, US4).
 *
 * Holds all interactivity for the `tournament.phase.current` editor:
 *   - 4-option radio group (`pre_tournament` → `group_stage` → `knockout`
 *     → `completed`), rank order 0..3.
 *   - Reason textarea (required) + Source-citation input (required —
 *     enforced client-side per T041; surfaces a friendlier error than the
 *     SQL backstop in slot 0077 ever would).
 *   - Backward-transition warning: when the selected rank is strictly less
 *     than the current rank (e.g. `completed` → `knockout`) the editor
 *     interposes a red confirmation banner. The action is allowed (spec edge
 *     case in `specs/008-configuration/contracts/admin-config-rpcs.write.md`)
 *     but flagged so it isn't done accidentally; the audit row is written
 *     unchanged either way.
 *   - Standard preview/confirm flow: POST `/api/admin/config/preview` →
 *     render `<PreviewWarning>` → on Acknowledge, POST
 *     `/api/admin/config/upsert` with the `acknowledge_token` (T027 routes —
 *     REUSED here, no new route handlers).
 *
 * Why a client component:
 *   T041 demands interactive radio + reason + source-citation + confirm
 *   flow with a synchronous backward-revert prompt. The server page
 *   (page.tsx) just gates + hydrates initial state.
 *
 * Wire format:
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Error envelope (both routes): `{ error: { code, message, field? } }`
 *     where `code` is one of `WCG01`..`WCG07` or `INTERNAL`/`BAD_REQUEST`.
 *     WCG02 is the canonical enum/range failure (matches the SQL backstop
 *     in slot 0077 lines 538–543 if a client-side bypass is attempted).
 *
 * DOM contract (T045 selectors):
 *   - `[data-testid="phase-radio"][value="<phase>"]` × 4
 *   - `[data-testid="phase-reason"]`
 *   - `[data-testid="phase-source-citation"]`
 *   - `[data-testid="phase-save"]`
 *   - `[data-testid="phase-backward-warning"]` (only when reverting)
 *   - `[data-testid="phase-backward-confirm"]`
 *   - `[data-testid="phase-backward-cancel"]`
 *   - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *   - `[data-testid="phase-toast"]` (success)
 *   - `[data-testid="phase-error"]` (server error)
 *
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/admin/config/locking/LockingEditor.tsx (sibling pattern)
 * @see apps/web/lib/config-validators.ts (T018)
 * @see supabase/migrations/0077_configuration.sql (lines 538–543: enum backstop)
 */

// ---------------------------------------------------------------------------
// Phase catalog. Order is the canonical rank order; descriptions render
// underneath each radio label.
// ---------------------------------------------------------------------------

const PHASE_CATALOG = [
  {
    value: 'pre_tournament',
    rank: 0,
    title: 'Pre-tournament',
    description:
      'Before the first kickoff. Predictions are open; group stage UI is hidden.',
  },
  {
    value: 'group_stage',
    rank: 1,
    title: 'Group stage',
    description:
      'Group matches in progress. Group standings render; final pick deadline copy is active.',
  },
  {
    value: 'knockout',
    rank: 2,
    title: 'Knockout',
    description:
      'Round of 16 onward. Bracket UI renders; per-match predictions still open until each kickoff.',
  },
  {
    value: 'completed',
    rank: 3,
    title: 'Completed',
    description:
      'Final has been played. Leaderboard is frozen; predictions are read-only.',
  },
] as const;

type PhaseValue = (typeof PHASE_CATALOG)[number]['value'];

function rankOf(value: PhaseValue): number {
  return PHASE_CATALOG.find((p) => p.value === value)!.rank;
}

function titleOf(value: PhaseValue): string {
  return PHASE_CATALOG.find((p) => p.value === value)!.title;
}

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

interface PhasesEditorProps {
  initialValue: PhaseValue;
  /** Bigint serialised as a decimal string for safe JSON round-trip. */
  initialVersionId: string;
}

export function PhasesEditor({
  initialValue,
  initialVersionId,
}: PhasesEditorProps): JSX.Element {
  const router = useRouter();

  const [currentValue, setCurrentValue] = useState<PhaseValue>(initialValue);
  const [selected, setSelected] = useState<PhaseValue>(initialValue);
  const [versionId, setVersionId] = useState<string>(initialVersionId);

  const [reason, setReason] = useState('');
  const [sourceCitation, setSourceCitation] = useState('');

  const [validationError, setValidationError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [backwardPending, setBackwardPending] = useState<boolean>(false);

  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const noChange = selected === currentValue;
  const reasonOk = reason.trim().length > 0;
  // `tournament.phase.current` is treated as security-sensitive per T041
  // (matches the providers/admin-roles/scoring/locking sibling UX). The SQL
  // backstop in slot 0077 does not include it in WCG02 step 4, so we enforce
  // it client-side and let admins know up front.
  const citationOk = sourceCitation.trim().length > 0;
  const isBackward = useMemo(
    () => rankOf(selected) < rankOf(currentValue),
    [selected, currentValue],
  );

  const saveDisabled =
    pending || noChange || !reasonOk || !citationOk || !!validationError;

  // ---------------------------------------------------------------------------
  // Selection handler — runs the T018 zod validator on each radio change.
  // ---------------------------------------------------------------------------

  function handleSelect(next: PhaseValue) {
    setSelected(next);
    setBackwardPending(false);
    setPreview(null);
    setError(null);
    setToast(null);
    const result = validateConfigValue('tournament.phase.current', next);
    if (!result.ok) {
      setValidationError(result.error);
    } else {
      setValidationError(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Save flow.
  //
  // Step A: if selected < current (backward), interpose the red confirmation
  //         banner. The user must click "Yes, revert" to continue.
  // Step B: POST /api/admin/config/preview, surface <PreviewWarning>.
  // Step C: on Acknowledge, POST /api/admin/config/upsert with the
  //         acknowledge_token.
  // ---------------------------------------------------------------------------

  function handleSaveClick() {
    if (saveDisabled) return;
    if (isBackward) {
      setBackwardPending(true);
      return;
    }
    void requestPreview();
  }

  function handleBackwardConfirm() {
    setBackwardPending(false);
    void requestPreview();
  }

  function handleBackwardCancel() {
    setBackwardPending(false);
  }

  async function requestPreview() {
    if (!reasonOk) {
      setError('Reason is required before save');
      setPreview(null);
      return;
    }
    if (!citationOk) {
      setError('Source citation is required before save');
      setPreview(null);
      return;
    }
    if (validationError) {
      setError(validationError);
      setPreview(null);
      return;
    }
    if (noChange) {
      setError('No change to submit');
      setPreview(null);
      return;
    }
    setError(null);
    setToast(null);

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: 'tournament.phase.current',
          value: selected,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        setError(`${code}: ${message}`);
        setPreview(null);
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      setPreview(previewResult);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Preview failed: ${message}`);
      setPreview(null);
    }
  }

  function handleConfirm(token: string | null) {
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'tournament.phase.current',
            value: selected,
            expected_version_id: versionId,
            reason: reason.trim(),
            source_citation: sourceCitation.trim(),
            acknowledge_token: token,
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          setVersionId(newVersionId);
          setCurrentValue(selected);
          setPreview(null);
          setReason('');
          setSourceCitation('');
          setToast(`Updated to ${titleOf(selected)} (version ${newVersionId})`);
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          const code =
            (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
          const message =
            (body as { error?: { message?: string } })?.error?.message ??
            'Update failed';
          setError(`${code}: ${message}`);
          setPreview(null);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Update failed: ${message}`);
        setPreview(null);
      }
    });
  }

  function handleCancel() {
    setPreview(null);
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <div data-testid="phases-editor" className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3 rounded border border-border bg-card p-4">
        <legend className="px-1 text-sm font-medium text-muted-foreground">
          Current phase
        </legend>
        {PHASE_CATALOG.map((phase) => {
          const isCurrent = phase.value === currentValue;
          const isSelected = phase.value === selected;
          return (
            <label
              key={phase.value}
              className={`flex items-start gap-3 rounded border p-3 text-sm transition-colors ${
                isSelected
                  ? 'border-blue-400 bg-accent/10'
                  : 'border-border hover:bg-muted/30'
              }`}
            >
              <input
                type="radio"
                name="tournament-phase"
                value={phase.value}
                checked={isSelected}
                onChange={() => handleSelect(phase.value)}
                disabled={pending}
                data-testid="phase-radio"
                className="mt-0.5 h-4 w-4 text-primary focus:ring-blue-500"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">
                  {phase.title}
                  {isCurrent && (
                    <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      current
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {phase.description}
                </span>
                <span className="text-xs font-mono text-muted-foreground/60">
                  {phase.value}
                </span>
              </span>
            </label>
          );
        })}
        {validationError && (
          <span
            data-testid="phase-validation-error"
            role="alert"
            className="text-xs text-destructive"
          >
            {validationError}
          </span>
        )}
      </fieldset>

      {/* Reason (required) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          Reason (required)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="phase-reason"
          rows={2}
          required
          disabled={pending}
          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
        />
      </label>

      {/* Source citation (required for tournament.phase.current per T041) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          Source citation (required)
        </span>
        <input
          type="text"
          value={sourceCitation}
          onChange={(e) => setSourceCitation(e.target.value)}
          data-testid="phase-source-citation"
          required
          disabled={pending}
          placeholder="e.g. FIFA fixture URL, Slack thread, ticket ref"
          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
        />
        <span className="text-xs text-muted-foreground">
          Phase transitions are audit-logged and require a citation so the
          decision is traceable.
        </span>
      </label>

      {/* Save button */}
      <div>
        <button
          type="button"
          onClick={handleSaveClick}
          disabled={saveDisabled}
          data-testid="phase-save"
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>

      {/* Backward-transition confirmation (interposed before preview) */}
      {backwardPending && (
        <div
          data-testid="phase-backward-warning"
          role="alert"
          className="rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive"
        >
          <h3 className="text-sm font-semibold text-destructive">
            Backward transition
          </h3>
          <p className="mt-2">
            Reverting from <strong>{titleOf(currentValue)}</strong> to{' '}
            <strong>{titleOf(selected)}</strong> is unusual — this should
            typically only be done to recover from a mistaken forward
            transition. The action will still be logged.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleBackwardCancel}
              data-testid="phase-backward-cancel"
              disabled={pending}
              className="rounded-md border border-gray-300 bg-card px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleBackwardConfirm}
              data-testid="phase-backward-confirm"
              disabled={pending}
              className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:bg-destructive/40"
            >
              Yes, revert
            </button>
          </div>
        </div>
      )}

      {/* Preview warning (renders when a pending change has been previewed) */}
      {preview && (
        <PreviewWarning
          preview={preview}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}

      {/* Toasts + errors */}
      {toast && (
        <div
          data-testid="phase-toast"
          role="status"
          className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
        >
          {toast}
        </div>
      )}
      {error && (
        <div
          data-testid="phase-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {pending && (
        <div className="text-sm text-muted-foreground">Submitting…</div>
      )}

      {/* Hidden version_id badge — useful for debugging + Playwright */}
      <p className="text-xs text-muted-foreground/60">
        Current version:{' '}
        <span data-testid="phase-version-id">{versionId}</span>
      </p>
    </div>
  );
}
