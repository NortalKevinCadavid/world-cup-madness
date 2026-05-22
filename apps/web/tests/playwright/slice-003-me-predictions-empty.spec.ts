// --------------------------------------------------------------------------
// Slice 003 / T011 — `GET /api/me/predictions` empty-array path.
// --------------------------------------------------------------------------
// RED acceptance test for the "newly-signed-in participant with no
// predictions" branch of GET /api/me/predictions.
//
// Source of truth:
//   - specs/003-match-predictions/contracts/predictions.read.md § Endpoint
//     GET /api/me/predictions — returns `{predictions: []}` when no
//     active rows exist for the caller.
//
// Setup:
//   1. Synthesize a fresh identity via the OIDC stub (a brand-new
//      newcomer@nortal.com, eligible, never seen before). The Supabase
//      auth-hook from Slice 001 will provision a participants row on
//      first sign-in.
//   2. GET /api/me/predictions. Assert 200 + body == { predictions: [] }.
//
// Cleanup:
//   afterEach uses the service-role client to DELETE the synthesized
//   participants row (and the auth.users + audit rows linked to it) so
//   sibling tests start from the canonical fixture state. Slice 001's
//   auth hook on a deactivated/missing participants row is safe to
//   re-run.
//
// RED until T015's `/api/me/predictions` GET handler lands.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// Brand-new identity not present in any fixture file. The leading hex
// nibble 'f' avoids collision with slice-001's 'a','b','c','d','e' personas.
const NEWCOMER = {
  sub: "00000000-0000-0000-0000-00000000000f",
  email: "newcomer@nortal.com",
  email_verified: true,
  name: "Newcomer Tester",
} as const;

interface MePredictionsResponse {
  predictions: unknown[];
}

test.describe(
  "US1 — GET /api/me/predictions returns empty array for a newly-signed-in participant @slice-003 @us1",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
    });

    test.afterEach(async () => {
      await resetStub();

      // Service-role cleanup — remove the synthesized participant, any
      // audit_log rows for them, and the underlying auth.users row so the
      // next worker test starts from the canonical fixture state.
      const client = getServiceClient();

      // Delete by auth_user_id; predictions cascade off participant_id
      // (none expected for this persona, but defensive).
      const { data: row } = await client
        .from("participants")
        .select("id")
        .eq("auth_user_id", NEWCOMER.sub)
        .maybeSingle();

      if (row?.id) {
        await client.from("predictions").delete().eq("participant_id", row.id);
        await client.from("audit_log").delete().eq("actor", row.id);
        await client.from("participants").delete().eq("id", row.id);
      }
      // auth.users rows live in a schema the JS client cannot reach
      // directly without a custom RPC; leaving the auth row alive is
      // safe because the seed's ON CONFLICT DO NOTHING is idempotent.
    });

    test(
      "newly-signed-in participant with no predictions sees GET /api/me/predictions = { predictions: [] } @slice-003 @us1",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: NEWCOMER.sub,
            email: NEWCOMER.email,
            email_verified: NEWCOMER.email_verified,
            name: NEWCOMER.name,
          },
        });

        const response = await request.get("/api/me/predictions");
        expect(
          response.status(),
          "GET /api/me/predictions for an eligible session MUST be 200 (contract § 200)",
        ).toBe(200);

        const body = (await response.json()) as MePredictionsResponse;
        expect(body).toMatchObject({
          predictions: expect.any(Array),
        });
        expect(
          body.predictions.length,
          "a brand-new participant with no submissions MUST see an empty array",
        ).toBe(0);
      },
    );
  },
);
