// --------------------------------------------------------------------------
// Slice 002 / T016 — late-added fixture appears after sync (US1 AS-3).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 1 (P1) Acceptance Scenario 3:
//   "Given the official schedule lists a new match added late, When the next
//    provider sync runs, Then the new match MUST appear in the catalog
//    without manual intervention."
//
// Source of truth:
//   - `specs/002-match-catalog/spec.md` § US1 Acceptance Scenario 3
//   - `specs/002-match-catalog/contracts/sync-runner.scheduled.md`
//     § Invocation Path 1 (Scheduled — `X-Internal-Auth`)
//   - `specs/002-match-catalog/quickstart.md` § Manual verification step 2
//
// Posture note (intentional double-RED):
//   This file is authored under US1 (catalog read behavior) but exercises a
//   US2 dependency (the `sync-catalog` Edge Function). Per the T016 prompt
//   it will be RED until BOTH of the following ship:
//     * T020 / T021 — the `GET /api/matches` route + participant catalog page.
//     * T032 / T033 / T040 / T041 — the sync-catalog Edge Function + its
//       provider-adapter wiring + the stub provider's fixture JSON file.
//   That is by design (Constitution Principle IX — write the scenario RED
//   first, then ship the implementation that turns it GREEN).
//
// Pre-state (Slice 002 fixture, after T012):
//   - 8 teams, 8 matches seeded via `supabase/seed/slice-002-fixture.sql`.
//   - The stub provider's fixture file mirrors those 8 matches.
//
// Test flow:
//   1. GET /api/matches → assert pre-state `total === 8`.
//   2. Read `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json`,
//      snapshot it, add a 9th match (`stub-match-late-9`, Argentina vs Brazil,
//      group A, venue 'Late Fixture Stadium'), write it back.
//   3. POST /functions/v1/sync-catalog with `X-Internal-Auth` header.
//   4. Poll `provider_sync_runs` via the service-role helper until the run
//      we triggered has `outcome IN ('success', 'success_no_changes')`.
//      Timeout: 30s p95 per `sync-runner.scheduled.md` § Performance budget
//      (we use 45s wall clock with 500ms polling for CI safety).
//   5. GET /api/matches → assert `total === 9` and the new fixture is
//      present with the correct shape (home=ARG, away=BRA, venue match).
//   6. Restore the snapshot JSON file in a `finally` block so the fixture
//      is always returned to its pre-test state — even if any assertion or
//      the sync trigger itself fails.
//
// Required env (document at top so a future operator can wire this up):
//   - SYNC_INTERNAL_AUTH_SECRET — the value of the `X-Internal-Auth` header
//     the sync coordinator expects (set via
//     `supabase secrets set SYNC_TRIGGER_SECRET=...` AND mirrored in
//     `apps/web/.env.local` so Playwright's process.env can see it). The
//     spec calls this `SYNC_TRIGGER_SECRET` on the server side; the test
//     reads it from `SYNC_INTERNAL_AUTH_SECRET` per the T016 brief. If
//     unset, the test self-fixmes with a clear remediation message rather
//     than running with a guessed value that would 401 against a real
//     sync engine.
//   - SUPABASE_FUNCTIONS_BASE_URL — optional override (defaults to
//     `http://localhost:54321/functions/v1`). The Playwright baseURL is
//     `http://localhost:3000` (Next.js dev server); the Edge Function
//     lives on the Supabase stack, so the sync trigger uses an absolute URL.
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — consumed transitively by
//     `helpers/service-role.ts` to poll `provider_sync_runs`.
//
// Pre-condition file (must exist for the test to run end-to-end):
//   - `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json`
//     This is created by T030 (stub provider snapshot). If the file is
//     missing the test self-fixmes — the sync engine cannot have shipped
//     without it, so the doubly-RED gate is honored automatically.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Persona — alpha@nortal.com is the eligible fixture identity from Slice 001.
// Reused here so the catalog reads succeed under the same auth posture as
// `slice-002-catalog-eligible-200.spec.ts`.
// --------------------------------------------------------------------------
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// --------------------------------------------------------------------------
// Paths + endpoints.
// --------------------------------------------------------------------------

