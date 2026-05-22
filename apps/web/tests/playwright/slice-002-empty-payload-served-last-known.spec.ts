// --------------------------------------------------------------------------
// Slice 002 / T037 — empty-payload served last-known (US3 AS-1 / SC-002).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 Acceptance Scenario 1:
//   "Given a previously-synced catalog and an unavailable provider, When a
//    participant requests the match list, Then the catalog MUST serve the
//    last known good data with no user-visible error."
//
// And success criterion SC-002:
//   "Catalog continues serving last-known-good data through provider
//    unavailability with zero user-visible errors."
//
// Source of truth:
//   - `specs/002-match-catalog/spec.md` § US3 Acceptance Scenario 1
//   - `specs/002-match-catalog/spec.md` § SC-002
//   - `specs/002-match-catalog/quickstart.md` § Manual verification step 4
//     ("Provider failure → last-known-good served")
//   - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 —
//     structural anomaly (empty replacement of populated data) MUST abort
//     the whole sync run; catalog stays untouched; admin alert (audit row)
//     emitted.
//
// Posture note (intentional double-RED):
//   This file is authored under US3 (failure-resilience behavior) but
//   exercises a US2 dependency (the `sync-catalog` Edge Function) AND a
//   pending sync-engine guard (T039 — payload-sanity guards). Per the T037
//   prompt the test will be RED until BOTH ship:
//     * The sync coordinator's R-004 empty-payload guard (`outcome
//       = 'rejected_empty'`, audit row `provider.sync_rejected_empty`).
//     * The participant `/matches` page (T021), already shipped, which we
//       rely on to render the last-known-good rows.
//   That is by design (Constitution Principle IX — write the scenario RED
//   first, then ship the implementation that turns it GREEN).
//
// Pre-state (Slice 002 fixture, after T012):
//   - 8 teams, 8 matches seeded via `supabase/seed/slice-002-fixture.sql`.
//   - The stub provider's fixture file mirrors those 8 matches.
//
// Test flow:
//   1. Sanity gate: GET /api/matches returns 8 rows (the pre-state).
//   2. Snapshot the stub fixture file (raw text), then overwrite it with
//      a structurally-valid JSON snapshot whose `matches` array is empty
//      (`{ matches: [], teams: [...preserved], ... }`). The empty-array
//      mutation simulates the canonical "empty payload for previously-
//      populated league" condition (spec § Edge Cases).
//   3. POST /functions/v1/sync-catalog with the `X-Internal-Auth` header.
//   4. Sign in via the OIDC stub as alpha@nortal.com (eligible) and
//      navigate to `/matches`.
//   5. Assert ALL 8 prior matches are still rendered in the table — the
//      catalog served last-known-good. Inspect by venue substring (the
//      fixture venues are unique).
//   6. Assert NO error UI is present — no error banner, no toast, no
//      crash boundary message. The page renders exactly as the happy
//      path would.
//   7. Assert the service-role `audit_log` view contains a row with
//      `action='provider.sync_rejected_empty'` produced by THIS run.
//   8. The `finally` block always restores the original fixture file
//      contents byte-identically (preserving any trailing newline) — even
//      if an assertion failed mid-test — so siblings start from a known
//      pre-state.
//
// Required env (mirrors T016):
//   - SYNC_INTERNAL_AUTH_SECRET — the `X-Internal-Auth` header value the
//     sync coordinator expects (also called `SYNC_TRIGGER_SECRET` on the
//     server side). If unset the test self-fixmes with a clear
//     remediation message rather than emit a false RED.
//   - SUPABASE_FUNCTIONS_BASE_URL — optional override (defaults to
//     `http://localhost:54321/functions/v1`).
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — consumed transitively by
//     `helpers/service-role.ts` for the `audit_log` query.
//
// Pre-condition file (must exist for the test to run end-to-end):
//   - `supabase/functions/_shared/providers/stub/fixtures/wc2026-snapshot.json`
//     This is created by T030 (stub provider snapshot). If missing the
//     test self-fixmes — the sync engine cannot ship without it.
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
import { readAuditLog } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Persona — alpha@nortal.com is the eligible fixture identity from Slice 001.
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
// Local contract types — mirror the response shape WITHOUT importing app
// code so the spec stays decoupled from any future internal refactor.
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
 * Loose shape of the stub provider's `wc2026-snapshot.json` body. We only
 * need to mutate `matches`; other top-level keys (`teams`, `version`, etc.)
 * are preserved untouched on the round-trip.
 */
