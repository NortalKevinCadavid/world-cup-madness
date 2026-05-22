'use client';

import { useId, useMemo, useState } from 'react';

import { validateConfigValue } from '@/lib/config-validators';

/**
 * `ConfigField` — generic value editor for a single `tournament_config` row
 * (Slice 008, Phase 2d, T020). Renders the input control appropriate for the
 * row's declared `value_type` and surfaces inline zod errors from T018's
 * `validateConfigValue(key, value)` dispatcher on every change.
 *
 * Source of truth:
 *   - specs/008-configuration/tasks.md T020 — input-by-value_type mapping.
 *   - apps/web/lib/config-validators.ts (T018) — per-key zod schemas.
 *   - specs/008-configuration/data-model.md § "Configuration namespace catalog"
 *     — frozen value_type enum (`text`, `integer`, `boolean`, `array`,
 *     `object`, `timestamptz`, `jsonb`, `numeric`, `uuid`, and the two
 *     compatibility variants `array_string`, `object_secret` which collapse
 *     into `array` / `object` for editing purposes).
 *
 * Behaviour:
 *   - Each input is fully controlled. `onChange` fires with the parsed value
 *     (e.g. number for `integer` / `numeric`, boolean for `boolean`, array
 *     for `array`, object for `object` / `jsonb`, ISO string for
 *     `timestamptz`). JSON inputs that fail to parse fire `onChange(value)`
 *     with the LAST successfully-parsed value but surface a parse error
 *     inline, so the upstream submit gate (PreviewWarning / page) won't see
 *     a half-typed JSON document.
 *   - After each successful local update we call
 *     `validateConfigValue(configKey, newValue)` and store the result; if
 *     `ok=false`, the error message is rendered in a `role="alert"` span
 *     directly beneath the control.
 *   - `readOnly=true` disables all inputs (used for secret keys whose
 *     ciphertext is revealed only via `admin_config_get_secret`, and for
 *     the version-history viewer).
 *   - Tailwind only; no third-party UI deps. Each control carries an
 *     accessible `<label>` association (htmlFor / id) and is keyboard
 *     reachable via standard tab order.
 *
 * Constitution Principle III: NO scoring math here. This file is a pure
 * presentational component; all validation is delegated to T018.
 */

export type ConfigFieldProps = {
  /** `tournament_config.value_type` (frozen catalog). */
  valueType: string;
  /** Current value (any shape — narrowed by `valueType`). */
  value: unknown;
  /** Fires with the parsed value on every successful local edit. */
  onChange: (newValue: unknown) => void;
  /** Disables every input when true. */
  readOnly?: boolean;
  /** `tournament_config.key` — used to dispatch per-key zod validation. */
  configKey: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SHARED_INPUT_CLASSES =
  'rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100';

const SHARED_TEXTAREA_CLASSES =
  'rounded border border-neutral-300 px-2 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-neutral-100';

/** RFC 4122 v1-5 UUID pattern (also accepts uppercase). Empty allowed. */
const UUID_PATTERN =
  '^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

function coerceString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => coerceString(entry));
  }
  return [];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return '';
  }
}

