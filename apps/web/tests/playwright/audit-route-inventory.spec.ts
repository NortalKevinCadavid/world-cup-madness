// --------------------------------------------------------------------------
// Slice 007 / T011 — audit_log route-inventory test (US2, P1).
// --------------------------------------------------------------------------
// User Story 2 of Slice 007 ("Audit records are tamper-resistant") demands
// two complementary guarantees:
//
//   (a) DB layer — UPDATE/DELETE on `public.audit_log` fail from every
//       application role (covered by T010's pgTAP `tamper_resistance.sql`).
//
//   (b) Application surface — no Next.js route, server component, or
//       lib helper offers an UPDATE/DELETE code path on `audit_log`
//       (covered by THIS test, per Clarification Q4 in spec.md).
//
// This test walks the `apps/web/app/` and `apps/web/lib/` source trees and
// fails — with file:line and the offending excerpt — if it finds any of:
//
//   1. Supabase-JS-client mutation:   `.from('audit_log').update(...)`
//                                     `.from('audit_log').delete(...)`
//   2. Raw SQL UPDATE:                `UPDATE audit_log` /
//                                     `UPDATE public.audit_log`
//   3. Raw SQL DELETE:                `DELETE FROM audit_log` /
//                                     `DELETE FROM public.audit_log`
//
// Sources of truth
// -----------------
//   - specs/007-audit-trail/tasks.md § T011 (this task)
//   - specs/007-audit-trail/spec.md § Clarification Q4 ("no UI/API surface
//     offers update/delete of audit_log")
//   - specs/007-audit-trail/contracts/audit-log.schema.md § Tamper-resistance
//   - .specify/memory/constitution.md § Principle XI (Regression-Gated)
//
// Authoring-time state (2026-05-21)
// ----------------------------------
// `app/` + `lib/` contain ONLY `.insert(...)` / `.select(...)` against
// `audit_log` (writers via SECURITY DEFINER SPs + triggers; readers via
// admin RPCs). Zero mutation matches expected at GREEN. This test serves
// as a tripwire against future regressions (e.g. an admin "delete row"
// button accidentally added during a refactor).
//
// Notes on regex hygiene
// -----------------------
// - All three patterns use the `g` flag to walk every match in the file.
// - We reset `lastIndex` per file because `exec` on a `g`-flagged regex
//   carries state between calls.
// - The walker skips `node_modules` and `.next`, and the test SKIPS itself
//   (this file contains the literal regex sources, which would otherwise
//   self-match).
// --------------------------------------------------------------------------

import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// `__dirname` here = apps/web/tests/playwright
const APP_DIR = path.resolve(__dirname, '..', '..', 'app');
const LIB_DIR = path.resolve(__dirname, '..', '..', 'lib');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

interface Violation {
  file: string;
  pattern: string;
  match: string;
  line: number;
}

// Patterns that indicate forbidden audit_log mutations from the
// application surface (Next.js routes, server components, lib helpers).
const FORBIDDEN_PATTERNS: RegExp[] = [
  // Supabase JS client style: .from('audit_log').update(... | .from("audit_log").delete(...
  /\.from\(\s*['"`]audit_log['"`]\s*\)\s*\.\s*(update|delete)/g,
  // Raw SQL UPDATE — case-insensitive; allows optional `public.` schema qualifier.
  /\bUPDATE\s+(?:public\.)?audit_log\b/gi,
  // Raw SQL DELETE — case-insensitive; `FROM` is optional in PG but conventional.
  /\bDELETE\s+(?:FROM\s+)?(?:public\.)?audit_log\b/gi,
];

async function walkDir(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory may not exist in some checkouts (e.g. brand-new clone before
    // build); the test still passes — it walked zero files there.
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const nested = await walkDir(full);
      out.push(...nested);
    } else if (entry.isFile() && EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

test.describe('Audit route inventory @slice-007 @us2', () => {
  test('No app/ or lib/ file contains audit_log.update() / audit_log.delete() / raw SQL UPDATE|DELETE on audit_log', async () => {
    const files = [
      ...(await walkDir(APP_DIR)),
      ...(await walkDir(LIB_DIR)),
    ];

    expect(files.length, 'walker found at least one source file under app/+lib/').toBeGreaterThan(0);

    const violations: Violation[] = [];
    // Absolute path to this spec — skip ourselves to avoid the regex literals
    // below self-matching.
    const selfPath = path.resolve(__filename);

    for (const file of files) {
      if (path.resolve(file) === selfPath) continue;

      const content = await readFile(file, 'utf8');

      for (const pattern of FORBIDDEN_PATTERNS) {
        // Reset global-regex state between files.
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const upTo = content.substring(0, match.index);
          const line = upTo.split('\n').length;
          violations.push({
            file: path.relative(REPO_ROOT, file),
            pattern: pattern.source,
            match: match[0],
            line,
          });
          // Defensive: zero-width matches would loop forever; bump lastIndex.
          if (match.index === pattern.lastIndex) pattern.lastIndex++;
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  - ${v.file}:${v.line} matches /${v.pattern}/ -> "${v.match}"`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} forbidden audit_log mutation(s) in apps/web/app/ + apps/web/lib/:\n${detail}\n\n` +
          `Per Slice 007 Clarification Q4, no UI/API surface may offer UPDATE or DELETE on audit_log. ` +
          `Audit records are append-only at every layer.`,
      );
    }

    expect(
      violations.length,
      'zero audit_log mutation operations in apps/web/app/ + apps/web/lib/',
    ).toBe(0);
  });
});
