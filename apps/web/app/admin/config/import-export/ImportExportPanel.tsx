'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `ImportExportPanel` — client companion to
 * `/admin/config/import-export/page.tsx` (Slice 008, Phase 8a, T054, US5).
 *
 * Owns two independent interactivity flows:
 *
 *  1. **Export** — single button. On click:
 *       a. `fetch('/api/admin/config/export')` (the T055 route).
 *       b. Read the response body as a Blob.
 *       c. Parse the filename out of `Content-Disposition` (the route handler
 *          encodes env + ISO timestamp into the header).
 *       d. `URL.createObjectURL(blob)` + click a hidden `<a download>` to
 *          trigger the browser file download, then `revokeObjectURL` after
 *          the next microtask to free the blob.
 *     Why not navigate the browser directly to the route? A direct `<a
 *     href="/api/.../export">` would work, but we want to surface server-side
 *     errors (403 / 409 / 500) inline rather than the browser's default
 *     download-failed dialog — the fetch path lets us read the JSON error
 *     envelope and render it in `[data-testid="import-error"]`.
 *
 *  2. **Import** — file picker + reason textarea + submit. On submit:
 *       a. Build a `FormData` body with the original `File` Blob + reason.
 *       b. POST to `/api/admin/config/import` (the T056 route).
 *       c. On 200: parse `{ imported_keys, version_ids, skipped_keys }`,
 *          show a green toast `"Imported N keys (M skipped)"`, and
 *          `router.refresh()` after 2s so the surrounding admin surface
 *          re-renders with the new audit state.
 *       d. On 422 (WCG08): parse `error.validation_errors` (each
 *          `{key, value, reason}`) and render one
 *          `[data-testid="import-validation-error"]` row per failure.
 *       e. On 401/403/409/500: render a generic banner in
 *          `[data-testid="import-error"]`.
 *
 * The route handler reads the file via `await file.text()` then re-parses as
 * JSON, so the multipart body MUST carry the original Blob (not just text).
 * We pass `file` straight through to `FormData.append`.
 *
 * Concurrency:
 *   `useTransition` guards both buttons. The export blob fetch is a no-op
 *   transition (no React state to defer), but using the same pending flag
 *   keeps the disabled-state behaviour consistent across both flows.
 *
 * DOM contract (T060 selectors):
 *   - `[data-testid="export-button"]`
 *   - `[data-testid="import-file-input"]`
 *   - `[data-testid="import-reason"]`
 *   - `[data-testid="import-submit"]`
 *   - `[data-testid="import-toast"]` (success)
 *   - `[data-testid="import-error"]` (server error)
 *   - `[data-testid="import-validation-error"]` per failed key with
 *      `data-failed-key="<key>"`
 *
 * @see specs/008-configuration/tasks.md § T054
 * @see specs/008-configuration/contracts/config-import.write.md
 * @see specs/008-configuration/contracts/config-version-history.read.md § admin_config_export
 * @see apps/web/app/admin/config/history/HistoryView.tsx (sibling client pattern)
 * @see apps/web/app/admin/config/phases/PhasesEditor.tsx (sibling confirm flow)
 * @see apps/web/app/api/admin/config/export/route.ts (T055 sibling route)
 * @see apps/web/app/api/admin/config/import/route.ts (T056 sibling route)
 */

// ---------------------------------------------------------------------------
// Wire types — mirror the T055 + T056 route responses exactly.
// ---------------------------------------------------------------------------

interface ImportSuccessBody {
  imported_keys: number;
  version_ids: string[];
  skipped_keys: string[];
}

interface ValidationErrorRow {
  key: string;
  value: unknown;
  reason: string;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    error?: string;
    detail?: string;
    field?: string;
    validation_errors?: ValidationErrorRow[];
  };
}

