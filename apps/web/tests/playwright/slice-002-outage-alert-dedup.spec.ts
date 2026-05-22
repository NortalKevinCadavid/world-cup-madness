// --------------------------------------------------------------------------
// Slice 002 / T037 — outage alert dedup (US3 AS-2 / SC-003).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 Acceptance Scenario 2 and SC-003:
//   "Given repeated provider failures beyond the configured threshold (e.g.,
//    30 minutes without success), When the threshold is crossed, Then an
//    administrator alert MUST be emitted exactly once per sustained outage
//    and a sync event MUST be recorded."
//
//   SC-003: "Administrators receive an alert within 15 minutes of sustained
//    provider failure beyond the configured threshold, and exactly once per
//    sustained outage (no flap-spam)."
//
// Source of truth:
//   - `specs/002-match-catalog/spec.md` § US3 Acceptance Scenario 2 + SC-003
//   - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q3
//     (audit row is canonical; webhook is opt-in)
//   - `specs/002-match-catalog/quickstart.md` § Manual verification step 5
//   - `specs/002-match-catalog/research.md` § R-008 (dedup state)
//   - `specs/002-match-catalog/tasks.md` T036 (the Deno-side mirror of this)
//
// Posture note (intentional triple-RED):
//   This file is authored under US3 (failure-resilience behavior) but
//   exercises (a) the `sync-catalog` Edge Function (US2 dependency,
//   T032/T033 shipped), (b) the R-008 outage-alert-dedup logic (T041
//   pending), AND (c) the R-004 sanity guards that turn the malformed
//   payload into a failure outcome (T039 pending). Per the T037 prompt
//   the test will be RED until ALL three ship.
//
// Pre-state (Slice 002 fixture, after T012):
//   - 8 teams, 8 matches seeded via `supabase/seed/slice-002-fixture.sql`.
//   - The stub provider's fixture file mirrors those 8 matches.
//   - `tournament_config.notifications.outage_threshold_minutes` defaults
//     to 15 (migration 0028). We TEMPORARILY shrink it to 1 for this test
//     and restore it in `finally` via `withTemporaryConfig`.
//
// Test flow (3 failures, between each we backdate
// provider_sync_state.first_failure_after_success_at by 2 minutes so the
// runner sees "more than 1 minute in outage"):
//   1. Set `notifications.outage_threshold_minutes = 1` (via
//      withTemporaryConfig — auto-restores).
//   2. Mutate the stub fixture to malformed JSON (a string that will not
//      JSON.parse) so the adapter throws and the run records a failure.
//   3. Trigger sync attempt #1. Backdate first_failure_after_success_at
//      by 2 minutes via service-role UPDATE.
//   4. Trigger sync attempt #2. Backdate again so the next attempt is
//      still past threshold.
//   5. Trigger sync attempt #3.
//   6. Assert exactly ONE `audit_log` row with
//      `action='provider.outage_alert_emitted'` exists, written after
//      the start of this test (filter via `since`). The dedup invariant
//      (R-008 / SC-003) requires "exactly once per sustained outage."
//   7. Restore the fixture in `finally` (byte-identical write).
//
// Required env: same as the empty-payload sibling.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  assertOidcStubReachable,
  resetStub,
} from "./fixtures/oidc";
import {
  getServiceClient,
  readAuditLog,
  withTemporaryConfig,
} from "./helpers/service-role";

// --------------------------------------------------------------------------
// Paths + endpoints.
// --------------------------------------------------------------------------

const STUB_SNAPSHOT_PATH = path.resolve(
  process.cwd(),
  "..",
  "..",
  "supabase",
  "functions",
  "_shared",
  "providers",
  "stub",
  "fixtures",
  "wc2026-snapshot.json",
);

const SYNC_FUNCTIONS_BASE_URL =
  process.env.SUPABASE_FUNCTIONS_BASE_URL ??
  "http://localhost:54321/functions/v1";

