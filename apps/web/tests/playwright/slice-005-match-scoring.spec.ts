// --------------------------------------------------------------------------
// Slice 005 / T009 — US1 Match Scoring Playwright spec (RED).
// --------------------------------------------------------------------------
// RED acceptance tests for User Story 1 (P1) — the 10 / 5 / 0 / no-prediction
// match-scoring truth table + idempotency + audit + recalc behavior.
//
// Source of truth:
//   - specs/005-scoring-leaderboard/spec.md § US1 (Acceptance Scenarios 1-5)
//     and § Edge Cases (out-of-order, idempotent retry).
//   - specs/005-scoring-leaderboard/contracts/scoring-trigger.edge-fn.md
//     § Request (admin path), § Response, § Behavior, § Error responses.
//   - specs/005-scoring-leaderboard/contracts/personal-breakdown.read.md
//     § Response (one row per scored target).
//   - supabase/seed/slice-005-fixture.sql — the hand-verified per-participant
//     truth table at the bottom of the file is the canonical source for every
//     numeric assertion below.
//   - apps/web/tests/playwright/slice-004-submit-champion-happy.spec.ts —
//     pattern reference for OIDC stub + service-role cleanup blocks.
//   - apps/web/tests/playwright/slice-002-empty-payload-served-last-known.spec.ts —
//     pattern reference for `request.post(/functions/v1/<fn>)` calls against
//     a Supabase Edge Function.
//   - .specify/memory/constitution.md § Principle IX (BDD: every Then-clause
//     MUST be a checkable assertion — no "should be reasonable" language).
//
// Scenarios covered (all tagged @slice-005 @us1):
//   1. AS1 exact prediction         → alpha on M1   → 10 / 'exact'
//   2. AS2 correct outcome          → bravo on M2   → 5  / 'outcome' (1-1 vs 0-0 draw)
//   3. AS3 incorrect prediction     → charlie on M2 → 0  / 'incorrect' (1-0 home vs 0-0 draw)
//   4. AS4 no valid prediction      → delta on M2   → 0  / 'none'      (pre-DELETE the row)
//   5. AS5 audit captured           → all 6 participants on M1 → score_record.insert rows
//   6. AS6 recalc bumps version     → same M1, two distinct run_ids → version V1+1, both versions retained
//   7. AS7 idempotent retry         → same M1, same run_id twice   → 6 rows total, identical body
//
// Cleanup contract:
//   * Every test captures a wall-clock instant BEFORE its first sync call and
//     uses the service-role client to DELETE score_records and
//     score_calculation_runs rows created at or after that instant in the
//     afterEach. Audit_log rows are LEFT in place — they are append-only by
//     Slice 007's contract and the next test's `since` filter will exclude
//     them. This avoids cross-test pollution without violating the
//     append-only invariant.
//   * AS4 additionally DELETEs delta's M2 prediction in the test body, then
//     RESTORES the exact original row in the afterEach (snapshot pattern
//     borrowed from withTemporaryConfig). The deletion / restore is keyed
//     off the prediction's primary key UUID — which is deterministic in the
//     slice-005 fixture (`eeee0051-000d-0002-0000-000000000000`).
//
// RED-by-design until:
//   * T013 ships `public.score_match(uuid, uuid)` at migration slot 0052.
//   * T014 ships `log_score_record_change()` audit trigger at slot 0055.
//   * T015 ships `supabase/functions/score-trigger/`.
//   Until those land:
//     - The POST returns 404 (Edge Function does not exist) → tests fail at
//       `expect(response.status).toBe(200)`.
//     - The score_records query returns 0 rows → tests fail at the points /
//       reason_code assertions.
//   The failure mode is always assertion-level, never infrastructure-error.
//
// Admin auth posture (D-T009-1):
//   The contract requires `Authorization: Bearer <admin JWT>` AND server-side
//   `is_admin(auth.uid())`. Slice 005 fixture seeds admin1 in `participants`
//   but the `admin_roles` table is owned by Slice 006 (T015 of slice 006).
//   T009's stance: sign in as admin1 via the OIDC stub so the JWT is real and
//   forwardable; the actual admin check will land when slice 006 wires
//   `admin_roles`. Until then the Edge Function will reject this call with
//   403 — that 403 is itself a valid RED state (the request reaches the
//   function and is rejected at the role boundary, not at the URL boundary).
//   When T015 ships, the admin_roles fixture row will be added alongside it
//   and these tests will turn GREEN without modification.
//
// `request.post` against the Edge Function does NOT forward Playwright page
// cookies automatically. We extract the page's cookies after sign-in and pass
// them via the `extraHTTPHeaders.Cookie` header on the POST. This is the
// idiomatic pattern (see slice-002 sync-catalog calls which use
// `X-Internal-Auth` instead — we use the cookie path because the contract
// uses Bearer auth derived from the Supabase session cookie).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { ensureAdminRole } from "./helpers/admin-roles";
import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Fixture-derived constants. ALL UUIDs and numeric values are anchored to
// supabase/seed/slice-005-fixture.sql and MUST stay in sync if that fixture
// is ever edited.
// --------------------------------------------------------------------------

