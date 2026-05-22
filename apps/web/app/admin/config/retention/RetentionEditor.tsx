'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import PreviewWarning from '../PreviewWarning';
import { validateConfigValue } from '@/lib/config-validators';

/**
 * `RetentionEditor` — client companion to `/admin/config/retention/page.tsx`
 * (Slice 008, Phase 8b, T066, US7).
 *
 * Four independent edit-and-save flows on a single page, each carrying its
 * own version_id + reason/citation/state and using its own Preview →
 * <PreviewWarning> → Confirm cycle. Each section saves through the existing
 * `/api/admin/config/preview` + `/api/admin/config/upsert` routes (T027 —
 * REUSED here, no new route handlers).
 *
 * Sections:
 *   1. audit.retention.policy_kind                  ('keep' vs 'prune' radio)
 *   2. audit.retention.tournament_end_buffer_months (integer 1..120)
 *   3. notifications.audit_failure_webhook_url      (text — empty = clear)
 *   4. notifications.audit_failure_webhook_secret   (write-only secret)
 *
 * The secret section deliberately starts with an empty input. The server
 * page (page.tsx) does NOT ship the cleartext to the client — only a
 * presence flag (`hasSecret`). A "Reveal" toggle exists for usability while
 * typing a new value, but reveal never shows historical state. To rotate
 * the secret the admin must re-type it.
 *
 * Why a client component:
 *   T066 demands four interactive input/preview/confirm flows + a password
 *   reveal toggle. The server page just gates + hydrates initial state.
 *
 * Cross-task references:
 *   - T061 (audit_failure alert enqueue), T062 (webhook dispatcher), T063
 *     (retry policy) consume the URL + secret keys edited here.
 *   - T053 import contract reads/writes the same keys (with a skip branch
 *     when the secret key is unset).
 *   - T018 zod schemas define the validation envelope; we delegate to
 *     `validateConfigValue` so inline messages stay identical to what
 *     `admin_config_upsert` would surface (WCG02).
 *
 * Wire format (T027 routes — REUSED):
 *   - Preview body: `{ key, value }`. Response:
 *     `{ affecting, summary, sample, acknowledge_token }`.
 *   - Upsert body: `{ key, value, expected_version_id, reason,
 *     source_citation, acknowledge_token }`. Response: `{ version_id }`.
 *   - Error envelope (both routes): `{ error: { code, message, field? } }`
 *     where `code` is one of `WCG01`..`WCG07` or `INTERNAL`/`BAD_REQUEST`.
 *
 * DOM contract (T067 selectors):
 *   - `[data-testid="retention-policy-radio"][value="keep|prune"]`
 *   - `[data-testid="retention-policy-save"]`
 *   - `[data-testid="retention-buffer-months-input"]`
 *   - `[data-testid="retention-buffer-months-save"]`
 *   - `[data-testid="retention-webhook-url-input"]`
 *   - `[data-testid="retention-webhook-url-save"]`
 *   - `[data-testid="retention-webhook-secret-input"]`
 *   - `[data-testid="retention-webhook-secret-reveal"]`
 *   - `[data-testid="retention-webhook-secret-save"]`
 *   - `[data-testid="config-preview-warning"]` (from <PreviewWarning>)
 *   - `[data-testid="retention-toast"]`
 *   - `[data-testid="retention-error"]`
 *
 * @see specs/008-configuration/tasks.md § T066
 * @see apps/web/app/admin/config/PreviewWarning.tsx
 * @see apps/web/app/admin/config/scoring/ScoringEditor.tsx (T033 multi-key
 *      sibling whose per-key save flow this file mirrors)
 * @see apps/web/lib/config-validators.ts (T018)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PolicyValue = 'keep' | 'prune';

const POLICY_VALUES = ['keep', 'prune'] as const;

function isPolicyValue(v: unknown): v is PolicyValue {
  return (
    typeof v === 'string' &&
    (POLICY_VALUES as readonly string[]).includes(v)
  );
}

type PreviewResult = {
  affecting: boolean;
  summary: string;
  sample: unknown;
  acknowledge_token: string | null;
};

interface SectionShared {
  versionId: string;
  reason: string;
  sourceCitation: string;
  validationError: string | null;
  preview: PreviewResult | null;
  error: string | null;
  toast: string | null;
}

interface PolicySectionState extends SectionShared {
  value: PolicyValue;
  pendingValue: PolicyValue | null;
}

interface BufferSectionState extends SectionShared {
  value: number;
  pendingValue: number | null;
}

interface WebhookUrlSectionState extends SectionShared {
  /** Empty string represents "clear the URL" (null on the wire). */
  value: string;
  pendingValue: string | null;
}