interface StubSnapshot {
  matches: unknown[];
  [extra: string]: unknown;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Reads the stub snapshot file, returns its raw text + parsed body. Throws
 * a clear remediation error if the file is missing or unparseable so the
 * test fails fast rather than mutating a poisoned fixture.
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
      `[T037 / empty-payload] Stub snapshot at ${STUB_SNAPSHOT_PATH} is not valid JSON — ${(err as Error).message}. ` +
        `Fix the file by hand; this test will refuse to mutate an unparseable fixture.`,
    );
  }
  if (!Array.isArray(parsed.matches)) {
    throw new Error(
      `[T037 / empty-payload] Stub snapshot at ${STUB_SNAPSHOT_PATH} has no top-level "matches" array. ` +
        `Confirm T030 has shipped and the file shape matches contracts/provider-adapter.contract.md.`,
    );
  }
  return { raw, parsed };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe(
  "US3 / empty payload → served last-known-good @slice-002 @us3",
  () => {
    // The sync trigger + a fresh sign-in + a `/matches` render take a
    // bit longer than the default Playwright budget. 60s is comfortable.
    test.setTimeout(60_000);

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      // The fixture restore is wrapped in the test's `finally`, but reset
      // the OIDC stub identity here as well for symmetry with sibling
      // slice-002 specs (so a worker re-using this context starts clean).
      await resetStub();
    });

    test(
      "empty stub payload is rejected; /matches still shows all 8 last-known matches @slice-002 @us3",
      async ({ page, request }) => {
        // ----------------------------------------------------------------
        // Guard 1 — required env. Without the trigger secret the test
        // cannot meaningfully execute against a real sync engine.
        // ----------------------------------------------------------------
        const internalSecret = process.env.SYNC_INTERNAL_AUTH_SECRET;
        if (!internalSecret) {
          test.fixme(
            true,
            "[T037 / empty-payload] SYNC_INTERNAL_AUTH_SECRET is not set. Add it " +
              "to `apps/web/.env.local` matching the value passed to " +
              "`supabase secrets set SYNC_TRIGGER_SECRET=...`. Without it the " +
              "sync trigger would 401 against the real sync engine.",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Guard 2 — required fixture file. The stub snapshot is created
        // by T030.
        // ----------------------------------------------------------------
        if (!existsSync(STUB_SNAPSHOT_PATH)) {
          test.fixme(
            true,
            `[T037 / empty-payload] Stub provider snapshot file is missing: ${STUB_SNAPSHOT_PATH}. ` +
              "It is created by T030 (stub provider's fixture JSON).",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Sign in as alpha — an eligible @nortal.com fixture identity —
        // so /api/matches and /matches return 200.
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
        // Pre-state sanity — confirm the catalog has the expected 8 rows.
        // This both validates the seed and locks in the baseline for the
        // post-sync "data unchanged" assertion.
        // ----------------------------------------------------------------
        const beforeRes = await request.get("/api/matches");
        expect(
          beforeRes.status(),
          "Pre-sync /api/matches MUST be 200 — sanity gate before mutating fixtures",
        ).toBe(200);

        const before = (await beforeRes.json()) as CatalogResponse;
        expect(
          before.total,
          "Pre-state expects exactly 8 fixture rows (per supabase/seed/slice-002-fixture.sql)",
        ).toBe(8);

        const expectedVenues = new Set(
          before.matches
            .map((m) => m.venue)
            .filter((v): v is string => typeof v === "string" && v.length > 0),
        );
        expect(
          expectedVenues.size,
          "Pre-state expects 8 distinct, non-null venues to use as last-known-good probes",
        ).toBe(8);

        // ----------------------------------------------------------------
        // Snapshot the stub provider's fixture so we can restore it in
        // the `finally` block regardless of how the rest of the test ends.
        // ----------------------------------------------------------------
        const { raw: originalSnapshotRaw, parsed: originalSnapshot } =
          await readStubSnapshot();

        // Capture the wall-clock instant BEFORE we trigger the sync so
        // the audit-log query downstream filters out any pre-existing
        // `provider.sync_rejected_empty` rows from sibling tests.
        const triggerInstant = new Date();

        try {
          // --------------------------------------------------------------
          // Step 1 — mutate the stub fixture: empty the `matches` array.
          // The rest of the JSON (e.g. `teams`, `version`) stays intact
          // so the adapter still parses structurally; only the catalog
          // payload is "empty replacement of populated data" (spec
          // Clarifications 2026-05-15 Q2 — structural anomaly).
          // --------------------------------------------------------------
          const mutated: StubSnapshot = {
            ...originalSnapshot,
            matches: [],
          };

          await writeFile(
            STUB_SNAPSHOT_PATH,
            JSON.stringify(mutated, null, 2) +
              (originalSnapshotRaw.endsWith("\n") ? "\n" : ""),
            "utf-8",
          );

          // --------------------------------------------------------------
          // Step 2 — trigger the sync via the internal-auth path. The
          // server response code is intentionally NOT asserted with
          // strict equality: the contract says 422 for `rejected_empty`,
          // but the canonical post-condition is the audit row + the
          // unchanged catalog rather than the HTTP status. We still
          // record the response body in the failure message so the
          // operator can correlate.
          // --------------------------------------------------------------
          const triggerResponse = await request.post(SYNC_CATALOG_ENDPOINT, {
            headers: {
              "X-Internal-Auth": internalSecret,
              "Content-Type": "application/json",
            },
            data: {
              provider: "stub",
              trigger: "cron",
              run_id: crypto.randomUUID(),
            },
          });

          // The response body is small; capture it so a downstream
          // assertion failure has useful context.
          const triggerBody = await triggerResponse
            .text()
            .catch(() => "<unreadable body>");

          // --------------------------------------------------------------
          // Step 3 — navigate to `/matches` as an eligible participant.
          // The page is a server component that calls /api/matches under
          // the hood (apps/web/lib/catalog/client.ts), so this exercises
          // the full last-known-good user path.
          // --------------------------------------------------------------
          await page.goto("/matches");
          await expect(
            page.getByRole("heading", { level: 1, name: /matches/i }),
            "The `/matches` page MUST render its top-level heading; the empty payload MUST NOT short-circuit the participant view.",
          ).toBeVisible();

          // --------------------------------------------------------------
          // Step 4 — assert all 8 prior matches are still displayed. We
          // probe by venue (each fixture venue is unique and the table
          // renders the venue verbatim in its own cell). Using getByText
          // with `exact: false` would match accidental substring overlaps,
          // so we use a strict containment scan via the page text.
          // --------------------------------------------------------------
          for (const venue of Array.from(expectedVenues)) {
            await expect(
              page.getByText(venue, { exact: true }),
              `Venue "${venue}" MUST still appear in /matches after an empty-payload sync — ` +
                `the catalog MUST serve last-known-good (US3 AS-1). Trigger response was: ${triggerBody}`,
            ).toBeVisible();
          }

          // --------------------------------------------------------------
          // Step 5 — assert no error UI surfaces. There is no banner
          // role wired for catalog errors today; we use both an explicit
          // `role=alert` query (Playwright's idiomatic error surface) and
          // a string scan for the well-known crash-boundary copy that
          // would appear if the catalog read had thrown.
          // --------------------------------------------------------------
          const alertCount = await page.getByRole("alert").count();
          expect(
            alertCount,
            "/matches MUST NOT render a role=alert region after a last-known-good fallback (SC-002 zero user-visible errors).",
          ).toBe(0);
          await expect(
            page.getByText(/something went wrong/i),
            "/matches MUST NOT render the Next.js error-boundary copy on a last-known-good fallback.",
          ).toHaveCount(0);
          await expect(
            page.getByText(/failed to load matches/i),
            "/matches MUST NOT render any explicit catalog-failure copy on a last-known-good fallback.",
          ).toHaveCount(0);

          // --------------------------------------------------------------
          // Step 6 — re-fetch /api/matches under the same session and
          // assert `total` is STILL 8. The empty payload MUST NOT have
          // replaced the populated catalog (FR-006 + spec § Edge Cases
          // "empty payload for previously-populated league").
          // --------------------------------------------------------------
          const afterRes = await request.get("/api/matches");
          expect(
            afterRes.status(),
            "Post-sync /api/matches MUST remain 200 — last-known-good serves through the outage.",
          ).toBe(200);
          const after = (await afterRes.json()) as CatalogResponse;
          expect(
            after.total,
            "Post-empty-payload-sync `total` MUST be 8 (unchanged from pre-state).",
          ).toBe(8);
          expect(
            after.matches.length,
            "Post-empty-payload-sync `matches.length` MUST be 8 (unchanged from pre-state).",
          ).toBe(8);

          // --------------------------------------------------------------
          // Step 7 — assert the audit row was written. The R-004 guard
          // contract is `audit_log.action = 'provider.sync_rejected_empty'`.
          // Filter by `since: triggerInstant` so a stale row from a
          // sibling test cannot make this a false GREEN.
          // --------------------------------------------------------------
          const rejectedRows = await readAuditLog({
            action: "provider.sync_rejected_empty",
            since: triggerInstant,
          });
          expect(
            rejectedRows.length,
            "audit_log MUST contain at least one `provider.sync_rejected_empty` row written after the sync trigger " +
              `(Clarifications 2026-05-15 Q2). Trigger response was: ${triggerBody}.`,
          ).toBeGreaterThanOrEqual(1);
        } finally {
          // ------------------------------------------------------------
          // Always restore the snapshot — even if any assertion above
          // failed or the sync trigger threw. Leaving the fixture as `[]`
          // would poison every subsequent slice-002 spec.
          //
          // We intentionally do NOT swallow restore errors: a failed
          // restore is a worse problem than a failed assertion, so we
          // let it bubble.
          // ------------------------------------------------------------
          await writeFile(STUB_SNAPSHOT_PATH, originalSnapshotRaw, "utf-8");
        }
      },
    );
  },
);
