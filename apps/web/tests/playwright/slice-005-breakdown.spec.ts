// --------------------------------------------------------------------------
// Slice 005 / T034 — US4 Personal Breakdown Playwright spec (RED).
// --------------------------------------------------------------------------
// RED acceptance tests for User Story 4 (P2) — the per-participant personal
// breakdown that decomposes a participant's points into one row per finished
// match + one row per scored final-prediction item (with `final_pending` for
// items whose `tournament_award.*_status='pending'`). The breakdown is the
// transparency surface that backs the leaderboard's total_points value
// (SC-002 — "sum of breakdown rows equals leaderboard total").
//
// Source of truth:
//   - specs/005-scoring-leaderboard/spec.md § US4 (Acceptance Scenarios 1-3)
//     and § SC-002 ("a participant who scored exactly 10 + 5 + 0 in three
//     matches plus one correct final pick has a total of exactly 35 in their
//     breakdown") and § SC-004 (loads in under 3 seconds — not asserted here
//     because performance is owned by T041 final regression).
//   - specs/005-scoring-leaderboard/contracts/personal-breakdown.read.md
//     § Access, § Response (one row per scored target), § Consistency with
//     the leaderboard (sum-equals-total invariant).
//   - supabase/seed/slice-005-fixture.sql — the hand-verified per-participant
//     truth table at the bottom of the file is the canonical source for every
//     numeric assertion + reason_code in tests 1, 2, and 3.
//   - apps/web/tests/playwright/slice-005-leaderboard.spec.ts (T022) — pattern
//     reference for X-Internal-Auth bypass, scope='match' + scope='finals'
//     sequential workaround, OIDC sign-in, and service-role cleanup.
//   - apps/web/tests/playwright/slice-005-final-scoring.spec.ts (T017) —
//     pattern reference for finals scoring invocation + final_pending row
//     shape (points=0 / reason_code='final_pending' / official=NULL).
//   - .specify/memory/constitution.md § Principle IX (BDD: every Then-clause
//     MUST be a checkable assertion — exact numeric / enum / boolean values,
//     no "should be reasonable", no ranges).
//
// Fixture truth table for ALPHA (slice-005-fixture.sql bottom):
//   Match rows (calculation_version=1):
//     M1 ARG vs MEX (official 2-1)   alpha pred 2-1  → 10 / 'exact'
//     M2 ESP vs BRA (official 0-0)   alpha pred 0-0  → 10 / 'exact'
//     M3 CAN vs USA (official 1-2)   alpha pred 1-2  → 10 / 'exact'
//   Final rows (calculation_version=1):
//     champion        alpha pick ARG     official ARG (confirmed)  → 20 / 'final_correct'
//     runner_up       alpha pick ESP     official ESP (confirmed)  → 20 / 'final_correct'
//     top_scorer      alpha pick Messi   official Messi (confirmed)→ 20 / 'final_correct'
//     best_player     alpha pick Pedri   official NULL (pending)   →  0 / 'final_pending'
//   Match subtotal = 30, Final subtotal = 60, Grand total = 90 (matches T029
//   leaderboard fixture row alpha=90/exact=3/outcome=0/final=60).
//
// Fixture truth table for BRAVO (used by Test 4 RLS isolation):
//   Match rows:
//     M1 (off 2-1)  bravo pred 2-1  → 10 / 'exact'
//     M2 (off 0-0)  bravo pred 1-1  →  5 / 'outcome' (draw)
//     M3 (off 1-2)  bravo pred 0-1  →  5 / 'outcome' (away win)
//   Final rows (combining slice 004 actives + slice 005 T008 actives):
//     champion    bravo pick BRA       → 0  / 'final_incorrect' (official ARG)
//     runner_up   bravo pick ESP       → 20 / 'final_correct'
//     top_scorer  bravo pick Vinícius  → 0  / 'final_incorrect' (official Messi)
//     best_player no active pick — score_finals MAY emit a 'none'-reason row
//                 or skip the row entirely. Test 4 only asserts on bravo's
//                 isolation from alpha's rows, NOT on the exact bravo row
//                 count, so either implementation choice is compatible.
//   Bravo total = 40 (per fixture truth table).
//
// Scenarios covered (all tagged @slice-005 @us4):
//   1. AS1 row-per-finished-match  — 3 match rows for alpha, each
//      predicted/official/points/reason_code per fixture truth table.
//   2. AS2 row-per-final-item      — 4 final rows for alpha (3 confirmed +
//      1 pending). The pending row MUST render with official_display=NULL
//      (or empty) + a "scoring pending" indicator.
//   3. AS3 sum-equals-leaderboard  — alpha's breakdown footer sum AND the
//      sum of per-row points cells BOTH equal alpha's /leaderboard
//      total_points cell (90). This is the load-bearing SC-002 invariant.
//   4. RLS cross-participant isolation — signed in as bravo, the page MUST
//      render ONLY bravo's rows (no alpha participant_id leakage in the
//      DOM). Attempting `?as_participant=<alpha-uuid>` URL manipulation
//      MUST be silently ignored — the underlying personal_breakdown_v
//      RLS only returns bravo's rows regardless of query params.
//
// DOM selector contract (T036 MUST honor):
//   * `[data-testid="breakdown-page"]`              — root element on /me/breakdown
//   * `[data-testid="breakdown-row"]`               — each row (match or final)
//   * `data-target-kind="match" | "final"`          — row kind attribute
//   * `data-participant-id="<uuid>"`                — row's owner participant id
//   * `[data-field="predicted_display"]`            — predicted score / pick
//   * `[data-field="official_display"]`             — official score / award winner
//   * `[data-field="points"]`                       — integer points
//   * `[data-field="reason_code"]`                  — enum string
//   * `[data-field="target_label"]`                 — human-readable label
//   * `[data-testid="breakdown-footer-sum"]`        — footer total cell
//   * `[data-testid="breakdown-empty"]`             — empty-state placeholder
//   * `[data-testid="final-pending-indicator"]`     — "scoring pending" cue
//                                                     on the final_pending row
//
// Score-trigger invocation pattern (mirrors T022):
//   T015 ships scope='match' (200) and scope='finals' (200). Until T037
//   ships scope='all', the "everything is scored at the latest
//   calculation_version" precondition is approximated by a sequential loop:
//   scope='match' for each of M1/M2/M3 followed by scope='finals' once.
//   When T037 lands, this can collapse to a single scope='all' POST without
//   changing any assertions. Auth uses the X-Internal-Auth bypass header
//   from T015 D-025 option B — these tests for breakdown reads SIGN IN as
//   a participant separately so the GET /me/breakdown flow runs through
//   the participant JWT path (RLS-gated per personal-breakdown.read.md
//   § Access).
//
// Cleanup contract:
//   * Every test captures `testStartInstant` BEFORE its first sync call and
//     uses the service-role client to DELETE score_records +
//     score_calculation_runs rows created at-or-after that instant in
//     afterEach. Audit_log rows are LEFT in place — they are append-only by
//     Slice 007's contract and the next test's `since` filter excludes them.
//   * No test in this file mutates tournament_award (the best_player slot
//     stays 'pending' so the final_pending assertion in Test 2 is exercised
//     by the fixture-default award).
//   * resetStub() is called in beforeEach + afterEach so the OIDC stub
//     never carries a stale claim payload across tests.
//
// RED-by-design until:
//   * T035 ships `public.personal_breakdown_v` at migration slot 0054b (D-023
//     vs spec slot 0055b — on-disk file is 0054b). Until then, the page can't
//     render rows and every Test 1/2/3/4 row-count assertion fails.
//   * T036 ships the Next.js `/me/breakdown` server component + lib that
//     reads personal_breakdown_v via the participant JWT. Until then, the
//     navigation either 404s or renders a "missing route" page → tests fail
//     at the row-count or footer-sum assertion.
//   The failure mode is always assertion-level, never infrastructure-error.
//
// Constitution Principle IX:
//   Every Then-clause asserts an exact numeric value, an exact UUID, or an
//   exact enum string. No "should be reasonable", no "approximately", no
//   ranges except where explicitly bounded by the spec (e.g. positive
//   integer for calculation_version monotonicity, not asserted here).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Fixture-derived constants. ALL UUIDs and numeric values are anchored to
// supabase/seed/slice-001-fixture.sql + supabase/seed/slice-005-fixture.sql
// and MUST stay in sync if those fixtures are ever edited.
// --------------------------------------------------------------------------

