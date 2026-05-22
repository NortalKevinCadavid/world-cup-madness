'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type {
  MatchFilters,
  MatchStage,
  MatchStatus,
} from '../../../../lib/types/match';

/**
 * Match-list filter UI — Slice 002 (T021).
 *
 * Client component. Renders form controls for the documented filters
 * (stage / group / status / team / from / to) and writes them through to
 * the URL search params. Filtering and pagination themselves live on the
 * server (the route handler does the SQL); this component only updates
 * the URL state so the server component re-renders with the new query.
 *
 * Conventions:
 *  - Empty / blank selection clears the param.
 *  - Selecting (or clearing) any filter resets `page` to `1` so the user
 *    never lands on an empty page beyond the new result set.
 *  - Sort is intentionally NOT exposed here in slice 002 — the route
 *    handler defaults to `kickoff_asc`, which the spec assumes.
 */

const STAGE_OPTIONS: { value: MatchStage; label: string }[] = [
  { value: 'group', label: 'Group stage' },
  { value: 'r16', label: 'Round of 16' },
  { value: 'qf', label: 'Quarter-finals' },
  { value: 'sf', label: 'Semi-finals' },
  { value: 'final', label: 'Final' },
  { value: 'third_place', label: 'Third-place playoff' },
];

const STATUS_OPTIONS: { value: MatchStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'postponed', label: 'Postponed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const GROUP_OPTIONS: string[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

interface MatchListFiltersProps {
  /** Current filter state, as decoded from the URL by the server page. */
  currentFilters: MatchFilters;
}

function firstOrEmpty(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function MatchListFilters({ currentFilters }: MatchListFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const current = useMemo(
    () => ({
      stage: firstOrEmpty(currentFilters.stage),
      group: currentFilters.group ?? '',
      status: firstOrEmpty(currentFilters.status),
      team_id: currentFilters.team_id ?? '',
      from: currentFilters.from ?? '',
      to: currentFilters.to ?? '',
    }),
    [currentFilters],
  );

  const pushParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      if (value === '') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      // Any filter change resets pagination so the user is not stranded
      // on an out-of-range page after the result set shrinks.
      next.delete('page');
      const qs = next.toString();
      router.push(qs.length > 0 ? `?${qs}` : '?');
    },
    [router, searchParams],
  );

  return (
    <form
      role="search"
      aria-label="Match filters"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3"
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-stage" className="text-xs font-medium text-neutral-700">
          Stage
        </label>
        <select
          id="filter-stage"
          name="stage"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          value={current.stage}
          onChange={(e) => pushParam('stage', e.target.value)}
        >
          <option value="">All stages</option>
          {STAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-group" className="text-xs font-medium text-neutral-700">
          Group
        </label>
        <select
          id="filter-group"
          name="group"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          value={current.group}
          onChange={(e) => pushParam('group', e.target.value)}
        >
          <option value="">All groups</option>
          {GROUP_OPTIONS.map((g) => (
            <option key={g} value={g}>
              Group {g}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-status" className="text-xs font-medium text-neutral-700">
          Status
        </label>
        <select
          id="filter-status"
          name="status"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          value={current.status}
          onChange={(e) => pushParam('status', e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-team-id" className="text-xs font-medium text-neutral-700">
          Team ID
        </label>
        <input
          id="filter-team-id"
          name="team_id"
          type="text"
          inputMode="text"
          placeholder="UUID"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          defaultValue={current.team_id}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== current.team_id) pushParam('team_id', v);
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-from" className="text-xs font-medium text-neutral-700">
          From (UTC)
        </label>
        <input
          id="filter-from"
          name="from"
          type="datetime-local"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          defaultValue={toLocalInput(current.from)}
          onBlur={(e) => {
            const v = fromLocalInput(e.target.value);
            if (v !== current.from) pushParam('from', v);
          }}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="filter-to" className="text-xs font-medium text-neutral-700">
          To (UTC)
        </label>
        <input
          id="filter-to"
          name="to"
          type="datetime-local"
          className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500"
          defaultValue={toLocalInput(current.to)}
          onBlur={(e) => {
            const v = fromLocalInput(e.target.value);
            if (v !== current.to) pushParam('to', v);
          }}
        />
      </div>
    </form>
  );
}

/**
 * Convert an ISO-8601 UTC instant to the `YYYY-MM-DDTHH:mm` shape a
 * `<input type="datetime-local">` accepts. We keep the field semantically
 * UTC (the route handler treats `from`/`to` as UTC) — the browser will
 * display the value verbatim without timezone shifting.
 */
function toLocalInput(iso: string): string {
  if (!iso) return '';
  // Already in the right shape? Use as-is.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) {
    return iso.slice(0, 16);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Convert the datetime-local input value back to an ISO-8601 UTC string.
 * Empty input → empty string (clears the filter).
 */
function fromLocalInput(value: string): string {
  if (!value) return '';
  // datetime-local omits seconds; append :00Z so the route handler sees a
  // bona-fide UTC timestamp.
  return `${value}:00Z`;
}