const SYNC_CATALOG_ENDPOINT = `${SYNC_FUNCTIONS_BASE_URL}/sync-catalog`;

// --------------------------------------------------------------------------
// Constants.
// --------------------------------------------------------------------------

const OUTAGE_THRESHOLD_KEY = "notifications.outage_threshold_minutes";
const OUTAGE_THRESHOLD_TEST_MINUTES = 1; // Shrunk from default 15 for this test.

const STUB_PROVIDER = "stub";

// We backdate by 2 minutes between attempts so the runner sees a
// strictly-greater-than-threshold elapsed time when it computes the
// alert gate (Clarifications Q3 R-008 — `now() - first_failure_after_success_at > threshold`).
const BACKDATE_MINUTES = 2;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * POSTs the sync trigger and returns the response body as text for
 * diagnostic logging. Does NOT assert any status — the canonical
 * post-conditions are the audit_log dedup count, not the per-attempt
 * status code.
 */
async function triggerSync(
  request: import("@playwright/test").APIRequestContext,
  internalSecret: string,
): Promise<string> {
  const res = await request.post(SYNC_CATALOG_ENDPOINT, {
    headers: {
      "X-Internal-Auth": internalSecret,
      "Content-Type": "application/json",
    },
    data: {
      provider: STUB_PROVIDER,
      trigger: "cron",
      run_id: crypto.randomUUID(),
    },
  });
  return res.text().catch(() => "<unreadable body>");
}

/**
 * Backdates `provider_sync_state.first_failure_after_success_at` by N
 * minutes for the stub provider so the next trigger's "minutes in outage"
 * computation crosses the configured threshold. Idempotent and safe to
 * call when the row does not yet exist (returns silently — the next
 * failure-path attempt will create it).
 */