// participants UUIDs (slice 001 + slice 005 fixtures).
const PARTICIPANTS = {
  alpha: "11111111-1111-1111-1111-111111111111",
  bravo: "22222222-2222-2222-2222-222222222222",
  charlie: "33333333-3333-3333-3333-333333333333",
  delta: "44444444-4444-4444-4444-444444444444",
  epsilon: "55555555-5555-5555-5555-555555555555",
  zeta: "66666666-6666-6666-6666-666666666666",
} as const;

// auth.users `sub` values per slice 001 fixture.
const ALPHA_IDENTITY = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const BRAVO_IDENTITY = {
  sub: "00000000-0000-0000-0000-00000000000b",
  email: "bravo@nortal.com",
  email_verified: true,
  name: "Bravo Tester",
} as const;

// matches UUIDs from § 3 of slice-005-fixture.sql.
const M1 = "eeee0050-0000-0000-0000-000000000001"; // ARG vs MEX 2-1
const M2 = "eeee0050-0000-0000-0000-000000000002"; // ESP vs BRA 0-0
const M3 = "eeee0050-0000-0000-0000-000000000003"; // CAN vs USA 1-2

// All finished match UUIDs in the slice-005 fixture. M4 is unfinished and
// produces no score_records on the score-trigger scope='match' path — and
// therefore MUST NOT contribute a row to personal_breakdown_v (the view only
// emits rows for FINISHED matches per the contract § Response).
const FINISHED_MATCHES = [M1, M2, M3] as const;

