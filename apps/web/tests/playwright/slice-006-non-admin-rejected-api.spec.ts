// --------------------------------------------------------------------------
// Slice 006 / T011 — non-admin direct API call is rejected (RED).
// --------------------------------------------------------------------------
// RED acceptance test for User Story 4 (P1) Acceptance Scenario 2:
//
//   "Given the same participant, When they call any admin API endpoint
//   directly with their session token, Then the API MUST reject the
//   request with the same denial regardless of route." (FR-005 —
//   Constitution Principle II — UI gating MUST NOT be the sole gate.)
//
//   + Acceptance Scenario 3: audit event recorded.
//
// Source of truth:
//   - specs/006-admin-overrides/contracts/admin-ui.surface.md
//       § `requireAdmin(client)` — the same helper guards the route
//       handler at `/api/admin/match-results`. The handler returns 403
//       with `{ error: { code: 'FORBIDDEN', reason: 'admin_required' } }`
//       when AdminAccessDeniedError is thrown.
//   - specs/006-admin-overrides/contracts/admin-rpcs.write.md § Pre-flight
//       — WAR01 → HTTP 403 envelope.
//   - specs/006-admin-overrides/spec.md § US4 AS2 + AS3.
//
// Persona: alpha (eligible, NOT admin).
//
// Behavior path:
//   alpha signs in via the Playwright page so the cookie jar holds a
//   real Supabase session JWT. We then call `request.post('/api/admin/...')`
//   — Playwright's `request` shares context with the browser when the
//   `page` fixture is used (cookie jar is forwarded automatically for
//   same-origin URLs against baseURL).
//
// Cleanup contract:
//   beforeEach: resetStub + assert alpha is NOT admin + snapshot M1
//   match_results. afterEach: restore M1 (defensive — the request MUST
//   NOT mutate state) + resetStub.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  participantId: "11111111-1111-1111-1111-111111111111",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const M1 = "eeee0050-0000-0000-0000-000000000001";

interface MatchResultsRow {
  match_id: string;
  home_score: number;
  away_score: number;
  home_score_for_scoring: number;
  away_score_for_scoring: number;
  result_status: string;
  source: string;
}

interface AuditLogRow {
  id: string;
  actor: string | null;
  action: string;
  reason: string | null;
  source: string;
  occurred_at: string;
}

async function assertAlphaNotAdmin(): Promise<void> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("admin_roles")
    .select("id")
    .eq("participant_id", ALPHA.participantId)
    .is("revoked_at", null);
  if (error) {
    throw new Error(`assertAlphaNotAdmin: ${error.message}`);
  }
  if (data && data.length > 0) {
    throw new Error(
      `Precondition failed: alpha (${ALPHA.participantId}) has an active admin_roles row.`,
    );
  }
}

async function readM1MatchResults(): Promise<MatchResultsRow | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("match_results")
    .select(
      "match_id,home_score,away_score,home_score_for_scoring,away_score_for_scoring,result_status,source",
    )
    .eq("match_id", M1)
    .maybeSingle();
  if (error) {
    throw new Error(`readM1MatchResults: ${error.message}`);
  }
  return (data ?? null) as MatchResultsRow | null;
}

async function restoreM1(snapshot: MatchResultsRow): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("match_results")
    .update({
      home_score: snapshot.home_score,
      away_score: snapshot.away_score,
      home_score_for_scoring: snapshot.home_score_for_scoring,
      away_score_for_scoring: snapshot.away_score_for_scoring,
      result_status: snapshot.result_status,
      source: snapshot.source,
    })
    .eq("match_id", M1);
  if (error) {
    throw new Error(`restoreM1: ${error.message}`);
  }
}

async function readAlphaAccessDeniedRows(since: Date): Promise<AuditLogRow[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("audit_log")
    .select("id,actor,action,reason,source,occurred_at")
    .eq("action", "admin.access_denied")
    .eq("actor", ALPHA.participantId)
    .gte("occurred_at", since.toISOString())
    .order("occurred_at", { ascending: false });
  if (error) {
    throw new Error(`readAlphaAccessDeniedRows: ${error.message}`);
  }
  return (data ?? []) as AuditLogRow[];
}