/**
 * Path to the stub provider's snapshot file. Resolved RELATIVE TO THE REPO
 * ROOT. Playwright's process.cwd() during `pnpm exec playwright test` from
 * `apps/web` is `apps/web`, so we step up two levels to reach the repo root
 * and then descend into `supabase/`.
 */
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
// Local types — mirror the contract shapes WITHOUT importing app code so
// the spec stays decoupled from the not-yet-shipped route handler.
// --------------------------------------------------------------------------

interface CatalogTeam {
  id: string;
  name: string;
  short_code: string;
  flag_url: string | null;
}

interface CatalogMatch {
  id: string;
  home_team: CatalogTeam;
  away_team: CatalogTeam;
  stage: string;
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: string;
  match_result: unknown | null;
}

interface CatalogResponse {
  matches: CatalogMatch[];
  page: number;
  page_size: number;
  total: number;
}

/**
 * Shape of one row in the stub provider's `wc2026-snapshot.json` `matches`
 * array. Mirrors the NormalizedFixture type the adapter contract emits
 * (`specs/002-match-catalog/contracts/provider-adapter.contract.md`). We
 * keep it loose (no enums) so the test does not have to be regenerated
 * if T030 ships small naming tweaks; the assertions key off venue and
 * short_code, both unambiguous in the fixture.
 */
interface StubFixtureRow {
  providerMatchId: string;
  homeTeam: { providerTeamId: string; name: string; shortCode: string; flagUrl: string | null };
  awayTeam: { providerTeamId: string; name: string; shortCode: string; flagUrl: string | null };
  stage: string;
  groupId: string | null;
  kickoffUtc: string;
  venue: string | null;
  status: string;
}