const SCORE_TRIGGER_ENDPOINT =
  (process.env.SUPABASE_FUNCTIONS_BASE_URL ??
    "http://localhost:54321/functions/v1") + "/score-trigger";

const INTERNAL_AUTH_SECRET =
  process.env.SCORE_TRIGGER_INTERNAL_AUTH_SECRET ?? "";

// Supabase Edge Runtime gateway requires `Authorization: Bearer <jwt>` to
// reach ANY /functions/v1/* path. Even when the function itself uses the
// X-Internal-Auth bypass for authorization, the gateway must be satisfied
// first. The anon key is sufficient — it's a valid JWT and the gateway
// does not inspect its role.
const SUPABASE_ANON_KEY_FOR_GATEWAY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

// --------------------------------------------------------------------------
// Local contract types — mirror scoring-trigger.edge-fn.md +
// personal-breakdown.read.md WITHOUT importing any app code so the spec
// stays decoupled from server refactors.
// --------------------------------------------------------------------------

interface ScoreTriggerRequest {
  scope: "match" | "finals" | "all";
  target_id?: string;
  reason: string;
  run_id?: string;
}

interface ScoreTriggerResponse {
  run_id: string;
  scope: "match" | "finals" | "all";
  target_id: string | null;
  calculation_version_written: number;
  affected_record_count: number;
  started_at: string;
  completed_at: string;
  notes: string | null;
  status: "succeeded";
}

/**
 * BreakdownRow — DOM projection mirroring personal-breakdown.read.md
 * § Response. `points` is an integer; `reason_code` is one of the
 * documented enum strings; `official_display` may be `null` for
 * `final_pending` rows per the contract.
 */
