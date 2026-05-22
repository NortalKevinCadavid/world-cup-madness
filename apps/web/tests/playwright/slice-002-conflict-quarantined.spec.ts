// --------------------------------------------------------------------------
// Slice 002 / T037 — cross-run conflict quarantined (US3 AS-3 + Edge Case).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 3 Acceptance Scenario 3 + the
// "conflicting data across two consecutive syncs" Edge Case:
//   "Provider returns conflicting data across two consecutive syncs (e.g.,
//    team A vs team B at one time, team A vs team C the next) → the catalog
//    MUST flag the conflict, record both observations in the audit trail,
//    and require admin resolution before propagating the change."
//
// Source of truth:
//   - `specs/002-match-catalog/spec.md` § US3 Acceptance Scenario 3 +
//     § Edge Cases (conflicting data across two consecutive syncs)
//   - `specs/002-match-catalog/spec.md` § Clarifications 2026-05-15 Q2 —
//     per-row data conflict (team-assignment change) MUST quarantine the
//     offending row into `match_pending_review` and apply the remaining
//     rows normally.
//   - `specs/002-match-catalog/quickstart.md` § Manual verification step 6
//     ("Conflict quarantine")
//   - `specs/002-match-catalog/data-model.md` § Entity 7 (Match Pending
//     Review)
//
// Posture note (intentional double-RED):
//   This file is authored under US3 (failure-resilience behavior) but
//   exercises a US2 dependency (the `sync-catalog` Edge Function) AND a
//   pending coordinator feature (T040 — per-row quarantine logic). Per
//   the T037 prompt the test will be RED until BOTH ship:
//     * The coordinator's R-005 cross-run conflict guard (writes
//       `match_pending_review`; leaves `matches` row unchanged).
//     * The participant `/matches` page (T021), already shipped, which
//       we rely on to demonstrate the unchanged team assignment.
//
// Pre-state (Slice 002 fixture, after T012):
//   - M1 = ARG vs MEX (finished, regulation 2-0) at Estadio Azteca,
//     2026-06-11T20:00Z, group A. M1's provider mapping is
//     match_provider_external_ids.provider_match_id = 'stub-match-1'.
//
// Test flow:
//   1. Sign in via the OIDC stub as alpha@nortal.com (eligible).
//   2. Sanity gate: /matches displays the M1 row (ARG vs MEX).
//   3. Snapshot the stub fixture file. Locate the row keyed by
//      providerMatchId='stub-match-1' and rewrite its away team to BRA
//      (a TEAM-SWAP conflict — Clarifications Q2 per-row class).
//   4. POST /functions/v1/sync-catalog with the `X-Internal-Auth` header.
//   5. Reload /matches; assert M1 STILL shows ARG vs MEX (catalog NOT
//      mutated by the conflicting sync).
//   6. Assert `match_pending_review` (queried via service-role) contains
//      a row for M1 keyed by provider='stub' + provider_external_id
//      ='stub-match-1', detected after the trigger.
//   7. The `finally` block always restores the original fixture file
//      contents byte-identically.
//
// Required env: same as the empty-payload sibling — SYNC_INTERNAL_AUTH_SECRET,
// SUPABASE_FUNCTIONS_BASE_URL (optional), SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (for the match_pending_review query).
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
// Fixture constants — M1 = ARG vs MEX in the seeded catalog. Provider IDs
// follow the slice-002-fixture.sql conventions (`stub-match-<n>`, team
// short codes lowercased).
// --------------------------------------------------------------------------

const M1_PROVIDER_MATCH_ID = "stub-match-1";
const M1_AWAY_TEAM_PROVIDER_ID_BEFORE = "mex"; // The seeded away team.
const M1_AWAY_TEAM_PROVIDER_ID_CONFLICT = "bra"; // The away team we swap to.

// --------------------------------------------------------------------------
// Local fixture-row shape — mirrors the stub adapter's NormalizedFixture.
// Kept loose so small renames in T030 do not break this spec.
// --------------------------------------------------------------------------

interface StubFixtureTeam {
  providerTeamId: string;
  name: string;
  shortCode: string;
  flagUrl: string | null;
}