interface StubSnapshot {
  matches: StubFixtureRow[];
  // Other top-level keys (e.g. `teams`, `version`) are tolerated and left
  // untouched by the round-trip — we only mutate `matches`.
  [extra: string]: unknown;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Reads the stub snapshot file, returns its raw text + parsed body.
 * Throws a clear error if the file is missing or unparseable — the test
 * body wraps the call in `test.fixme` for the missing-file branch.
 */
async function readStubSnapshot(): Promise<{
  raw: string;
  parsed: StubSnapshot;
}> {
  const raw = await readFile(STUB_SNAPSHOT_PATH, "utf-8");
  let parsed: StubSnapshot;
  try {
    parsed = JSON.parse(raw) as StubSnapshot;
  } catch (err) {
    throw new Error(
      `[T016] Stub snapshot at ${STUB_SNAPSHOT_PATH} is not valid JSON — ${(err as Error).message}. ` +
        `Fix the file by hand; this test will refuse to mutate an unparseable fixture.`,
    );
  }
  if (!Array.isArray(parsed.matches)) {
    throw new Error(
      `[T016] Stub snapshot at ${STUB_SNAPSHOT_PATH} has no top-level "matches" array. ` +
        `Confirm T030 has shipped and the file shape matches contracts/provider-adapter.contract.md.`,
    );
  }
  return { raw, parsed };
}

/**
 * Polls `provider_sync_runs` (via service-role) for a row matching
 * `predicate` whose `outcome` has been set. Returns the row when found,
 * or throws on timeout.
 *
 * The poll interval is 500ms and the wall-clock timeout is 45s. The
 * contract's p95 target is 30s for a complete sync; 45s leaves margin
 * for the CI machine spin-up cost without inflating Playwright's
 * per-test budget (we explicitly raise this test's timeout below).
 */
async function pollForSyncCompletion(opts: {
  startedAfter: Date;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{
  id: string;
  outcome: string;
  counts: { created?: number; updated?: number } | null;
  started_at: string;
  finished_at: string | null;
}> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const client = getServiceClient();

  let lastSeenError: string | null = null;

  while (Date.now() < deadline) {
    const { data, error } = await client
      .from("provider_sync_runs")
      .select("id, outcome, counts, started_at, finished_at")
      .gte("started_at", opts.startedAfter.toISOString())
      .not("outcome", "is", null)
      .order("started_at", { ascending: false })
      .limit(1);

    if (error) {
      // Don't throw immediately — the sync_runs table may briefly not exist
      // (RED before T032) or RLS may briefly mis-route. Capture the message
      // and let the timeout fire with full context if it doesn't recover.
      lastSeenError = error.message;
    } else if (data && data.length > 0) {
      return data[0] as {
        id: string;
        outcome: string;
        counts: { created?: number; updated?: number } | null;
        started_at: string;
        finished_at: string | null;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `[T016] Timed out after ${timeoutMs}ms polling provider_sync_runs ` +
      `for a completed run started after ${opts.startedAfter.toISOString()}. ` +
      (lastSeenError
        ? `Last error from service-role query: ${lastSeenError}. `
        : "") +
      `If the sync engine (T032/T033) has not shipped this is the expected RED state.`,
  );
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe(
  "US1 / late-fixture appears after sync @slice-002 @us1 @sync",
  () => {
    // Raise the per-test timeout to comfortably accommodate the 45s
    // sync-completion poll plus the bracketing reads and sign-in.
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
      "a fixture added to the provider snapshot appears in /api/matches after sync @slice-002 @us1 @sync",
      async ({ page, request }) => {
        // ----------------------------------------------------------------
        // Guard 1 — required env. The trigger secret is critical; if it
        // is absent the test cannot meaningfully execute, so we self-fixme
        // with a clear remediation message rather than emit a false RED.
        // ----------------------------------------------------------------
        const internalSecret = process.env.SYNC_INTERNAL_AUTH_SECRET;
        if (!internalSecret) {
          test.fixme(
            true,
            "[T016] SYNC_INTERNAL_AUTH_SECRET is not set. Add it to " +
              "`apps/web/.env.local` matching the value passed to " +
              "`supabase secrets set SYNC_TRIGGER_SECRET=...`. Without it " +
              "the sync trigger would 401 against the real sync engine.",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Guard 2 — required fixture file. The stub snapshot is created
        // by T030. Before T030 ships this test is gated RED at the
        // assertions; once the file exists it executes end-to-end.
        // ----------------------------------------------------------------
        if (!existsSync(STUB_SNAPSHOT_PATH)) {
          test.fixme(
            true,
            `[T016] Stub provider snapshot file is missing: ${STUB_SNAPSHOT_PATH}. ` +
              "It is created by T030 (stub provider's fixture JSON). Re-enable " +
              "this test once the file exists.",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Sign in as an eligible participant so /api/matches returns 200.
        // ----------------------------------------------------------------
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // ----------------------------------------------------------------
        // Pre-state — confirm the catalog has the expected 8 fixture rows.
        // This both validates the seed and gives the test a deterministic
        // baseline for the post-sync delta assertion.
        // ----------------------------------------------------------------
        const beforeRes = await request.get("/api/matches");
        expect(
          beforeRes.status(),
          "Pre-sync /api/matches must be 200 — sanity gate before mutating fixtures",
        ).toBe(200);

        const before = (await beforeRes.json()) as CatalogResponse;
        expect(
          before.total,
          "Pre-state expects exactly 8 fixture rows (per supabase/seed/slice-002-fixture.sql)",
        ).toBe(8);

        // ----------------------------------------------------------------
        // Snapshot the stub provider's fixture so we can restore it in
        // the `finally` block regardless of how the rest of the test ends.
        // ----------------------------------------------------------------
        const { raw: originalSnapshotRaw, parsed: originalSnapshot } =
          await readStubSnapshot();

        // Capture the wall-clock instant just before we trigger the sync.
        // We use this as the lower bound when polling provider_sync_runs
        // so a stale prior run (from a sibling test or pg_cron tick)
        // cannot be mistaken for the run we just kicked off.
        const triggerInstant = new Date();

        try {
          // --------------------------------------------------------------
          // Step 1 — mutate the stub fixture: add a 9th match.
          // --------------------------------------------------------------
          const newFixture: StubFixtureRow = {
            providerMatchId: "stub-match-late-9",
            homeTeam: {
              providerTeamId: "stub-team-arg",
              name: "Argentina",
              shortCode: "ARG",
              flagUrl: null,
            },
            awayTeam: {
              providerTeamId: "stub-team-bra",
              name: "Brazil",
              shortCode: "BRA",
              flagUrl: null,
            },
            stage: "group",
            groupId: "A",
            kickoffUtc: "2026-06-20T20:00:00Z",
            venue: "Late Fixture Stadium",
            status: "scheduled",
          };

          const mutated: StubSnapshot = {
            ...originalSnapshot,
            matches: [...originalSnapshot.matches, newFixture],
          };

          // Preserve the original file's trailing newline (if any) so the
          // restore in `finally` is byte-identical to the pre-test state.
          await writeFile(
            STUB_SNAPSHOT_PATH,
            JSON.stringify(mutated, null, 2) +
              (originalSnapshotRaw.endsWith("\n") ? "\n" : ""),
            "utf-8",
          );

          // --------------------------------------------------------------
          // Step 2 — trigger the sync via the internal-auth path
          // (Path 1 of contracts/sync-runner.scheduled.md § Invocation).
          // --------------------------------------------------------------
          const triggerResponse = await request.post(SYNC_CATALOG_ENDPOINT, {
            headers: {
              "X-Internal-Auth": internalSecret,
              "Content-Type": "application/json",
            },
            data: {
              provider: "stub",
              trigger: "cron",
              // run_id is caller-supplied per the contract — use a fresh UUID
              // each test invocation to avoid colliding with prior runs.
              run_id: crypto.randomUUID(),
            },
          });

          expect(
            triggerResponse.ok(),
            `sync-catalog trigger MUST return 2xx (got ${triggerResponse.status()} ` +
              `${await triggerResponse.text().catch(() => "<unreadable body>")}). ` +
              "If the Edge Function is not running, start it with " +
              "`supabase functions serve sync-catalog --env-file .env.local`.",
          ).toBe(true);

          // --------------------------------------------------------------
          // Step 3 — wait for the sync coordinator to record a completion
          // row in provider_sync_runs. The contract guarantees the row is
          // written even on idempotent retries, so this is the canonical
          // "sync done" signal (sync-runner.scheduled.md § Outcome enum).
          // --------------------------------------------------------------
          const completedRun = await pollForSyncCompletion({
            startedAfter: triggerInstant,
            timeoutMs: 45_000,
            intervalMs: 500,
          });

          // We accept either `success` (a row was created/updated — the
          // expected case here, since we added a new fixture) OR
          // `success_no_changes` (defensive — covers the unusual case
          // where the stub provider has already absorbed our change in
          // a prior in-flight run). Anything else fails the test loudly.
          expect(
            completedRun.outcome,
            `sync-catalog completed with outcome=${completedRun.outcome}; ` +
              "expected `success` (since we added a brand-new fixture row).",
          ).toBe("success");

          // --------------------------------------------------------------
          // Step 4 — re-read the catalog and assert the new match appears.
          // --------------------------------------------------------------
          const afterRes = await request.get("/api/matches");
          expect(
            afterRes.status(),
            "Post-sync /api/matches must remain 200",
          ).toBe(200);

          const after = (await afterRes.json()) as CatalogResponse;
          expect(
            after.total,
            "Post-sync `total` MUST be 9 (8 seeded + 1 newly synced)",
          ).toBe(9);
          expect(
            after.matches.length,
            "Post-sync `matches` array MUST contain 9 rows",
          ).toBe(9);

          const newCatalogRow = after.matches.find(
            (m) => m.venue === "Late Fixture Stadium",
          );
          expect(
            newCatalogRow,
            "The newly synced fixture (venue='Late Fixture Stadium') MUST be " +
              "present in the catalog response after the sync run completes.",
          ).toBeDefined();
          expect(newCatalogRow!.home_team.short_code).toBe("ARG");
          expect(newCatalogRow!.away_team.short_code).toBe("BRA");
          expect(newCatalogRow!.stage).toBe("group");
          expect(newCatalogRow!.group_id).toBe("A");
          expect(newCatalogRow!.status).toBe("scheduled");
          // The new match is scheduled (not finished) — match_result MUST be null.
          expect(newCatalogRow!.match_result).toBeNull();
          // kickoff_utc must round-trip ISO-8601 and remain in UTC (Constitution VI).
          expect(newCatalogRow!.kickoff_utc).toMatch(
            /^2026-06-20T20:00:00(\.000)?Z$/,
          );
        } finally {
          // ------------------------------------------------------------
          // Always restore the snapshot — even if any assertion above
          // failed or the sync trigger threw. The fixture file is shared
          // across tests; leaving the 9th row in it would poison every
          // subsequent run (and contaminate the seed fixture count).
          //
          // We intentionally do NOT swallow restore errors: a failed
          // restore is a worse problem than a failed assertion, so we
          // re-throw to make the breakage maximally visible.
          // ------------------------------------------------------------
          await writeFile(STUB_SNAPSHOT_PATH, originalSnapshotRaw, "utf-8");
        }
      },
    );
  },
);