interface BreakdownRowDom {
  target_kind: "match" | "final" | string;
  /** Slice 005 follow-up #6 — present on every row via the page's data-target-id attribute. */
  target_id: string;
  participant_id: string;
  predicted_display: string;
  official_display: string | null;
  points: number;
  reason_code: string;
  target_label: string;
  has_pending_indicator: boolean;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * POSTs to /functions/v1/score-trigger using the T015 X-Internal-Auth bypass
 * header (D-025 option B). Returns status + raw body + parsed JSON. Mirrors
 * the T022 callScoreTrigger helper byte-for-byte so cross-file refactors
 * stay trivial.
 */
async function callScoreTrigger(
  request: import("@playwright/test").APIRequestContext,
  body: ScoreTriggerRequest,
): Promise<{
  status: number;
  rawBody: string;
  parsed: ScoreTriggerResponse | null;
}> {
  const response = await request.post(SCORE_TRIGGER_ENDPOINT, {
    headers: {
      "Content-Type": "application/json",
      // Gateway gate — anon key is enough; the role doesn't matter here.
      ...(SUPABASE_ANON_KEY_FOR_GATEWAY
        ? { Authorization: `Bearer ${SUPABASE_ANON_KEY_FOR_GATEWAY}` }
        : {}),
      // Function-level auth — the bypass that puts authPath='internal'.
      "X-Internal-Auth": INTERNAL_AUTH_SECRET,
    },
    data: body,
  });
  const rawBody = await response.text().catch(() => "<unreadable body>");
  let parsed: ScoreTriggerResponse | null = null;
  try {
    parsed = JSON.parse(rawBody) as ScoreTriggerResponse;
  } catch {
    parsed = null;
  }
  return { status: response.status(), rawBody, parsed };
}

/**
 * Drives a full-tournament scoring pass via a SINGLE scope='all' call.
 *
 * History (2026-05-23): originally a sequential workaround that fired
 * scope='match' for each of M1/M2/M3 followed by scope='finals' once.
 * The slice 005 author noted in the spec docstring that "When T037 lands,
 * the loop can collapse to a single scope='all' POST without changing
 * the assertions" — T037 (migration slot 0058 score_all_fn) HAS shipped,
 * so the collapse happens here.
 *
 * Why the collapse is load-bearing for this test: leaderboard_v and
 * personal_breakdown_v filter score_records at the CURRENT
 * tournament_config.current_calculation_version. Each separate SP call
 * bumps that pointer (per the slice 005 design — each run is a distinct
 * version). The sequential loop wrote M1@v=2, M2@v=3, M3@v=4, finals@v=5
 * — and the view filtering at v=5 saw ONLY the finals records. A single
 * scope='all' call writes every row at the same v_target_version so the
 * view sees everything at the latest pointer.
 *
 * See specs/005-scoring-leaderboard/follow-up-current-calculation-version-off-by-one.md
 * for the underlying SP fix (migration 0080) that prerequires this.
 *
 * Returns the `calculation_version_written` from the call.
 */
async function runFullScoringSequence(
  request: import("@playwright/test").APIRequestContext,
  reasonTag: string,
): Promise<number> {
  const r = await callScoreTrigger(request, {
    scope: "all",
    reason: `${reasonTag} — scope='all'`,
    run_id: crypto.randomUUID(),
  });
  expect(
    r.status,
    `score-trigger scope='all' MUST return 200. Got body: ${r.rawBody}`,
  ).toBe(200);
  expect(
    r.parsed?.calculation_version_written,
    `score-trigger scope='all' response MUST include calculation_version_written. Got body: ${r.rawBody}`,
  ).toBeGreaterThan(0);
  return r.parsed!.calculation_version_written;
}

/**
 * Service-role: delete every score_records + score_calculation_runs row
 * created at-or-after `since`. Idempotent. Audit_log is NOT touched
 * (append-only by Slice 007's contract).
 */
async function purgeScoringRowsSince(since: Date): Promise<void> {
  const client = getServiceClient();
  const sinceIso = since.toISOString();
  const { error: srErr } = await client
    .from("score_records")
    .delete()
    .gte("calculated_at", sinceIso);
  if (srErr) {
    throw new Error(`purgeScoringRowsSince score_records: ${srErr.message}`);
  }
  const { error: runsErr } = await client
    .from("score_calculation_runs")
    .delete()
    .gte("started_at", sinceIso);
  if (runsErr) {
    throw new Error(
      `purgeScoringRowsSince score_calculation_runs: ${runsErr.message}`,
    );
  }
}

/**
 * Reads the rendered breakdown rows from the /me/breakdown page DOM. Each
 * row exposes its kind via `data-target-kind`, its owner via
 * `data-participant-id`, and per-column cells via `data-field="<column>"`.
 *
 * Returns rows in DOM order (which the contract specifies is sorted by
 * target_kind ASC, target_label ASC). Callers filter by target_kind for
 * the per-row assertions in Tests 1 and 2.
 */
async function readBreakdownRows(
  page: import("@playwright/test").Page,
): Promise<BreakdownRowDom[]> {
  return page.$$eval(
    '[data-testid="breakdown-row"]',
    (rows: Element[]) =>
      rows.map((row) => {
        const get = (field: string): string => {
          const el = row.querySelector(`[data-field="${field}"]`);
          return (el?.textContent ?? "").trim();
        };
        const officialRaw = (() => {
          const el = row.querySelector('[data-field="official_display"]');
          if (!el) return null;
          // Treat empty / dash-only cells as null per contract: final_pending
          // rows have official_display=null which the UI MAY render as "" or
          // "—" / "-". Any of those forms collapse to null here so the Test 2
          // assertion is robust to the UI's pending-cell rendering choice.
          const text = (el.textContent ?? "").trim();
          if (text === "" || text === "—" || text === "-") return null;
          return text;
        })();
        return {
          target_kind: row.getAttribute("data-target-kind") ?? "",
          target_id: row.getAttribute("data-target-id") ?? "",
          participant_id:
            row.getAttribute("data-participant-id") ?? "",
          predicted_display: get("predicted_display"),
          official_display: officialRaw,
          points: Number.parseInt(get("points"), 10),
          reason_code: get("reason_code"),
          target_label: get("target_label"),
          has_pending_indicator:
            row.querySelector('[data-testid="final-pending-indicator"]') !==
            null,
        };
      }),
  );
}

/**
 * Reads alpha's `total_points` cell from the /leaderboard page. Used by
 * Test 3 to assert the SC-002 invariant: breakdown sum === leaderboard
 * total. Mirrors the T022 readLeaderboardDom selector contract but
 * narrows to a single participant for this test.
 */
async function readLeaderboardTotalFor(
  page: import("@playwright/test").Page,
  participantId: string,
): Promise<number> {
  return page.$eval(
    `[data-testid="leaderboard-row"][data-participant-id="${participantId}"] [data-field="total_points"]`,
    (el) => Number.parseInt((el.textContent ?? "").trim(), 10),
  );
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US4 — Personal Breakdown @slice-005 @us4", () => {
  // Run serially within the file. fullyParallel: true at the
  // playwright.config.ts level would otherwise spawn one worker per test,
  // and all four tests call scope='all' against the shared local
  // database — racing on tournament_config.current_calculation_version
  // and tripping score_records_uk on the concurrent INSERTs.
  // (Added 2026-05-23 after the slice 005 follow-up SP fix landed.)
  test.describe.configure({ mode: "serial" });

  // Breakdown rendering + scoring round-trips take a bit longer than the
  // default Playwright budget; mirror the T022 budget for parity.
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  // Per-test wall-clock instant captured in beforeEach so afterEach can purge
  // ONLY rows created by this test.
  let testStartInstant: Date;

  test.beforeEach(async () => {
    await resetStub();
    testStartInstant = new Date();
  });

  test.afterEach(async () => {
    await purgeScoringRowsSince(testStartInstant);
    await resetStub();
  });

  // ----------------------------------------------------------------------
  // Test 1 — Row per finished match (3 rows) for alpha (AS1).
  // ----------------------------------------------------------------------
  // Drives the full fixture through the score-trigger sequential workaround,
  // then signs in as alpha and asserts the /me/breakdown DOM exposes
  // exactly 3 rows with target_kind='match'. Each row's predicted_display,
  // official_display, points, and reason_code MUST match the fixture truth
  // table (alpha is exact on M1/M2/M3 → all 3 rows = 10 / 'exact').
  test(
    "AS1 — Given the slice-005 fixture is fully scored, When alpha views /me/breakdown, Then exactly 3 rows MUST render with target_kind='match' AND each MUST report predicted/official scores + points=10 + reason_code='exact' per fixture truth table @slice-005 @us4",
    async ({ page, request }) => {
      await runFullScoringSequence(request, "T034 Test 1");

      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA_IDENTITY.sub,
          email: ALPHA_IDENTITY.email,
          email_verified: ALPHA_IDENTITY.email_verified,
          name: ALPHA_IDENTITY.name,
        },
      });
      await page.goto("/me/breakdown");
      await page.waitForSelector('[data-testid="breakdown-page"]', {
        timeout: 10_000,
      });
      await page.waitForSelector('[data-testid="breakdown-row"]', {
        timeout: 10_000,
      });