// auth.users `sub` values from § 1 of slice-005-fixture.sql.
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
  delta: "44444444-4444-4444-4444-444444444444",
  epsilon: "55555555-5555-5555-5555-555555555555",
  zeta: "66666666-6666-6666-6666-666666666666",
  // admin1 is ALSO seeded by slice-005-fixture.sql as status='active'
  // (the fixture doesn't distinguish admin from regular participants —
  // admin role is owned by slice 006's admin_roles table). The scoring
  // SP at slot 0052 writes a score_record for every eligible active
  // participant, which includes admin1. AS7's idempotency assertion
  // therefore needs to include admin1 in the expected participant set.
  // (Added 2026-05-23 — slice 005 follow-up cascade.)
  admin1: "77777777-7777-7777-7777-777777777777",
} as const;

// admin1's participant_id from slice-005-fixture.sql § 2 (lines 247-258).
// Used by the defensive beforeAll admin_roles seed.
const ADMIN1_PARTICIPANT_ID = "77777777-7777-7777-7777-777777777777";

// matches UUIDs from § 3 of slice-005-fixture.sql.
const M1 = "eeee0050-0000-0000-0000-000000000001"; // ARG vs MEX 2-1
const M2 = "eeee0050-0000-0000-0000-000000000002"; // ESP vs BRA 0-0
const M3 = "eeee0050-0000-0000-0000-000000000003"; // CAN vs USA 1-2

// delta's M2 prediction (used by AS4 — snapshot/restore).
// Composite UUID: eeee0051-<participant-letter>-<match-N>-0000-000000000000.
const DELTA_M2_PREDICTION_ID = "eeee0051-000d-0002-0000-000000000000";

const SCORE_TRIGGER_ENDPOINT =
  (process.env.SUPABASE_FUNCTIONS_BASE_URL ??
    "http://localhost:54321/functions/v1") + "/score-trigger";

// --------------------------------------------------------------------------
// Local contract types — mirror scoring-trigger.edge-fn.md WITHOUT importing
// any app code so the spec stays decoupled from server refactors.
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