interface ErrorBody {
  error: {
    code: string;
    reason?: string;
    message?: string;
  };
}

test.describe(
  "US4 — non-admin direct API call rejected with 403 @slice-006 @us1",
  () => {
    test.setTimeout(60_000);

    let snapshot: MatchResultsRow | null = null;
    let testStartInstant: Date;

    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      await assertAlphaNotAdmin();
      const snap = await readM1MatchResults();
      if (!snap) {
        throw new Error(
          `M1 (${M1}) match_results row missing — confirm supabase/seed/slice-005-fixture.sql was applied.`,
        );
      }
      snapshot = snap;
      testStartInstant = new Date();
    });

    test.afterEach(async () => {
      if (snapshot) {
        await restoreM1(snapshot);
      }
      await resetStub();
    });

    test(
      "alpha (non-admin) POST /api/admin/match-results returns 403 FORBIDDEN; audit row written; match_results unchanged @slice-006 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: ALPHA.sub,
            email: ALPHA.email,
            email_verified: ALPHA.email_verified,
            name: ALPHA.name,
          },
        });

        // Forward signed-in cookies. (Earlier assumption was that the bare
        // `request` fixture shared storage state with `page`, but after the
        // Keycloak/PKCE migration in commit 5a74acf the session lives in
        // sb-*-auth-token cookies on the page's BrowserContext only — see
        // specs/001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md.)
        const cookies = await page.context().cookies();
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

        const response = await request.post("/api/admin/match-results", {
          headers: { Cookie: cookieHeader },
          data: {
            match_id: M1,
            home_score: 4,
            away_score: 4,
            home_score_for_scoring: 4,
            away_score_for_scoring: 4,
            result_status: "regulation",
            reason: "T011 attempt by non-admin (should be denied)",
            source_citation: "https://fifa.example/non-admin-attempt",
          },
        });

        expect(
          response.status(),
          "POST /api/admin/match-results by non-admin MUST return 403 " +
            "(admin-ui.surface.md § requireAdmin(client); admin-rpcs.write.md § WAR01)",
        ).toBe(403);

        const body = (await response.json()) as ErrorBody;
        expect(
          body.error,
          "403 body MUST have an `error` envelope",
        ).toBeDefined();
        expect(
          body.error.code,
          "403 body error.code MUST be 'FORBIDDEN' (admin-ui.surface.md § Cross-slice contract — Locked per WAR01)",
        ).toBe("FORBIDDEN");
        expect(
          body.error.reason,
          "403 body error.reason MUST be 'admin_required' (FR-005 / Constitution II — UI MUST NOT be sole gate)",
        ).toBe("admin_required");

        // Service-role verify: audit_log row admin.access_denied for alpha.
        const auditRows = await readAlphaAccessDeniedRows(testStartInstant);
        expect(
          auditRows.length,
          "audit_log MUST contain at least one admin.access_denied row for alpha (US4 AS3)",
        ).toBeGreaterThanOrEqual(1);
        expect(auditRows[0].action).toBe("admin.access_denied");
        expect(
          auditRows[0].actor,
          `audit row actor MUST equal alpha's participants.id ('${ALPHA.participantId}')`,
        ).toBe(ALPHA.participantId);

        // Service-role verify: match_results MUST NOT have changed.
        const after = await readM1MatchResults();
        expect(after, "match_results row MUST still exist").not.toBeNull();
        expect(
          after!.home_score,
          `match_results.home_score MUST remain ${snapshot!.home_score} after the 403`,
        ).toBe(snapshot!.home_score);
        expect(
          after!.away_score,
          `match_results.away_score MUST remain ${snapshot!.away_score} after the 403`,
        ).toBe(snapshot!.away_score);
        expect(
          after!.home_score_for_scoring,
          `match_results.home_score_for_scoring MUST remain ${snapshot!.home_score_for_scoring}`,
        ).toBe(snapshot!.home_score_for_scoring);
        expect(
          after!.away_score_for_scoring,
          `match_results.away_score_for_scoring MUST remain ${snapshot!.away_score_for_scoring}`,
        ).toBe(snapshot!.away_score_for_scoring);
      },
    );
  },
);
