'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Pagination controls for the participant match list — Slice 002 (T021).
 *
 * Client component. Renders Prev / Next buttons and a "Page X of Y"
 * indicator. The component does NOT fetch or filter any data — it only
 * mutates the `page` URL search param so the server component re-renders
 * the next slice of results.
 *
 * The route handler clamps `page_size` server-side (1..200), so any
 * inconsistency in the URL is corrected by the server response that
 * follows. We deliberately do not echo the corrected value into the URL
 * here — the next user-driven nav will normalize it.
 */
interface PaginationControlsProps {
  /** Current 1-indexed page, as returned by the route handler. */
  page: number;
  /** Page size actually applied (after server clamp). */
  page_size: number;
  /** Total matching rows across all pages. */
  total: number;
}

export function PaginationControls({
  page,
  page_size,
  total,
}: PaginationControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Defensive: server should never return page_size <= 0, but guard
  // against a divide-by-zero just in case.
  const totalPages = page_size > 0 ? Math.max(1, Math.ceil(total / page_size)) : 1;
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const gotoPage = useCallback(
    (next: number) => {
      const sp = new URLSearchParams(searchParams?.toString() ?? '');
      if (next <= 1) {
        sp.delete('page');
      } else {
        sp.set('page', String(next));
      }
      const qs = sp.toString();
      router.push(qs.length > 0 ? `?${qs}` : '?');
    },
    [router, searchParams],
  );

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <button
        type="button"
        disabled={!canPrev}
        onClick={() => gotoPage(page - 1)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      <span
        aria-live="polite"
        className="text-neutral-600"
      >
        Page <span className="font-medium text-neutral-900">{page}</span> of{' '}
        <span className="font-medium text-neutral-900">{totalPages}</span>
        <span className="ml-2 text-neutral-400">({total} matches)</span>
      </span>
      <button
        type="button"
        disabled={!canNext}
        onClick={() => gotoPage(page + 1)}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
}
