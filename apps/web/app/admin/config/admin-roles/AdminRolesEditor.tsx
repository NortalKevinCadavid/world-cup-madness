'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `AdminRolesEditor` — client companion to `/admin/config/admin-roles/page.tsx`
 * (Slice 008, Phase 6, T040, US4).
 *
 * Two flows live on the same surface:
 *
 *   1. ACTIVE ADMINS TABLE.
 *      Lists every row from `admin_roles` with `revoked_at IS NULL`, joined
 *      back to `participants` for email + display_name. Each row carries a
 *      "Revoke" button. Clicking it opens a modal containing a reason
 *      textarea + source-citation input + Confirm / Cancel buttons. When the
 *      row's `participant_id` matches the CURRENT user's participant id, the
 *      modal additionally renders a red warning banner: "You are revoking
 *      your OWN admin role." (DB-side allows it; we only warn at the UI.)
 *
 *   2. GRANT FORM.
 *      Free-text search input that debounces against
 *      `GET /api/admin/participants/search?q=...` (T040 route). Up to 5
 *      results render below the input as clickable rows; selecting one pins
 *      its `participantId` into hidden state and shows the chosen
 *      participant's email + display_name. Below: required Reason textarea,
 *      required Source-citation input, "Grant admin role" button. Submit
 *      POSTs to `/api/admin/config/grant-admin-role`.
 *
 * Per the LOCKED RPC signature (T038):
 *   - `admin_config_grant_admin_role(p_participant_id uuid, p_reason text,
 *      p_source_citation text) RETURNS uuid`
 *   - `admin_config_revoke_admin_role(p_participant_id uuid, p_reason text,
 *      p_source_citation text) RETURNS void`
 *
 * Both server-side RPCs require BOTH reason AND source_citation as non-empty;
 * the client mirrors that requirement to fail fast (WCG02 would otherwise
 * surface on submit).
 *
 * On success of either flow this component calls `router.refresh()` so the
 * server component re-pulls the admins list and we see the new state.
 *
 * Wire format:
 *   - Grant body:   { participantId, reason, sourceCitation }
 *                   Response: { participant_id: <uuid> }
 *   - Revoke body:  { participantId, reason, sourceCitation }
 *                   Response: { status: 'ok' }
 *   - Search:       GET /api/admin/participants/search?q=...&limit=5
 *                   Response: { results: [{ id, email, display_name }] }
 *   - Error envelope (all routes): { error: { code, message, field? } }
 *
 * DOM contract (T044 will assert):
 *   - `[data-testid="admin-roles-table"]`
 *   - `[data-testid="admin-row"][data-participant-id="<uuid>"]`
 *   - `[data-testid="admin-revoke-button"]`
 *   - Revoke modal: `[data-testid="revoke-modal"]`,
 *     `[data-testid="revoke-reason"]`,
 *     `[data-testid="revoke-source-citation"]`,
 *     `[data-testid="revoke-confirm"]`, `[data-testid="revoke-cancel"]`,
 *     `[data-testid="revoke-self-warning"]` (only when own role).
 *   - Grant form: `[data-testid="grant-form"]`,
 *     `[data-testid="grant-search-input"]`,
 *     `[data-testid="grant-search-results"]`,
 *     `[data-testid="grant-search-result"][data-participant-id="<uuid>"]`,
 *     `[data-testid="grant-reason"]`,
 *     `[data-testid="grant-source-citation"]`,
 *     `[data-testid="grant-submit"]`.
 *   - Shared: `[data-testid="admin-roles-toast"]`,
 *             `[data-testid="admin-roles-error"]`.
 *
 * @see apps/web/app/admin/config/admin-roles/page.tsx
 * @see specs/008-configuration/contracts/admin-config-rpcs.write.md § admin role wrappers
 * @see specs/008-configuration/tasks.md § T040
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveAdmin {
  /** `admin_roles.id` — used as React key. */
  id: string;
  /** `admin_roles.participant_id`. */
  participantId: string;
  /** `admin_roles.granted_at` (ISO string). */
  grantedAt: string;
  /** `admin_roles.granted_by` participant id (nullable for bootstrap). */
  grantedBy: string | null;
  /** Joined from `participants.email` — null when the LEFT JOIN misses. */
  email: string | null;
  /** Joined from `participants.display_name`. */
  displayName: string | null;
}

interface SearchResult {
  id: string;
  email: string;
  display_name: string;
}