      const allRows = await readBreakdownRows(page);
      // personal_breakdown_v's match_rows CTE does `caller CROSS JOIN matches
      // WHERE m.status = 'finished'` — it yields one row per finished match
      // in the ENTIRE DB, regardless of source slice. The slice-002 fixture
      // also seeds a finished match (bbbb0000-0000-0000-0000-000000000001)
      // that alpha never predicted; the contract surfaces that as a
      // points=0 / reason_code='none' / predicted_display='' row (the view's
      // documented no-prediction baseline). The slice 005 truth table is
      // about M1/M2/M3 specifically, so we filter to those UUIDs before
      // asserting on count and per-row shape.
      //
      // See specs/005-scoring-leaderboard/follow-up-breakdown-test-foreign-finished-match.md.
      const SLICE_005_MATCH_IDS = new Set<string>([M1, M2, M3]);
      const matchRows = allRows.filter(
        (r) =>
          r.target_kind === "match" && SLICE_005_MATCH_IDS.has(r.target_id),
      );

      expect(
        matchRows.length,
        "alpha's breakdown MUST contain exactly 3 rows with target_kind='match' for slice-005's M1/M2/M3 (other slices' finished matches are filtered out by SLICE_005_MATCH_IDS)",
      ).toBe(3);

      // Every match row MUST belong to alpha (RLS invariant).
      for (const row of matchRows) {
        expect(
          row.participant_id,
          "every match row's data-participant-id MUST equal alpha's UUID — RLS invariant per personal-breakdown.read.md § Access",
        ).toBe(PARTICIPANTS.alpha);
      }

      // Per fixture truth table: alpha is exact on M1/M2/M3. The fixture
      // does not pin which row appears first in DOM order — the contract
      // says target_label.asc, but the exact label format is "<H> vs <A> ·
      // <Stage>", which the seed comment block does not pre-canonicalise.
      // We therefore assert on EVERY match row that points=10 +
      // reason_code='exact' + predicted_display === official_display
      // (alpha is exact, so the two columns are identical strings).
      for (const row of matchRows) {
        expect(
          row.points,
          `alpha's match row (label='${row.target_label}') MUST award 10 points (fixture: alpha exact on all 3 finished matches)`,
        ).toBe(10);
        expect(
          row.reason_code,
          `alpha's match row (label='${row.target_label}') MUST have reason_code='exact' per fixture truth table`,
        ).toBe("exact");
        expect(
          row.predicted_display.length,
          `alpha's match row (label='${row.target_label}') MUST have a non-empty predicted_display per contract § Response`,
        ).toBeGreaterThan(0);
        expect(
          row.official_display,
          `alpha's match row (label='${row.target_label}') MUST have a non-null official_display (every match is finished)`,
        ).not.toBeNull();
        expect(
          row.predicted_display,
          `alpha is exact on '${row.target_label}' — predicted_display MUST equal official_display ('${row.predicted_display}' vs '${row.official_display}')`,
        ).toBe(row.official_display);
      }

