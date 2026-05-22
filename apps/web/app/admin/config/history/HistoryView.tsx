'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `HistoryView` — client companion to `/admin/config/history/page.tsx`
 * (Slice 008, Phase 7, T048, US5).
 *
 * Owns three pieces of interactivity:
 *
 *  1. **Filter input** — a single text box. The server page is
 *     `force-dynamic`, so typing into this input doesn't re-query directly;
 *     instead the field is debounced (300ms) and the URL search-param
 *     `?key=<value>` is updated via `router.push`. Next then re-renders the
 *     server page with the new filter. Clearing the input strips the param
 *     entirely (back to "all keys").
 *
 *  2. **Vertical timeline** — newest first. Each entry shows a change_kind
 *     badge, the affected `key`, the actor, `created_at` (formatted in
 *     `America/Mexico_City`), `version_id`, optional `parent_version_id`
 *     (admin_rollback rows only), the reason, the source citation, and a
 *     collapsed previous→new JSON diff. EVERY entry — including
 *     `admin_rollback` rows — exposes a "Rollback to this" button per the
 *     T048 contract; rolling back to a rollback row simply chains another
 *     rollback (the underlying RPC has no notion of "leaf-only" targets).
 *
 *  3. **Rollback modal** — opens when "Rollback to this" is clicked. Renders
 *     the target's key + new_value preview, a required reason textarea, and
 *     an optional source-citation input. On Confirm, POSTs
 *     `{ targetVersionId, reason, sourceCitation }` to
 *     `/api/admin/config/rollback`. On success, the modal closes, a toast
 *     appears, and `router.refresh()` re-runs the server page — which then
 *     re-renders us with the freshly-inserted admin_rollback row at the top
 *     of the timeline.
 *
 * Why a separate component (not folded into `<VersionTimeline>` from T022):
 *   `VersionTimeline.tsx` is a pure-display server component. Extending it
 *   with the filter input, modal lifecycle, and useTransition state would
 *   force it to add `'use client'` and break the existing T024+ test
 *   selectors (`[data-testid="version-timeline"]`, etc.). The cheaper move
 *   is a parallel client component scoped to T048's distinct DOM contract
 *   (`[data-testid="history-*"]` selectors). The VersionTimeline file stays
 *   unmodified for callers that want a read-only embed.
 *
 * Wire format:
 *   - POST `/api/admin/config/rollback` body (T048 sibling route):
 *     `{ targetVersionId: string, reason: string,
 *       sourceCitation: string | null }`. `targetVersionId` is sent as a
 *     decimal string to survive JSON precision (the bigint may exceed
 *     `Number.MAX_SAFE_INTEGER` after enough writes).
 *   - 200 response: `{ new_version_id: string }`.
 *   - Error envelope: `{ error: { code, message, field? } }` with `code` in
 *     `WCG02`/`WCG03`/`WCG04`/`WCG07`/`BAD_REQUEST`/`INTERNAL`.
 *
 * DOM contract (T051 selectors):
 *   - `[data-testid="history-filter-input"]`,
 *     `[data-testid="history-filter-clear"]`
 *   - `[data-testid="history-timeline"]` container
 *   - Per entry: `[data-testid="history-entry"][data-version-id="N"]` with
 *     `data-key`, `data-change-kind`
 *   - Per entry: `[data-testid="history-entry-change-kind"]` badge
 *   - Per entry: `[data-testid="history-entry-rollback"]` button
 *   - Modal: `[data-testid="rollback-modal"]`,
 *     `[data-testid="rollback-reason"]`,
 *     `[data-testid="rollback-source-citation"]`,
 *     `[data-testid="rollback-confirm"]`,
 *     `[data-testid="rollback-cancel"]`
 *   - Toast: `[data-testid="history-toast"]`
 *   - Error banner: `[data-testid="history-error"]`
 *
 * @see specs/008-configuration/tasks.md § T048
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin_config_rollback
 * @see apps/web/app/admin/config/VersionTimeline.tsx (T022 sibling component — pure display)
 * @see apps/web/app/admin/config/phases/PhasesEditor.tsx (T041 sibling client-component pattern)
 * @see apps/web/app/api/admin/config/rollback/route.ts (T048 sibling route)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One row from `config_version_history`. Mirrors the RPC's TABLE return type
 * (slot 0077 lines 1829–1842). All bigint-shaped columns are normalised to
 * decimal strings server-side (in `page.tsx`) so the client doesn't have to
 * deal with the number-vs-string union postgrest can produce.
 */
