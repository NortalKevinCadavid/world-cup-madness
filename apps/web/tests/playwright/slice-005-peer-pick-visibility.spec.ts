// --------------------------------------------------------------------------
// Slice 005 / T023 — US3 Peer-Pick Visibility Playwright spec (RED).
// --------------------------------------------------------------------------
// RED-by-design acceptance tests for FR-016: peer-pick visibility gates on
// lock state for BOTH the match-pick surface (peer_pick_v +
// /api/peer-pick/[match_id]) AND the final-tournament-pick surface
// (peer_final_pick_v + /api/peer-final-pick/[participant_id]).
//
// The gate is in the database (Constitution Principle III, R-010). Tests
// exercise both the UI route handler AND a direct Supabase REST call so a
// participant who attempts to bypass the UI hits the same RLS gate
// (SC-009: "100% of attempts ... rejected at the server boundary").
//
// Source of truth:
//   - specs/005-scoring-leaderboard/spec.md § FR-016, § Edge Cases (lock
//     boundary, direct API attempt, admin-invalidated, finals before first
//     kickoff).
//   - specs/005-scoring-leaderboard/contracts/peer-pick.read.md (entire
//     file — the "Test surface" table at the bottom is the spec for THIS
//     task; Lock-boundary behavior + First-kickoff-boundary behavior tables
//     are the per-test numeric anchors).
//   - specs/005-scoring-leaderboard/research.md § R-010 (the lock predicate
//     `now() >= kickoff_utc - lock_window_minutes` lives in the view, not in
//     app code).
//   - docs/architecture/scoring-model.md § 7.1 (BR-LOCK-003 strict-equality
//     boundary — at exactly kickoff − 60min the match is locked, so peer
//     reads are PERMITTED at the boundary).
//   - apps/web/tests/playwright/slice-003-matches-lock-state-boundary.spec.ts
//     — pattern reference for synthetic match `kickoff_utc` calibration.
//   - apps/web/tests/playwright/slice-004-me-final-predictions-lock-state-at-boundary.spec.ts
//     — pattern reference for mutating tournament_config.first_kickoff_utc
//     + restoring the fixture value byte-identically in afterEach.
//   - apps/web/tests/playwright/slice-003-submit-direct-api-rejected.spec.ts
//     — pattern reference for direct-API rejection assertions on a route
//     handler (this file extends the pattern to the Supabase REST surface).
//   - .specify/memory/constitution.md § Principle IX (BDD: every Then-clause
//     MUST be a checkable assertion — no "should be reasonable" language).
//
// Scenarios covered (all tagged @slice-005 @us3):
//
//   MATCH-PICK (6 tests):
//     1. Pre-lock empty           — synthetic M_TEST kickoff = now + 60:01;
//                                   /api/peer-pick/<M_TEST> → 200 + picks=[].
//     2. At lock boundary         — kickoff = now + 60:00 (strict >=);
//                                   /api/peer-pick/<M_TEST> → 200 + picks
//                                   contains bravo + charlie predictions
//                                   (excludes self per peer_pick_v predicate
//                                   `participant_id <> auth.uid()`).
//     3. Post-lock (kickoff -30m) — kickoff = now + 30:00 minutes;
//                                   /api/peer-pick/<M_TEST> → 200 + picks
//                                   non-empty.
//     4. Direct REST pre-lock     — participant JWT → /rest/v1/peer_pick_v
//                                   pre-lock → empty array (SC-009: RLS at
//                                   the view denies regardless of caller
//                                   bypassing the route handler).
//     5. Direct REST admin JWT    — admin1 pre-lock attempts the same
//                                   /rest/v1/peer_pick_v query. The contract
//                                   § Server-side gate uses
//                                   is_eligible_nortal_participant(...) as
//                                   the only gating predicate beyond the
//                                   lock predicate — admin1 IS an eligible
//                                   Nortal participant, but the lock
//                                   predicate still gates them (the contract
//                                   does NOT carve out an admin bypass on
//                                   peer_pick_v). Test asserts the documented
//                                   "no admin bypass — admin reads through a
//                                   different surface" interpretation: zero
//                                   rows. If the implementation chooses the
//                                   alternative ("admin sees rows pre-lock"),
//                                   this test will fail green-vs-red against
//                                   the contract's "different surface"
//                                   reading; the assertion documents the
//                                   reading T023 is locking in. See D-T023-1
//                                   below.
//     6. Admin-invalidated mask   — predictions has no admin_invalidated
//                                   column today (slice 006 owns admin
//                                   invalidation; T032's view applies the
//                                   masking via a JOIN against the slice-006
//                                   invalidation surface). T023 marks this
//                                   test fixme with a pointer to slice 006
//                                   per D-T023-2 below; the assertion shape
//                                   is encoded so the test goes green once
//                                   slice 006 + T029 + T032 ship together.
//
//   FINAL-PICK (4 tests):
//     7. Before first kickoff     — UPDATE first_kickoff_utc to (now + 1h);
//                                   /api/peer-final-pick/<bravo-uuid> →
//                                   200 + pick=null.
//     8. At first-kickoff boundary — UPDATE first_kickoff_utc to now (strict
//                                   >=); /api/peer-final-pick/<bravo-uuid>
//                                   → 200 + pick.champion_team_id IS NOT
//                                   NULL (bravo's slice-004 champion=BRA pick
//                                   is visible).
//     9. After first kickoff      — UPDATE first_kickoff_utc to (now - 1h);
//                                   /api/peer-final-pick/<bravo-uuid> →
//                                   200 + pick contains bravo's slice-004
//                                   champion (BRA), top_scorer (Vinícius),
//                                   AND bravo's slice-005 runner_up (ESP),
//                                   AND best_player IS NULL (bravo never
//                                   submitted best_player).
//    10. Caller asks about self   — alpha GETs
//                                   /api/peer-final-pick/<alpha-uuid> →
//                                   200 + pick=null (view excludes self per
//                                   the contract § Server-side gate
//                                   `participant_id <> auth.uid()`).
//
// Synthetic match approach (match-pick tests):
//   T023 calibrates M_TEST.kickoff_utc relative to now() per test, NOT the
//   existing slice-002 / slice-005 matches whose kickoffs are fixed in 2026
//   or 2027 and cannot exercise the precise boundary semantics required by
//   FR-016. Each match-pick test inserts a fresh M_TEST row in beforeEach
//   with status='scheduled', kickoff_utc = now() + Δ, plus three predictions
//   (alpha/bravo/charlie) submitted at a baseline 2026-04-01 timestamp so
//   the predictions table is well-populated by the time the lock predicate
//   evaluates. afterEach deletes predictions then deletes the match
//   (predictions FK → matches ON DELETE RESTRICT, so prediction rows MUST
//   be removed first).
//
// Tournament-config snapshot pattern (final-pick tests):
//   Tests 7-10 mutate tournament_config.first_kickoff_utc. beforeEach
//   snapshots the current value; afterEach restores it byte-identically.
//   The slice-004 fixture seeds '"2026-06-16T20:00:00Z"'::jsonb; the
//   snapshot/restore preserves whatever value is present at test start so
//   slice-008's admin UI (when it lands) cannot break this suite.
//
// D-T023-1 — Admin gate posture on peer_pick_v:
//   contracts/peer-pick.read.md § Server-side gate documents the ONLY two
//   predicates inside peer_pick_v's RLS: (a) eligibility and (b) lock
//   predicate. No `is_admin(...) OR lock_passed` carve-out is documented.
//   Test 5 therefore asserts the strict reading: admin1 sees zero rows
//   pre-lock through /rest/v1/peer_pick_v. If T029 chooses the alternative
//   (an `OR is_admin(...)` clause), this assertion will surface that
//   deviation explicitly so the contract gets updated to match — Spec Kit's
//   RED-first model demands the test pin the documented behavior, not the
//   implementer's preference.
//
// D-T023-2 — Admin-invalidated test pending slice 006:
//   The `predictions` table (migration 0030) has NO admin_invalidated /
//   invalidated_at column. The "admin-invalidated → null fields" masking
//   per contract requires either:
//     (a) a slice-006-owned admin_invalidations table that T029's
//         peer_pick_v JOINs against, OR
//     (b) a future ALTER TABLE adding the column to predictions.
//   Neither has shipped. T023 encodes the test body with `test.fixme(true,
//   ...)` and a TODO pointing at slice 006 so the assertion lights up when
//   the invalidation surface ships. The test still authors the full
//   Then-clause shape so it goes green-by-design once the dependency lands.
//
// RED-by-design until T029 + T032 ship:
//   * T029 ships `peer_pick_v` + `peer_final_pick_v` at slot 0054 per D-023.
//   * T032 ships `/api/peer-pick/[match_id]/route.ts` and
//     `/api/peer-final-pick/[participant_id]/route.ts`.
//   Until those land:
//     - Route GETs return 404 (the route file does not exist) → tests fail
//       at `expect(response.status).toBe(200)`.
//     - Direct REST queries return 42P01 (view does not exist) →
//       PostgREST surfaces 404 → tests fail at the rows-length / shape
//       assertions.
//   The failure mode is always assertion-level, never infrastructure-error.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Fixture-derived constants (anchored to slice-001 / slice-004 / slice-005
// fixtures; MUST stay in sync if any are edited).
// --------------------------------------------------------------------------

