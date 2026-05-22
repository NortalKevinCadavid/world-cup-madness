// --------------------------------------------------------------------------
// Slice 004 / T022 — POST /api/final-predictions ignores client-supplied
// time and bypass attempts (US3.4 / FR-005 / BR-LOCK-001).
// --------------------------------------------------------------------------
// RED acceptance test for the "trusted server clock" invariant:
//
//   FR-005: "System MUST consult only trusted server time for the lock
//   decision; client-supplied time MUST be ignored (BR-LOCK-001)."
//
// The POST contract (specs/004-final-predictions/contracts/
// final-predictions.write.md § Request body) defines exactly three input
// fields: `item_kind`, `target_team_id`, `target_player_id`. There is no
// `now`, no `client_now`, no `X-Client-Now` header, no `fake_now`. A
// malicious or buggy client SHOULD NOT be able to inject a future
// timestamp and slip past the global lock.
//
// Test design choice:
//   The route's zod schema (T018) is NOT `.strict()` — by default zod
//   strips unknown keys from the parsed object. This means a client can
//   safely send extra fields like `fake_now` and the handler will simply
//   ignore them. THAT'S THE CORRECT BEHAVIOUR: extra fields neither
//   error the request out (which would be hostile to forward-compat
//   clients) NOR are they honored as lock-bypass overrides.
//
//   Likewise, the request can include arbitrary headers (e.g.
//   `X-Client-Now`) — Next.js's request object does not surface them to
//   user-land unless the route reads them. The T018 handler reads NONE
//   of these headers in its lock-check path; it only invokes the SP,
//   which consults Postgres `now()`.
//
//   So the assertion is straightforward:
//     - Lock the system (first_kickoff_utc = 1s in the past).
//     - POST with a body that includes both the valid contract fields
//       AND extra "future clock" fields (`fake_now`, `client_now`,
//       `now`) plus a `X-Client-Now` header in the future.
//     - Assert: response is 409 FINAL_PREDICTIONS_LOCKED. Extra fields
//       did NOT bypass the lock; extra headers did NOT bypass the lock.
//
// This proves the route's lock decision is independent of any
// client-supplied value (FR-005 / BR-LOCK-001 satisfied).
//
// Persona: charlie.
//
// Source of truth:
//   - specs/004-final-predictions/spec.md FR-005, US3 AS-4 (via US2 lock).
//   - specs/004-final-predictions/contracts/final-predictions.write.md
//     § Request body (canonical three fields only).
//   - T018 handler: `SUBMIT_SCHEMA` is z.object().superRefine — no
//     `.strict()`, so unknown keys are dropped, not rejected.
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  participantId: "33333333-3333-3333-3333-333333333333",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;

const POL_TEAM_ID = "aaaa0000-0000-0000-0000-000000000004";
const FIXTURE_FIRST_KICKOFF = "2026-06-16T20:00:00Z";

// A "future" timestamp the bad client might try to inject. Far enough in
// the future that, were it honored, the lock predicate would say
// "editable". Test purpose: prove it is NOT honored.
const FUTURE_FAKE_NOW = "2099-01-01T00:00:00Z";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    reason?: string;
  };
}

async function setFirstKickoffUtc(isoValue: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("tournament_config")
    .update({ value: isoValue })
    .eq("key", "first_kickoff_utc");
  if (error) {
    throw new Error(`setFirstKickoffUtc(${isoValue}) failed — ${error.message}`);
  }
}

async function deleteCharlieChampionRows(): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from("final_predictions")
    .delete()
    .eq("participant_id", CHARLIE.participantId)
    .eq("item_kind", "champion");
  if (error) {
    throw new Error(`deleteCharlieChampionRows failed — ${error.message}`);
  }
}

test.describe(
  "US2/FR-005 — client clock / extra fields cannot bypass lock @slice-004 @us2",
  () => {
    test.beforeAll(async () => {
      await assertOidcStubReachable();
    });

    test.beforeEach(async () => {
      await resetStub();
      // Lock the system: first_kickoff_utc 1s in the past.
      const justAfterIso = new Date(Date.now() - 1000).toISOString();
      await setFirstKickoffUtc(justAfterIso);
    });

    test.afterEach(async () => {
      await setFirstKickoffUtc(FIXTURE_FIRST_KICKOFF);
      await deleteCharlieChampionRows();
      await resetStub();
    });

    test(
      "charlie POST with future fake_now field + X-Client-Now header still returns 409 (server clock is authoritative) @slice-004 @us2",
      async ({ page, request }) => {
        await signInWithIdentity(page, {
          claims: {
            sub: CHARLIE.sub,
            email: CHARLIE.email,
            email_verified: CHARLIE.email_verified,
            name: CHARLIE.name,
          },
        });

        const response = await request.post("/api/final-predictions", {
          headers: {
            // Bogus header — handler MUST NOT consult it.
            "X-Client-Now": FUTURE_FAKE_NOW,
          },
          // Extra body fields the client hopes the server will honor as a
          // clock override. Per T018's zod schema (no `.strict()`),
          // unknown keys are silently stripped. The SP's lock check then
          // runs against Postgres `now()` only.
          data: {
            item_kind: "champion",
            target_team_id: POL_TEAM_ID,
            fake_now: FUTURE_FAKE_NOW,
            client_now: FUTURE_FAKE_NOW,
            now: FUTURE_FAKE_NOW,
          },
        });

        expect(
          response.status(),
          "client-supplied future clock MUST NOT bypass the server lock (FR-005)",
        ).toBe(409);

        const body = (await response.json()) as ErrorBody;
        expect(
          body.error.code,
          "error.code MUST remain 'FINAL_PREDICTIONS_LOCKED' regardless of injected clock fields",
        ).toBe("FINAL_PREDICTIONS_LOCKED");
        expect(
          body.error.reason,
          "error.reason MUST remain 'lock_window_passed'",
        ).toBe("lock_window_passed");
      },
    );
  },
);