export interface HistoryEntry {
  version_id: string;
  key: string;
  previous_value: unknown;
  new_value: unknown;
  /**
   * One of `'initial_seed' | 'admin_upsert' | 'admin_rollback' |
   * 'import_bulk'` per slot 0077 § the `change_kind` check constraint.
   * Typed as `string` here because the RPC's TABLE return uses `text`.
   */
  change_kind: string;
  actor: string | null;
  reason: string;
  source_citation: string | null;
  audit_log_id: string | null;
  parent_version_id: string | null;
  acknowledge_token_used: string | null;
  created_at: string;
}

interface HistoryViewProps {
  initialEntries: HistoryEntry[];
  initialFilterKey: string | null;
  limit: number;
}

interface ModalState {
  entry: HistoryEntry;
  reason: string;
  sourceCitation: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers — kept inside this file so the client bundle doesn't
// drag in the server-only timeline helpers.
// ---------------------------------------------------------------------------

const TZ = 'America/Mexico_City';
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  timeZone: TZ,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatAbsolute(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return DATE_FORMATTER.format(date);
}

function formatRelative(iso: string, now: number): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const deltaSec = Math.round((now - date.getTime()) / 1000);
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaDay < 30) return `${deltaDay}d ago`;
  const deltaMonth = Math.round(deltaDay / 30);
  if (deltaMonth < 12) return `${deltaMonth}mo ago`;
  const deltaYear = Math.round(deltaMonth / 12);
  return `${deltaYear}y ago`;
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortActor(actor: string | null): string {
  if (!actor) return 'system';
  // 8-character prefix matches the convention used in the audit-search UI;
  // full uuid is in the row attribute for selector-based assertions.
  if (actor.length <= 8) return actor;
  return `${actor.slice(0, 8)}…`;
}