      // Sanity: the per-row points sum to alpha's match subtotal of 30.
      const matchSubtotal = matchRows.reduce((acc, r) => acc + r.points, 0);
      expect(
        matchSubtotal,
        "sum of alpha's match-row points MUST equal exactly 30 (3 × 10 exact)",
      ).toBe(30);
    },
  );

  // ----------------------------------------------------------------------
  // Test 2 — Row per final item (4 rows: 3 confirmed correct + 1 pending).
  // ----------------------------------------------------------------------
  // Per fixture: alpha picks champion=ARG (confirmed → 20), runner_up=ESP
  // (confirmed → 20), top_scorer=Messi (confirmed → 20), best_player=Pedri
  // (PENDING — tournament_award.best_player_status='pending' → 0 /
  // 'final_pending'). The pending row MUST render with official_display
  // NULL/empty + the 'final-pending-indicator' visual cue per
  // personal-breakdown.read.md § Response ("UI can show 'scoring pending'
  // rather than implying 0").
  test(
    "AS2 — Given alpha's 4 final picks (3 confirmed correct + 1 pending), When alpha views /me/breakdown, Then exactly 4 rows MUST render with target_kind='final': 3 with points=20/'final_correct' AND 1 with points=0/'final_pending'/official_display=NULL/pending-indicator visible @slice-005 @us4",
    async ({ page, request }) => {
      await runFullScoringSequence(request, "T034 Test 2");

      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA_IDENTITY.sub,
          email: ALPHA_IDENTITY.email,
          email_verified: ALPHA_IDENTITY.email_verified,
          name: ALPHA_IDENTITY.name,
        },
      });
      await page.goto("/me/breakdown");
      await page.waitForSelector('[data-testid="breakdown-page"]', {
        timeout: 10_000,
      });
      await page.waitForSelector('[data-testid="breakdown-row"]', {
        timeout: 10_000,
      });

      const allRows = await readBreakdownRows(page);
      const finalRows = allRows.filter((r) => r.target_kind === "final");

      expect(
        finalRows.length,
        "alpha's breakdown MUST contain exactly 4 rows with target_kind='final' (one per final-prediction item: champion, runner_up, top_scorer, best_player)",
      ).toBe(4);

      // Every final row MUST belong to alpha (RLS invariant).
      for (const row of finalRows) {
        expect(
          row.participant_id,
          "every final row's data-participant-id MUST equal alpha's UUID — RLS invariant per personal-breakdown.read.md § Access",
        ).toBe(PARTICIPANTS.alpha);
      }

      // Partition: 3 confirmed-correct rows + 1 pending row.
      const correctRows = finalRows.filter(
        (r) => r.reason_code === "final_correct",
      );
      const pendingRows = finalRows.filter(
        (r) => r.reason_code === "final_pending",
      );

      expect(
        correctRows.length,
        "alpha MUST have exactly 3 final rows with reason_code='final_correct' (champion, runner_up, top_scorer all confirmed correct per fixture)",
      ).toBe(3);
      expect(
        pendingRows.length,
        "alpha MUST have exactly 1 final row with reason_code='final_pending' (best_player slot, tournament_award.best_player_status='pending')",
      ).toBe(1);

      // Each confirmed-correct row MUST award exactly 20 points.
      for (const row of correctRows) {
        expect(
          row.points,
          `alpha's final-correct row '${row.target_label}' MUST award exactly 20 points per fixture (FR-002 + slice-005 truth table)`,
        ).toBe(20);
        expect(
          row.official_display,
          `alpha's final-correct row '${row.target_label}' MUST have a non-null official_display (status='confirmed')`,
        ).not.toBeNull();
        expect(
          row.predicted_display.length,
          `alpha's final-correct row '${row.target_label}' MUST have a non-empty predicted_display per contract § Response`,
        ).toBeGreaterThan(0);
      }

      // The pending row MUST award 0 / official=NULL + render the
      // pending visual indicator per personal-breakdown.read.md § Response.
      const pending = pendingRows[0];
      expect(
        pending.points,
        "alpha's final_pending row MUST award 0 points (R-008 / personal-breakdown.read.md: pending → 0)",
      ).toBe(0);
      expect(
        pending.official_display,
        "alpha's final_pending row MUST have official_display=null (rendered as empty or dash) — personal-breakdown.read.md § Response: 'official_display=null if final_pending'",
      ).toBeNull();
      expect(
        pending.has_pending_indicator,
        "alpha's final_pending row MUST render a [data-testid='final-pending-indicator'] visual cue so the UI shows 'scoring pending' rather than implying 0 (personal-breakdown.read.md § Response)",
      ).toBe(true);

      // Sanity: the per-row points sum to alpha's final subtotal of 60.
      const finalSubtotal = finalRows.reduce((acc, r) => acc + r.points, 0);
      expect(
        finalSubtotal,
        "sum of alpha's final-row points MUST equal exactly 60 (3 × 20 correct + 1 × 0 pending)",
      ).toBe(60);
    },
  );

  // ----------------------------------------------------------------------
  // Test 3 — Sum of breakdown rows equals leaderboard total (SC-002, AS3).
  // ----------------------------------------------------------------------
  // Load-bearing invariant: for any given calculation_version, the sum of
  // a participant's `points` across all rows in personal_breakdown_v MUST
  // equal their `total_points` in leaderboard_v. Per fixture, alpha = 90
  // (30 match + 60 final). This is the canonical SC-002 assertion shape.
  test(
    "AS3 / SC-002 — Given the slice-005 fixture is fully scored, When alpha sums all 7 breakdown rows (3 match + 4 final) AND reads /leaderboard, Then SUM(breakdown.points)=90 AND leaderboard.total_points=90 AND the two MUST be exactly equal (personal-breakdown.read.md § Consistency with the leaderboard) @slice-005 @us4",
    async ({ page, request }) => {
      await runFullScoringSequence(request, "T034 Test 3");

      await signInWithIdentity(page, {
        claims: {
          sub: ALPHA_IDENTITY.sub,
          email: ALPHA_IDENTITY.email,
          email_verified: ALPHA_IDENTITY.email_verified,
          name: ALPHA_IDENTITY.name,
        },
      });

      // Step 1 — read /me/breakdown and sum the points cells.
      await page.goto("/me/breakdown");
      await page.waitForSelector('[data-testid="breakdown-page"]', {
        timeout: 10_000,
      });
      await page.waitForSelector('[data-testid="breakdown-row"]', {
        timeout: 10_000,
      });

      const allRows = await readBreakdownRows(page);

      // Filter to slice-005's surfaces. Match rows from other slices'
      // fixtures (e.g., slice-002's bbbb0000-...001) appear in the view
      // by design — see specs/005-scoring-leaderboard/follow-up-breakdown-test-foreign-finished-match.md.
      // Final rows are not subject to the same CROSS JOIN, so no UUID filter
      // is needed on them.
      const SLICE_005_MATCH_IDS_AS3 = new Set<string>([M1, M2, M3]);
      const slice005Rows = allRows.filter(
        (r) =>
          r.target_kind === "final" ||
          (r.target_kind === "match" &&
            SLICE_005_MATCH_IDS_AS3.has(r.target_id)),
      );

      expect(
        slice005Rows.length,
        "alpha's slice-005 breakdown rows MUST be exactly 7 (3 slice-005 match + 4 final) per fixture truth table; other slices' finished matches are filtered out",
      ).toBe(7);

      const breakdownSum = slice005Rows.reduce((acc, r) => acc + r.points, 0);
      expect(
        breakdownSum,
        "SUM(slice-005 breakdown.points) for alpha MUST equal exactly 90 per fixture truth table (30 match + 60 final)",
      ).toBe(90);

      // If the page renders a footer-sum cell, it MUST report the same value
      // as the row sum. Absence of the footer is tolerated (some renderings
      // may omit it) — the row-sum equality above is the load-bearing assertion.
      const footerHandle = await page.$('[data-testid="breakdown-footer-sum"]');
      if (footerHandle !== null) {
        const footerText = (await footerHandle.textContent()) ?? "";
        const footerNumber = Number.parseInt(footerText.trim(), 10);
        expect(
          Number.isNaN(footerNumber),
          `breakdown-footer-sum text '${footerText.trim()}' MUST parse as an integer when present`,
        ).toBe(false);
        expect(
          footerNumber,
          "breakdown-footer-sum, when rendered, MUST equal the sum of the row points cells (90)",
        ).toBe(90);
      }

      // Step 2 — navigate to /leaderboard and read alpha's total_points cell.
      await page.goto("/leaderboard");
      await page.waitForSelector('[data-testid="leaderboard-row"]', {
        timeout: 10_000,
      });

      const leaderboardTotal = await readLeaderboardTotalFor(
        page,
        PARTICIPANTS.alpha,
      );

      expect(
        leaderboardTotal,
        "alpha's leaderboard total_points cell MUST equal exactly 90 per fixture truth table",
      ).toBe(90);

      // Step 3 — load-bearing SC-002 invariant: the two values MUST be
      // exactly equal at the latest calculation_version.
      expect(
        breakdownSum,
        "SC-002 invariant: SUM(breakdown.points) === leaderboard.total_points for the same participant at the same calculation_version (personal-breakdown.read.md § Consistency with the leaderboard + spec § SC-002)",
      ).toBe(leaderboardTotal);
    },
  );

  // ----------------------------------------------------------------------
  // Test 4 — RLS prevents cross-participant breakdown access.
  // ----------------------------------------------------------------------
  // Per personal-breakdown.read.md § Access: "RLS limits results to
  // participant_id = auth.uid()". This test signs in as bravo and asserts
  // (a) every rendered row's data-participant-id is bravo's UUID and
  // (b) no row's data-participant-id is alpha's UUID. Direct URL
  // manipulation via `?as_participant=<alpha-uuid>` MUST be silently
  // ignored — the underlying view's RLS only returns bravo's rows
  // regardless of any query parameters the client sends.
  test(
    "RLS — Given bravo is signed in, When bravo views /me/breakdown AND /me/breakdown?as_participant=<alpha-uuid>, Then EVERY rendered row MUST have data-participant-id=bravo AND ZERO rows MUST have data-participant-id=alpha (RLS isolation per personal-breakdown.read.md § Access) @slice-005 @us4",
    async ({ page, request }) => {
      await runFullScoringSequence(request, "T034 Test 4");

      await signInWithIdentity(page, {
        claims: {
          sub: BRAVO_IDENTITY.sub,
          email: BRAVO_IDENTITY.email,
          email_verified: BRAVO_IDENTITY.email_verified,
          name: BRAVO_IDENTITY.name,
        },
      });

      // Step 1 — plain /me/breakdown navigation as bravo.
      await page.goto("/me/breakdown");
      await page.waitForSelector('[data-testid="breakdown-page"]', {
        timeout: 10_000,
      });
      // Bravo has at least the 3 finished-match rows + 2 confirmed final
      // rows per fixture (champion=BRA wrong, runner_up=ESP correct,
      // top_scorer=Vinícius wrong; best_player has no active pick so the
      // view MAY or MAY NOT emit a 'none'-reason row — both are compatible
      // with this test's assertion shape). Wait for at least one row.
      await page.waitForSelector('[data-testid="breakdown-row"]', {
        timeout: 10_000,
      });

      const bravoRows = await readBreakdownRows(page);

      expect(
        bravoRows.length,
        "bravo's breakdown MUST render at least one row (3 match + ≥2 final rows per fixture)",
      ).toBeGreaterThan(0);

      // Every single row MUST belong to bravo — the load-bearing RLS
      // invariant. No row MAY surface alpha's participant_id.
      for (const row of bravoRows) {
        expect(
          row.participant_id,
          `every row's data-participant-id MUST equal bravo's UUID. Got '${row.participant_id}' on row '${row.target_label}' — RLS leak per personal-breakdown.read.md § Access`,
        ).toBe(PARTICIPANTS.bravo);
      }

      // Cross-check: no row in the DOM has alpha's participant_id.
      const alphaLeakCount = bravoRows.filter(
        (r) => r.participant_id === PARTICIPANTS.alpha,
      ).length;
      expect(
        alphaLeakCount,
        `ZERO rows in bravo's /me/breakdown DOM may carry data-participant-id='${PARTICIPANTS.alpha}'. Found ${alphaLeakCount} leaking row(s) — RLS contract violation per personal-breakdown.read.md § Access`,
      ).toBe(0);

      // Step 2 — direct URL manipulation: attempt to pass alpha's UUID via
      // a query parameter. The page MUST ignore the param. The underlying
      // RLS-gated view only returns bravo's rows regardless.
      const tamperedUrl = `/me/breakdown?as_participant=${PARTICIPANTS.alpha}`;
      await page.goto(tamperedUrl);
      await page.waitForSelector('[data-testid="breakdown-page"]', {
        timeout: 10_000,
      });
      await page.waitForSelector('[data-testid="breakdown-row"]', {
        timeout: 10_000,
      });

      const tamperedRows = await readBreakdownRows(page);

      expect(
        tamperedRows.length,
        `after ?as_participant manipulation, bravo MUST still see her own rows (≥1). Got ${tamperedRows.length} — the page either erred or hid rows it should have shown`,
      ).toBeGreaterThan(0);

      // Re-assert the RLS invariant on the tampered navigation: every row
      // MUST still be bravo's, and zero rows MUST carry alpha's UUID. The
      // query param MUST have no effect.
      for (const row of tamperedRows) {
        expect(
          row.participant_id,
          `after ?as_participant=${PARTICIPANTS.alpha} tamper, every row's data-participant-id MUST STILL equal bravo's UUID. Got '${row.participant_id}' on row '${row.target_label}' — query param was honored, which is an RLS contract violation`,
        ).toBe(PARTICIPANTS.bravo);
      }

      const alphaLeakAfterTamper = tamperedRows.filter(
        (r) => r.participant_id === PARTICIPANTS.alpha,
      ).length;
      expect(
        alphaLeakAfterTamper,
        `after ?as_participant=${PARTICIPANTS.alpha} tamper, ZERO rows in the DOM may carry alpha's UUID. Found ${alphaLeakAfterTamper} leaking row(s) — server honored the client-supplied participant override, violating personal-breakdown.read.md § Access`,
      ).toBe(0);

      // Optional but informative: the row set under tampering SHOULD be
      // identical to the un-tampered set (same count, same participant_id).
      // We assert on count equality as a load-bearing "no extra rows
      // appeared" check — alpha's 7 rows MUST NOT silently merge into
      // bravo's set.
      expect(
        tamperedRows.length,
        `after tamper, bravo's row count MUST equal her un-tampered row count (${bravoRows.length}). Got ${tamperedRows.length} — the query param leaked rows`,
      ).toBe(bravoRows.length);
    },
  );
});
