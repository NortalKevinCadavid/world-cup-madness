/**
 * RFC 4180 compliant CSV encoder for audit-log export.
 * Reference: specs/007-audit-trail/contracts/audit-export.stream.md § CSV column order (LOCKED).
 */

export const AUDIT_CSV_COLUMNS = [
  'sequence_id',
  'occurred_at',
  'actor',
  'action',
  'entity_type',
  'entity_id',
  'source',
  'reason',
  'source_citation',
  'previous_value',
  'new_value',
  'id',
] as const;

export type AuditCsvColumn = typeof AUDIT_CSV_COLUMNS[number];

/**
 * Encode a single cell value per RFC 4180.
 * - null/undefined → empty string
 * - objects/arrays → JSON.stringify
 * - strings/numbers → toString
 * - Quote-wraps if value contains comma, double-quote, newline, or carriage-return.
 * - Internal double-quotes are doubled.
 */
function encodeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    str = String(value);
  } else {
    // Object, array, etc.
    str = JSON.stringify(value);
  }

  // Check if quoting is needed
  if (/[,"\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Produces an RFC 4180-compliant CSV line for `row`, projecting only `columns` in order.
 * Returns the line WITHOUT a trailing newline (caller appends \r\n or \n).
 */
export function toCsvLine(row: Record<string, unknown>, columns: readonly string[]): string {
  return columns.map((col) => encodeCell(row[col])).join(',');
}
