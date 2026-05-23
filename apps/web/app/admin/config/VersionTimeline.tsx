// Server component — DO NOT add 'use client'.
// Renders a vertical timeline of tournament_config_versions rows.
// Rollback wiring: this is a server component so the button cannot bind
// to onRollback directly; the parent (T023 page) is expected to wrap the
// timeline in a client boundary or a server-action <form>. Each rollback
// button carries data-version-id so the wrapper can dispatch.

// NOTE: T017 (apps/web/lib/config-client.ts) does not yet exist, so
// ConfigVersion is defined locally here. Once T017 lands, replace this
// with `import type { ConfigVersion } from '../../../lib/config-client';`.
export interface ConfigVersion {
  version_id: number;
  key: string;
  previous_value: unknown;
  new_value: unknown;
  change_kind: 'initial_seed' | 'upsert' | 'rollback';
  actor: string | null;
  reason: string;
  source_citation: string | null;
  audit_log_id: string | null;
  parent_version_id: number | null;
  acknowledge_token_used: boolean;
  created_at: string;
}

export interface VersionTimelineProps {
  versions: ConfigVersion[];
  onRollback?: (versionId: number) => void;
}

const TZ = 'America/Mexico_City';
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  timeZone: TZ,
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return DATE_FORMATTER.format(date);
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function badgeClasses(kind: ConfigVersion['change_kind']): string {
  switch (kind) {
    case 'initial_seed':
      return 'bg-muted text-muted-foreground border-border';
    case 'upsert':
      return 'bg-accent/15 text-primary border-accent/40';
    case 'rollback':
      return 'bg-open/15 text-open border-open/40';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function badgeLabel(kind: ConfigVersion['change_kind']): string {
  switch (kind) {
    case 'initial_seed':
      return 'Initial seed';
    case 'upsert':
      return 'Upsert';
    case 'rollback':
      return 'Rollback';
    default:
      return kind;
  }
}

export default function VersionTimeline({
  versions,
  // onRollback is intentionally unused inside the server component itself.
  // It is part of the public prop contract so a client wrapper / server
  // action in the parent can read it; tests target the button by selector.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onRollback: _onRollback,
}: VersionTimelineProps) {
  if (versions.length === 0) {
    return (
      <div
        data-testid="version-timeline"
        className="rounded border border-border bg-card p-6 text-sm text-muted-foreground"
      >
        No version history yet.
      </div>
    );
  }

  return (
    <ol
      data-testid="version-timeline"
      className="relative ml-3 border-l border-border"
    >
      {versions.map((version) => {
        const isRollbackRow = version.change_kind === 'rollback';
        return (
          <li
            key={version.version_id}
            data-testid="version-row"
            data-version-id={version.version_id}
            data-change-kind={version.change_kind}
            className="mb-6 ml-4"
          >
            <span
              aria-hidden="true"
              className="absolute -left-1.5 mt-2 h-3 w-3 rounded-full border border-card bg-muted-foreground/60"
            />

            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                #{version.version_id}
              </span>
              <span
                data-testid="version-change-kind-badge"
                className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${badgeClasses(
                  version.change_kind
                )}`}
              >
                {badgeLabel(version.change_kind)}
              </span>
              <span className="text-xs text-muted-foreground">
                key: <span className="font-mono">{version.key}</span>
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {formatCreatedAt(version.created_at)}
              </span>
            </div>

            <div className="mt-2 text-sm text-muted-foreground">
              <div>
                <span className="font-medium">Actor:</span>{' '}
                <span className="font-mono text-xs">
                  {version.actor ?? 'system'}
                </span>
              </div>
              <div className="mt-1">
                <span className="font-medium">Reason:</span>{' '}
                <span>{version.reason || '—'}</span>
              </div>
              {version.source_citation ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  Citation: {version.source_citation}
                </div>
              ) : null}
              {version.parent_version_id !== null ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  Parent version: #{version.parent_version_id}
                </div>
              ) : null}
            </div>

            <details className="mt-2 rounded border border-border bg-muted/30 p-2 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Diff (previous → new)
              </summary>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Previous
                  </div>
                  <pre className="overflow-auto rounded bg-card p-2 text-xs text-foreground">
                    {formatJson(version.previous_value)}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    New
                  </div>
                  <pre className="overflow-auto rounded bg-card p-2 text-xs text-foreground">
                    {formatJson(version.new_value)}
                  </pre>
                </div>
              </div>
            </details>

            {!isRollbackRow ? (
              <div className="mt-3">
                <button
                  type="button"
                  data-testid="version-rollback-button"
                  data-version-id={version.version_id}
                  className="rounded border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/30"
                >
                  Rollback to this
                </button>
              </div>
            ) : (
              <div className="mt-3 text-xs italic text-muted-foreground">
                Cannot roll back a rollback row directly — select its
                predecessor.
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