// auth.users sub values.
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const ADMIN1 = {
  sub: "00000000-0000-0000-0000-0000000000d3",
  email: "admin1@nortal.com",
  email_verified: true,
  name: "Admin One",
} as const;

// participants UUIDs (slice 001 + slice 005 fixtures).
const PARTICIPANTS = {
  alpha: "11111111-1111-1111-1111-111111111111",
  bravo: "22222222-2222-2222-2222-222222222222",
  charlie: "33333333-3333-3333-3333-333333333333",
} as const;

// Slice-005 teams (slice-002 fixture).
const TEAM_ARG = "aaaa0000-0000-0000-0000-000000000001";
const TEAM_MEX = "aaaa0000-0000-0000-0000-000000000002";
const TEAM_BRA = "aaaa0000-0000-0000-0000-000000000006";
const TEAM_ESP = "aaaa0000-0000-0000-0000-000000000005";

// Slice-004 players (slice-004 fixture).
const PLAYER_VINICIUS = "dddd1000-0000-0000-0000-000000000011";

// Synthetic M_TEST UUID. Chosen in the eeee0053-* namespace to avoid
// collision with slice-002 (bbbb0000-*), slice-003 synthetic matches
// (dddd0000-*), and slice-005 fixture matches (eeee0050-*). The same UUID
// is reused across all six match-pick tests (each test's beforeEach
// re-creates the row with its own kickoff_utc; afterEach deletes it).
const M_TEST = "eeee0053-0000-0000-0000-000000000023";

