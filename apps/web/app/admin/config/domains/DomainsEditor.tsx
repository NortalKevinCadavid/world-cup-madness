'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

/**
 * `DomainsEditor` — client companion to `/admin/config/domains/page.tsx`
 * (Slice 008, Phase 3, T027, US1).
 *
 * Holds all interactivity for the approved-corporate-domains editor:
 *   - List of current domains with per-row Remove button.
 *   - Add-new input + Add button.
 *   - Reason textarea + Source citation input.
 *   - Preview → PreviewWarning → Confirm flow that POSTs to
 *     `/api/admin/config/preview` and `/api/admin/config/upsert`.
 *
 * Why a client component:
 *   T027 demands an interactive add/remove/preview/confirm flow. Per spec the
 *   bulk of logic lives here; the server page (page.tsx) just gates +
 *   hydrates initial state.
 *
 * Wire format:
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Error envelope (both routes): `{ error: { code, message, field? } }`
 *     where `code` is one of `WCG01`..`WCG07` or `INTERNAL`/`BAD_REQUEST`.
 *
 * DOM contract (T028 selectors):
 *   - `[data-testid="domains-editor"]`
 *   - `[data-testid="domains-list"]`
 *   - `[data-testid="domain-row"]`            (one per existing domain)
 *   - `[data-testid="domain-remove-button"]`  (one per row, `data-domain`)
 *   - `[data-testid="domain-add-input"]`
 *   - `[data-testid="domain-add-button"]`
 *   - `[data-testid="domain-reason"]`
 *   - `[data-testid="domain-source-citation"]`
 *   - `[data-testid="config-preview-warning"]` (rendered by <PreviewWarning>)
 *   - `[data-testid="config-toast"]`           (success toast)
 *   - `[data-testid="config-error"]`           (inline error envelope)
 *
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/lib/config-validators.ts
 * @see specs/008-configuration/tasks.md § T027
 */

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

interface DomainsEditorProps {
  initialDomains: string[];
  /** Bigint serialised as a decimal string for safe JSON round-trip. */
  initialVersionId: string;
}

export function DomainsEditor({
  initialDomains,
  initialVersionId,
}: DomainsEditorProps): JSX.Element {
  const router = useRouter();

  const [domains, setDomains] = useState<string[]>(initialDomains);
  const [versionId, setVersionId] = useState<string>(initialVersionId);

  const [newDomain, setNewDomain] = useState('');
  const [reason, setReason] = useState('');
  const [sourceCitation, setSourceCitation] = useState('');

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pendingValue, setPendingValue] = useState<string[] | null>(null);

  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Local-only validation (mirrors what the SP will enforce server-side).
  // The shared T018 validator is the source of truth.
  // ---------------------------------------------------------------------------

  function validateNextValue(value: string[]): string | null {
    const result = validateConfigValue('eligibility.allowed_domains', value);
    if (!result.ok) return result.error;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Preview + add/remove handlers.
  // ---------------------------------------------------------------------------

  async function triggerPreview(value: string[]) {
    if (!reason.trim()) {
      setError('Reason is required before preview/save');
      setPendingValue(null);
      setPreview(null);
      return;
    }
    const localError = validateNextValue(value);
    if (localError) {
      setError(localError);
      setPendingValue(null);
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
          key: 'eligibility.allowed_domains',
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
        setPendingValue(null);
        setPreview(null);
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      setPreview(previewResult);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Preview failed: ${message}`);
      setPendingValue(null);
      setPreview(null);
    }
  }

  function handleAddDomain() {
    const trimmed = newDomain.trim();
    if (!trimmed) {
      setError('Domain is required');
      return;
    }
    const next = [...domains, trimmed];
    setPendingValue(next);
    setPreview(null);
    void triggerPreview(next);
  }

  function handleRemoveDomain(idx: number) {
    const next = domains.filter((_, i) => i !== idx);
    setPendingValue(next);
    setPreview(null);
    void triggerPreview(next);
  }

  // ---------------------------------------------------------------------------
  // Confirm — POSTs to /api/admin/config/upsert.
  // ---------------------------------------------------------------------------

  function handleConfirm(token: string | null) {
    if (!pendingValue) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'eligibility.allowed_domains',
            value: pendingValue,
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
          setDomains(pendingValue);
          setVersionId(newVersionId);
          setPendingValue(null);
          setPreview(null);
          setNewDomain('');
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
          setPendingValue(null);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Update failed: ${message}`);
        setPreview(null);
        setPendingValue(null);
      }
    });
  }

  function handleCancel() {
    setPreview(null);
    setPendingValue(null);
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <div data-testid="domains-editor" className="flex flex-col gap-4">
      {/* Domain list */}
      <ul
        data-testid="domains-list"
        aria-label="Approved corporate domains"
        className="flex flex-col gap-2"
      >
        {domains.length === 0 ? (
          <li className="rounded border border-dashed border-neutral-300 p-3 text-sm text-neutral-500">
            No domains configured. Add one below to enable sign-in.
          </li>
        ) : (
          domains.map((domain, idx) => (
            <li
              key={`${idx}-${domain}`}
              data-testid="domain-row"
              className="flex items-center justify-between rounded border border-neutral-200 bg-white p-2"
            >
              <span className="font-mono text-sm text-neutral-800">{domain}</span>
              <button
                type="button"
                onClick={() => handleRemoveDomain(idx)}
                data-testid="domain-remove-button"
                data-domain={domain}
                disabled={pending}
                className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))
        )}
      </ul>

      {/* Add new domain */}
      <div className="flex items-center gap-2">
        <label htmlFor="domain-add-input" className="sr-only">
          New domain
        </label>
        <input
          id="domain-add-input"
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="example.com"
          data-testid="domain-add-input"
          disabled={pending}
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
        />
        <button
          type="button"
          onClick={handleAddDomain}
          data-testid="domain-add-button"
          disabled={pending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {/* Reason (required) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">
          Reason (required)
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="domain-reason"
          rows={2}
          required
          disabled={pending}
          className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
        />
      </label>

      {/* Source citation (optional) */}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-neutral-700">
          Source citation (optional)
        </span>
        <input
          type="text"
          value={sourceCitation}
          onChange={(e) => setSourceCitation(e.target.value)}
          data-testid="domain-source-citation"
          disabled={pending}
          className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
        />
      </label>

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
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
        >
          {toast}
        </div>
      )}
      {error && (
        <div
          data-testid="config-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {pending && (
        <div className="text-sm text-neutral-500">Submitting…</div>
      )}

      {/* Hidden version_id badge — useful for debugging + Playwright */}
      <p className="text-xs text-neutral-400">
        Current version: <span data-testid="domain-version-id">{versionId}</span>
      </p>
    </div>
  );
}