interface StubFixtureRow {
  providerMatchId: string;
  homeTeam: StubFixtureTeam;
  awayTeam: StubFixtureTeam;
  stage: string;
  groupId: string | null;
  kickoffUtc: string;
  venue: string | null;
  status: string;
  // The stub's row may carry other fields (e.g. `matchResult`); preserve
  // them by spreading the original row when we mutate.
  [extra: string]: unknown;
}

interface StubSnapshot {
  matches: StubFixtureRow[];
  [extra: string]: unknown;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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
      `[T037 / conflict] Stub snapshot at ${STUB_SNAPSHOT_PATH} is not valid JSON — ${(err as Error).message}.`,
    );
  }
  if (!Array.isArray(parsed.matches)) {
    throw new Error(
      `[T037 / conflict] Stub snapshot at ${STUB_SNAPSHOT_PATH} has no top-level "matches" array.`,
    );
  }
  return { raw, parsed };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe(
  "US3 / cross-run conflict quarantined @slice-002 @us3",
  () => {
    test.setTimeout(60_000);

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
      "team-swap conflict quarantines the row; /matches still shows the pre-conflict team @slice-002 @us3",
      async ({ page, request }) => {
        // ----------------------------------------------------------------
        // Guard 1 — required env.
        // ----------------------------------------------------------------
        const internalSecret = process.env.SYNC_INTERNAL_AUTH_SECRET;
        if (!internalSecret) {
          test.fixme(
            true,
            "[T037 / conflict] SYNC_INTERNAL_AUTH_SECRET is not set. Add it to " +
              "`apps/web/.env.local` matching `supabase secrets set SYNC_TRIGGER_SECRET=...`.",
          );
          return;
        }

        // ----------------------------------------------------------------
        // Guard 2 — required fixture file.
        // ----------------------------------------------------------------
        if (!existsSync(STUB_SNAPSHOT_PATH)) {
          test.fixme(
            true,
            `[T037 / conflict] Stub provider snapshot file is missing: ${STUB_SNAPSHOT_PATH}.`,
          );
          return;
        }

        // ----------------------------------------------------------------
        // Sign in as an eligible participant.
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
        // Pre-state sanity — M1 (ARG vs MEX) is on the page.
        // ----------------------------------------------------------------
        await page.goto("/matches");
        await expect(
          page.getByRole("heading", { level: 1, name: /matches/i }),
        ).toBeVisible();
        // Both team short codes MUST be on the page; we'll re-check them
        // after the conflicting sync to assert M1 was NOT mutated.
        await expect(
          page.getByText("Argentina"),
          "Pre-state expects M1 to render Argentina (the home team) on /matches.",
        ).toBeVisible();
        await expect(
          page.getByText("Mexico"),
          "Pre-state expects M1 to render Mexico (the away team) on /matches.",
        ).toBeVisible();

        // ----------------------------------------------------------------
        // Snapshot the fixture so we can restore it in `finally`.
        // ----------------------------------------------------------------
        const { raw: originalSnapshotRaw, parsed: originalSnapshot } =
          await readStubSnapshot();

        // Locate M1 in the fixture so we can mutate ONLY its away team
        // (per Clarifications Q2: per-row anomaly, not structural).
        const m1Index = originalSnapshot.matches.findIndex(
          (m) => m.providerMatchId === M1_PROVIDER_MATCH_ID,
        );
        if (m1Index < 0) {
          throw new Error(
            `[T037 / conflict] Stub fixture has no row with providerMatchId='${M1_PROVIDER_MATCH_ID}'. ` +
              `T030's fixture file MUST mirror supabase/seed/slice-002-fixture.sql, which seeds M1 ` +
              `(ARG vs MEX) with that provider id.`,
          );
        }
        const m1Original = originalSnapshot.matches[m1Index]!;

        // Sanity — the row we're about to mutate is indeed MEX-away.
        expect(
          m1Original.awayTeam.providerTeamId,
          `[T037 / conflict] Sanity guard: M1's pre-mutation awayTeam.providerTeamId MUST be '${M1_AWAY_TEAM_PROVIDER_ID_BEFORE}'.`,
        ).toBe(M1_AWAY_TEAM_PROVIDER_ID_BEFORE);

        // Capture the wall-clock instant before triggering the sync so
        // the match_pending_review query can filter out any stale rows
        // produced by sibling tests in the same worker.
        const triggerInstant = new Date();

        try {
          // --------------------------------------------------------------
          // Step 1 — mutate the stub fixture: swap M1's away team from
          // MEX to BRA. Every other row is left untouched (per-row
          // anomaly per Clarifications 2026-05-15 Q2).
          // --------------------------------------------------------------
          const conflictRow: StubFixtureRow = {
            ...m1Original,
            awayTeam: {
              ...m1Original.awayTeam,
              providerTeamId: M1_AWAY_TEAM_PROVIDER_ID_CONFLICT,
              name: "Brazil",
              shortCode: "BRA",
            },
          };

          const mutated: StubSnapshot = {
            ...originalSnapshot,
            matches: originalSnapshot.matches.map((m, i) =>
              i === m1Index ? conflictRow : m,
            ),
          };

          await writeFile(
            STUB_SNAPSHOT_PATH,
            JSON.stringify(mutated, null, 2) +
              (originalSnapshotRaw.endsWith("\n") ? "\n" : ""),
            "utf-8",
          );

          // --------------------------------------------------------------
          // Step 2 — trigger the sync.
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

          const triggerBody = await triggerResponse
            .text()
            .catch(() => "<unreadable body>");

          // --------------------------------------------------------------
          // Step 3 — reload `/matches` and assert M1 is UNCHANGED.
          // The away team MUST still be Mexico; Brazil MAY still appear
          // on the page (it has its own fixture rows, e.g. M5 ESP-BRA),
          // so we cannot assert Brazil's absence. The unambiguous proof
          // that M1 was not mutated is that Mexico is still rendered.
          // --------------------------------------------------------------
          await page.goto("/matches");
          await expect(
            page.getByRole("heading", { level: 1, name: /matches/i }),
          ).toBeVisible();
          await expect(
            page.getByText("Argentina"),
            "Post-conflict-sync expects M1's home team (Argentina) to STILL be rendered — " +
              "the catalog MUST NOT auto-apply a per-row conflict (Clarifications 2026-05-15 Q2).",
          ).toBeVisible();
          await expect(
            page.getByText("Mexico"),
            "Post-conflict-sync expects M1's away team to STILL be Mexico — " +
              `the catalog MUST NOT propagate the swap to Brazil. Trigger response was: ${triggerBody}`,
          ).toBeVisible();

          // --------------------------------------------------------------
          // Step 4 — query match_pending_review via service-role. There
          // MUST be at least one unresolved row keyed by provider='stub'
          // and provider_external_id='stub-match-1', detected after the
          // trigger.
          // --------------------------------------------------------------
          const client = getServiceClient();
          const { data: quarantineRows, error: quarantineErr } = await client
            .from("match_pending_review")
            .select(
              "id, provider, provider_external_id, conflict_class, resolution, detected_at",
            )
            .eq("provider", "stub")
            .eq("provider_external_id", M1_PROVIDER_MATCH_ID)
            .gte("detected_at", triggerInstant.toISOString())
            .order("detected_at", { ascending: false });

          // Tolerate the table briefly not existing (T040 not shipped yet
          // would surface as a "relation does not exist" or RLS error) by
          // failing with the full message rather than throwing — the
          // canonical RED state belongs to the assertion below.
          expect(
            quarantineErr,
            "service-role SELECT on match_pending_review MUST NOT error " +
              `(got: ${quarantineErr ? quarantineErr.message : "ok"}). ` +
              `Trigger response was: ${triggerBody}.`,
          ).toBeNull();
          expect(
            (quarantineRows ?? []).length,
            "match_pending_review MUST contain at least one row for " +
              `provider='stub' / provider_external_id='${M1_PROVIDER_MATCH_ID}' detected after the trigger ` +
              "(Clarifications 2026-05-15 Q2 — per-row team-assignment conflict).",
          ).toBeGreaterThanOrEqual(1);

          // The quarantined row MUST be unresolved (NULL resolution).
          const fresh = (quarantineRows ?? []).find(
            (r) => r.resolution === null,
          );
          expect(
            fresh,
            "At least one match_pending_review row for M1 MUST have resolution=NULL " +
              "(the sync coordinator never auto-resolves — Slice 006 owns resolution).",
          ).toBeDefined();
        } finally {
          // Restore the fixture byte-identically.
          await writeFile(STUB_SNAPSHOT_PATH, originalSnapshotRaw, "utf-8");
        }
      },
    );
  },
);
