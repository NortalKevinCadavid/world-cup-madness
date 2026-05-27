'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type {
  FinalPrediction,
  ItemKind,
} from '../../../../../lib/final-predictions/types';
import type { Player, Team } from '../../../../../lib/roster/types';

import { PlayerPicker } from './PlayerPicker';
import { TeamPicker } from './TeamPicker';

/**
 * Four-slot final-predictions submission form — Slice 004 (T019).
 *
 * Renders one row per `item_kind`:
 *   - champion    → TeamPicker
 *   - runner_up   → TeamPicker
 *   - top_scorer  → PlayerPicker
 *   - best_player → PlayerPicker
 *
 * Each row has its own staged selection, error display, and submit button.
 * Per FR-002 the four items are independently editable; we therefore POST
 * one slot at a time and rely on `router.refresh()` to refetch the server
 * component's data so the page reflects the new active pick.
 *
 * The component DOES NOT re-implement lock semantics in JS (Constitution
 * Principle III). When `lockState === 'locked'` we disable the submits and
 * the pickers — the server is still the authoritative gate and will reject
 * a stale POST with 409 FINAL_PREDICTIONS_LOCKED.
 *
 * Pending state: `useTransition` lets us show "Submitting…" + disable the
 * button without blocking the React render thread.
 *
 * `data-testid` strings follow the snake_case slot convention documented in
 * the T019 task prompt, e.g. `submit-champion`, `error-runner_up`,
 * `team-picker-champion`, `player-picker-top_scorer`.
 *
 * @see specs/004-final-predictions/contracts/final-predictions.write.md
 * @see specs/004-final-predictions/spec.md § US1 Acceptance Scenarios 1, 2
 */
export interface FinalsFormProps {
  /** Active rows pre-loaded by the server component. May be empty. */
  initialPredictions: FinalPrediction[];
  /** Full team set (~32 rows) for the team pickers. */
  teams: Team[];
  /**
   * Map of `target_player_id` → `{id, full_name}` for any player slots
   * the participant has already filled. Lets us display the current pick
   * without a roundtrip when the picker is closed.
   */
  initialPlayerLabels: Record<string, { id: string; full_name: string }>;
  /** Server-authoritative lock state — display only, server re-checks. */
  lockState: 'editable' | 'locked';
}

interface RowState {
  /** Currently-staged team id (team slots) — what will be POSTed. */
  teamId: string | null;
  /** Currently-staged player ref (player slots) — what will be POSTed. */
  player: { id: string; full_name: string } | null;
  /** Last server error message for this row, or null. */
  error: string | null;
}

interface SlotDefinition {
  kind: ItemKind;
  /** i18n key under the `Finals` namespace for the slot label. */
  labelKey: string;
  /** i18n key under the `Finals` namespace for the slot description. */
  descKey: string;
  kindType: 'team' | 'player';
}

/**
 * Static ordering of the four picks. Display order mirrors the contract
 * (champion → runner_up → top_scorer → best_player). Labels/descriptions are
 * resolved at render via next-intl (Finals namespace).
 */
const SLOTS: readonly SlotDefinition[] = [
  { kind: 'champion', labelKey: 'championLabel', descKey: 'championDesc', kindType: 'team' },
  { kind: 'runner_up', labelKey: 'runnerUpLabel', descKey: 'runnerUpDesc', kindType: 'team' },
  { kind: 'top_scorer', labelKey: 'topScorerLabel', descKey: 'topScorerDesc', kindType: 'player' },
  { kind: 'best_player', labelKey: 'bestPlayerLabel', descKey: 'bestPlayerDesc', kindType: 'player' },
];

/** Build initial RowState for each slot from the server props. */
function buildInitialRows(
  initialPredictions: FinalPrediction[],
  playerLabels: Record<string, { id: string; full_name: string }>,
): Record<ItemKind, RowState> {
  const byKind = new Map<ItemKind, FinalPrediction>();
  for (const p of initialPredictions) {
    byKind.set(p.item_kind, p);
  }

  function rowFor(kind: ItemKind, kindType: 'team' | 'player'): RowState {
    const pick = byKind.get(kind);
    if (!pick) {
      return { teamId: null, player: null, error: null };
    }
    if (kindType === 'team') {
      return { teamId: pick.target_team_id, player: null, error: null };
    }
    const playerRef =
      pick.target_player_id !== null
        ? (playerLabels[pick.target_player_id] ?? {
            id: pick.target_player_id,
            // Fallback label when the server didn't pre-resolve the row
            // (e.g. the player has been removed from the roster); the
            // banner will surface that separately in T025.
            full_name: 'Selected player',
          })
        : null;
    return { teamId: null, player: playerRef, error: null };
  }

  return {
    champion: rowFor('champion', 'team'),
    runner_up: rowFor('runner_up', 'team'),
    top_scorer: rowFor('top_scorer', 'player'),
    best_player: rowFor('best_player', 'player'),
  };
}