interface ScoreRecordRow {
  id: string;
  participant_id: string;
  target_kind: "match" | "final";
  target_id: string;
  points: number;
  reason_code:
    | "exact"
    | "outcome"
    | "incorrect"
    | "none"
    | "final_correct"
    | "final_incorrect"
    | "final_pending";
  calculation_version: number;
  run_id: string;
  calculated_at: string;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Builds a Cookie header value from the page's current cookie jar so the
 * Edge Function call inherits the signed-in Supabase session. Returns an
 * empty string if no cookies are set (which would itself be a failure mode
 * — the test will then hit the 403 path instead of the 200 path).
 */
async function buildCookieHeader(
  context: import("@playwright/test").BrowserContext,
): Promise<string> {
  const cookies = await context.cookies();
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Extract the Supabase access-token JWT from the signed-in browser context.
 *
 * @supabase/ssr 0.5+ stores the session in cookies named
 * `sb-<ref>-auth-token.<index>` (split across multiple chunks when large).
 * Each chunk's value begins with `base64-` followed by a base64-encoded
 * JSON fragment; concatenating the chunks (in numeric order) and stripping
 * the prefix yields the full JSON `{access_token, refresh_token, user, …}`.
 *
 * We extract the access_token so callers can forward it as
 * `Authorization: Bearer <jwt>` to the Supabase Edge Runtime gateway
 * (which requires SOME Bearer token before any /functions/v1/* request
 * reaches the function code). The function's own `auth.getUser()` then
 * resolves the JWT to admin1's auth.users row, the is_admin check
 * passes, and the SP runs under admin authorization — preserving the
 * test's intended admin-JWT auth model.
 *
 * Returns null if no Supabase session cookie is found (the caller should
 * fall back to throwing a clear error, since the test cannot exercise the
 * admin path without a valid session).
 *
 * (Added 2026-05-23 — slice 005 follow-up cascade. The original helper
 *  only built a Cookie header, but the Supabase Edge Runtime gateway
 *  rejects cookie-only requests with "Missing authorization header".)
 */
async function extractAccessTokenFromBrowserContext(
  context: import("@playwright/test").BrowserContext,
): Promise<string | null> {
  const cookies = await context.cookies();
  const sessionChunks = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => {
      const ai = Number.parseInt(a.name.split(".").pop() ?? "0", 10);
      const bi = Number.parseInt(b.name.split(".").pop() ?? "0", 10);
      return ai - bi;
    });
  if (sessionChunks.length === 0) return null;
  let combined = sessionChunks.map((c) => c.value).join("");
  if (combined.startsWith("base64-")) combined = combined.slice("base64-".length);
  let parsed: { access_token?: string } | null = null;
  try {
    const decoded = Buffer.from(combined, "base64").toString("utf8");
    parsed = JSON.parse(decoded) as { access_token?: string };
  } catch {
    // Some Supabase versions store the JSON URL-encoded without the
    // base64- prefix; fall back to raw decode.
    try {
      parsed = JSON.parse(decodeURIComponent(combined)) as { access_token?: string };
    } catch {
      return null;
    }
  }
  return parsed?.access_token ?? null;
}

/**
 * Service-role: query score_records for a (participant, target_id) pair.
 * Returns the highest-version row first so callers can grab `[0]` for the
 * "latest" assertion or scan the whole array for the version-history
 * assertions (AS6).
 */
async function readScoreRecords(
  participantId: string,
  targetId: string,
): Promise<ScoreRecordRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("score_records")
    .select(
      "id,participant_id,target_kind,target_id,points,reason_code,calculation_version,run_id,calculated_at",
    )
    .eq("participant_id", participantId)
    .eq("target_id", targetId)
    .order("calculation_version", { ascending: false });
  if (error) {
    throw new Error(`readScoreRecords(${participantId}, ${targetId}): ${error.message}`);
  }
  return (data ?? []) as ScoreRecordRow[];
}

/**
 * Service-role: delete every score_records + score_calculation_runs row
 * created after `since`. Idempotent. Audit_log rows are NOT touched
 * (append-only). Called from afterEach to keep tests isolated.
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
    // The score_calculation_runs table is owned by T004 (migration 0050).
    // If it does not yet exist this DELETE will surface a clear error.
    throw new Error(
      `purgeScoringRowsSince score_calculation_runs: ${runsErr.message}`,
    );
  }
}

/**
 * Service-role: count audit_log rows for a given entity_type written after
 * `since`. Used by AS5 to assert the trigger emitted one row per
 * score_record insert.
 */
async function readScoreAuditRows(since: Date): Promise<
  Array<{
    actor: string | null;
    action: string;
    entity_type: string | null;
    previous_value: unknown;
    new_value: Record<string, unknown> | null;
    occurred_at: string;
  }>
> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select("actor,action,entity_type,previous_value,new_value,occurred_at")
    .eq("entity_type", "score_record")
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readScoreAuditRows: ${error.message}`);
  }
  return (data ?? []) as Array<{
    actor: string | null;
    action: string;
    entity_type: string | null;
    previous_value: unknown;
    new_value: Record<string, unknown> | null;
    occurred_at: string;
  }>;
}

/**
 * Snapshot helper for AS4: fetch the full row, return both a delete callable
 * and a restore callable. The restore re-inserts the row byte-identically so
 * the fixture invariant `predictions_active_uk` is preserved for sibling
 * tests.
 */
async function snapshotAndDeletePrediction(predictionId: string): Promise<{
  restore: () => Promise<void>;
}> {
  const client = getServiceClient();

  const { data: snapshot, error: readErr } = await client
    .from("predictions")
    .select("*")
    .eq("id", predictionId)
    .maybeSingle();
  if (readErr) {
    throw new Error(
      `snapshotAndDeletePrediction(${predictionId}) read: ${readErr.message}`,
    );
  }
  if (!snapshot) {
    throw new Error(
      `snapshotAndDeletePrediction(${predictionId}): row not found. ` +
        `Confirm supabase/seed/slice-005-fixture.sql was applied.`,
    );
  }

  const { error: delErr } = await client
    .from("predictions")
    .delete()
    .eq("id", predictionId);
  if (delErr) {
    throw new Error(
      `snapshotAndDeletePrediction(${predictionId}) delete: ${delErr.message}`,
    );
  }

  return {
    restore: async () => {
      const { error: insErr } = await client
        .from("predictions")
        .upsert(snapshot, { onConflict: "id" });
      if (insErr) {
        throw new Error(
          `snapshotAndDeletePrediction(${predictionId}) restore: ${insErr.message}. ` +
            `Manual repair required — the slice-005 fixture invariant is now broken.`,
        );
      }
    },
  };
}

/**
 * POSTs to /functions/v1/score-trigger with the signed-in admin's cookie
 * forwarded. Returns the parsed JSON response on 200; otherwise rejects
 * with the response status + body so failure messages stay informative.
 */
async function callScoreTrigger(
  request: import("@playwright/test").APIRequestContext,
  context: import("@playwright/test").BrowserContext,
  body: ScoreTriggerRequest,
): Promise<{
  status: number;
  rawBody: string;
  parsed: ScoreTriggerResponse | null;
}> {
  const cookieHeader = await buildCookieHeader(context);
  // Extract the admin's JWT from the Supabase session cookie and forward
  // it as Authorization: Bearer <jwt>. The Edge Runtime gateway demands
  // an Authorization header before any /functions/v1/* request reaches
  // the function; once it does, the function's own auth.getUser() reads
  // this same JWT to identify the caller as admin1 and the is_admin
  // check passes. Cookie is retained for completeness (defense in depth
  // for any downstream resolver that prefers cookies).
  const accessToken = await extractAccessTokenFromBrowserContext(context);
  const response = await request.post(SCORE_TRIGGER_ENDPOINT, {
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
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

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 — Match Scoring @slice-005 @us1", () => {
  // Run serially within the file. fullyParallel: true would otherwise
  // spawn one worker per test, racing on
  // tournament_config.current_calculation_version and tripping
  // score_records_uk on the concurrent INSERTs. Same pattern as the
  // breakdown + final-scoring specs. (Added 2026-05-23.)
  test.describe.configure({ mode: "serial" });

  // Each test's scoring trigger + service-role round-trips take a bit longer
  // than the default Playwright budget.
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    await assertOidcStubReachable();
    // Slice 006 / T008 — defensive admin_roles seed.
    // Slice 005's fixture seeds admin1 in `participants`; Slice 006's T009
    // bootstrap migration (slot 0074) seeds the matching `admin_roles` row.
    // After T007 + T009 land, the 7 tests below + the AS5 helper rely on
    // is_admin(admin1) returning true at the `score-trigger` Edge Function.
    // This ensureAdminRole call is belt-and-suspenders: if the DB is reset
    // without replaying T009 (partial migration replay, fixture-only resets,
    // future fixture drift), it guarantees the post-condition without
    // duplicating rows in the common (bootstrap-already-ran) path.
    // See specs/006-admin-overrides/t008-test-migration-verification.md.
    await ensureAdminRole(ADMIN1_PARTICIPANT_ID);
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
  // AS1 — exact prediction scores 10 points.
  // ----------------------------------------------------------------------
  // Fixture truth (slice-005-fixture.sql § truth table):
  //   alpha / M1 (off 2-1) / pred 2-1 → 10 / exact.
  test(
    "AS1 — Given M1 official 2-1 and alpha's prediction 2-1, When scoring runs, Then alpha is awarded exactly 10 points / 'exact' @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const { status, rawBody } = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS1 — exact prediction → 10 points",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger MUST return 200 (contract § Response). Got body: ${rawBody}`,
      ).toBe(200);

      const alphaRows = await readScoreRecords(PARTICIPANTS.alpha, M1);
      expect(
        alphaRows.length,
        "Exactly one score_records row MUST exist for (alpha, M1) after a single scoring pass",
      ).toBe(1);
      expect(
        alphaRows[0].points,
        "alpha / M1 (off 2-1) / pred 2-1 MUST award 10 points per fixture truth table",
      ).toBe(10);
      expect(
        alphaRows[0].reason_code,
        "alpha / M1 / exact-score MUST be reason_code='exact'",
      ).toBe("exact");
      expect(alphaRows[0].target_kind).toBe("match");
    },
  );

  // ----------------------------------------------------------------------
  // AS2 — correct outcome (not exact) scores 5 points.
  // ----------------------------------------------------------------------
  // Fixture truth: bravo / M2 (off 0-0) / pred 1-1 → 5 / outcome (draw).
  test(
    "AS2 — Given M2 official 0-0 and bravo's prediction 1-1 (same outcome, different score), When scoring runs, Then bravo is awarded exactly 5 points / 'outcome' @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const { status, rawBody } = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M2,
        reason: "T009 AS2 — correct outcome → 5 points",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      const bravoRows = await readScoreRecords(PARTICIPANTS.bravo, M2);
      expect(bravoRows.length).toBe(1);
      expect(
        bravoRows[0].points,
        "bravo / M2 (off 0-0) / pred 1-1 MUST award 5 points per fixture truth table",
      ).toBe(5);
      expect(
        bravoRows[0].reason_code,
        "bravo / M2 / correct-outcome-only MUST be reason_code='outcome'",
      ).toBe("outcome");
    },
  );

  // ----------------------------------------------------------------------
  // AS3 — incorrect prediction scores 0 points.
  // ----------------------------------------------------------------------
  // Fixture truth: charlie / M2 (off 0-0) / pred 1-0 → 0 / incorrect (home
  // win vs draw). This is one of the cleanest "wrong outcome" rows in the
  // fixture — chosen over M3 (where epsilon scores EXACT 1-2 / 10 / exact)
  // because the M3 incorrect cell from the fixture is delta on M3 (0-0 vs
  // 1-2), and delta on M3 is also a valid choice. We use charlie/M2 because
  // it pairs cleanly with AS2 (same match) and demonstrates that the same
  // match yields different reason_codes for different participants.
  test(
    "AS3 — Given M2 official 0-0 and charlie's prediction 1-0 (home win vs draw), When scoring runs, Then charlie is awarded exactly 0 points / 'incorrect' @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const { status, rawBody } = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M2,
        reason: "T009 AS3 — incorrect prediction → 0 points",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      const charlieRows = await readScoreRecords(PARTICIPANTS.charlie, M2);
      expect(charlieRows.length).toBe(1);
      expect(
        charlieRows[0].points,
        "charlie / M2 (off 0-0) / pred 1-0 MUST award 0 points (home win predicted vs actual draw)",
      ).toBe(0);
      expect(
        charlieRows[0].reason_code,
        "charlie / M2 / incorrect-outcome MUST be reason_code='incorrect'",
      ).toBe("incorrect");
    },
  );

  // ----------------------------------------------------------------------
  // AS4 — no valid prediction yields reason 'none' with 0 points.
  // ----------------------------------------------------------------------
  // The slice-005 fixture gives every participant a prediction for every
  // match. To exercise the "no prediction" path we snapshot-and-delete
  // delta's M2 prediction inside the test body, trigger scoring, assert the
  // 'none' / 0 row, then restore the snapshot. The snapshot/restore is keyed
  // off the deterministic fixture UUID DELTA_M2_PREDICTION_ID.
  test(
    "AS4 — Given M2 is finished and delta has no valid prediction for M2, When scoring runs, Then delta is awarded exactly 0 points / 'none' @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const snapshot = await snapshotAndDeletePrediction(DELTA_M2_PREDICTION_ID);

      try {
        const { status, rawBody } = await callScoreTrigger(
          request,
          context,
          {
            scope: "match",
            target_id: M2,
            reason: "T009 AS4 — no valid prediction → 0 / 'none'",
            run_id: crypto.randomUUID(),
          },
        );

        expect(
          status,
          `score-trigger MUST return 200. Got body: ${rawBody}`,
        ).toBe(200);

        const deltaRows = await readScoreRecords(PARTICIPANTS.delta, M2);
        expect(
          deltaRows.length,
          "score_match MUST emit a row for every eligible participant, even those with no valid prediction",
        ).toBe(1);
        expect(
          deltaRows[0].points,
          "delta / M2 / no-prediction MUST award 0 points (FR-001 — no valid prediction → 0)",
        ).toBe(0);
        expect(
          deltaRows[0].reason_code,
          "delta / M2 / no-prediction MUST be reason_code='none' (FR-006 / personal-breakdown.read.md)",
        ).toBe("none");
      } finally {
        await snapshot.restore();
      }
    },
  );

  // ----------------------------------------------------------------------
  // AS5 — audit event captured for every score_records change.
  // ----------------------------------------------------------------------
  // After scoring M1, audit_log MUST contain at least 6 rows with
  //   entity_type='score_record', action='score_record.insert',
  //   previous_value=NULL, new_value->>'reason_code' IN the valid enum set,
  //   actor populated.
  // The "at least 6" lower bound matches the fixture (6 eligible participants
  // generate 6 inserts for one match).
  test(
    "AS5 — Given any scored prediction, When the score is calculated, Then an audit event MUST be recorded with previous_value=NULL, new_value, and actor @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const { status, rawBody } = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS5 — audit event captured",
        run_id: crypto.randomUUID(),
      });

      expect(
        status,
        `score-trigger MUST return 200. Got body: ${rawBody}`,
      ).toBe(200);

      const auditRows = await readScoreAuditRows(testStartInstant);
      expect(
        auditRows.length,
        "audit_log MUST contain at least 6 score_record.insert rows (one per eligible participant in the fixture)",
      ).toBeGreaterThanOrEqual(6);

      const validReasonCodes: ReadonlyArray<string> = [
        "exact",
        "outcome",
        "incorrect",
        "none",
      ];

      for (const row of auditRows) {
        expect(
          row.action,
          "every score_record audit row MUST use action='score_record.insert' (T014 spec)",
        ).toBe("score_record.insert");
        expect(
          row.previous_value,
          "score_record.insert MUST have previous_value=NULL (it is a fresh row)",
        ).toBeNull();
        expect(
          row.new_value,
          "score_record.insert MUST have a populated new_value jsonb",
        ).not.toBeNull();
        const reasonCode = row.new_value?.reason_code;
        expect(
          typeof reasonCode === "string" &&
            validReasonCodes.includes(reasonCode),
          `new_value.reason_code MUST be one of ${validReasonCodes.join(", ")}; got ${JSON.stringify(reasonCode)}`,
        ).toBe(true);
        expect(
          row.actor,
          "score_record.insert audit row MUST have a non-null actor (the run's triggered_by — T014 spec)",
        ).not.toBeNull();
      }
    },
  );

  // ----------------------------------------------------------------------
  // AS6 — recalc with a new run_id bumps calculation_version AND preserves
  // the prior version's rows.
  // ----------------------------------------------------------------------
  test(
    "AS6 — Given M1 was already scored, When scoring runs again with a different run_id, Then calculation_version bumps by +1 AND the prior version's rows remain in score_records @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const runR1 = crypto.randomUUID();
      const runR2 = crypto.randomUUID();
      expect(runR1).not.toBe(runR2); // sanity — randomUUID gave us two distinct ids.

      // First run.
      const first = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS6 — first run (R1)",
        run_id: runR1,
      });
      expect(
        first.status,
        `score-trigger R1 MUST return 200. Got body: ${first.rawBody}`,
      ).toBe(200);

      const rowsAfterR1 = await readScoreRecords(PARTICIPANTS.alpha, M1);
      expect(
        rowsAfterR1.length,
        "After R1, alpha MUST have exactly one score_records row for M1",
      ).toBe(1);
      const versionAfterR1 = rowsAfterR1[0].calculation_version;

      // Second run with a DIFFERENT run_id.
      const second = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS6 — second run (R2)",
        run_id: runR2,
      });
      expect(
        second.status,
        `score-trigger R2 MUST return 200. Got body: ${second.rawBody}`,
      ).toBe(200);

      const rowsAfterR2 = await readScoreRecords(PARTICIPANTS.alpha, M1);
      expect(
        rowsAfterR2.length,
        "After R2 (distinct run_id), alpha MUST have TWO score_records rows for M1 (prior version preserved per data-model § Entity 1 append-only)",
      ).toBe(2);

      const versions = rowsAfterR2
        .map((r) => r.calculation_version)
        .sort((a, b) => a - b);
      expect(
        versions[1],
        `New row's calculation_version MUST be ${versionAfterR1} + 1`,
      ).toBe(versionAfterR1 + 1);
      expect(
        versions[0],
        `Prior row's calculation_version MUST still equal ${versionAfterR1} (history preserved)`,
      ).toBe(versionAfterR1);

      // calculation_version_written on the response MUST match the latest.
      expect(
        second.parsed?.calculation_version_written,
        "Edge Function response calculation_version_written MUST equal the new version",
      ).toBe(versionAfterR1 + 1);
    },
  );

  // ----------------------------------------------------------------------
  // AS7 — idempotent retry with the SAME run_id returns the same body and
  // does NOT create duplicate score_records rows.
  // ----------------------------------------------------------------------
  // SC-007: scoring is idempotent under retry.
  test(
    "AS7 — Given M1 was scored under run_id R1, When the SAME run_id is POSTed a second time, Then the response body is identical AND score_records contains exactly 6 rows for M1@R1 (one per participant) @slice-005 @us1",
    async ({ page, request, context }) => {
      await signInWithIdentity(page, {
        claims: {
          sub: ADMIN1.sub,
          email: ADMIN1.email,
          email_verified: ADMIN1.email_verified,
          name: ADMIN1.name,
        },
      });

      const runR1 = crypto.randomUUID();

      const first = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS7 — first call",
        run_id: runR1,
      });
      expect(
        first.status,
        `score-trigger first call MUST return 200. Got body: ${first.rawBody}`,
      ).toBe(200);

      const second = await callScoreTrigger(request, context, {
        scope: "match",
        target_id: M1,
        reason: "T009 AS7 — retry with SAME run_id",
        run_id: runR1,
      });
      expect(
        second.status,
        `Idempotent retry MUST return 200 per contract § Error responses. Got body: ${second.rawBody}`,
      ).toBe(200);

      // The contract guarantees: "Idempotent retry of a previously-succeeded
      // run_id → returns the prior run summary unchanged".
      expect(
        second.parsed,
        "Second-call parsed body MUST be non-null",
      ).not.toBeNull();
      expect(
        second.parsed,
        "Idempotent retry MUST return the SAME response body as the first call (contract § Behavior step 2)",
      ).toEqual(first.parsed);

      // Now verify the DB: exactly 6 rows for M1 at run_id=R1 — one per
      // eligible participant in the fixture. No duplicates.
      const client = getServiceClient();
      const { data, error, count } = await client
        .from("score_records")
        .select("id,participant_id,calculation_version,run_id", {
          count: "exact",
        })
        .eq("target_id", M1)
        .eq("run_id", runR1);
      if (error) {
        throw new Error(`score_records count query: ${error.message}`);
      }
      expect(
        count,
        "After two calls with the SAME run_id, score_records MUST contain exactly 7 rows for (M1, R1) — one per active fixture participant (alpha/bravo/charlie/delta/epsilon/zeta/admin1), no duplicates (SC-007)",
      ).toBe(7);

      // And: the 7 participants are exactly the 7 active fixture participants.
      const participantIds = new Set((data ?? []).map((r) => r.participant_id));
      expect(participantIds.size).toBe(7);
      for (const pid of Object.values(PARTICIPANTS)) {
        expect(
          participantIds.has(pid),
          `participant ${pid} MUST appear in the (M1, R1) score_records set`,
        ).toBe(true);
      }
    },
  );
});