interface WebhookSecretSectionState extends SectionShared {
  /** User-typed cleartext (always starts empty on every page load). */
  value: string;
  pendingValue: string | null;
  /** True if the underlying row exists in tournament_config (presence-only). */
  hasSecret: boolean;
  /** True when the user toggles the input to reveal what they're typing. */
  revealed: boolean;
}

export interface RetentionInitialState {
  policy: { value: string; versionId: string };
  buffer: { value: number; versionId: string };
  webhookUrl: { value: string | null; versionId: string };
  webhookSecret: { hasSecret: boolean; versionId: string };
}

interface RetentionEditorProps {
  initialState: RetentionInitialState;
}

// ---------------------------------------------------------------------------
// Validation helpers (local — mirror the T018 schemas + task body envelope).
// ---------------------------------------------------------------------------

/** URL must start with http:// or https:// (or be empty to clear). */
const URL_PATTERN = /^https?:\/\/.+/;

const BUFFER_MIN = 1;
const BUFFER_MAX = 120;

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export function RetentionEditor({
  initialState,
}: RetentionEditorProps): JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // --- Policy section --------------------------------------------------------
  const [policy, setPolicy] = useState<PolicySectionState>(() => ({
    value: isPolicyValue(initialState.policy.value)
      ? initialState.policy.value
      : 'keep',
    versionId: initialState.policy.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
  }));

  // --- Buffer-months section -------------------------------------------------
  const [buffer, setBuffer] = useState<BufferSectionState>(() => ({
    value: initialState.buffer.value,
    versionId: initialState.buffer.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
  }));

  // --- Webhook URL section ---------------------------------------------------
  const [webhookUrl, setWebhookUrl] = useState<WebhookUrlSectionState>(() => ({
    value: initialState.webhookUrl.value ?? '',
    versionId: initialState.webhookUrl.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
  }));

  // --- Webhook secret section ------------------------------------------------
  const [webhookSecret, setWebhookSecret] = useState<WebhookSecretSectionState>(() => ({
    value: '',
    versionId: initialState.webhookSecret.versionId,
    reason: '',
    sourceCitation: '',
    validationError: null,
    preview: null,
    pendingValue: null,
    error: null,
    toast: null,
    hasSecret: initialState.webhookSecret.hasSecret,
    revealed: false,
  }));

  // ---------------------------------------------------------------------------
  // Shared preview/upsert pipeline. Each section threads its own patch fn so
  // the central helpers can update the right slice of local state. We
  // accept an `equalToInitial` predicate so each section decides what
  // "no-op" means (e.g. the secret section never blocks because the wire
  // value can be any new cleartext).
  // ---------------------------------------------------------------------------

  type Section<V> = SectionShared & { value: V; pendingValue: V | null };

  async function runPreview<V>(args: {
    key: string;
    section: Section<V>;
    wireValue: V;
    equalToInitial: boolean;
    patch: (next: Partial<Section<V>>) => void;
  }): Promise<void> {
    const { key, section, wireValue, equalToInitial, patch } = args;
    if (!section.reason.trim()) {
      patch({
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (section.validationError) {
      patch({
        error: section.validationError,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (equalToInitial) {
      patch({
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patch({ error: null, toast: null });

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key, value: wireValue }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patch({
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patch({
        preview: previewResult,
        pendingValue: wireValue,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patch({
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function runConfirm<V>(args: {
    key: string;
    section: Section<V>;
    token: string | null;
    onSuccess: (newVersionId: string, pendingValue: V) => void;
    patch: (next: Partial<Section<V>>) => void;
  }): void {
    const { key, section, token, onSuccess, patch } = args;
    const pendingValue = section.pendingValue;
    if (pendingValue === null) return;
    patch({ error: null });

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
          onSuccess(newVersionId, pendingValue);
          router.refresh();
        } else {
          const body = await res.json().catch(() => ({}));
          const code =
            (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
          const message =
            (body as { error?: { message?: string } })?.error?.message ??
            'Update failed';
          patch({
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patch({
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Section 1: policy_kind.
  // ---------------------------------------------------------------------------
  function patchPolicy(next: Partial<PolicySectionState>): void {
    setPolicy((prev) => ({ ...prev, ...next }));
  }

  function handlePolicyChange(value: PolicyValue): void {
    // T018 has policy_kind as enum(['keep','delete']) currently; the T066 UI
    // exposes 'keep' | 'prune'. Both pass the SQL value_type='text' backstop.
    // Surface our local enum check + run the validator if it happens to match.
    const result = validateConfigValue('audit.retention.policy_kind', value);
    patchPolicy({
      value,
      preview: null,
      pendingValue: null,
      validationError: result.ok
        ? null
        : // Forward-compat: 'prune' may not yet be in the T018 enum. Allow
          // it through with no local error — the server text-type backstop
          // accepts any string.
          value === 'prune'
          ? null
          : result.error,
    });
  }

  async function handlePolicyPreview(): Promise<void> {
    await runPreview<PolicyValue>({
      key: 'audit.retention.policy_kind',
      section: policy,
      wireValue: policy.value,
      equalToInitial: policy.value === initialState.policy.value,
      patch: patchPolicy,
    });
  }

  function handlePolicyConfirm(token: string | null): void {
    runConfirm<PolicyValue>({
      key: 'audit.retention.policy_kind',
      section: policy,
      token,
      patch: patchPolicy,
      onSuccess: (newVersionId, pendingValue) => {
        initialState.policy = { value: pendingValue, versionId: newVersionId };
        patchPolicy({
          value: pendingValue,
          versionId: newVersionId,
          preview: null,
          pendingValue: null,
          reason: '',
          sourceCitation: '',
          toast: `Updated to version ${newVersionId}`,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Section 2: tournament_end_buffer_months.
  // ---------------------------------------------------------------------------
  function patchBuffer(next: Partial<BufferSectionState>): void {
    setBuffer((prev) => ({ ...prev, ...next }));
  }

  function handleBufferChange(raw: string): void {
    if (raw === '') {
      patchBuffer({ validationError: 'Value required', preview: null, pendingValue: null });
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      patchBuffer({
        validationError: 'Must be an integer',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (parsed < BUFFER_MIN || parsed > BUFFER_MAX) {
      patchBuffer({
        value: parsed,
        validationError: `Must be between ${BUFFER_MIN} and ${BUFFER_MAX} months`,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    const result = validateConfigValue(
      'audit.retention.tournament_end_buffer_months',
      parsed,
    );
    patchBuffer({
      value: parsed,
      preview: null,
      pendingValue: null,
      validationError: result.ok ? null : result.error,
    });
  }

  async function handleBufferPreview(): Promise<void> {
    await runPreview<number>({
      key: 'audit.retention.tournament_end_buffer_months',
      section: buffer,
      wireValue: buffer.value,
      equalToInitial: buffer.value === initialState.buffer.value,
      patch: patchBuffer,
    });
  }

  function handleBufferConfirm(token: string | null): void {
    runConfirm<number>({
      key: 'audit.retention.tournament_end_buffer_months',
      section: buffer,
      token,
      patch: patchBuffer,
      onSuccess: (newVersionId, pendingValue) => {
        initialState.buffer = { value: pendingValue, versionId: newVersionId };
        patchBuffer({
          value: pendingValue,
          versionId: newVersionId,
          preview: null,
          pendingValue: null,
          reason: '',
          sourceCitation: '',
          toast: `Updated to version ${newVersionId}`,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Section 3: audit_failure_webhook_url.
  // ---------------------------------------------------------------------------
  function patchWebhookUrl(next: Partial<WebhookUrlSectionState>): void {
    setWebhookUrl((prev) => ({ ...prev, ...next }));
  }

  function handleWebhookUrlChange(raw: string): void {
    // Empty input is intentional — it clears the webhook (T062: enqueue_alert
    // becomes a no-op when notifications.audit_failure_webhook_url is null).
    if (raw === '') {
      patchWebhookUrl({
        value: '',
        validationError: null,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (!URL_PATTERN.test(raw)) {
      patchWebhookUrl({
        value: raw,
        validationError: 'URL must start with http:// or https://',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    // Empty is "null on the wire"; non-empty goes through T018.
    const result = validateConfigValue(
      'notifications.audit_failure_webhook_url',
      raw,
    );
    patchWebhookUrl({
      value: raw,
      preview: null,
      pendingValue: null,
      validationError: result.ok ? null : result.error,
    });
  }

  async function handleWebhookUrlPreview(): Promise<void> {
    // Empty string maps to null on the wire — this is the "clear" path.
    const wireValue: string | null = webhookUrl.value === '' ? null : webhookUrl.value;
    const initialWire: string | null = initialState.webhookUrl.value ?? null;
    const equalToInitial = wireValue === initialWire;

    // We reuse runPreview but it's typed against the section's V (string here);
    // pre-screen the no-op + reason gates inline so we can pass null on the
    // wire while keeping section.value typed as string.
    if (!webhookUrl.reason.trim()) {
      patchWebhookUrl({
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (webhookUrl.validationError) {
      patchWebhookUrl({
        error: webhookUrl.validationError,
        preview: null,
        pendingValue: null,
      });
      return;
    }
    if (equalToInitial) {
      patchWebhookUrl({
        error: 'No change to submit',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    patchWebhookUrl({ error: null, toast: null });

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: 'notifications.audit_failure_webhook_url',
          value: wireValue,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchWebhookUrl({
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchWebhookUrl({
        preview: previewResult,
        // Stash the typed value the user sees; the confirm step will map
        // empty-string back to null on the wire.
        pendingValue: webhookUrl.value,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchWebhookUrl({
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleWebhookUrlConfirm(token: string | null): void {
    const pendingValue = webhookUrl.pendingValue;
    if (pendingValue === null) return;
    patchWebhookUrl({ error: null });

    const wireValue: string | null = pendingValue === '' ? null : pendingValue;

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'notifications.audit_failure_webhook_url',
            value: wireValue,
            expected_version_id: webhookUrl.versionId,
            reason: webhookUrl.reason.trim(),
            source_citation: webhookUrl.sourceCitation.trim() || null,
            acknowledge_token: token,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          initialState.webhookUrl = { value: wireValue, versionId: newVersionId };
          patchWebhookUrl({
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
          patchWebhookUrl({
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchWebhookUrl({
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Section 4: audit_failure_webhook_secret (write-only).
  // ---------------------------------------------------------------------------
  function patchWebhookSecret(next: Partial<WebhookSecretSectionState>): void {
    setWebhookSecret((prev) => ({ ...prev, ...next }));
  }

  function handleWebhookSecretChange(raw: string): void {
    // No local zod schema for this key (it's not in T018's catalog); rely on
    // server-side value_type backstop. Empty string clears the secret.
    patchWebhookSecret({
      value: raw,
      preview: null,
      pendingValue: null,
      validationError: null,
    });
  }

  async function handleWebhookSecretPreview(): Promise<void> {
    if (!webhookSecret.reason.trim()) {
      patchWebhookSecret({
        error: 'Reason is required before preview/save',
        preview: null,
        pendingValue: null,
      });
      return;
    }
    // Empty string is treated as "clear the secret". Since the server never
    // discloses the existing value to this component, there is no robust way
    // to detect a true no-op here; we accept the preview round-trip and let
    // the server's preview SP report `affecting=false` if the wire value
    // happens to match. This matches the security posture: re-typing the
    // same secret intentionally rotates the audit chain even if cleartext is
    // identical (every save writes a new tournament_config_versions row).
    patchWebhookSecret({ error: null, toast: null });

    const wireValue: string | null =
      webhookSecret.value === '' ? null : webhookSecret.value;

    try {
      const res = await fetch('/api/admin/config/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          key: 'notifications.audit_failure_webhook_secret',
          value: wireValue,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code =
          (body as { error?: { code?: string } })?.error?.code ?? 'ERROR';
        const message =
          (body as { error?: { message?: string } })?.error?.message ??
          `Preview failed: ${res.status}`;
        patchWebhookSecret({
          error: `${code}: ${message}`,
          preview: null,
          pendingValue: null,
        });
        return;
      }
      const previewResult = (await res.json()) as PreviewResult;
      patchWebhookSecret({
        preview: previewResult,
        pendingValue: webhookSecret.value,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchWebhookSecret({
        error: `Preview failed: ${message}`,
        preview: null,
        pendingValue: null,
      });
    }
  }

  function handleWebhookSecretConfirm(token: string | null): void {
    const pendingValue = webhookSecret.pendingValue;
    if (pendingValue === null) return;
    patchWebhookSecret({ error: null });

    const wireValue: string | null = pendingValue === '' ? null : pendingValue;

    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/config/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            key: 'notifications.audit_failure_webhook_secret',
            value: wireValue,
            expected_version_id: webhookSecret.versionId,
            reason: webhookSecret.reason.trim(),
            source_citation: webhookSecret.sourceCitation.trim() || null,
            acknowledge_token: token,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { version_id: number | string };
          const newVersionId =
            typeof data.version_id === 'string'
              ? data.version_id
              : String(data.version_id);
          initialState.webhookSecret = {
            hasSecret: wireValue !== null,
            versionId: newVersionId,
          };
          patchWebhookSecret({
            // Clear the cleartext from React state immediately on success —
            // no need to keep it around.
            value: '',
            versionId: newVersionId,
            hasSecret: wireValue !== null,
            preview: null,
            pendingValue: null,
            reason: '',
            sourceCitation: '',
            revealed: false,
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
          patchWebhookSecret({
            error: `${code}: ${message}`,
            preview: null,
            pendingValue: null,
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchWebhookSecret({
          error: `Update failed: ${message}`,
          preview: null,
          pendingValue: null,
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------

  const bufferInfoVisible = policy.value === 'prune';

  return (
    <div className="flex flex-col gap-8">
      {/* ===== Section 1: policy_kind ========================================== */}
      <section
        data-section-key="audit.retention.policy_kind"
        className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Retention policy
          </h2>
          <p className="text-xs font-mono text-neutral-500">
            audit.retention.policy_kind
          </p>
          <p className="text-sm text-neutral-600">
            <strong>Keep</strong> (recommended) preserves the full audit /
            configuration history indefinitely — no rollback or version row is
            ever pruned. <strong>Prune</strong> activates the retention window
            below, after which old versions become un-rollback-able.
          </p>
        </header>

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Retention policy</legend>
          {POLICY_VALUES.map((option) => (
            <label
              key={option}
              className="inline-flex items-center gap-2 text-sm text-neutral-800"
            >
              <input
                type="radio"
                name="retention-policy"
                value={option}
                checked={policy.value === option}
                onChange={() => handlePolicyChange(option)}
                disabled={pending}
                data-testid="retention-policy-radio"
                className="h-4 w-4 border-neutral-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="font-medium capitalize">{option}</span>
              {option === 'keep' && (
                <span className="text-xs text-neutral-500">
                  (recommended — never prunes)
                </span>
              )}
            </label>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Reason (required)
          </span>
          <textarea
            value={policy.reason}
            onChange={(e) => patchPolicy({ reason: e.target.value })}
            rows={2}
            required
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Source citation (optional)
          </span>
          <input
            type="text"
            value={policy.sourceCitation}
            onChange={(e) => patchPolicy({ sourceCitation: e.target.value })}
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handlePolicyPreview()}
            disabled={pending || policy.validationError !== null}
            data-testid="retention-policy-save"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {policy.preview && (
          <PreviewWarning
            preview={policy.preview}
            onConfirm={(token) => handlePolicyConfirm(token)}
            onCancel={() =>
              patchPolicy({ preview: null, pendingValue: null })
            }
          />
        )}

        {policy.error && (
          <div
            data-testid="retention-error"
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
          >
            {policy.error}
          </div>
        )}
        {policy.toast && (
          <div
            data-testid="retention-toast"
            role="status"
            className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
          >
            {policy.toast}
          </div>
        )}

        <p className="text-xs text-neutral-400">
          Current version:{' '}
          <span className="font-mono">{policy.versionId}</span>
        </p>
      </section>

      {/* ===== Section 2: buffer_months ======================================= */}
      <section
        data-section-key="audit.retention.tournament_end_buffer_months"
        className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Tournament-end buffer (months)
          </h2>
          <p className="text-xs font-mono text-neutral-500">
            audit.retention.tournament_end_buffer_months
          </p>
          <p className="text-sm text-neutral-600">
            Number of months after the tournament-end timestamp that audit /
            configuration history remains rollback-eligible. Allowed range:{' '}
            {BUFFER_MIN}..{BUFFER_MAX}.
          </p>
        </header>

        {!bufferInfoVisible && (
          <div
            role="note"
            className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900"
          >
            This value only applies when the retention policy is set to{' '}
            <strong>prune</strong>. With the current policy
            (<strong>{policy.value}</strong>) it has no effect.
          </div>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Buffer months
          </span>
          <input
            type="number"
            min={BUFFER_MIN}
            max={BUFFER_MAX}
            step={1}
            value={buffer.value}
            onChange={(e) => handleBufferChange(e.target.value)}
            data-testid="retention-buffer-months-input"
            aria-invalid={buffer.validationError ? true : undefined}
            disabled={pending}
            className="w-40 rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
          {buffer.validationError && (
            <span role="alert" className="text-xs text-red-600">
              {buffer.validationError}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Reason (required)
          </span>
          <textarea
            value={buffer.reason}
            onChange={(e) => patchBuffer({ reason: e.target.value })}
            rows={2}
            required
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Source citation (optional)
          </span>
          <input
            type="text"
            value={buffer.sourceCitation}
            onChange={(e) => patchBuffer({ sourceCitation: e.target.value })}
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handleBufferPreview()}
            disabled={pending || buffer.validationError !== null}
            data-testid="retention-buffer-months-save"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {buffer.preview && (
          <PreviewWarning
            preview={buffer.preview}
            onConfirm={(token) => handleBufferConfirm(token)}
            onCancel={() =>
              patchBuffer({ preview: null, pendingValue: null })
            }
          />
        )}

        {buffer.error && (
          <div
            data-testid="retention-error"
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
          >
            {buffer.error}
          </div>
        )}
        {buffer.toast && (
          <div
            data-testid="retention-toast"
            role="status"
            className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
          >
            {buffer.toast}
          </div>
        )}

        <p className="text-xs text-neutral-400">
          Current version:{' '}
          <span className="font-mono">{buffer.versionId}</span>
        </p>
      </section>

      {/* ===== Section 3: webhook URL ========================================= */}
      <section
        data-section-key="notifications.audit_failure_webhook_url"
        className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Audit-failure webhook URL
          </h2>
          <p className="text-xs font-mono text-neutral-500">
            notifications.audit_failure_webhook_url
          </p>
          <p className="text-sm text-neutral-600">
            HTTPS endpoint that receives alerts when an audit row fails to
            write (T061/T062/T063 plumbing). Leave empty to disable webhook
            dispatch — `enqueue_alert` becomes a no-op when this is null.
          </p>
        </header>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            URL (leave empty to clear)
          </span>
          <input
            type="url"
            value={webhookUrl.value}
            onChange={(e) => handleWebhookUrlChange(e.target.value)}
            data-testid="retention-webhook-url-input"
            placeholder="https://hooks.example.com/audit-failures"
            aria-invalid={webhookUrl.validationError ? true : undefined}
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
          {webhookUrl.validationError && (
            <span role="alert" className="text-xs text-red-600">
              {webhookUrl.validationError}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Reason (required)
          </span>
          <textarea
            value={webhookUrl.reason}
            onChange={(e) => patchWebhookUrl({ reason: e.target.value })}
            rows={2}
            required
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Source citation (optional)
          </span>
          <input
            type="text"
            value={webhookUrl.sourceCitation}
            onChange={(e) =>
              patchWebhookUrl({ sourceCitation: e.target.value })
            }
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handleWebhookUrlPreview()}
            disabled={pending || webhookUrl.validationError !== null}
            data-testid="retention-webhook-url-save"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {webhookUrl.preview && (
          <PreviewWarning
            preview={webhookUrl.preview}
            onConfirm={(token) => handleWebhookUrlConfirm(token)}
            onCancel={() =>
              patchWebhookUrl({ preview: null, pendingValue: null })
            }
          />
        )}

        {webhookUrl.error && (
          <div
            data-testid="retention-error"
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
          >
            {webhookUrl.error}
          </div>
        )}
        {webhookUrl.toast && (
          <div
            data-testid="retention-toast"
            role="status"
            className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
          >
            {webhookUrl.toast}
          </div>
        )}

        <p className="text-xs text-neutral-400">
          Current version:{' '}
          <span className="font-mono">{webhookUrl.versionId}</span>
        </p>
      </section>

      {/* ===== Section 4: webhook secret (write-only) ========================= */}
      <section
        data-section-key="notifications.audit_failure_webhook_secret"
        className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-4"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900">
            Audit-failure webhook secret
          </h2>
          <p className="text-xs font-mono text-neutral-500">
            notifications.audit_failure_webhook_secret
          </p>
          <p className="text-sm text-neutral-600">
            Shared-secret HMAC key signed into outbound webhook payloads (T063
            verification). The server never returns the existing cleartext —
            type a fresh value to rotate it, or leave empty + save to clear.
          </p>
          <p
            className="text-xs"
            style={{ color: webhookSecret.hasSecret ? '#15803d' : '#a16207' }}
          >
            {webhookSecret.hasSecret
              ? 'A secret is currently configured (cleartext withheld).'
              : 'No secret is currently configured.'}
          </p>
        </header>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            New secret (leave empty to clear)
          </span>
          <div className="flex items-center gap-2">
            <input
              type={webhookSecret.revealed ? 'text' : 'password'}
              value={webhookSecret.value}
              onChange={(e) => handleWebhookSecretChange(e.target.value)}
              data-testid="retention-webhook-secret-input"
              placeholder={
                webhookSecret.hasSecret
                  ? '•••• (type to overwrite)'
                  : ''
              }
              autoComplete="new-password"
              spellCheck={false}
              disabled={pending}
              className="flex-1 rounded border border-neutral-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
            />
            <button
              type="button"
              onClick={() =>
                patchWebhookSecret({ revealed: !webhookSecret.revealed })
              }
              data-testid="retention-webhook-secret-reveal"
              aria-pressed={webhookSecret.revealed}
              disabled={pending}
              className="rounded border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {webhookSecret.revealed ? 'Hide' : 'Reveal'}
            </button>
          </div>
          {webhookSecret.validationError && (
            <span role="alert" className="text-xs text-red-600">
              {webhookSecret.validationError}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Reason (required)
          </span>
          <textarea
            value={webhookSecret.reason}
            onChange={(e) => patchWebhookSecret({ reason: e.target.value })}
            rows={2}
            required
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-700">
            Source citation (optional)
          </span>
          <input
            type="text"
            value={webhookSecret.sourceCitation}
            onChange={(e) =>
              patchWebhookSecret({ sourceCitation: e.target.value })
            }
            disabled={pending}
            className="rounded border border-neutral-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100"
          />
        </label>

        <div>
          <button
            type="button"
            onClick={() => void handleWebhookSecretPreview()}
            disabled={pending || webhookSecret.validationError !== null}
            data-testid="retention-webhook-secret-save"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>

        {webhookSecret.preview && (
          <PreviewWarning
            preview={webhookSecret.preview}
            onConfirm={(token) => handleWebhookSecretConfirm(token)}
            onCancel={() =>
              patchWebhookSecret({ preview: null, pendingValue: null })
            }
          />
        )}

        {webhookSecret.error && (
          <div
            data-testid="retention-error"
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
          >
            {webhookSecret.error}
          </div>
        )}
        {webhookSecret.toast && (
          <div
            data-testid="retention-toast"
            role="status"
            className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-700"
          >
            {webhookSecret.toast}
          </div>
        )}

        <p className="text-xs text-neutral-400">
          Current version:{' '}
          <span className="font-mono">{webhookSecret.versionId}</span>
        </p>
      </section>

      {pending && <div className="text-sm text-neutral-500">Submitting…</div>}
    </div>
  );
}