export function FinalsForm({
  initialPredictions,
  teams,
  initialPlayerLabels,
  lockState,
}: FinalsFormProps) {
  const router = useRouter();
  const t = useTranslations('Finals');
  const [rows, setRows] = useState<Record<ItemKind, RowState>>(() =>
    buildInitialRows(initialPredictions, initialPlayerLabels),
  );
  // One transition slot per kind so a long-running submit on one row
  // doesn't gray out the other three's pending indicators. React's
  // `useTransition` doesn't accept a key, so we track per-row "pending"
  // alongside a single transition wrapper.
  const [isPending, startTransition] = useTransition();
  const [pendingKind, setPendingKind] = useState<ItemKind | null>(null);

  function updateRow(kind: ItemKind, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
  }

  function buildSubmitBody(
    kind: ItemKind,
    row: RowState,
  ): Record<string, string> | null {
    if (kind === 'champion' || kind === 'runner_up') {
      if (!row.teamId) return null;
      return { item_kind: kind, target_team_id: row.teamId };
    }
    if (!row.player) return null;
    return { item_kind: kind, target_player_id: row.player.id };
  }

  async function submitSlot(kind: ItemKind) {
    const row = rows[kind];
    const body = buildSubmitBody(kind, row);
    if (!body) {
      updateRow(kind, { error: t('selectFirst') });
      return;
    }
    updateRow(kind, { error: null });
    setPendingKind(kind);
    startTransition(async () => {
      try {
        const response = await fetch('/api/final-predictions', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errBody = (await response.json().catch(() => null)) as
            | { error?: { message?: string; reason?: string } }
            | null;
          const message =
            errBody?.error?.message ??
            errBody?.error?.reason ??
            t('submitFailed', { status: response.status });
          updateRow(kind, { error: message });
          setPendingKind(null);
          return;
        }
        // Success: clear the error and pull fresh server state. The page
        // re-renders with the new active prediction, which feeds back into
        // `initialPredictions` and our row state next mount.
        updateRow(kind, { error: null });
        setPendingKind(null);
        router.refresh();
      } catch (err) {
        updateRow(kind, {
          error: err instanceof Error ? err.message : t('networkError'),
        });
        setPendingKind(null);
      }
    });
  }

  const formDisabled = lockState === 'locked';

  return (
    <form
      data-testid="finals-form"
      data-lock-state={lockState}
      onSubmit={(event) => event.preventDefault()}
      className="flex flex-col gap-6"
    >
      {SLOTS.map((slot) => {
        const row = rows[slot.kind];
        const rowPending = isPending && pendingKind === slot.kind;
        const hasSelection =
          slot.kindType === 'team' ? row.teamId !== null : row.player !== null;
        const submitDisabled = formDisabled || rowPending || !hasSelection;

        return (
          <section
            key={slot.kind}
            data-testid={`slot-${slot.kind}`}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
          >
            <header className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold text-foreground">
                {t(slot.labelKey)}
              </h2>
              <p className="text-xs text-muted-foreground">{t(slot.descKey)}</p>
            </header>

            <div className="flex flex-wrap items-center gap-3">
              {slot.kindType === 'team' ? (
                <TeamPicker
                  teams={teams}
                  value={row.teamId}
                  onChange={(teamId) =>
                    updateRow(slot.kind, { teamId, error: null })
                  }
                  disabled={formDisabled || rowPending}
                  testIdPrefix={`team-picker-${slot.kind}`}
                />
              ) : (
                <PlayerPicker
                  value={row.player}
                  onChange={(player: Player | null) =>
                    updateRow(slot.kind, {
                      player:
                        player !== null
                          ? { id: player.id, full_name: player.full_name }
                          : null,
                      error: null,
                    })
                  }
                  disabled={formDisabled || rowPending}
                  testIdPrefix={`player-picker-${slot.kind}`}
                />
              )}

              <button
                type="button"
                onClick={() => submitSlot(slot.kind)}
                disabled={submitDisabled}
                data-testid={`submit-${slot.kind}`}
                className="rounded border border-blue-700 bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rowPending ? t('submitting') : t('submit')}
              </button>
            </div>

            {row.error ? (
              <div
                data-testid={`error-${slot.kind}`}
                role="alert"
                aria-live="polite"
                className="text-sm text-destructive"
              >
                {row.error}
              </div>
            ) : null}
          </section>
        );
      })}
    </form>
  );
}