// Predetermined synthetic prediction UUIDs (one per participant) for
// teardown determinism. Pattern:
//   eeee0053-<participant-letter>-0023-0000-000000000000
const PRED_ALPHA = "eeee0053-000a-0023-0000-000000000000";
const PRED_BRAVO = "eeee0053-000b-0023-0000-000000000000";
const PRED_CHARLIE = "eeee0053-000c-0023-0000-000000000000";

// Routes under test.
const PEER_PICK_ROUTE = (matchId: string) => `/api/peer-pick/${matchId}`;
const PEER_FINAL_PICK_ROUTE = (participantId: string) =>
  `/api/peer-final-pick/${participantId}`;

// Supabase env (consumed by direct-REST tests).
const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

// --------------------------------------------------------------------------
// Local contract types — mirror contracts/peer-pick.read.md WITHOUT
// importing any app code so the spec stays decoupled from server refactors.
// --------------------------------------------------------------------------

interface PeerPickRow {
  match_id: string;
  participant_id: string;
  display_name: string;
  predicted_home: number | null;
  predicted_away: number | null;
  submitted_at: string | null;
}

interface PeerPickResponse {
  picks: PeerPickRow[];
}

interface PeerFinalPickRow {
  participant_id: string;
  display_name: string;
  champion_team_id: string | null;
  runner_up_team_id: string | null;
  top_scorer_player_id: string | null;
  best_player_player_id: string | null;
  submitted_at: string | null;
}

interface PeerFinalPickResponse {
  pick: PeerFinalPickRow | null;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Builds a Cookie header value from the page's current cookie jar so
 * `request.get` / `request.post` calls inherit the signed-in Supabase
 * session.
 */
async function buildCookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Extracts the Supabase access-token JWT from the page's localStorage. The
 * Supabase JS client persists the session under a `sb-<project-ref>-auth-token`
 * key as a JSON-encoded array/object containing `access_token`. Used by the
 * direct-REST tests to call /rest/v1/peer_pick_v with a participant-scoped
 * bearer that mimics what a malicious client outside the UI would send.
 *
 * Returns `null` if no Supabase session is present in localStorage (which is
 * itself a failure mode for tests that require sign-in).
 */
async function extractParticipantJwt(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  return page.evaluate(() => {
    const keys = Object.keys(window.localStorage).filter((k) =>
      k.startsWith("sb-"),
    );
    for (const k of keys) {
      const raw = window.localStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        // Two known shapes: (1) { access_token, refresh_token, ... }
        // (2) [access_token, refresh_token, ...] (older supabase-js).
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as { access_token?: unknown }).access_token === "string"
        ) {
          return (parsed as { access_token: string }).access_token;
        }
        if (Array.isArray(parsed) && typeof parsed[0] === "string") {
          return parsed[0];
        }
      } catch {
        // ignore non-JSON entries (PKCE verifier blobs, etc.)
      }
    }
    return null;
  });
}

/**
 * Creates M_TEST in `public.matches` with the given kickoff_utc, plus
 * three predictions (alpha / bravo / charlie). Idempotent — every fixture
 * row uses ON CONFLICT DO NOTHING / pre-delete; the deterministic UUIDs in
 * PRED_ALPHA / PRED_BRAVO / PRED_CHARLIE let the afterEach delete them
 * without scanning.
 *
 * `submittedAtIso` defaults to '2026-04-01T10:00:00Z' (well before any of
 * the synthetic kickoffs this suite uses) so the predictions are unambiguously
 * "valid" and pre-date the lock window the test calibrates.
 */
