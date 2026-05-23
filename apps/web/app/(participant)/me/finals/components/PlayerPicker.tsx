'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
} from 'cmdk';

import type { Player, PlayersResponse } from '../../../../../lib/roster/types';

/**
 * Keyboard-accessible typeahead for player picks (top_scorer / best_player)
 * — Slice 004 (T019), per research.md § R-012.
 *
 * Unlike `TeamPicker` (which receives the full ~32-row team set upfront),
 * the player roster is large (hundreds of rows across 32 squads) so this
 * component does NOT eagerly fetch the full list. Instead:
 *
 *   1. User opens the popover. We optionally pre-load a first page of
 *      results when `teamFilter` is set so the user sees the squad
 *      immediately on open.
 *   2. As the user types, we debounce `q` for 250 ms then issue a fresh
 *      `GET /api/players?q=…&limit=20[&team_id=…]`.
 *   3. The previous in-flight request is aborted via `AbortController`,
 *      so stale results never override fresher ones.
 *
 * Filtering happens on the server (the `q` argument), so we tell cmdk to
 * skip its built-in filter via `shouldFilter={false}` and just render the
 * server-returned slice in order.
 *
 * Display-only — the parent <FinalsForm> drives submit and renders errors.
 *
 * @see specs/004-final-predictions/contracts/final-predictions.read.md
 *      § Endpoint GET /api/players
 * @see specs/004-final-predictions/research.md § R-012
 */
export interface PlayerPickerProps {
  /**
   * Current selection (or null). We accept a stripped `{id, full_name}`
   * shape because the parent server component only pre-loads those two
   * fields for the initial render; once the user opens the picker and
   * selects, the full `Player` row is passed to `onChange`.
   */
  value: { id: string; full_name: string } | null;
  /** Selection callback. `null` signals "clear". */
  onChange: (player: Player | null) => void;
  /** Disable interaction (e.g. when picks are locked or a submit is in flight). */
  disabled?: boolean;
  /** Optional restriction to a single team's roster. */
  teamFilter?: string | null;
  /** `data-testid` prefix the parent uses to scope assertions per slot. */
  testIdPrefix: string;
}

/** Debounce delay for `q` → fetch. Mirrors a typical typeahead snappy feel. */
const SEARCH_DEBOUNCE_MS = 250;

/** Result-set cap; the server also clamps but we send our preferred page. */
const RESULT_LIMIT = 20;

export function PlayerPicker({
  value,
  onChange,
  disabled = false,
  teamFilter = null,
  testIdPrefix,
}: PlayerPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Player[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Click-outside-to-close. Mirrors TeamPicker.
  useEffect(() => {
    if (!open) return;
    function handleDocumentMouseDown(event: MouseEvent) {
      const root = containerRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, [open]);

  // Debounced fetch: schedule one search 250 ms after the latest keystroke,
  // canceling any in-flight request from a prior keystroke.
  useEffect(() => {
    if (!open) return;
    const timeoutId = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      const params = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) params.set('q', trimmed);
      if (teamFilter) params.set('team_id', teamFilter);
      params.set('limit', String(RESULT_LIMIT));

      setLoading(true);
      setError(null);
      fetch(`/api/players?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const body = (await response
              .json()
              .catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(
              body?.error?.message ?? `Search failed (${response.status})`,
            );
          }
          return (await response.json()) as PlayersResponse;
        })
        .then((body) => {
          setResults(body.players ?? []);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') {
            // Superseded by a fresher query; the next .then() will
            // settle the loading state for that one. Stay quiet here.
            return;
          }
          setLoading(false);
          setError(err instanceof Error ? err.message : 'Search failed');
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open, query, teamFilter]);

  // When the popover closes, abort any in-flight request so it doesn't
  // resolve into stale state on a future open.
  useEffect(() => {
    if (open) return;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open]);

  function handleSelect(player: Player) {
    onChange(player);
    setOpen(false);
  }

  const buttonLabel = value ? value.full_name : 'Select a player';

  return (
    <div
      ref={containerRef}
      className="relative inline-block w-full max-w-sm"
      data-testid={testIdPrefix}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${testIdPrefix}-toggle`}
        className="flex w-full items-center justify-between rounded border border-border bg-card px-3 py-1.5 text-left text-sm text-foreground hover:border-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={value ? '' : 'text-muted-foreground/60'}>{buttonLabel}</span>
        <span aria-hidden className="ml-2 text-muted-foreground">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <Command
            label="Search players"
            shouldFilter={false}
            className="flex flex-col"
          >
            <CommandInput
              placeholder="Search by name…"
              autoFocus
              value={query}
              onValueChange={setQuery}
              data-testid={`${testIdPrefix}-input`}
              className="w-full rounded-t-md border-b border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
            />
            <CommandList className="max-h-60 overflow-y-auto">
              {loading ? (
                <CommandLoading className="px-3 py-2 text-sm text-muted-foreground">
                  Searching…
                </CommandLoading>
              ) : null}
              {error ? (
                <div
                  className="px-3 py-2 text-sm text-destructive"
                  role="alert"
                  data-testid={`${testIdPrefix}-search-error`}
                >
                  {error}
                </div>
              ) : null}
              {!loading && !error && results.length === 0 ? (
                <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
                  {query.trim().length === 0
                    ? 'Type to search…'
                    : 'No players match.'}
                </CommandEmpty>
              ) : null}
              {results.map((player) => (
                <CommandItem
                  key={player.id}
                  value={player.id}
                  keywords={[
                    player.full_name,
                    player.display_name ?? '',
                    player.team_short_code ?? '',
                  ]}
                  onSelect={() => handleSelect(player)}
                  data-testid={`player-result-${player.id}`}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm aria-selected:bg-accent/10 aria-selected:text-primary cursor-pointer"
                >
                  <span className="text-foreground">{player.full_name}</span>
                  {player.team_short_code ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      ({player.team_short_code})
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
