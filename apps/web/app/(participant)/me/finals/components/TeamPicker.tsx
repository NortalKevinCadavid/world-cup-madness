'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from 'cmdk';

import type { Team } from '../../../../../lib/roster/types';

/**
 * Keyboard-accessible typeahead for team picks (champion / runner_up) —
 * Slice 004 (T019), per research.md § R-012.
 *
 * Built on `cmdk`. The full team set arrives upfront (~32 rows) so all
 * filtering is client-side via `cmdk`'s built-in `command-score` matcher.
 * We extend each `CommandItem`'s `keywords` array with `short_code` so a
 * search for `"ARG"` matches Argentina even though the display label
 * shows "Argentina" first.
 *
 * Visual layout:
 *   ┌──────────────────────────────────────────────┐
 *   │ [button: short_code + name (or "Select a    ▼│   <- toggle
 *   └──────────────────────────────────────────────┘
 *      ┌──────────────────────────────────────────┐
 *      │ [input — filter teams]                   │
 *      ├──────────────────────────────────────────┤
 *      │ ARG  Argentina                           │
 *      │ BRA  Brazil                              │
 *      │ ...                                      │
 *      └──────────────────────────────────────────┘
 *
 * Closes when:
 *   - An item is selected (via mouse OR Enter).
 *   - Escape is pressed inside the input.
 *   - A click lands outside the popover (we listen on `document`).
 *
 * Does NOT manage its own validation — the parent <FinalsForm> drives the
 * submit and surfaces server errors.
 *
 * Accessibility: the toggle button carries `aria-haspopup="listbox"` and
 * `aria-expanded`; the popover root is the cmdk `Command` which manages
 * roving tabindex + `aria-activedescendant` internally.
 *
 * @see specs/004-final-predictions/research.md § R-012
 */
export interface TeamPickerProps {
  /** Full tournament team set (~32 rows). Filtered client-side. */
  teams: Team[];
  /** Currently selected team id, or null if none. */
  value: string | null;
  /** Selection callback. `null` signals "clear". */
  onChange: (teamId: string | null) => void;
  /** Disable interaction (e.g. when picks are locked or a submit is in flight). */
  disabled?: boolean;
  /** `data-testid` prefix the parent uses to scope assertions per slot. */
  testIdPrefix: string;
}

export function TeamPicker({
  teams,
  value,
  onChange,
  disabled = false,
  testIdPrefix,
}: TeamPickerProps) {
  const t = useTranslations('Finals');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Quick lookup so the button label can render the selected team without
  // scanning the array on every keystroke.
  const teamsById = useMemo(() => {
    const map = new Map<string, Team>();
    for (const t of teams) map.set(t.id, t);
    return map;
  }, [teams]);

  const selected = value !== null ? (teamsById.get(value) ?? null) : null;

  // Click-outside-to-close. cmdk doesn't ship a popover primitive, so we
  // listen on the document and dismiss when the click target is outside
  // our wrapper.
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

  function handleSelect(teamId: string) {
    onChange(teamId);
    setOpen(false);
  }

  const buttonLabel = selected
    ? `${selected.short_code} — ${selected.name}`
    : t('selectTeam');

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
        <span className={selected ? '' : 'text-muted-foreground/60'}>
          {buttonLabel}
        </span>
        <span aria-hidden className="ml-2 text-muted-foreground">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <Command
            label={t('filterTeams')}
            className="flex flex-col"
            // cmdk's default `command-score` filter handles the team-name
            // + short-code keyword match we set on each item below, so
            // we let it run rather than swapping a custom `filter` in.
          >
            <CommandInput
              placeholder={t('searchTeamPlaceholder')}
              autoFocus
              data-testid={`${testIdPrefix}-input`}
              className="w-full rounded-t-md border-b border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500"
            />
            <CommandList className="max-h-60 overflow-y-auto">
              <CommandEmpty className="px-3 py-2 text-sm text-muted-foreground">
                {t('noTeams')}
              </CommandEmpty>
              {teams.map((team) => (
                <CommandItem
                  key={team.id}
                  // `value` MUST be unique within the cmdk root — the team
                  // UUID guarantees that. The `keywords` extension lets
                  // users find a team by its short_code (e.g. "ARG").
                  value={team.id}
                  keywords={[team.name, team.short_code]}
                  onSelect={() => handleSelect(team.id)}
                  data-testid={`${testIdPrefix}-option-${team.id}`}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm aria-selected:bg-accent/10 aria-selected:text-primary cursor-pointer"
                >
                  <span className="inline-block w-10 font-mono text-xs text-muted-foreground">
                    {team.short_code}
                  </span>
                  <span className="text-foreground">{team.name}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      ) : null}
    </div>
  );
}