interface AdminRolesEditorProps {
  /** Current active admins (admin_roles LEFT JOIN participants, revoked_at IS NULL). */
  activeAdmins: ActiveAdmin[];
  /**
   * The CURRENT user's `participants.id` (used to render the self-revoke
   * warning). Null only if the participant row is unexpectedly missing.
   */
  currentParticipantId: string | null;
}

interface RevokeModalState {
  admin: ActiveAdmin;
  reason: string;
  sourceCitation: string;
  error: string | null;
}

interface GrantFormState {
  /** Current text in the search input. */
  query: string;
  /** Most-recent search results (capped at 5). */
  results: SearchResult[];
  /** True while a search request is in-flight. */
  searching: boolean;
  /** Most-recent search error (rare; surfaced inline). */
  searchError: string | null;
  /** Pinned participant id once the operator picks a result. */
  selected: SearchResult | null;
  reason: string;
  sourceCitation: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminRolesEditor({
  activeAdmins,
  currentParticipantId,
}: AdminRolesEditorProps): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Revoke modal state. `null` when no row's modal is open.
  const [revokeModal, setRevokeModal] = useState<RevokeModalState | null>(null);

  // Grant form state.
  const [grant, setGrant] = useState<GrantFormState>({
    query: '',
    results: [],
    searching: false,
    searchError: null,
    selected: null,
    reason: '',
    sourceCitation: '',
  });

  // Shared toast / error state (rendered once at the bottom of the page).
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Search debounce.
  //
  // Whenever `grant.query` changes (and is long enough), schedule a fetch
  // SEARCH_DEBOUNCE_MS later. Cancel the previous timeout. If the operator
  // clears the input or types <2 chars, drop results immediately.
  // ---------------------------------------------------------------------------
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSearchTokenRef = useRef(0);