function isoToDatetimeLocal(iso: unknown): string {
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  // `datetime-local` wants `YYYY-MM-DDTHH:MM` in *local* wall-clock time.
  // We slice the local ISO to drop the seconds + timezone suffix.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfigField({
  valueType,
  value,
  onChange,
  readOnly = false,
  configKey,
}: ConfigFieldProps) {
  const fieldId = useId();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Local mirror state for the dynamic array editor + the JSON textareas. We
  // keep these as strings so the user can type partially-invalid JSON without
  // losing keystrokes.
  const initialArray = useMemo(() => coerceStringArray(value), [value]);
  const [arrayDraft, setArrayDraft] = useState<string[]>(initialArray);
  const [jsonDraft, setJsonDraft] = useState<string>(() =>
    valueType === 'object' || valueType === 'jsonb' ? safeStringify(value) : '',
  );

  function runValidation(next: unknown) {
    const result = validateConfigValue(configKey, next);
    if (result.ok) {
      setValidationError(null);
    } else {
      setValidationError(result.error);
    }
  }

  function emit(next: unknown) {
    setParseError(null);
    runValidation(next);
    onChange(next);
  }

  // -- Per-type renderers ----------------------------------------------------

  if (valueType === 'boolean') {
    const checked = value === true;
    return (
      <div className="flex flex-col gap-1">
        <label
          htmlFor={fieldId}
          className="inline-flex items-center gap-2 text-sm font-medium text-neutral-800"
        >
          <input
            id={fieldId}
            type="checkbox"
            checked={checked}
            disabled={readOnly}
            onChange={(e) => emit(e.target.checked)}
            aria-describedby={validationError ? `${fieldId}-error` : undefined}
            aria-invalid={validationError ? true : undefined}
            className="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
          />
          <span>{checked ? 'Enabled' : 'Disabled'}</span>
        </label>
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (valueType === 'integer') {
    const num = typeof value === 'number' ? value : Number(value ?? 0);
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="sr-only">
          {configKey}
        </label>
        <input
          id={fieldId}
          type="number"
          step={1}
          value={Number.isFinite(num) ? num : ''}
          disabled={readOnly}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              setParseError('Value required');
              return;
            }
            const parsed = Number.parseInt(raw, 10);
            if (Number.isNaN(parsed)) {
              setParseError('Must be an integer');
              return;
            }
            emit(parsed);
          }}
          aria-describedby={validationError ? `${fieldId}-error` : undefined}
          aria-invalid={validationError ? true : undefined}
          className={SHARED_INPUT_CLASSES}
        />
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (valueType === 'numeric') {
    const num = typeof value === 'number' ? value : Number(value ?? 0);
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="sr-only">
          {configKey}
        </label>
        <input
          id={fieldId}
          type="number"
          step="any"
          value={Number.isFinite(num) ? num : ''}
          disabled={readOnly}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              setParseError('Value required');
              return;
            }
            const parsed = Number.parseFloat(raw);
            if (Number.isNaN(parsed)) {
              setParseError('Must be a number');
              return;
            }
            emit(parsed);
          }}
          aria-describedby={validationError ? `${fieldId}-error` : undefined}
          aria-invalid={validationError ? true : undefined}
          className={SHARED_INPUT_CLASSES}
        />
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (valueType === 'timestamptz') {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="sr-only">
          {configKey}
        </label>
        <input
          id={fieldId}
          type="datetime-local"
          value={isoToDatetimeLocal(value)}
          disabled={readOnly}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              emit(null);
              return;
            }
            const parsed = new Date(raw);
            if (Number.isNaN(parsed.getTime())) {
              setParseError('Invalid date/time');
              return;
            }
            emit(parsed.toISOString());
          }}
          aria-describedby={validationError ? `${fieldId}-error` : undefined}
          aria-invalid={validationError ? true : undefined}
          className={SHARED_INPUT_CLASSES}
        />
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (valueType === 'uuid') {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="sr-only">
          {configKey}
        </label>
        <input
          id={fieldId}
          type="text"
          inputMode="text"
          pattern={UUID_PATTERN}
          value={coerceString(value)}
          disabled={readOnly}
          onChange={(e) => emit(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          aria-describedby={validationError ? `${fieldId}-error` : undefined}
          aria-invalid={validationError ? true : undefined}
          className={`${SHARED_INPUT_CLASSES} font-mono`}
        />
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (valueType === 'array' || valueType === 'array_string') {
    return (
      <div className="flex flex-col gap-2">
        <ul
          aria-label={`Entries for ${configKey}`}
          className="flex flex-col gap-2"
        >
          {arrayDraft.map((entry, idx) => {
            const entryId = `${fieldId}-entry-${idx}`;
            return (
              <li key={idx} className="flex items-center gap-2">
                <label htmlFor={entryId} className="sr-only">
                  Entry {idx + 1}
                </label>
                <input
                  id={entryId}
                  type="text"
                  value={entry}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = arrayDraft.slice();
                    next[idx] = e.target.value;
                    setArrayDraft(next);
                    emit(next);
                  }}
                  className={`${SHARED_INPUT_CLASSES} flex-1`}
                />
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => {
                    const next = arrayDraft.filter((_, i) => i !== idx);
                    setArrayDraft(next);
                    emit(next);
                  }}
                  aria-label={`Remove entry ${idx + 1}`}
                  className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        <div>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => {
              const next = [...arrayDraft, ''];
              setArrayDraft(next);
              emit(next);
            }}
            className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add entry
          </button>
        </div>
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  if (
    valueType === 'object' ||
    valueType === 'jsonb' ||
    valueType === 'object_secret'
  ) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="sr-only">
          {configKey}
        </label>
        <textarea
          id={fieldId}
          rows={8}
          value={jsonDraft}
          disabled={readOnly}
          spellCheck={false}
          onChange={(e) => {
            const raw = e.target.value;
            setJsonDraft(raw);
            if (raw.trim() === '') {
              setParseError(null);
              emit(null);
              return;
            }
            try {
              const parsed = JSON.parse(raw) as unknown;
              setParseError(null);
              runValidation(parsed);
              onChange(parsed);
            } catch (err) {
              setParseError(
                err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON',
              );
            }
          }}
          aria-describedby={
            validationError || parseError ? `${fieldId}-error` : undefined
          }
          aria-invalid={validationError || parseError ? true : undefined}
          className={SHARED_TEXTAREA_CLASSES}
          placeholder="{}"
        />
        {renderError(fieldId, validationError, parseError)}
      </div>
    );
  }

  // Default: text input (also handles `text` and any forward-compat
  // value_type the catalog might grow).
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="sr-only">
        {configKey}
      </label>
      <input
        id={fieldId}
        type="text"
        value={coerceString(value)}
        disabled={readOnly}
        onChange={(e) => emit(e.target.value)}
        aria-describedby={validationError ? `${fieldId}-error` : undefined}
        aria-invalid={validationError ? true : undefined}
        className={SHARED_INPUT_CLASSES}
      />
      {renderError(fieldId, validationError, parseError)}
    </div>
  );
}

function renderError(
  fieldId: string,
  validationError: string | null,
  parseError: string | null,
) {
  const message = parseError ?? validationError;
  if (!message) return null;
  return (
    <span
      id={`${fieldId}-error`}
      role="alert"
      aria-live="polite"
      className="text-xs text-red-600"
    >
      {message}
    </span>
  );
}