// ---------------------------------------------------------------------------
// Filename extraction. The T055 route encodes the filename as
//   `attachment; filename="world-cup-madness-config-<env>-<ts>.json"`
// We parse defensively (RFC 6266-lite) and fall back to a generic name if
// the header is missing or malformed.
// ---------------------------------------------------------------------------

function parseFilenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  // Prefer `filename*=` (RFC 5987) if present.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain && plain[1]) return plain[1].trim();
  return fallback;
}

/**
 * Best-effort JSON-error extraction from a fetch Response. Used by both
 * flows; on parse failure we surface a generic message.
 */
async function readErrorEnvelope(res: Response): Promise<ErrorEnvelope['error']> {
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body && typeof body === 'object' && body.error) return body.error;
  } catch {
    /* ignore */
  }
  return { code: 'INTERNAL', message: `Request failed with status ${res.status}.` };
}

function humanizeError(err: ErrorEnvelope['error']): string {
  if (!err) return 'Request failed.';
  if (err.message) return err.message;
  if (err.detail) return err.detail;
  if (err.error) return err.error;
  if (err.code) return err.code;
  return 'Request failed.';
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export default function ImportExportPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Import-flow state.
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrorRow[]>(
    [],
  );

  // Hidden anchor used to trigger the export download.
  const downloadAnchorRef = useRef<HTMLAnchorElement | null>(null);

  // Auto-clear toast/error after 6s so old banners don't linger.
  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(handle);
  }, [toast]);

  // ------------------------------------------------------------------------
  // Export flow.
  // ------------------------------------------------------------------------

  const handleExport = useCallback(() => {
    setError(null);
    setValidationErrors([]);
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch('/api/admin/config/export', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Export request failed: ${message}`);
        return;
      }

      if (!res.ok) {
        const err = await readErrorEnvelope(res);
        setError(`Export failed (${res.status}): ${humanizeError(err)}`);
        return;
      }

      const blob = await res.blob();
      const filename = parseFilenameFromContentDisposition(
        res.headers.get('Content-Disposition'),
        `world-cup-madness-config-${new Date()
          .toISOString()
          .replaceAll(':', '-')
          .replaceAll('.', '-')}.json`,
      );

      const url = URL.createObjectURL(blob);
      const a = downloadAnchorRef.current;
      if (a) {
        a.href = url;
        a.download = filename;
        a.click();
      }
      // Defer revokeObjectURL so Chrome/Firefox finish initiating the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      setToast(`Exported configuration as ${filename}.`);
    });
  }, []);

  // ------------------------------------------------------------------------
  // Import flow.
  // ------------------------------------------------------------------------

  const canSubmitImport =
    file !== null && reason.trim().length > 0 && !pending;

  const handleImport = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (file === null || reason.trim().length === 0) return;

      setError(null);
      setValidationErrors([]);
      setToast(null);

      startTransition(async () => {
        // Defensive JSON-parse before the upload so a malformed file is
        // surfaced inline rather than round-tripped to the server.
        let text: string;
        try {
          text = await file.text();
        } catch (readErr) {
          const message =
            readErr instanceof Error ? readErr.message : String(readErr);
          setError(`Failed to read file: ${message}`);
          return;
        }
        try {
          JSON.parse(text);
        } catch {
          setError('Selected file is not valid JSON.');
          return;
        }

        const fd = new FormData();
        // Send the original Blob (not the parsed text) — the route handler
        // re-reads via `await file.text()` and re-parses, so we must hand
        // it the binary File object so multipart parsing on the server
        // sees a File entry.
        fd.append('file', file, file.name);
        fd.append('reason', reason.trim());

        let res: Response;
        try {
          res = await fetch('/api/admin/config/import', {
            method: 'POST',
            body: fd,
            credentials: 'same-origin',
          });
        } catch (fetchErr) {
          const message =
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          setError(`Import request failed: ${message}`);
          return;
        }

        if (res.status === 200) {
          const body = (await res.json()) as ImportSuccessBody;
          const importedCount =
            typeof body.imported_keys === 'number' ? body.imported_keys : 0;
          const skippedCount = Array.isArray(body.skipped_keys)
            ? body.skipped_keys.length
            : 0;
          setToast(
            `Imported ${importedCount} key${importedCount === 1 ? '' : 's'}` +
              ` (${skippedCount} skipped).`,
          );
          // Reset the form so an admin can't accidentally re-submit.
          setFile(null);
          setReason('');

          // Refresh the surrounding admin surface after a short delay so the
          // toast remains visible. router.refresh() re-runs the server page
          // (and any layout-level data) without a full navigation.
          window.setTimeout(() => router.refresh(), 2000);
          return;
        }

        const err = await readErrorEnvelope(res);

        if (res.status === 422 && err?.code === 'WCG08') {
          // Aggregate validation failure path.
          const rows: ValidationErrorRow[] = Array.isArray(err.validation_errors)
            ? err.validation_errors
            : [];
          setValidationErrors(rows);
          setError(
            rows.length > 0
              ? `Import rejected: ${rows.length} key${rows.length === 1 ? '' : 's'} failed validation.`
              : `Import rejected: ${humanizeError(err)}`,
          );
          return;
        }

        // Generic error path (401 / 403 / 500 / other 4xx).
        setError(`Import failed (${res.status}): ${humanizeError(err)}`);
      });
    },
    [file, reason, router],
  );

  // ------------------------------------------------------------------------
  // Render.
  // ------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-6">
      {/* Hidden anchor used by the export-download flow */}
      <a ref={downloadAnchorRef} className="hidden" aria-hidden="true" />

      {/* Export card */}
      <section className="rounded-lg border border-border bg-card p-5 flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">
            Export configuration
          </h2>
          <p className="text-sm text-muted-foreground">
            Downloads the current configuration as a signed JSON envelope.
            Provider credentials are redacted; the export carries no secret
            material.
          </p>
        </header>
        <div>
          <button
            type="button"
            onClick={handleExport}
            disabled={pending}
            data-testid="export-button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Exporting…' : 'Export configuration'}
          </button>
        </div>
      </section>

      {/* Import card */}
      <section className="rounded-lg border border-border bg-card p-5 flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">
            Import configuration
          </h2>
          <p className="text-sm text-muted-foreground">
            Upload a previously-signed envelope (downloaded from this page or
            another environment). The signature is verified server-side; an
            import with an invalid or unsigned envelope is rejected.
          </p>
        </header>

        <form onSubmit={handleImport} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-muted-foreground">
              Envelope file (.json)
            </span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={pending}
              data-testid="import-file-input"
              className="text-sm file:mr-3 file:rounded file:border file:border-border file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-muted-foreground hover:file:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {file !== null && (
              <span className="font-mono text-xs text-muted-foreground">
                {file.name} ({file.size.toLocaleString()} bytes)
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-muted-foreground">
              Reason (required)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={2000}
              required
              disabled={pending}
              data-testid="import-reason"
              placeholder="e.g. Restoring 2026-05-20 snapshot after rollback drill"
              className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
            />
          </label>

          <div>
            <button
              type="submit"
              disabled={!canSubmitImport}
              data-testid="import-submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Importing…' : 'Import configuration'}
            </button>
          </div>
        </form>

        {/* Per-key validation error list (WCG08 aggregate). */}
        {validationErrors.length > 0 && (
          <ul className="mt-2 flex flex-col gap-2">
            {validationErrors.map((row, idx) => (
              <li
                key={`${row.key}-${idx}`}
                data-testid="import-validation-error"
                data-failed-key={row.key}
                className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <div className="font-mono text-xs font-medium text-destructive">
                  {row.key}
                </div>
                <div className="mt-1">{row.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Success toast */}
      {toast && (
        <div
          data-testid="import-toast"
          role="status"
          className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
        >
          {toast}
        </div>
      )}

      {/* Generic error banner */}
      {error && (
        <div
          data-testid="import-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}