  useEffect(() => {
    if (searchTimeoutRef.current !== null) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    const trimmed = grant.query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setGrant((prev) => ({
        ...prev,
        results: [],
        searching: false,
        searchError: null,
      }));
      return;
    }
    setGrant((prev) => ({ ...prev, searching: true, searchError: null }));
    const token = ++lastSearchTokenRef.current;
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const url = new URL(
          '/api/admin/participants/search',
          window.location.origin,
        );
        url.searchParams.set('q', trimmed);
        url.searchParams.set('limit', '5');
        const res = await fetch(url.toString(), {
          method: 'GET',
          credentials: 'include',
        });
        // Discard stale responses (newer search has been issued).
        if (token !== lastSearchTokenRef.current) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          const code = body.error?.code ?? `HTTP_${res.status}`;
          const message = body.error?.message ?? `Search failed: ${res.status}`;
          setGrant((prev) => ({
            ...prev,
            results: [],
            searching: false,
            searchError: `${code}: ${message}`,
          }));
          return;
        }
        const data = (await res.json()) as { results?: SearchResult[] };
        setGrant((prev) => ({
          ...prev,
          results: Array.isArray(data.results) ? data.results.slice(0, 5) : [],
          searching: false,
          searchError: null,
        }));
      } catch (e) {
        if (token !== lastSearchTokenRef.current) return;
        const message = e instanceof Error ? e.message : String(e);
        setGrant((prev) => ({
          ...prev,
          results: [],
          searching: false,
          searchError: `Search failed: ${message}`,
        }));
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimeoutRef.current !== null) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }
    };
  }, [grant.query]);

  // ---------------------------------------------------------------------------
  // Revoke flow.
  // ---------------------------------------------------------------------------

  function handleOpenRevoke(admin: ActiveAdmin) {
    setError(null);
    setToast(null);
    setRevokeModal({
      admin,
      reason: '',
      sourceCitation: '',
      error: null,
    });
  }

  function handleCloseRevoke() {
    setRevokeModal(null);
  }

  function handleConfirmRevoke() {
    if (!revokeModal) return;
    const { admin, reason, sourceCitation } = revokeModal;
    if (!reason.trim()) {
      setRevokeModal({
        ...revokeModal,
        error: 'Reason is required to revoke an admin role',
      });
      return;
    }
    if (!sourceCitation.trim()) {
      setRevokeModal({
        ...revokeModal,
        error: 'Source citation is required to revoke an admin role',
      });
      return;
    }
    setRevokeModal({ ...revokeModal, error: null });

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/revoke-admin-role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            participantId: admin.participantId,
            reason: reason.trim(),
            sourceCitation: sourceCitation.trim(),
          }),
        });
        if (res.ok) {
          setRevokeModal(null);
          const who = admin.email ?? admin.participantId;
          setToast(`Revoked admin role for ${who}`);
          setError(null);
          router.refresh();
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          const code = body.error?.code ?? 'ERROR';
          const message = body.error?.message ?? 'Revoke failed';
          setRevokeModal({
            ...revokeModal,
            error: `${code}: ${message}`,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setRevokeModal({
          ...revokeModal,
          error: `Revoke failed: ${message}`,
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Grant flow.
  // ---------------------------------------------------------------------------

  function handleSelectSearchResult(result: SearchResult) {
    setGrant((prev) => ({
      ...prev,
      selected: result,
      // Pin the query to the selected email so the operator sees what they picked.
      query: result.email,
      // Clear the dropdown — they've made their choice.
      results: [],
    }));
  }

  function handleClearSelection() {
    setGrant((prev) => ({
      ...prev,
      selected: null,
      query: '',
      results: [],
      reason: '',
      sourceCitation: '',
    }));
  }

  function handleSubmitGrant() {
    setError(null);
    setToast(null);
    const selected = grant.selected;
    if (!selected) {
      setError('Select a participant before granting admin role');
      return;
    }
    if (!grant.reason.trim()) {
      setError('Reason is required to grant an admin role');
      return;
    }
    if (!grant.sourceCitation.trim()) {
      setError('Source citation is required to grant an admin role');
      return;
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/grant-admin-role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            participantId: selected.id,
            reason: grant.reason.trim(),
            sourceCitation: grant.sourceCitation.trim(),
          }),
        });
        if (res.ok) {
          setToast(`Granted admin role to ${selected.email}`);
          setError(null);
          setGrant({
            query: '',
            results: [],
            searching: false,
            searchError: null,
            selected: null,
            reason: '',
            sourceCitation: '',
          });
          router.refresh();
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { code?: string; message?: string };
          };
          const code = body.error?.code ?? 'ERROR';
          const message = body.error?.message ?? 'Grant failed';
          setError(`${code}: ${message}`);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(`Grant failed: ${message}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isSelfRevoke =
    revokeModal !== null &&
    currentParticipantId !== null &&
    revokeModal.admin.participantId === currentParticipantId;

  return (
    <div className="flex flex-col gap-6">
      {/* SECTION 1 — Current admins table. */}
      <section className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Current admins
          </h2>
          <p className="text-sm text-neutral-600">
            Each row is an active grant from <code className="font-mono text-xs">admin_roles</code>{' '}
            (where <code className="font-mono text-xs">revoked_at IS NULL</code>). Revoking a
            row records a row in{' '}
            <code className="font-mono text-xs">audit_log</code> (via the slice-006
            trigger) plus a linked{' '}
            <code className="font-mono text-xs">tournament_config_versions</code>{' '}
            row.
          </p>
        </header>

        {activeAdmins.length === 0 ? (
          <div
            data-testid="admin-roles-empty"
            role="status"
            className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            No active admins. Bootstrap one via SQL or seed.
          </div>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-200">
            <table
              data-testid="admin-roles-table"
              className="w-full text-left text-sm"
            >
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Display name</th>
                  <th className="px-3 py-2 font-medium">Granted at</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeAdmins.map((admin) => {
                  const isSelf =
                    currentParticipantId !== null &&
                    admin.participantId === currentParticipantId;
                  return (
                    <tr
                      key={admin.id}
                      data-testid="admin-row"
                      data-participant-id={admin.participantId}
                      className="border-t border-neutral-200"
                    >
                      <td className="px-3 py-2 font-mono text-xs text-neutral-800">
                        {admin.email ?? <em className="text-neutral-400">(unknown)</em>}
                        {isSelf && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                            you
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-neutral-700">
                        {admin.displayName ?? (
                          <em className="text-neutral-400">(unknown)</em>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                        {admin.grantedAt}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleOpenRevoke(admin)}
                          disabled={pending}
                          data-testid="admin-revoke-button"
                          className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SECTION 2 — Grant form. */}
      <section
        data-testid="grant-form"
        className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Grant admin role
          </h2>
          <p className="text-sm text-neutral-600">
            Search by email or display name (min {MIN_QUERY_LENGTH} chars). Pick a
            result, supply a reason + source citation, and submit. Grants take
            effect immediately.
          </p>
        </header>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Participant (search by email or name)
          </span>
          <input
            type="text"
            value={grant.query}
            onChange={(e) =>
              setGrant((prev) => ({
                ...prev,
                query: e.target.value,
                // Clear pinned selection when the operator edits the input.
                selected:
                  prev.selected && e.target.value === prev.selected.email
                    ? prev.selected
                    : null,
              }))
            }
            disabled={pending}
            data-testid="grant-search-input"
            placeholder="alice@nortal.com"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
          {grant.selected && (
            <span className="flex items-center gap-2 text-xs text-neutral-600">
              Selected:{' '}
              <span className="font-mono">{grant.selected.email}</span>
              <button
                type="button"
                onClick={handleClearSelection}
                className="rounded border border-neutral-300 px-2 py-0.5 text-[10px] hover:bg-neutral-100"
              >
                Change
              </button>
            </span>
          )}
        </label>

        {!grant.selected && grant.query.trim().length >= MIN_QUERY_LENGTH && (
          <div
            data-testid="grant-search-results"
            className="overflow-hidden rounded border border-neutral-200"
          >
            {grant.searching && (
              <p className="px-3 py-2 text-xs text-neutral-500">Searching…</p>
            )}
            {grant.searchError && (
              <p className="px-3 py-2 text-xs text-red-600">
                {grant.searchError}
              </p>
            )}
            {!grant.searching &&
              !grant.searchError &&
              grant.results.length === 0 && (
                <p className="px-3 py-2 text-xs text-neutral-500">No matches.</p>
              )}
            {grant.results.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => handleSelectSearchResult(result)}
                data-testid="grant-search-result"
                data-participant-id={result.id}
                className="block w-full border-t border-neutral-200 px-3 py-2 text-left first:border-t-0 hover:bg-neutral-50"
              >
                <span className="block font-mono text-xs text-neutral-800">
                  {result.email}
                </span>
                <span className="block text-xs text-neutral-500">
                  {result.display_name}
                </span>
              </button>
            ))}
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Reason (required)
          </span>
          <textarea
            value={grant.reason}
            onChange={(e) =>
              setGrant((prev) => ({ ...prev, reason: e.target.value }))
            }
            rows={2}
            required
            disabled={pending}
            data-testid="grant-reason"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Source citation (required)
          </span>
          <input
            type="text"
            value={grant.sourceCitation}
            onChange={(e) =>
              setGrant((prev) => ({ ...prev, sourceCitation: e.target.value }))
            }
            required
            disabled={pending}
            data-testid="grant-source-citation"
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={handleSubmitGrant}
            disabled={pending || grant.selected === null}
            data-testid="grant-submit"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Grant admin role
          </button>
        </div>
      </section>

      {/* Shared toast + error. */}
      {toast && (
        <div
          data-testid="admin-roles-toast"
          role="status"
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
        >
          {toast}
        </div>
      )}
      {error && (
        <div
          data-testid="admin-roles-error"
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {pending && <p className="text-sm text-neutral-500">Submitting…</p>}

      {/* Revoke modal (rendered last so it overlays everything else). */}
      {revokeModal && (
        <div
          data-testid="revoke-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Revoke admin role for ${revokeModal.admin.email ?? revokeModal.admin.participantId}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <header className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-neutral-900">
                Revoke admin role
              </h2>
              <p className="text-xs font-mono text-neutral-500">
                {revokeModal.admin.email ?? revokeModal.admin.participantId}
              </p>
            </header>

            {isSelfRevoke && (
              <div
                data-testid="revoke-self-warning"
                role="alert"
                className="mt-3 rounded border border-red-400 bg-red-50 p-3 text-sm text-red-800"
              >
                <p className="font-semibold">
                  You are revoking your OWN admin role.
                </p>
                <p className="mt-1">
                  This will end your admin session on the next request. You
                  will need another admin to grant the role back to you.
                </p>
              </div>
            )}

            <label className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">
                Reason (required)
              </span>
              <textarea
                value={revokeModal.reason}
                onChange={(e) =>
                  setRevokeModal((prev) =>
                    prev ? { ...prev, reason: e.target.value } : prev,
                  )
                }
                rows={2}
                required
                disabled={pending}
                data-testid="revoke-reason"
                className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
              />
            </label>

            <label className="mt-3 flex flex-col gap-1">
              <span className="text-sm font-medium text-neutral-700">
                Source citation (required)
              </span>
              <input
                type="text"
                value={revokeModal.sourceCitation}
                onChange={(e) =>
                  setRevokeModal((prev) =>
                    prev ? { ...prev, sourceCitation: e.target.value } : prev,
                  )
                }
                required
                disabled={pending}
                data-testid="revoke-source-citation"
                className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
              />
            </label>

            {revokeModal.error && (
              <div
                role="alert"
                className="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
              >
                {revokeModal.error}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCloseRevoke}
                disabled={pending}
                data-testid="revoke-cancel"
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRevoke}
                disabled={pending}
                data-testid="revoke-confirm"
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Confirm revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
