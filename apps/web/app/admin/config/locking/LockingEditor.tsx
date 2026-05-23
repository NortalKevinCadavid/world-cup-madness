'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

/**
 * `LockingEditor` — client companion to `/admin/config/locking/page.tsx`
 * (Slice 008, Phase 4, T030, US2).
 *
 * Holds all interactivity for the match-prediction lock-window editor:
 *   - Single integer input (1..1440 minutes per T018 zod schema).
 *   - Reason textarea (required) + Source citation input (optional).
 *   - Preview → PreviewWarning → Confirm flow that POSTs to
 *     `/api/admin/config/preview` and `/api/admin/config/upsert` (created
 *     in T027 — REUSED here, no new routes).
 *
 * Why a client component:
 *   T030 demands an interactive input/preview/confirm flow. Per spec the bulk
 *   of logic lives here; the server page (page.tsx) just gates + hydrates
 *   initial state.
 *
 * Wire format:
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Error envelope (both routes): `{ error: { code, message, field? } }`
 *     where `code` is one of `WCG01`..`WCG07` or `INTERNAL`/`BAD_REQUEST`.
 *     WCG02 is the canonical range-validation failure (matches what the
 *     server's `admin_config_upsert` body emits if a client-side bypass is
 *     attempted).
 *
 * DOM contract (T031 selectors):
 *   - `[data-testid="locking-editor"]`
 *   - `[data-testid="locking-window-input"]`
 *   - `[data-testid="locking-validation-error"]` (when range/parse fails)
 *   - `[data-testid="locking-reason"]`
 *   - `[data-testid="locking-source-citation"]`
 *   - `[data-testid="locking-preview-button"]`
 *   - `[data-testid="config-preview-warning"]` (rendered by <PreviewWarning>)
 *   - `[data-testid="config-toast"]`           (success toast)
 *   - `[data-testid="config-error"]`           (inline error envelope)
 *
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/lib/config-validators.ts
 * @see specs/008-configuration/tasks.md § T030
 */

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

interface LockingEditorProps {
  initialValue: number;
  /** Bigint serialised as a decimal string for safe JSON round-trip. */
  initialVersionId: string;
}

export function LockingEditor({
  initialValue,
  initialVersionId,
}: LockingEditorProps): JSX.Element {
  const router = useRouter();

  const [value, setValue] = useState<number>(initialValue);
  const [versionId, setVersionId] = useState<string>(initialVersionId);

  const [reason, setReason] = useState('');
  const [sourceCitation, setSourceCitation] = useState('');

  const [validationError, setValidationError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Local-only validation (mirrors what `admin_config_upsert` enforces
  // server-side, surfaced as WCG02 if a client bypass is attempted).
  // The shared T018 validator is the source of truth.
  // ---------------------------------------------------------------------------

  function handleValueChange(raw: string) {
    if (raw === '') {
      setValidationError('Value required');
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      setValidationError('Must be an integer');
      return;
    }
    setValue(parsed);
    const result = validateConfigValue(
      'locking.match_prediction_window_minutes',
      parsed,
    );
    if (!result.ok) {
      setValidationError(result.error);
    } else {
      setValidationError(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Preview — POSTs to /api/admin/config/preview (T027 route, REUSED).
  // ---------------------------------------------------------------------------

  async function handlePreview() {
    if (!reason.trim()) {
      setError('Reason is required before preview/save');
      setPreview(null);
      return;
    }
    if (validationError) {
      setError(validationError);
      setPreview(null);
      return;
    }
    if (value === initialValue) {
      setError('No change to submit');
      setPreview(null);
      return;
    }
    // Double-check the local validator before round-tripping the server.
    const localCheck = validateConfigValue(
      'locking.match_prediction_window_minutes',
      value,
    );
    if (!localCheck.ok) {
      setValidationError(localCheck.error);
      setError(localCheck.error);
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
          key: 'locking.match_prediction_window_minutes',
          value,
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

  // ---------------------------------------------------------------------------
  // Confirm — POSTs to /api/admin/config/upsert (T027 route, REUSED).
  // ---------------------------------------------------------------------------

  function handleConfirm(token: string | null) {
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'locking.match_prediction_window_minutes',
            value,
            expected_version_id: versionId,
            reason: reason.trim(),
            source_citation: sourceCitation.trim() || null,
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
          setPreview(null);
          setReason('');
          setSourceCitation('');
          setToast(`Updated to version ${newVersionId}`);
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
    <div data-testid="locking-editor" className="flex flex-col gap-4">
      {/* Window (minutes) input */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          Window (minutes)
        </span>
        <input
          type="number"
          min={1}
          max={1440}
          step={1}
          value={value}
          onChange={(e) => handleValueChange(e.target.value)}
          data-testid="locking-window-input"
          aria-invalid={validationError ? true : undefined}
          aria-describedby={
            validationError ? 'locking-validation-error' : undefined
          }
          disabled={pending}
          className="w-40 rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
        />
        {validationError && (
          <span
            id="locking-validation-error"
            data-testid="locking-validation-error"
            role="alert"
            className="text-xs text-destructive"
          >
            {validationError}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          Allowed range: 1..1440 minutes (T018 zod schema).
        </span>
      </label>

      {/* Reason (required) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          Reason (required)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="locking-reason"
          rows={2}
          required
          disabled={pending}
          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
        />
      </label>

      {/* Source citation (optional) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-muted-foreground">
          Source citation (optional)
        </span>
        <input
          type="text"
          value={sourceCitation}
          onChange={(e) => setSourceCitation(e.target.value)}
          data-testid="locking-source-citation"
          disabled={pending}
          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
        />
      </label>

      {/* Preview button */}
      <div>
        <button
          type="button"
          onClick={handlePreview}
          disabled={pending || !!validationError}
          data-testid="locking-preview-button"
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Preview change
        </button>
      </div>

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
          data-testid="config-toast"
          role="status"
          className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
        >
          {toast}
        </div>
      )}
      {error && (
        <div
          data-testid="config-error"
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
        <span data-testid="locking-version-id">{versionId}</span>
      </p>
    </div>
  );
}
