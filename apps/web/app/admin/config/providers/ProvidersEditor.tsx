'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

import { PROVIDER_NUMERIC_SEGMENTS, type ProviderNumericSegment } from './segments';

/**
 * `ProvidersEditor` — client companion to `/admin/config/providers/page.tsx`
 * (Slice 008, Phase 6, T039, US4).
 *
 * Three independent flows on a single page:
 *   1. Active-provider dropdown + Save → confirm dialog warns "switching
 *      provider takes effect on the next scheduled sync", then runs the
 *      standard Preview → PreviewWarning → Confirm → upsert cycle.
 *   2. Per-provider numeric inputs (retry.max_attempts,
 *      retry.backoff_seconds_base, alert.threshold_consecutive_failures).
 *      Each has its own Save button with its own version_id, mirroring
 *      ScoringEditor's per-key slice pattern (T033).
 *   3. Per-provider "Reveal credential" button → opens a modal that POSTs to
 *      `/api/admin/config/get-secret`. The cleartext is rendered ONLY inside
 *      that modal in a readonly input + Copy button; it is never rendered
 *      inline on the main page and never lives in this component's state
 *      beyond modal-open lifetime (cleared on Close).
 *
 * Why a client component:
 *   T039 demands interactive multi-key save flows + a modal reveal path. The
 *   server page (page.tsx) gates + hydrates initial state and computes the
 *   provider catalog.
 *
 * Wire format:
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Get-secret body: `{ key }`. Response: `{ value: { secret, value } }`.
 *
 * @see apps/web/app/admin/config/providers/page.tsx
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/api/admin/config/get-secret/route.ts
 * @see specs/008-configuration/tasks.md § T039
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

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

export type ProvidersInitialState = {
  active: { value: string; versionId: string };
  allProviderIds: string[];
  providers: Array<{
    id: string;
    numeric: Record<
      ProviderNumericSegment,
      { value: number; versionId: string } | null
    >;
    credential: { key: string; present: boolean };
  }>;
};

interface ProvidersEditorProps {
  initialState: ProvidersInitialState;
}

// Short hyphenated alias per task spec (used in DOM testids). The actual key
// segments live in `PROVIDER_NUMERIC_SEGMENTS` (re-exported from page.tsx).
// The task body referred to `retry.backoff_seconds` and `alert.failure_threshold`;
// the seed/validator use the longer names (D-T039-A in page.tsx). We expose
// BOTH the task-body alias (for T043 testid stability) and `data-config-key`
// (for the authoritative key string).
const SEGMENT_TESTID_ALIAS: Record<ProviderNumericSegment, string> = {
  'retry.max_attempts': 'retry-max-attempts',
  'retry.backoff_seconds_base': 'retry-backoff-seconds',
  'alert.threshold_consecutive_failures': 'alert-failure-threshold',
};

const SEGMENT_LABELS: Record<
  ProviderNumericSegment,
  { title: string; help: string; min: number; max: number }
> = {
  'retry.max_attempts': {
    title: 'Retry max attempts',
    help: 'Maximum retry attempts per sync call before giving up. Range 1..100.',
    min: 1,
    max: 100,
  },
  'retry.backoff_seconds_base': {
    title: 'Retry backoff (seconds)',
    help: 'Base backoff delay in seconds; the sync loop multiplies by retry count. Range 1..3600.',
    min: 1,
    max: 3600,
  },
  'alert.threshold_consecutive_failures': {
    title: 'Alert: consecutive failures',
    help: 'Raise an operator alert after this many consecutive sync failures. Range 1..1000.',
    min: 1,
    max: 1000,
  },
};

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export function ProvidersEditor({
  initialState,
}: ProvidersEditorProps): JSX.Element {
  const router = useRouter();

  // --- Active-provider section state. ---------------------------------------
  const [active, setActive] = useState<SectionState<string>>({
    value: initialState.active.value,
    versionId: initialState.active.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
  });

  /**
   * When the user clicks Save on the dropdown we first show a confirm dialog
   * (per T039: "Switching provider takes effect on next scheduled sync.
   * Continue?"). On confirm we then run Preview. This gate lives in its own
   * piece of state so the standard PreviewWarning can render below it.
   */
  const [activeConfirmOpen, setActiveConfirmOpen] = useState(false);

  // --- Per-provider numeric state. -----------------------------------------
  // Shape: providerId → segment → SectionState<number> | null (null when the
  // row was not seeded; the editor renders a disabled-with-explanation slot).
  type NumericPerProvider = Record<
    string,
    Record<ProviderNumericSegment, SectionState<number> | null>
  >;

  const [numeric, setNumeric] = useState<NumericPerProvider>(() => {
    const init: NumericPerProvider = {};
    for (const p of initialState.providers) {
      const segs = {} as Record<ProviderNumericSegment, SectionState<number> | null>;
      for (const segment of PROVIDER_NUMERIC_SEGMENTS) {
        const row = p.numeric[segment];
        segs[segment] = row
          ? {
              value: row.value,
              versionId: row.versionId,
              reason: '',
              sourceCitation: '',
              validationError: null,
              preview: null,
              pendingValue: null,
              error: null,
              toast: null,
            }
          : null;
      }
      init[p.id] = segs;
    }
    return init;
  });

  // --- Credential reveal modal state. --------------------------------------
  type CredentialModal = {
    providerId: string;
    key: string;
    value: string | null; // null while loading
    error: string | null;
    copied: boolean;
  };
  const [credentialModal, setCredentialModal] = useState<CredentialModal | null>(
    null,
  );

  // --- Per-provider expand/collapse. The active provider's section is open
  //     by default; others start collapsed.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const p of initialState.providers) {
      init[p.id] = p.id === initialState.active.value;
    }
    return init;
  });

  const [pending, startTransition] = useTransition();

  const providerLookup = useMemo(() => {
    const m = new Map<string, (typeof initialState.providers)[number]>();
    for (const p of initialState.providers) m.set(p.id, p);
    return m;
  }, [initialState]);

  // ---------------------------------------------------------------------------
  // Active provider — patch helpers.
  // ---------------------------------------------------------------------------
  function patchActive(patch: Partial<SectionState<string>>) {
    setActive((prev) => ({ ...prev, ...patch }));
  }

  function patchNumeric(
    providerId: string,
    segment: ProviderNumericSegment,
    patch: Partial<SectionState<number>>,
  ) {
    setNumeric((prev) => {
      const current = prev[providerId]?.[segment];
      if (!current) return prev;
      return {
        ...prev,
        [providerId]: {
          ...prev[providerId]!,
          [segment]: { ...current, ...patch },
        },
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Active provider — flow.
  //
  // Click Save → open in-page confirm dialog → on confirm, run Preview, which
  // renders PreviewWarning → on PreviewWarning confirm, run upsert.
  // ---------------------------------------------------------------------------
  function handleActiveSaveClick() {
    if (!active.reason.trim()) {
      patchActive({
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (!active.sourceCitation.trim()) {
      // Source citation is required for security-sensitive keys (providers.active
      // is in the locked sensitive list per admin-config-rpcs.write.md).
      patchActive({
        error: 'Source citation is required for the active-provider key',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (active.value === initialState.active.value) {
      patchActive({
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (!initialState.allProviderIds.includes(active.value)) {
      patchActive({
        error: `Unknown provider id "${active.value}"`,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patchActive({ error: null, toast: null });
    setActiveConfirmOpen(true);
  }

  async function handleActiveConfirmContinue() {
    setActiveConfirmOpen(false);
    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: 'providers.active', value: active.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchActive({
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchActive({ preview: previewResult, pendingValue: active.value });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchActive({
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleActiveCancelConfirm() {
    setActiveConfirmOpen(false);
  }

  function handleActiveUpsertConfirm(token: string | null) {
    const pendingValue = active.pendingValue;
    if (pendingValue === null) return;
    patchActive({ error: null });

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'providers.active',
            value: pendingValue,
            expected_version_id: active.versionId,
            reason: active.reason.trim(),
            source_citation: active.sourceCitation.trim() || null,
            acknowledge_token: token,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          initialState.active = { value: pendingValue, versionId: newVersionId };
          patchActive({
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
          patchActive({
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchActive({
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  function handleActiveCancelPreview() {
    patchActive({ preview: null, pendingValue: null });
  }

  // ---------------------------------------------------------------------------
  // Numeric — per-key flow (Preview → PreviewWarning → Confirm).
  // ---------------------------------------------------------------------------

  function handleNumericChange(
    providerId: string,
    segment: ProviderNumericSegment,
    raw: string,
  ) {
    const section = numeric[providerId]?.[segment];
    if (!section) return;
    if (raw === '') {
      patchNumeric(providerId, segment, { validationError: 'Value required' });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      patchNumeric(providerId, segment, { validationError: 'Must be an integer' });
      return;
    }
    const fullKey = `providers.${providerId}.${segment}`;
    const result = validateConfigValue(fullKey, parsed);
    if (!result.ok) {
      patchNumeric(providerId, segment, {
        value: parsed,
        validationError: result.error,
      });
    } else {
      patchNumeric(providerId, segment, { value: parsed, validationError: null });
    }
  }

  async function handleNumericPreview(
    providerId: string,
    segment: ProviderNumericSegment,
  ) {
    const section = numeric[providerId]?.[segment];
    if (!section) return;
    if (!section.reason.trim()) {
      patchNumeric(providerId, segment, {
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (section.validationError) {
      patchNumeric(providerId, segment, {
        error: section.validationError,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const initial = initialState.providers
      .find((p) => p.id === providerId)
      ?.numeric[segment];
    if (initial && section.value === initial.value) {
      patchNumeric(providerId, segment, {
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const fullKey = `providers.${providerId}.${segment}`;
    const localCheck = validateConfigValue(fullKey, section.value);
    if (!localCheck.ok) {
      patchNumeric(providerId, segment, {
        validationError: localCheck.error,
        error: localCheck.error,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patchNumeric(providerId, segment, { error: null, toast: null });

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: fullKey, value: section.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchNumeric(providerId, segment, {
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchNumeric(providerId, segment, {
        preview: previewResult,
        pendingValue: section.value,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchNumeric(providerId, segment, {
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleNumericConfirm(
    providerId: string,
    segment: ProviderNumericSegment,
    token: string | null,
  ) {
    const section = numeric[providerId]?.[segment];
    if (!section || section.pendingValue === null) return;
    const pendingValue = section.pendingValue;
    const fullKey = `providers.${providerId}.${segment}`;
    patchNumeric(providerId, segment, { error: null });

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: fullKey,
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
          // Snap the snapshot so subsequent "no-op" checks key off the
          // newly-persisted value.
          const p = initialState.providers.find((pp) => pp.id === providerId);
          if (p) {
            p.numeric[segment] = { value: pendingValue, versionId: newVersionId };
          }
          patchNumeric(providerId, segment, {
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
          patchNumeric(providerId, segment, {
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchNumeric(providerId, segment, {
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  function handleNumericCancel(
    providerId: string,
    segment: ProviderNumericSegment,
  ) {
    patchNumeric(providerId, segment, { preview: null, pendingValue: null });
  }

  // ---------------------------------------------------------------------------
  // Credential reveal modal flow.
  // ---------------------------------------------------------------------------

  async function handleReveal(providerId: string) {
    const p = providerLookup.get(providerId);
    if (!p) return;
    const key = p.credential.key;
    setCredentialModal({ providerId, key, value: null, error: null, copied: false });
    try {
      const res = await fetch('/api/admin/config/get-secret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Reveal failed: ${res.status}`;
        setCredentialModal({
          providerId,
          key,
          value: null,
          error: `${code}: ${message}`,
          copied: false,
        });
        return;
      }
      const data = (await res.json()) as {
        value: { secret?: boolean; value?: string | null } | null;
      };
      const cleartext =
        typeof data?.value?.value === 'string' ? data.value.value : '';
      setCredentialModal({
        providerId,
        key,
        value: cleartext,
        error: null,
        copied: false,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCredentialModal({
        providerId,
        key,
        value: null,
        error: `Reveal failed: ${message}`,
        copied: false,
      });
    }
  }

  async function handleCopyCredential() {
    if (!credentialModal?.value) return;
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(credentialModal.value);
      }
      setCredentialModal((prev) => (prev ? { ...prev, copied: true } : prev));
    } catch {
      setCredentialModal((prev) =>
        prev ? { ...prev, error: 'Copy failed (clipboard unavailable)' } : prev,
      );
    }
  }

  function handleCloseCredentialModal() {
    // Drop the cleartext from component state on close.
    setCredentialModal(null);
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  return (
    <div data-testid="providers-editor" className="flex flex-col gap-6">
      {/* Active provider section. */}
      <section
        data-section-key="providers.active"
        className="flex flex-col gap-3 rounded border border-border bg-card p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">
            Active provider
          </h2>
          <p className="text-xs font-mono text-muted-foreground">providers.active</p>
          <p className="text-sm text-muted-foreground">
            The provider id used by the next scheduled sync. Changing this
            does <em>not</em> retroactively re-fetch existing data.
          </p>
        </header>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">Provider</span>
          <select
            value={active.value}
            onChange={(e) => patchActive({ value: e.target.value })}
            data-testid="active-provider-select"
            disabled={pending}
            className="w-72 rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
          >
            {initialState.allProviderIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Reason (required)
          </span>
          <textarea
            value={active.reason}
            onChange={(e) => patchActive({ reason: e.target.value })}
            rows={2}
            required
            disabled={pending}
            className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted-foreground">
            Source citation (required)
          </span>
          <input
            type="text"
            value={active.sourceCitation}
            onChange={(e) => patchActive({ sourceCitation: e.target.value })}
            required
            disabled={pending}
            className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={handleActiveSaveClick}
            disabled={pending}
            data-testid="active-provider-save"
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {activeConfirmOpen && (
          <div
            data-testid="active-provider-confirm"
            role="dialog"
            aria-modal="true"
            className="rounded-lg border border-amber-400 bg-open/10 p-4"
          >
            <h3 className="text-sm font-semibold text-open">
              Confirm provider switch
            </h3>
            <p className="mt-2 text-sm text-open">
              Switching the active provider takes effect on the next scheduled
              sync. In-flight results from the previous adapter are not
              re-fetched. Continue?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="active-provider-confirm-cancel"
                onClick={handleActiveCancelConfirm}
                className="rounded-md border border-gray-300 bg-card px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="active-provider-confirm-continue"
                onClick={() => void handleActiveConfirmContinue()}
                className="rounded-md bg-open px-4 py-2 text-sm font-medium text-white hover:bg-open/90"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {active.preview && (
          <PreviewWarning
            preview={active.preview}
            onConfirm={handleActiveUpsertConfirm}
            onCancel={handleActiveCancelPreview}
          />
        )}

        {active.error && (
          <div
            data-testid="active-provider-error"
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {active.error}
          </div>
        )}
        {active.toast && (
          <div
            data-testid="active-provider-toast"
            role="status"
            className="rounded border border-win/40 bg-win/10 p-3 text-sm text-win"
          >
            {active.toast}
          </div>
        )}

        <p className="text-xs text-muted-foreground/60">
          Current version:{' '}
          <span className="font-mono">{active.versionId}</span>
        </p>
      </section>

      {/* Per-provider sub-sections. */}
      {initialState.providers.map((provider) => {
        const isExpanded = expanded[provider.id] ?? false;
        return (
          <section
            key={provider.id}
            data-testid="provider-section"
            data-provider-id={provider.id}
            className="flex flex-col gap-3 rounded border border-border bg-card p-4"
          >
            <header className="flex items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold text-foreground">
                  {provider.id}
                </h2>
                <p className="text-xs font-mono text-muted-foreground">
                  providers.{provider.id}.*
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [provider.id]: !prev[provider.id],
                  }))
                }
                data-testid={`provider-${provider.id}-toggle`}
                aria-expanded={isExpanded}
                className="rounded border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                {isExpanded ? 'Collapse' : 'Expand'}
              </button>
            </header>

            {isExpanded && (
              <div className="flex flex-col gap-4">
                {PROVIDER_NUMERIC_SEGMENTS.map((segment) => {
                  const alias = SEGMENT_TESTID_ALIAS[segment];
                  const label = SEGMENT_LABELS[segment];
                  const section = numeric[provider.id]?.[segment];
                  const fullKey = `providers.${provider.id}.${segment}`;

                  if (!section) {
                    return (
                      <div
                        key={segment}
                        data-testid={`provider-${provider.id}-${alias}-missing`}
                        className="rounded border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
                      >
                        <p className="font-medium">{label.title}</p>
                        <p className="font-mono text-xs">{fullKey}</p>
                        <p className="mt-1 text-xs">
                          Not seeded. Bootstrap this key via SQL or import
                          before editing.
                        </p>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={segment}
                      data-config-key={fullKey}
                      className="flex flex-col gap-2 rounded border border-border bg-muted/30 p-3"
                    >
                      <header className="flex flex-col gap-1">
                        <h3 className="text-sm font-semibold text-foreground">
                          {label.title}
                        </h3>
                        <p className="text-xs font-mono text-muted-foreground">
                          {fullKey}
                        </p>
                        <p className="text-xs text-muted-foreground">{label.help}</p>
                      </header>

                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Value
                        </span>
                        <input
                          type="number"
                          min={label.min}
                          max={label.max}
                          step={1}
                          value={section.value}
                          onChange={(e) =>
                            handleNumericChange(
                              provider.id,
                              segment,
                              e.target.value,
                            )
                          }
                          data-testid={`provider-${provider.id}-${alias}-input`}
                          aria-invalid={section.validationError ? true : undefined}
                          disabled={pending}
                          className="w-40 rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
                        />
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Reason (required)
                        </span>
                        <textarea
                          value={section.reason}
                          onChange={(e) =>
                            patchNumeric(provider.id, segment, {
                              reason: e.target.value,
                            })
                          }
                          rows={2}
                          required
                          disabled={pending}
                          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
                        />
                      </label>

                      <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Source citation (optional)
                        </span>
                        <input
                          type="text"
                          value={section.sourceCitation}
                          onChange={(e) =>
                            patchNumeric(provider.id, segment, {
                              sourceCitation: e.target.value,
                            })
                          }
                          disabled={pending}
                          className="rounded border border-border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-muted"
                        />
                      </label>

                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            void handleNumericPreview(provider.id, segment)
                          }
                          disabled={pending || section.validationError !== null}
                          data-testid={`provider-${provider.id}-${alias}-save`}
                          className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Save
                        </button>
                      </div>

                      {section.preview && (
                        <PreviewWarning
                          preview={section.preview}
                          onConfirm={(token) =>
                            handleNumericConfirm(provider.id, segment, token)
                          }
                          onCancel={() =>
                            handleNumericCancel(provider.id, segment)
                          }
                        />
                      )}

                      {section.error && (
                        <div
                          data-testid={`provider-${provider.id}-${alias}-error`}
                          role="alert"
                          className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                        >
                          {section.error}
                        </div>
                      )}
                      {section.toast && (
                        <div
                          data-testid={`provider-${provider.id}-${alias}-toast`}
                          role="status"
                          className="rounded border border-win/40 bg-win/10 p-2 text-xs text-win"
                        >
                          {section.toast}
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground/60">
                        Current version:{' '}
                        <span className="font-mono">{section.versionId}</span>
                      </p>
                    </div>
                  );
                })}

                {/* Credential reveal entry. Never renders the value inline. */}
                <div className="flex items-center justify-between rounded border border-border bg-muted/30 p-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold text-foreground">
                      Credential
                    </h3>
                    <p className="text-xs font-mono text-muted-foreground">
                      {provider.credential.key}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {provider.credential.present
                        ? '•••• (reveal to view)'
                        : 'Not configured.'}{' '}
                      Every reveal writes an{' '}
                      <code className="font-mono">
                        admin.config_secret_accessed
                      </code>{' '}
                      audit row.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleReveal(provider.id)}
                    disabled={pending || !provider.credential.present}
                    data-testid={`provider-${provider.id}-reveal-credential`}
                    className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Reveal credential
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}

      {/* Credential reveal modal. */}
      {credentialModal && (
        <div
          data-testid={`provider-${credentialModal.providerId}-credential-modal`}
          role="dialog"
          aria-modal="true"
          aria-label={`Credential for ${credentialModal.providerId}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-card p-5 shadow-xl">
            <header className="flex flex-col gap-1">
              <h2 className="text-base font-semibold text-foreground">
                Credential — {credentialModal.providerId}
              </h2>
              <p className="text-xs font-mono text-muted-foreground">
                {credentialModal.key}
              </p>
            </header>

            {credentialModal.error ? (
              <div
                role="alert"
                className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {credentialModal.error}
              </div>
            ) : credentialModal.value === null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Loading credential…
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Value
                  </span>
                  <input
                    type="text"
                    readOnly
                    value={credentialModal.value}
                    data-testid={`provider-${credentialModal.providerId}-credential-value`}
                    onFocus={(e) => e.currentTarget.select()}
                    className="rounded border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Copy this value somewhere safe; closing this dialog drops it
                  from the page state.
                </p>
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleCopyCredential()}
                disabled={
                  credentialModal.value === null || credentialModal.error !== null
                }
                data-testid={`provider-${credentialModal.providerId}-credential-copy`}
                className="rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-primary hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {credentialModal.copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={handleCloseCredentialModal}
                data-testid={`provider-${credentialModal.providerId}-credential-close`}
                className="rounded-md border border-gray-300 bg-card px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="text-sm text-muted-foreground">Submitting…</div>
      )}
    </div>
  );
}
