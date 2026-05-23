'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface AuditSearchFilters {
  actor: string;
  entity_type: string;
  entity_id: string;
  action_pattern: string;
  source: string;
  from: string;
  to: string;
}

export interface AuditFiltersFormProps {
  initial?: Partial<AuditSearchFilters>;
  /**
   * Optional callback invoked with the submitted filters. If omitted, the
   * form falls back to navigating `/admin/audit/search?<query>` via the
   * Next.js client router — this lets the form be embedded directly in a
   * Next.js server component (T020) without passing a server action.
   */
  onSearch?: (filters: AuditSearchFilters) => void;
  loading?: boolean;
}

function filtersToQueryString(filters: AuditSearchFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

const SOURCE_OPTIONS = ['', 'auth_hook', 'rls', 'api_guard', 'ui', 'trigger', 'admin_rpc', 'system'] as const;

export function AuditFiltersForm({ initial, onSearch, loading = false }: AuditFiltersFormProps) {
  const router = useRouter();
  const [actor, setActor] = useState(initial?.actor ?? '');
  const [entityType, setEntityType] = useState(initial?.entity_type ?? '');
  const [entityId, setEntityId] = useState(initial?.entity_id ?? '');
  const [actionPattern, setActionPattern] = useState(initial?.action_pattern ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [from, setFrom] = useState(initial?.from ?? '');
  const [to, setTo] = useState(initial?.to ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    // Client-side validation: from <= to
    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (fromDate > toDate) {
        setValidationError('"From" must be on or before "To"');
        return;
      }
    }

    const filters: AuditSearchFilters = {
      actor: actor.trim(),
      entity_type: entityType.trim(),
      entity_id: entityId.trim(),
      action_pattern: actionPattern.trim(),
      source: source.trim(),
      from: from.trim(),
      to: to.trim(),
    };

    startTransition(() => {
      if (onSearch) {
        onSearch(filters);
      } else {
        // Default behaviour: navigate the current page with a new query
        // string. Used when the form is embedded in a server component
        // (T020) that re-renders on each request.
        const qs = filtersToQueryString(filters);
        router.push(qs ? `/admin/audit/search?${qs}` : '/admin/audit/search');
      }
    });
  }

  const isLoading = loading || isPending;

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="audit-filters-form"
      className="space-y-3 rounded border p-4"
    >
      <h2 className="text-lg font-semibold">Filters</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm">Actor (UUID)</span>
          <input
            name="actor"
            type="text"
            value={actor}
            onChange={e => setActor(e.target.value)}
            placeholder="00000000-0000-0000-0000-..."
            className="mt-1 block w-full rounded border p-2 text-sm font-mono"
          />
        </label>
        <label className="block">
          <span className="text-sm">Entity type</span>
          <input
            name="entity_type"
            type="text"
            value={entityType}
            onChange={e => setEntityType(e.target.value)}
            placeholder="prediction, final_prediction, ..."
            className="mt-1 block w-full rounded border p-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm">Entity ID (UUID)</span>
          <input
            name="entity_id"
            type="text"
            value={entityId}
            onChange={e => setEntityId(e.target.value)}
            className="mt-1 block w-full rounded border p-2 text-sm font-mono"
          />
        </label>
        <label className="block">
          <span className="text-sm">Action pattern (SQL LIKE)</span>
          <input
            name="action_pattern"
            type="text"
            value={actionPattern}
            onChange={e => setActionPattern(e.target.value)}
            placeholder="admin.%"
            className="mt-1 block w-full rounded border p-2 text-sm font-mono"
          />
        </label>
        <label className="block">
          <span className="text-sm">Source</span>
          <select
            name="source"
            value={source}
            onChange={e => setSource(e.target.value)}
            className="mt-1 block w-full rounded border p-2 text-sm"
          >
            {SOURCE_OPTIONS.map(s => (
              <option key={s} value={s}>{s || '(any)'}</option>
            ))}
          </select>
        </label>
        <div />  {/* spacer for grid alignment */}
        <label className="block">
          <span className="text-sm">From</span>
          <input
            name="from"
            type="datetime-local"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="mt-1 block w-full rounded border p-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-sm">To</span>
          <input
            name="to"
            type="datetime-local"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="mt-1 block w-full rounded border p-2 text-sm"
          />
        </label>
      </div>

      {validationError && (
        <div data-testid="audit-filters-validation-error" role="alert" className="text-sm text-destructive">
          {validationError}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        data-testid="audit-filters-submit"
        className="rounded bg-primary px-4 py-2 text-white disabled:opacity-50"
      >
        {isLoading ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