async function setupSyntheticMatch(
  kickoffUtc: Date,
  submittedAtIso: string = "2026-04-01T10:00:00Z",
): Promise<void> {
  const client = getServiceClient();

  // Belt-and-braces: clear any straggler rows from a prior aborted test.
  await client.from("predictions").delete().eq("match_id", M_TEST);
  await client.from("matches").delete().eq("id", M_TEST);

  const { error: matchErr } = await client.from("matches").insert({
    id: M_TEST,
    home_team_id: TEAM_ARG,
    away_team_id: TEAM_MEX,
    stage: "group",
    group_id: "A",
    kickoff_utc: kickoffUtc.toISOString(),
    status: "scheduled",
    venue: "T023 synthetic",
  });
  if (matchErr) {
    throw new Error(`setupSyntheticMatch matches insert: ${matchErr.message}`);
  }

  const { error: predErr } = await client.from("predictions").insert([
    {
      id: PRED_ALPHA,
      participant_id: PARTICIPANTS.alpha,
      match_id: M_TEST,
      predicted_home: 2,
      predicted_away: 1,
      source: "ui",
      submitted_at: submittedAtIso,
      created_by: PARTICIPANTS.alpha,
    },
    {
      id: PRED_BRAVO,
      participant_id: PARTICIPANTS.bravo,
      match_id: M_TEST,
      predicted_home: 1,
      predicted_away: 1,
      source: "ui",
      submitted_at: submittedAtIso,
      created_by: PARTICIPANTS.bravo,
    },
    {
      id: PRED_CHARLIE,
      participant_id: PARTICIPANTS.charlie,
      match_id: M_TEST,
      predicted_home: 0,
      predicted_away: 0,
      source: "ui",
      submitted_at: submittedAtIso,
      created_by: PARTICIPANTS.charlie,
    },
  ]);
  if (predErr) {
    throw new Error(`setupSyntheticMatch predictions insert: ${predErr.message}`);
  }
}

/**
 * Removes M_TEST + its three predictions. Run from afterEach. predictions
 * MUST be deleted first because the matches FK is ON DELETE RESTRICT.
 */
async function teardownSyntheticMatch(): Promise<void> {
  const client = getServiceClient();
  await client.from("predictions").delete().eq("match_id", M_TEST);
  await client.from("matches").delete().eq("id", M_TEST);
}

/**
 * Snapshot the current tournament_config.first_kickoff_utc value, replace
 * it with `nextIsoValue` (a bare ISO string, NOT pre-encoded JSON — the
 * supabase-js client will encode it as a JSON string when writing to the
 * `value` jsonb column), then return a `restore` callable that writes the
 * original snapshot back byte-identically.
 *
 * Defensive: throws if the row does not exist (i.e. slice-004's fixture
 * never ran), so the test fails fast with a clear message instead of
 * silently no-oping.
 */
async function snapshotAndSetFirstKickoffUtc(
  nextIsoValue: string,
): Promise<{ restore: () => Promise<void> }> {
  const client = getServiceClient();

  const { data: snapshotRow, error: readErr } = await client
    .from("tournament_config")
    .select("value")
    .eq("key", "first_kickoff_utc")
    .maybeSingle();
  if (readErr) {
    throw new Error(
      `snapshotAndSetFirstKickoffUtc read: ${readErr.message}`,
    );
  }
  if (!snapshotRow) {
    throw new Error(
      "snapshotAndSetFirstKickoffUtc: tournament_config.first_kickoff_utc row missing. " +
        "Confirm slice-004-fixture.sql ran (it seeds the row with '\"2026-06-16T20:00:00Z\"'::jsonb).",
    );
  }
  const original = snapshotRow.value;

  const { error: writeErr } = await client
    .from("tournament_config")
    .update({ value: nextIsoValue })
    .eq("key", "first_kickoff_utc");
  if (writeErr) {
    throw new Error(
      `snapshotAndSetFirstKickoffUtc write: ${writeErr.message}`,
    );
  }

  return {
    restore: async () => {
      const { error: restoreErr } = await client
        .from("tournament_config")
        .update({ value: original })
        .eq("key", "first_kickoff_utc");
      if (restoreErr) {
        throw new Error(
          `snapshotAndSetFirstKickoffUtc restore: ${restoreErr.message}. ` +
            `Manual repair required — first_kickoff_utc is drifted.`,
        );
      }
    },
  };
}

/**
 * Issues GET /api/peer-pick/<match_id> on the app-under-test with the
 * signed-in browser context's cookies forwarded. Returns status + parsed
 * body (or null if the body is non-JSON, e.g. a 404 HTML page from
 * Next.js).
 */
async function getPeerPick(
  request: APIRequestContext,
  context: BrowserContext,
  matchId: string,
): Promise<{
  status: number;
  rawBody: string;
  parsed: PeerPickResponse | null;
}> {
  const cookieHeader = await buildCookieHeader(context);
  const response = await request.get(PEER_PICK_ROUTE(matchId), {
    headers: { Cookie: cookieHeader },
  });
  const rawBody = await response.text().catch(() => "<unreadable body>");
  let parsed: PeerPickResponse | null = null;
  try {
    parsed = JSON.parse(rawBody) as PeerPickResponse;
  } catch {
    parsed = null;
  }
  return { status: response.status(), rawBody, parsed };
}

/**
 * Issues GET /api/peer-final-pick/<participant_id> on the app-under-test
 * with the signed-in browser context's cookies forwarded.
 */