function badgeClasses(kind: string): string {
  switch (kind) {
    case 'initial_seed':
      return 'bg-neutral-200 text-neutral-800 border-neutral-300';
    case 'admin_upsert':
      return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'admin_rollback':
      return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'import_bulk':
      return 'bg-purple-100 text-purple-800 border-purple-300';
    default:
      return 'bg-neutral-100 text-neutral-700 border-neutral-300';
  }
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export default function HistoryView({
  initialEntries,
  initialFilterKey,
  limit,
}: HistoryViewProps): JSX.Element {
  const router = useRouter();

  const [filterDraft, setFilterDraft] = useState<string>(initialFilterKey ?? '');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // `now` is captured once per render for the relative-time formatter. We
  // intentionally don't re-tick on a timer here — the timeline isn't a live
  // feed (a router.refresh re-renders the server page on rollback success,
  // which gives us a fresh `now`). Avoiding setInterval also keeps SSR
  // hydration deterministic.
  const renderNow = useMemo(() => Date.now(), []);

  // ---------------------------------------------------------------------------
  // Filter input — debounced URL push.
  //
  // Updating `?key` is the SOLE source of truth; the server page re-runs
  // `config_version_history` on every push. We debounce 300ms so typing
  // doesn't fire a stampede of router pushes (Next will queue them anyway,
  // but the page transition flicker is jarring).
  // ---------------------------------------------------------------------------

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    const trimmed = filterDraft.trim();
    const targetUrl =
      trimmed.length > 0
        ? `/admin/config/history?key=${encodeURIComponent(trimmed)}`
        : '/admin/config/history';
    const currentTarget =
      (initialFilterKey ?? '').length > 0
        ? `/admin/config/history?key=${encodeURIComponent(initialFilterKey ?? '')}`
        : '/admin/config/history';
    if (targetUrl === currentTarget) return; // no-op
    debounceRef.current = setTimeout(() => {
      router.push(targetUrl);
    }, 300);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [filterDraft, initialFilterKey, router]);

  function handleClearFilter() {
    setFilterDraft('');
    // The effect above will pick this up, but the typical UX expectation is
    // an immediate jump back to the unfiltered URL; push synchronously and
    // cancel any pending debounce.
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    router.push('/admin/config/history');
  }

  // ---------------------------------------------------------------------------
  // Rollback modal lifecycle.
  // ---------------------------------------------------------------------------

  function openRollbackModal(entry: HistoryEntry) {
    setError(null);
    setToast(null);
    setModal({ entry, reason: '', sourceCitation: '' });
  }

  function closeModal() {
    if (pending) return; // don't allow cancel mid-submit
    setModal(null);
  }

  function handleConfirmRollback() {
    if (!modal) return;
    const reason = modal.reason.trim();
    if (reason.length === 0) {
      setError('Reason is required to roll back.');
      return;
    }

    const sourceCitation =
      modal.sourceCitation.trim().length > 0
        ? modal.sourceCitation.trim()
        : null;

    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            // Pass as a string so bigint precision survives JSON.
            targetVersionId: modal.entry.version_id,
            reason,
            sourceCitation,
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { new_version_id: string };
          setToast(
            `Rolled back ${modal.entry.key} to version ${modal.entry.version_id} (new version ${data.new_version_id}).`,
          );
          setModal(null);
          // router.refresh re-runs the SERVER page, which re-runs
          // `config_version_history` and re-renders this component with the
          // new admin_rollback row at the top.
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          const code =
            (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
          const message =
            (body as { error?: { message?: string } })?.error?.message ??
            'Rollback failed';
          setError(`${code}: ${message}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Rollback failed: ${message}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Filter input */}
      <div className="flex items-center gap-2 rounded border border-neutral-200 bg-white p-3">
        <label
          htmlFor="history-filter-input"
          className="text-sm font-medium text-neutral-700"
        >
          Filter by config key:
        </label>
        <input
          id="history-filter-input"
          type="text"
          value={filterDraft}
          onChange={(e) => setFilterDraft(e.target.value)}
          data-testid="history-filter-input"
          placeholder="e.g. scoring.final_pick_points"
          className="flex-1 rounded border border-neutral-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleClearFilter}
          data-testid="history-filter-clear"
          disabled={filterDraft.length === 0 && initialFilterKey === null}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear
        </button>
        <span className="text-xs text-neutral-500">
          Showing up to {limit}
        </span>
      </div>

      {/* Empty state */}
      {initialEntries.length === 0 ? (
        <div
          data-testid="history-timeline"
          className="rounded border border-neutral-200 bg-white p-6 text-sm text-neutral-500"
        >
          {initialFilterKey
            ? `No version history for ${initialFilterKey}.`
            : 'No version history yet.'}
        </div>
      ) : (
        <ol
          data-testid="history-timeline"
          className="relative ml-3 flex flex-col gap-0 border-l border-neutral-200"
        >
          {initialEntries.map((entry) => (
            <li
              key={entry.version_id}
              data-testid="history-entry"
              data-version-id={entry.version_id}
              data-key={entry.key}
              data-change-kind={entry.change_kind}
              className="relative mb-6 ml-4 rounded border border-neutral-200 bg-white p-4"
            >
              <span
                aria-hidden="true"
                className="absolute -left-[1.4rem] top-5 h-3 w-3 rounded-full border-2 border-white bg-neutral-400"
              />

              {/* Header line */}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  data-testid="history-entry-change-kind"
                  className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${badgeClasses(
                    entry.change_kind,
                  )}`}
                >
                  {entry.change_kind}
                </span>
                <span className="font-mono text-sm text-neutral-700">
                  {entry.key}
                </span>
                <span className="ml-auto text-xs text-neutral-500">
                  #{entry.version_id}
                </span>
              </div>

              {/* Metadata line */}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
                <span title={entry.actor ?? 'system'}>
                  <span className="font-medium">Actor:</span>{' '}
                  <span className="font-mono">{shortActor(entry.actor)}</span>
                </span>
                <span title={entry.created_at}>
                  <span className="font-medium">When:</span>{' '}
                  {formatRelative(entry.created_at, renderNow)} (
                  {formatAbsolute(entry.created_at)})
                </span>
                {entry.parent_version_id !== null && (
                  <span>
                    <span className="font-medium">Parent:</span>{' '}
                    <span className="font-mono">
                      #{entry.parent_version_id}
                    </span>
                  </span>
                )}
              </div>

              {/* Reason line */}
              <div className="mt-2 text-sm text-neutral-700">
                <span className="font-medium">Reason:</span>{' '}
                <span>{entry.reason || '—'}</span>
              </div>

              {/* Optional citation */}
              {entry.source_citation !== null &&
                entry.source_citation.length > 0 && (
                  <div className="mt-1 text-xs text-neutral-500">
                    <span className="font-medium">Citation:</span>{' '}
                    {entry.source_citation}
                  </div>
                )}

              {/* Diff */}
              <details className="mt-3 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs">
                <summary className="cursor-pointer font-medium text-neutral-700">
                  Diff (previous → new)
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                      Previous
                    </div>
                    <pre className="overflow-auto rounded bg-white p-2 text-xs text-neutral-800">
                      {formatJson(entry.previous_value)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                      New
                    </div>
                    <pre className="overflow-auto rounded bg-white p-2 text-xs text-neutral-800">
                      {formatJson(entry.new_value)}
                    </pre>
                  </div>
                </div>
              </details>

              {/* Rollback button — present on EVERY entry per T048 contract,
                  including admin_rollback rows (chaining a rollback is
                  a legitimate, audit-logged operation; the RPC doesn't
                  distinguish targets by change_kind). */}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => openRollbackModal(entry)}
                  data-testid="history-entry-rollback"
                  data-version-id={entry.version_id}
                  disabled={pending}
                  className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Rollback to this
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* Modal */}
      {modal && (
        <div
          data-testid="rollback-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm configuration rollback"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-neutral-900">
              Confirm rollback
            </h2>
            <p className="mt-2 text-sm text-neutral-700">
              You are about to roll back{' '}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs">
                {modal.entry.key}
              </code>{' '}
              to version{' '}
              <span className="font-mono">#{modal.entry.version_id}</span>. The
              current value will be replaced with:
            </p>
            <pre className="mt-2 max-h-40 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-800">
              {formatJson(modal.entry.new_value)}
            </pre>

            <label className="mt-4 flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">
                Reason (required)
              </span>
              <textarea
                value={modal.reason}
                onChange={(e) =>
                  setModal((m) => (m ? { ...m, reason: e.target.value } : m))
                }
                data-testid="rollback-reason"
                rows={3}
                required
                disabled={pending}
                className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
              />
            </label>

            <label className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">
                Source citation (optional)
              </span>
              <input
                type="text"
                value={modal.sourceCitation}
                onChange={(e) =>
                  setModal((m) =>
                    m ? { ...m, sourceCitation: e.target.value } : m,
                  )
                }
                data-testid="rollback-source-citation"
                disabled={pending}
                placeholder="e.g. Slack thread, ticket ref"
                className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                data-testid="rollback-cancel"
                disabled={pending}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRollback}
                data-testid="rollback-confirm"
                disabled={pending || modal.reason.trim().length === 0}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? 'Rolling back…' : 'Confirm rollback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast (success) */}
      {toast && (
        <div
          data-testid="history-toast"
          role="status"
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
        >
          {toast}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          data-testid="history-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </div>
  );
}
