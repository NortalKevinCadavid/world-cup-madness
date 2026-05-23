import type { AuditRow } from '../../../../lib/audit-search';

export interface AuditResultsTableProps {
  rows: AuditRow[];
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

function formatOccurredAt(iso: string): string {
  const date = new Date(iso);
  return DATE_FORMATTER.format(date);
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return JSON.stringify(value, null, 2);
}

export function AuditResultsTable({ rows }: AuditResultsTableProps) {
  if (rows.length === 0) {
    return (
      <div data-testid="audit-results-empty" className="rounded border p-6 text-sm text-muted-foreground">
        No audit events match the filters.
      </div>
    );
  }

  return (
    <table data-testid="audit-results-table" className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b bg-muted/30">
          <th className="p-2 text-left">Seq</th>
          <th className="p-2 text-left">Occurred</th>
          <th className="p-2 text-left">Actor</th>
          <th className="p-2 text-left">Action</th>
          <th className="p-2 text-left">Entity type</th>
          <th className="p-2 text-left">Entity ID</th>
          <th className="p-2 text-left">Source</th>
          <th className="p-2 text-left">Reason</th>
          <th className="p-2 text-left">Citation</th>
          <th className="p-2 text-left">Prev</th>
          <th className="p-2 text-left">New</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id} data-testid="audit-results-row" className="border-b align-top">
            <td className="p-2 font-mono">{row.sequence_id}</td>
            <td className="p-2">{formatOccurredAt(row.occurred_at)}</td>
            <td className="p-2 font-mono">{row.actor ?? '—'}</td>
            <td className="p-2">{row.action}</td>
            <td className="p-2">{row.entity_type ?? '—'}</td>
            <td className="p-2 font-mono">{row.entity_id ?? '—'}</td>
            <td className="p-2">{row.source}</td>
            <td className="p-2">{row.reason ?? '—'}</td>
            <td className="p-2 max-w-xs truncate" title={row.source_citation ?? ''}>{row.source_citation ?? '—'}</td>
            <td className="p-2">
              <details>
                <summary className="cursor-pointer text-muted-foreground">view</summary>
                <pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 text-xs">{formatJson(row.previous_value)}</pre>
              </details>
            </td>
            <td className="p-2">
              <details>
                <summary className="cursor-pointer text-muted-foreground">view</summary>
                <pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 text-xs">{formatJson(row.new_value)}</pre>
              </details>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