async function getPeerFinalPick(
  request: APIRequestContext,
  context: BrowserContext,
  participantId: string,
): Promise<{
  status: number;
  rawBody: string;
  parsed: PeerFinalPickResponse | null;
}> {
  const cookieHeader = await buildCookieHeader(context);
  const response = await request.get(PEER_FINAL_PICK_ROUTE(participantId), {
    headers: { Cookie: cookieHeader },
  });
  const rawBody = await response.text().catch(() => "<unreadable body>");
  let parsed: PeerFinalPickResponse | null = null;
  try {
    parsed = JSON.parse(rawBody) as PeerFinalPickResponse;
  } catch {
    parsed = null;
  }
  return { status: response.status(), rawBody, parsed };
}

/**
 * Issues GET /rest/v1/peer_pick_v?match_id=eq.<uuid> directly against
 * Supabase's PostgREST surface using the participant's JWT (extracted from
 * page localStorage). This is the "direct API attempt" SC-009 / FR-016
 * second-half assertion: a participant who bypasses the UI MUST still hit
 * the RLS gate at the view level.
 *
 * apikey + Authorization headers are both required per Supabase PostgREST
 * conventions (apikey = anon key, Authorization = bearer participant JWT).
 */
async function getPeerPickDirect(
  request: APIRequestContext,
  matchId: string,
  jwt: string,
): Promise<{
  status: number;
  rawBody: string;
  parsed: unknown[] | null;
}> {
  const url = `${SUPABASE_URL}/rest/v1/peer_pick_v?match_id=eq.${matchId}&select=*`;
  const response = await request.get(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
    },
  });
  const rawBody = await response.text().catch(() => "<unreadable body>");
  let parsed: unknown[] | null = null;
  try {
    const json = JSON.parse(rawBody) as unknown;
    parsed = Array.isArray(json) ? json : null;
  } catch {
    parsed = null;
  }
  return { status: response.status(), rawBody, parsed };
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US3 — Peer-Pick Visibility @slice-005 @us3", () => {
  // Each test exercises a service-role round-trip + a route call; bump the
  // default Playwright budget for safety.
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await assertOidcStubReachable();
  });

  // ----------------------------------------------------------------------
  // MATCH-PICK GROUP — 6 tests on /api/peer-pick/<M_TEST> and
  // /rest/v1/peer_pick_v.
  // ----------------------------------------------------------------------
  test.describe("Match-pick peer visibility (peer_pick_v + /api/peer-pick)", () => {
    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await teardownSyntheticMatch();
      await resetStub();
    });

    // --------------------------------------------------------------------
    // TEST 1 — Pre-lock: kickoff = now + 60:01 → empty picks array.
    // --------------------------------------------------------------------
    test(
      "Test 1 — Given M_TEST kickoff = now + 60:01 (1 s outside the 60-min lock window) and alpha/bravo/charlie predictions exist, When alpha GETs /api/peer-pick/<M_TEST>, Then response is 200 + body.picks is exactly [] @slice-005 @us3",
      async ({ page, request, context }) => {
        // 60 min + 1 s in the future → lock predicate `now() >= kickoff − 60min`
        // is FALSE → peer_pick_v returns zero rows → route returns picks=[].
        const kickoff = new Date(Date.now() + 60 * 60 * 1000 + 1000);
        await setupSyntheticMatch(kickoff);

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerPick(
          request,
          context,
          M_TEST,
        );
        expect(
          status,
          `GET /api/peer-pick/<M_TEST> pre-lock MUST return 200 (deny-by-RLS is empty body, not HTTP error). Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed,
          "Pre-lock body MUST parse as JSON with shape { picks: [] }",
        ).not.toBeNull();
        expect(
          parsed?.picks,
          "Pre-lock body.picks MUST be exactly [] (RLS hides all peer picks before lock per FR-016 + R-010)",
        ).toEqual([]);
      },
    );

    // --------------------------------------------------------------------
    // TEST 2 — At lock boundary: kickoff = now + 60:00 exactly → non-empty
    // picks excluding self.
    // --------------------------------------------------------------------
    test(
      "Test 2 — Given M_TEST kickoff = now + 60:00 (exact boundary, BR-LOCK-003 strict >=) and alpha/bravo/charlie predictions exist, When alpha GETs /api/peer-pick/<M_TEST>, Then response is 200 + body.picks contains bravo's and charlie's predictions AND excludes alpha's own pick @slice-005 @us3",
      async ({ page, request, context }) => {
        // Use a tiny back-dating (kickoff = now + 60 min − 50ms) so that by
        // the time the route's transaction evaluates `now() >= kickoff −
        // 60min`, the predicate is unambiguously true even at the strict
        // boundary. This is the same idiom slice-004's
        // me-final-predictions-lock-state-at-boundary test uses.
        const kickoff = new Date(Date.now() + 60 * 60 * 1000 - 50);
        await setupSyntheticMatch(kickoff);

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerPick(
          request,
          context,
          M_TEST,
        );
        expect(
          status,
          `GET /api/peer-pick/<M_TEST> at boundary MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);

        const picks = parsed?.picks ?? [];
        expect(
          picks.length,
          "At-boundary body.picks MUST contain exactly 2 rows (bravo + charlie; alpha excluded as self)",
        ).toBe(2);

        const pickerIds = new Set(picks.map((p) => p.participant_id));
        expect(
          pickerIds.has(PARTICIPANTS.bravo),
          "body.picks MUST include bravo's prediction at the boundary",
        ).toBe(true);
        expect(
          pickerIds.has(PARTICIPANTS.charlie),
          "body.picks MUST include charlie's prediction at the boundary",
        ).toBe(true);
        expect(
          pickerIds.has(PARTICIPANTS.alpha),
          "body.picks MUST NOT include the caller's own pick (peer view self-exclusion)",
        ).toBe(false);

        // Spot-check bravo's predicted scores match what setupSyntheticMatch
        // wrote (1-1) — proves the row payload is not masked at the
        // boundary.
        const bravoRow = picks.find((p) => p.participant_id === PARTICIPANTS.bravo);
        expect(bravoRow?.predicted_home, "bravo predicted_home MUST equal 1").toBe(1);
        expect(bravoRow?.predicted_away, "bravo predicted_away MUST equal 1").toBe(1);
        expect(
          bravoRow?.submitted_at,
          "bravo submitted_at MUST be non-null (peer pick is valid, not invalidated)",
        ).not.toBeNull();
      },
    );

    // --------------------------------------------------------------------
    // TEST 3 — Post-lock (kickoff − 30:00 in the future, i.e. 30 min before
    // kickoff): non-empty picks.
    // --------------------------------------------------------------------
    test(
      "Test 3 — Given M_TEST kickoff = now + 30:00 (30 min before kickoff, well inside the lock window) and alpha/bravo/charlie predictions exist, When alpha GETs /api/peer-pick/<M_TEST>, Then response is 200 + body.picks has length 2 (bravo + charlie) @slice-005 @us3",
      async ({ page, request, context }) => {
        const kickoff = new Date(Date.now() + 30 * 60 * 1000);
        await setupSyntheticMatch(kickoff);

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerPick(
          request,
          context,
          M_TEST,
        );
        expect(
          status,
          `GET /api/peer-pick/<M_TEST> post-lock MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.picks?.length,
          "Post-lock body.picks MUST contain exactly 2 rows (bravo + charlie)",
        ).toBe(2);
      },
    );

    // --------------------------------------------------------------------
    // TEST 4 — Direct REST with participant JWT pre-lock → zero rows.
    // --------------------------------------------------------------------
    // SC-009: the gate is in the database. A participant who hits
    // /rest/v1/peer_pick_v directly with their own JWT MUST get the same
    // empty result the route handler returns — the route is just a thin
    // pass-through.
    test(
      "Test 4 — Given M_TEST is pre-lock (kickoff = now + 60:01) and alpha is signed in, When alpha calls /rest/v1/peer_pick_v?match_id=eq.<M_TEST> DIRECTLY with their participant JWT, Then response is 200 + body is exactly [] (RLS at the view, not the route, SC-009) @slice-005 @us3",
      async ({ page, request }) => {
        const kickoff = new Date(Date.now() + 60 * 60 * 1000 + 1000);
        await setupSyntheticMatch(kickoff);

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const jwt = await extractParticipantJwt(page);
        expect(
          jwt,
          "alpha's participant JWT MUST be extractable from localStorage after sign-in (preflight for direct-REST test)",
        ).not.toBeNull();

        const { status, rawBody, parsed } = await getPeerPickDirect(
          request,
          M_TEST,
          jwt as string,
        );
        expect(
          status,
          `Direct /rest/v1/peer_pick_v call MUST return 200 (RLS deny renders as empty body, not HTTP error). Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed,
          "Direct-REST body MUST parse as a JSON array",
        ).not.toBeNull();
        expect(
          parsed?.length,
          "Direct-REST pre-lock body MUST be exactly [] — the RLS gate is in the view, so a participant bypassing the route gets the same answer (SC-009)",
        ).toBe(0);
      },
    );

    // --------------------------------------------------------------------
    // TEST 5 — Direct REST with admin JWT pre-lock.
    // --------------------------------------------------------------------
    // Per D-T023-1, contracts/peer-pick.read.md § Server-side gate does NOT
    // document an `is_admin(...) OR …` carve-out — the only predicates are
    // (a) eligibility and (b) lock. admin1 IS an eligible Nortal
    // participant but is also subject to the lock predicate. Test asserts
    // the strict "no admin bypass" reading: admin sees zero rows pre-lock.
    test(
      "Test 5 — Given M_TEST is pre-lock and admin1 is signed in, When admin1 calls /rest/v1/peer_pick_v?match_id=eq.<M_TEST> DIRECTLY with their participant JWT, Then response is 200 + body is exactly [] (contract documents no admin bypass on peer_pick_v; admin reads through a separate admin surface — D-T023-1) @slice-005 @us3",
      async ({ page, request }) => {
        const kickoff = new Date(Date.now() + 60 * 60 * 1000 + 1000);
        await setupSyntheticMatch(kickoff);

        await signInWithIdentity(page, {
          claims: {
            sub: ADMIN1.sub,
            email: ADMIN1.email,
            email_verified: ADMIN1.email_verified,
            name: ADMIN1.name,
          },
        });

        const jwt = await extractParticipantJwt(page);
        expect(
          jwt,
          "admin1's JWT MUST be extractable from localStorage after sign-in",
        ).not.toBeNull();

        const { status, rawBody, parsed } = await getPeerPickDirect(
          request,
          M_TEST,
          jwt as string,
        );
        expect(
          status,
          `Direct /rest/v1/peer_pick_v call by admin1 MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.length,
          "admin1 pre-lock through /rest/v1/peer_pick_v MUST see exactly 0 rows — contract documents no admin bypass on this view (D-T023-1). If T029 lands the alternative `OR is_admin(...)` clause, the contract must be updated FIRST and this test re-spec'd.",
        ).toBe(0);
      },
    );

    // --------------------------------------------------------------------
    // TEST 6 — Admin-invalidated pick masked to null fields.
    // --------------------------------------------------------------------
    // D-T023-2: predictions table has no admin_invalidated column today;
    // slice 006 owns the invalidation surface. Test is fixme until that
    // dependency lands. Assertion shape encoded so it goes green once
    // slice 006 + T029 ship together.
    test(
      "Test 6 — Given M_TEST is post-lock AND bravo's prediction was admin-invalidated, When alpha GETs /api/peer-pick/<M_TEST>, Then bravo's row appears with predicted_home=null AND predicted_away=null AND submitted_at=null (no leak of admin override per contract § Response) @slice-005 @us3",
      async ({ page, request, context }) => {
        // Slice 006 owns the admin-invalidation surface (admin_invalidations
        // table OR a predictions.admin_invalidated column). The contract's
        // masking row in peer_pick_v depends on that surface. Until it
        // ships, the test cannot exercise the masking path without
        // fabricating a schema that does not exist.
        test.fixme(
          true,
          "Admin-invalidated peer-pick masking depends on slice 006's admin invalidation surface (predictions.admin_invalidated column or admin_invalidations table). T029's peer_pick_v WILL apply the mask; T023 cannot drive the input state until that surface lands. Pin to slice 006 / T023-followup.",
        );

        // The body below is the assertion that will hold once the
        // dependency ships. Setup + assertions are encoded fully so the
        // test goes green-by-design when fixme is removed.

        const kickoff = new Date(Date.now() + 30 * 60 * 1000);
        await setupSyntheticMatch(kickoff);

        // TODO(slice-006): mark bravo's prediction (PRED_BRAVO) as
        // admin-invalidated via the slice-006 surface. The exact call
        // depends on whether slice 006 ships a column or a table; both
        // shapes are compatible with the assertion below.

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, parsed } = await getPeerPick(request, context, M_TEST);
        expect(status).toBe(200);

        const bravoRow = (parsed?.picks ?? []).find(
          (p) => p.participant_id === PARTICIPANTS.bravo,
        );
        expect(bravoRow).toBeDefined();
        expect(
          bravoRow?.predicted_home,
          "Admin-invalidated bravo predicted_home MUST be null (contract § Response — no leak of admin override)",
        ).toBeNull();
        expect(
          bravoRow?.predicted_away,
          "Admin-invalidated bravo predicted_away MUST be null",
        ).toBeNull();
        expect(
          bravoRow?.submitted_at,
          "Admin-invalidated bravo submitted_at MUST be null",
        ).toBeNull();
      },
    );
  });

  // ----------------------------------------------------------------------
  // FINAL-PICK GROUP — 4 tests on /api/peer-final-pick/<participant>.
  // ----------------------------------------------------------------------
  test.describe("Final-tournament-pick peer visibility (peer_final_pick_v + /api/peer-final-pick)", () => {
    let restoreFirstKickoff: (() => Promise<void>) | null;

    test.beforeEach(async () => {
      await resetStub();
      restoreFirstKickoff = null;
    });

    test.afterEach(async () => {
      if (restoreFirstKickoff) {
        await restoreFirstKickoff();
        restoreFirstKickoff = null;
      }
      await resetStub();
    });

    // --------------------------------------------------------------------
    // TEST 7 — Before first kickoff → pick=null.
    // --------------------------------------------------------------------
    test(
      "Test 7 — Given tournament_config.first_kickoff_utc is set to now + 1h (first kickoff in the future) and alpha is signed in, When alpha GETs /api/peer-final-pick/<bravo-uuid>, Then response is 200 + body.pick is exactly null (FR-016 final-tournament variant pre-lock) @slice-005 @us3",
      async ({ page, request, context }) => {
        const futureKickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const handle = await snapshotAndSetFirstKickoffUtc(futureKickoff);
        restoreFirstKickoff = handle.restore;

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerFinalPick(
          request,
          context,
          PARTICIPANTS.bravo,
        );
        expect(
          status,
          `GET /api/peer-final-pick/<bravo> pre-first-kickoff MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.pick,
          "Pre-first-kickoff body.pick MUST be exactly null (contract § Error responses — 'First kickoff has not yet occurred')",
        ).toBeNull();
      },
    );

    // --------------------------------------------------------------------
    // TEST 8 — At first-kickoff boundary → populated row.
    // --------------------------------------------------------------------
    test(
      "Test 8 — Given tournament_config.first_kickoff_utc is set to now (the exact strict-equality boundary, BR-LOCK-003 mirror) and alpha is signed in, When alpha GETs /api/peer-final-pick/<bravo-uuid>, Then response is 200 + body.pick is non-null AND body.pick.champion_team_id equals bravo's slice-004 pick (BRA) @slice-005 @us3",
      async ({ page, request, context }) => {
        // 50ms back-date so the predicate `now() >= first_kickoff_utc` is
        // unambiguously true at strict equality. Same idiom slice-004
        // me-final-predictions-lock-state-at-boundary uses.
        const boundaryIso = new Date(Date.now() - 50).toISOString();
        const handle = await snapshotAndSetFirstKickoffUtc(boundaryIso);
        restoreFirstKickoff = handle.restore;

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerFinalPick(
          request,
          context,
          PARTICIPANTS.bravo,
        );
        expect(
          status,
          `GET /api/peer-final-pick/<bravo> at boundary MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.pick,
          "At-boundary body.pick MUST be a non-null row (strict >= per BR-LOCK-003 mirror)",
        ).not.toBeNull();
        expect(
          parsed?.pick?.participant_id,
          "body.pick.participant_id MUST equal bravo's uuid",
        ).toBe(PARTICIPANTS.bravo);
        expect(
          parsed?.pick?.champion_team_id,
          "At-boundary bravo's champion_team_id MUST equal BRA (slice-004 fixture row 4 — bravo's champion pick)",
        ).toBe(TEAM_BRA);
      },
    );

    // --------------------------------------------------------------------
    // TEST 9 — After first kickoff → full populated pick.
    // --------------------------------------------------------------------
    // bravo's active final-prediction picks combine slice-004 + slice-005:
    //   slice-004 row 4: champion   -> BRA
    //   slice-004 row 5: top_scorer -> Vinícius
    //   slice-005 row 2: runner_up  -> ESP
    //   (no best_player pick — peer_final_pick_v MUST return null for it.)
    test(
      "Test 9 — Given tournament_config.first_kickoff_utc is set to now - 1h (first kickoff well past) and alpha is signed in, When alpha GETs /api/peer-final-pick/<bravo-uuid>, Then body.pick.champion_team_id equals BRA AND body.pick.runner_up_team_id equals ESP AND body.pick.top_scorer_player_id equals Vinícius AND body.pick.best_player_player_id is null (bravo never submitted a best_player pick) @slice-005 @us3",
      async ({ page, request, context }) => {
        const pastKickoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const handle = await snapshotAndSetFirstKickoffUtc(pastKickoff);
        restoreFirstKickoff = handle.restore;

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerFinalPick(
          request,
          context,
          PARTICIPANTS.bravo,
        );
        expect(
          status,
          `GET /api/peer-final-pick/<bravo> post-first-kickoff MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.pick,
          "Post-first-kickoff body.pick MUST be non-null (FR-016 final-tournament-half happy path)",
        ).not.toBeNull();

        expect(
          parsed?.pick?.champion_team_id,
          "bravo's champion_team_id MUST equal BRA (slice-004 fixture row 4)",
        ).toBe(TEAM_BRA);
        expect(
          parsed?.pick?.runner_up_team_id,
          "bravo's runner_up_team_id MUST equal ESP (slice-005 fixture row 2)",
        ).toBe(TEAM_ESP);
        expect(
          parsed?.pick?.top_scorer_player_id,
          "bravo's top_scorer_player_id MUST equal Vinícius (slice-004 fixture row 5)",
        ).toBe(PLAYER_VINICIUS);
        expect(
          parsed?.pick?.best_player_player_id,
          "bravo never submitted a best_player pick → field MUST be null in the consolidated peer_final_pick_v row",
        ).toBeNull();
      },
    );

    // --------------------------------------------------------------------
    // TEST 10 — Caller asks about themselves → pick=null (self-exclusion).
    // --------------------------------------------------------------------
    test(
      "Test 10 — Given tournament_config.first_kickoff_utc is set to now - 1h (lock passed) and alpha is signed in, When alpha GETs /api/peer-final-pick/<alpha-uuid> (their OWN id), Then response is 200 + body.pick is exactly null (peer_final_pick_v predicate `participant_id <> auth.uid()` self-exclusion; self-reads go through /me/breakdown) @slice-005 @us3",
      async ({ page, request, context }) => {
        const pastKickoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const handle = await snapshotAndSetFirstKickoffUtc(pastKickoff);
        restoreFirstKickoff = handle.restore;

        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        const { status, rawBody, parsed } = await getPeerFinalPick(
          request,
          context,
          PARTICIPANTS.alpha,
        );
        expect(
          status,
          `GET /api/peer-final-pick/<alpha> for caller's own id MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);
        expect(
          parsed?.pick,
          "Self-query body.pick MUST be exactly null — contract § Server-side gate excludes `participant_id <> auth.uid()`",
        ).toBeNull();
      },
    );
  });
});