async function backdateFirstFailureAfterSuccess(minutes: number): Promise<void> {
  const client = getServiceClient();

  const { data: row, error: readErr } = await client
    .from("provider_sync_state")
    .select("provider, first_failure_after_success_at")
    .eq("provider", STUB_PROVIDER)
    .maybeSingle();

  if (readErr) {
    throw new Error(
      `backdateFirstFailureAfterSuccess: failed to read provider_sync_state — ${readErr.message}.`,
    );
  }
  if (!row || !row.first_failure_after_success_at) {
    // The row does not exist yet, OR the runner hasn't started populating
    // the outage column. Skip the backdate; the next failure will set it.
    return;
  }

  const current = new Date(row.first_failure_after_success_at);
  const backdated = new Date(current.getTime() - minutes * 60_000);

  const { error: writeErr } = await client
    .from("provider_sync_state")
    .update({ first_failure_after_success_at: backdated.toISOString() })
    .eq("provider", STUB_PROVIDER);

  if (writeErr) {
    throw new Error(
      `backdateFirstFailureAfterSuccess: failed to backdate — ${writeErr.message}.`,
    );
  }
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe(
  "US3 / outage alert dedup @slice-002 @us3",
  () => {
    // 3 sync attempts + DB backdating + audit-log query take meaningfully
    // longer than the default budget. 90s is generous but bounded.
    test.setTimeout(90_000);

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();
    });

    test(
      "three sustained failures emit exactly one provider.outage_alert_emitted row @slice-002 @us3",
      async ({ request }) => {
        // ----------------------------------------------------------------
        // Guard 1 — required env.
        // ----------------------------------------------------------------
        const internalSecret = process.env.SYNC_INTERNAL_AUTH_SECRET;
        if (!internalSecret) {
          test.fixme(
            true,
            "[T037 / outage-dedup] SYNC_INTERNAL_AUTH_SECRET is not set. Add it " +
              "to `apps/web/.env.local` matching `supabase secrets set SYNC_TRIGGER_SECRET=...`.",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Guard 2 — required fixture file.
        // ----------------------------------------------------------------
        if (!existsSync(STUB_SNAPSHOT_PATH)) {
          test.fixme(
            true,
            `[T037 / outage-dedup] Stub provider snapshot file is missing: ${STUB_SNAPSHOT_PATH}.`,
          );
          return;
        }

        // ----------------------------------------------------------------
        // Snapshot the fixture so we can restore it byte-identically in
        // the `finally` block. We mutate it to malformed JSON BEFORE the
        // first trigger and only restore at the end.
        // ----------------------------------------------------------------
        const originalSnapshotRaw = await readFile(
          STUB_SNAPSHOT_PATH,
          "utf-8",
        );

        // Capture the wall-clock instant BEFORE we begin so the audit
        // query filters out any pre-existing outage alerts written by
        // sibling tests in the same Playwright worker.
        const testStartInstant = new Date();

        try {
          // --------------------------------------------------------------
          // Step 1 — mutate the stub fixture to malformed JSON. A bare
          // closing brace is unambiguously JSON.parse-failing. The
          // adapter will throw on read, the coordinator will record a
          // failure outcome, and the outage state will advance.
          // --------------------------------------------------------------
          await writeFile(STUB_SNAPSHOT_PATH, "}", "utf-8");

          // --------------------------------------------------------------
          // Step 2 — temporarily shrink the outage threshold to 1 minute
          // so the dedup gate fires after a single backdate iteration.
          // withTemporaryConfig snapshot/restore happens automatically.
          // --------------------------------------------------------------
          await withTemporaryConfig(
            OUTAGE_THRESHOLD_KEY,
            OUTAGE_THRESHOLD_TEST_MINUTES,
            async () => {
              // ----------------------------------------------------------
              // Step 3 — first sync attempt. This populates
              // first_failure_after_success_at if it was not already set.
              // ----------------------------------------------------------
              const body1 = await triggerSync(request, internalSecret);

              // Backdate so the NEXT trigger sees > 1 minute elapsed.
              await backdateFirstFailureAfterSuccess(BACKDATE_MINUTES);

              // ----------------------------------------------------------
              // Step 4 — second sync attempt. This is the attempt that
              // SHOULD cross the threshold and emit the single alert row.
              // ----------------------------------------------------------
              const body2 = await triggerSync(request, internalSecret);

              // Backdate AGAIN so attempt #3 also clears the threshold.
              // The dedup invariant says we MUST NOT emit a second alert
              // for the same sustained outage.
              await backdateFirstFailureAfterSuccess(BACKDATE_MINUTES);

              // ----------------------------------------------------------
              // Step 5 — third sync attempt. The dedup gate MUST suppress
              // any further alert (R-008 / SC-003 "exactly once per
              // sustained outage").
              // ----------------------------------------------------------
              const body3 = await triggerSync(request, internalSecret);

              // ----------------------------------------------------------
              // Step 6 — assert exactly ONE alert row, written after the
              // test started. Use the service-role audit_log query to
              // bypass RLS (`authenticated` cannot SELECT audit_log).
              // ----------------------------------------------------------
              const rows = await readAuditLog({
                action: "provider.outage_alert_emitted",
                since: testStartInstant,
              });

              expect(
                rows.length,
                "audit_log MUST contain exactly ONE `provider.outage_alert_emitted` row " +
                  "across the three sustained-outage sync attempts (R-008 / SC-003 dedup). " +
                  `Trigger response bodies were: 1=${body1} 2=${body2} 3=${body3}. ` +
                  `Observed ${rows.length} alert row(s).`,
              ).toBe(1);
            },
          );
        } finally {
          // Always restore the fixture byte-identically — even if the
          // assertion above failed or the trigger threw. The threshold
          // config is restored by withTemporaryConfig automatically.
          await writeFile(STUB_SNAPSHOT_PATH, originalSnapshotRaw, "utf-8");
        }
      },
    );
  },
);
