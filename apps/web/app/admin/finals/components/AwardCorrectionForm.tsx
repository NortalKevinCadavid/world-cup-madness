'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * `AwardCorrectionForm` — client-side correction form for `/admin/finals`
 * (Slice 006, Phase 5, US3, T031).
 *
 * Source of truth:
 *   - specs/006-admin-overrides/contracts/admin-ui.surface.md §
 *     `/admin/finals` — per-item form.
 *   - apps/web/app/api/admin/tournament-award/route.ts (T031) — POST body
 *     shape:
 *       { item_kind, target_id?, status, reason, source_citation }.
 *
 * DOM contract (locked by T028 Playwright specs —
 * slice-006-admin-finals-correct-top-scorer.spec.ts and
 * slice-006-admin-finals-confirm-pending.spec.ts):
 *   - Form root:   `form[data-testid="admin-award-form"]`
 *   - Item kind:   `select[name="item_kind"]`
 *                  options: champion | runner_up | top_scorer | best_player.
 *   - Target id:   `input[name="target_id"]`
 *                  accepts a UUID. (The tests use `.fill(...)` which works
 *                  against an `<input>` directly.)
 *   - Status:      `select[name="status"]`
 *                  options: pending | confirmed.
 *   - Reason:      `textarea[name="reason"]`
 *   - Source:      `input[name="source_citation"]`
 *   - Submit:      `[data-testid="admin-award-submit"]`
 *
 * Layout posture: a SINGLE form whose `item_kind` is admin-selectable
 * (rather than four separate forms). The T028 specs explicitly support both
 * single-form and one-form-per-item layouts; single-form is leaner and
 * matches the "Per-item form" wording in admin-ui.surface.md because the
 * select directs the dispatch on submission.
 *
 * Behaviour:
 *   - On submit: POST to `/api/admin/tournament-award` with the locked body
 *     shape. The route handler does zod validation + admin gate + SP
 *     dispatch; on 4xx with `error.field` we surface a field-level inline
 *     error; on success we `router.refresh()` so the server page refetches
 *     the tournament_award row + audit history.
 *   - `useTransition` keeps the rest of the page interactive while the
 *     POST is in flight.
 *   - Reason / source_citation are NOT pre-filled — admins must re-justify
 *     each correction (FR-002 / contract Audit emission pattern).
 *
 * Constitution Principle III: NO scoring math here. The form is a thin
 * wrapper over the route handler / SP.
 */

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    reason?: string;
    field?: string;
  };
}

interface AwardCorrectionFormProps {
  initialItemKind?: ItemKind;
}

type ItemKind = 'champion' | 'runner_up' | 'top_scorer' | 'best_player';
type AwardStatus = 'pending' | 'confirmed';

const ITEM_KIND_OPTIONS: ReadonlyArray<{ value: ItemKind; label: string }> = [
  { value: 'champion', label: 'Champion (team)' },
  { value: 'runner_up', label: 'Runner-up (team)' },
  { value: 'top_scorer', label: 'Top scorer (player)' },
  { value: 'best_player', label: 'Best player (player)' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: AwardStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'confirmed', label: 'Confirmed' },
];

export function AwardCorrectionForm({
  initialItemKind = 'champion',
}: AwardCorrectionFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [itemKind, setItemKind] = useState<ItemKind>(initialItemKind);
  const [targetId, setTargetId] = useState<string>('');
  const [status, setStatus] = useState<AwardStatus>('confirmed');
  const [reason, setReason] = useState<string>('');
  const [sourceCitation, setSourceCitation] = useState<string>('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setErrorField(null);
    setSuccessMessage(null);

    startTransition(async () => {
      try {
        const response = await fetch('/api/admin/tournament-award', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            item_kind: itemKind,
            target_id: targetId.trim().length > 0 ? targetId.trim() : null,
            status,
            reason,
            source_citation: sourceCitation,
          }),
        });

        if (response.ok) {
          // Clear justification fields so every correction must be re-justified
          // per FR-002. Item kind + target id retain so a follow-up correction
          // is straightforward.
          setReason('');
          setSourceCitation('');
          setSuccessMessage('Award updated.');
          router.refresh();
          return;
        }

        const body = (await response.json().catch(() => null)) as
          | ErrorEnvelope
          | null;
        const message =
          body?.error?.message ??
          body?.error?.reason ??
          `Submit failed (${response.status})`;
        setErrorMessage(message);
        setErrorField(body?.error?.field ?? null);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Network error');
        setErrorField(null);
      }
    });
  }

  return (
    <form
      data-testid="admin-award-form"
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-card p-6 flex flex-col gap-4"
    >
      <h2 className="text-lg font-semibold text-foreground">
        Correct tournament award
      </h2>
      <p className="text-xs text-muted-foreground">
        Every correction is captured in the audit log. Slice 005&apos;s
        award-confirmed trigger fires a finals recalculation automatically
        when an award row is changed.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Award</span>
        <select
          name="item_kind"
          value={itemKind}
          onChange={(e) => setItemKind(e.target.value as ItemKind)}
          disabled={pending}
          aria-invalid={errorField === 'item_kind' || undefined}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        >
          {ITEM_KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Target id (team uuid for champion/runner_up, player uuid for
          top_scorer/best_player)
        </span>
        <input
          name="target_id"
          type="text"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'target_id' || undefined}
          className="rounded border border-border px-2 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="00000000-0000-0000-0000-000000000000"
        />
        {errorField === 'target_id' && errorMessage ? (
          <span
            id="field-error-target_id"
            data-testid="field-error-target_id"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">Status</span>
        <select
          name="status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AwardStatus)}
          disabled={pending}
          aria-invalid={errorField === 'status' || undefined}
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Reason <span className="text-destructive">*</span>
        </span>
        <textarea
          name="reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'reason' || undefined}
          aria-describedby={
            errorField === 'reason' ? 'field-error-reason' : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="e.g. FIFA awards committee re-evaluation"
        />
        {errorField === 'reason' && errorMessage ? (
          <span
            id="field-error-reason"
            data-testid="field-error-reason"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-foreground">
          Source citation (URL or document reference){' '}
          <span className="text-destructive">*</span>
        </span>
        <input
          name="source_citation"
          type="text"
          value={sourceCitation}
          onChange={(e) => setSourceCitation(e.target.value)}
          disabled={pending}
          aria-invalid={errorField === 'source_citation' || undefined}
          aria-describedby={
            errorField === 'source_citation'
              ? 'field-error-source_citation'
              : undefined
          }
          className="rounded border border-border px-2 py-1.5 focus:border-blue-500 focus:outline-none disabled:bg-muted"
          placeholder="https://fifa.example/awards/..."
        />
        {errorField === 'source_citation' && errorMessage ? (
          <span
            id="field-error-source_citation"
            data-testid="field-error-source_citation"
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive"
          >
            {errorMessage}
          </span>
        ) : null}
      </label>

      {errorMessage && !errorField ? (
        <div
          data-testid="admin-award-form-error"
          role="alert"
          aria-live="polite"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      ) : null}

      {successMessage ? (
        <div
          data-testid="admin-award-form-success"
          role="status"
          aria-live="polite"
          className="rounded border border-win/40 bg-win/10 px-3 py-2 text-sm text-win"
        >
          {successMessage}
        </div>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          data-testid="admin-award-submit"
          className="rounded border border-blue-700 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Submitting…' : 'Apply correction'}
        </button>
      </div>
    </form>
  );
}
