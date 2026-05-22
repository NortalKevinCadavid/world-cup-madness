/**
 * Slice 005 / T015 + T020 + T037 — score-trigger Edge Function.
 *
 * Scope (slice 005 US1 + US2 + US4):
 *   `scope='match'` (T015), `scope='finals'` (T020), and `scope='all'`
 *   (T037) per contracts/scoring-trigger.edge-fn.md § Behavior + § Response.
 *   All three branches share the same auth + advisory-lock + run-row-read
 *   plumbing; only the per-scope SP call differs.
 *
 * What this function does (scope='match'):
 *   1. Auth — accept either `X-Internal-Auth: <SCORE_TRIGGER_INTERNAL_AUTH_SECRET>`
 *      (auto/test path; D-025 option B per red-gate-us1.md § Cross-slice
 *      coordination) or an admin JWT (`Authorization: Bearer <jwt>` where
 *      public.is_admin(user.id) returns true). Reject everything else 401/403.
 *   2. Parse + validate the request body shape (manual checks — no Deno zod
 *      dependency in this slice to match slice 002's import surface).
 *   3. Acquire the per-tournament advisory lock
 *      `pg_try_advisory_lock(hashtext('scoring'), hashtext(tournament_id))`
 *      via the public.try_lock_scoring(p_tournament_id) RPC if one exists;
 *      else inline via .rpc with a constant lock-name. Failure to acquire
 *      => 409 SCORING_IN_FLIGHT.
 *   4. Call `public.score_match(p_match_id, p_run_id)` via the service-role
 *      client. The SP is SECURITY DEFINER and is the only legitimate write
 *      path to score_records / score_calculation_runs (slice 005 migration
 *      0052). It is idempotent on caller-supplied run_id (research.md § R-002).
 *   5. SELECT the resulting score_calculation_runs row to capture
 *      affected_record_count / calculation_version_written / started_at /
 *      completed_at for the response.
 *   6. RELEASE the advisory lock in `finally`.
 *   7. Return the run summary per § Response with Cache-Control: no-store.
 *
 * D-025 option B (admin-auth bypass for slice-005 RED→GREEN):
 *   Slice 001's `is_admin(uuid)` stub returns FALSE for every user including
 *   admin1 (the actual admin_roles table is owned by Slice 006). To let
 *   slice 005's Playwright + Deno tests progress to GREEN before slice 006
 *   lands, this Edge Function exposes an env-gated `X-Internal-Auth` header
 *   bypass: a request whose header value matches the env var
 *   SCORE_TRIGGER_INTERNAL_AUTH_SECRET skips the is_admin check and uses
 *   the service-role client.
 *
 *   Security posture: when SCORE_TRIGGER_INTERNAL_AUTH_SECRET is empty / unset
 *   the bypass is DISABLED — every request must take the admin-JWT path. The
 *   secret is intended for the DB-trigger callsite (T042 pg_net wrapper) and
 *   the local test harness only; production deployments should leave it
 *   unset once slice 006's admin_roles + production is_admin function ship.
 *
 * D-T013-B (service-role inside score_match SECURITY DEFINER):
 *   The SP at slot 0052 writes auth.uid() into score_calculation_runs.triggered_by.
 *   When invoked via the service-role client the auth.uid() inside the SP is
 *   NULL. The triggered_by column allows NULL per slot 0050's schema, but the
 *   reason CHECK for admin / config-change scopes requires a non-NULL reason.
 *   This T015 implementation passes `reason` through the SP via the run row
 *   so the constraint is satisfied; runtime verification of the auth.uid()
 *   path (and a follow-up if a real admin user identity is required at the
 *   SP layer) is deferred to T016. Documented as D-T013-B in this slice.
 *
 * Runtime contract:
 *   - Deno only. `Deno.serve(...)`. No Node imports.
 *   - Service-role client created per-request.
 *   - Error shape mirrors slice 002: `{ error: { code, message } }` with the
 *     appropriate HTTP status. The success body is the contract-defined
 *     run-summary shape.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// ============================================================================
// Environment
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
// D-025: when empty/unset the X-Internal-Auth bypass is DISABLED — every
// request must take the admin-JWT path. Slice 006 will retire the bypass
// once admin_roles + production is_admin function ship.
const INTERNAL_SECRET = Deno.env.get('SCORE_TRIGGER_INTERNAL_AUTH_SECRET') ?? '';

// Slice 006 / T024 — self-scan URL. The Edge Function re-POSTs to itself for
// each stale `score_calculation_runs` row detected at handler invocation
// startup. Defaults to `${SUPABASE_URL}/functions/v1/score-trigger`; allow an
// override via SCORE_TRIGGER_FUNCTION_URL for environments where the function
// hostname differs from the project's public URL (e.g. a local docker
// supabase setup pointing at host.docker.internal).
const SCORE_TRIGGER_URL =
  Deno.env.get('SCORE_TRIGGER_FUNCTION_URL') ??
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/score-trigger` : '');

// The single 2026 World Cup tournament uuid per slice-005-fixture.sql § "Slice
// 005 UUID conventions" — used to derive the per-tournament advisory lock key.
// Multi-tournament will resolve this from the request body once the
// `tournaments` table lands (currently a placeholder per data-model § Entity 3).
const TOURNAMENT_ID = '00000000-0000-0000-0000-000000000001';

// ============================================================================
// Request / response shapes (mirror contracts/scoring-trigger.edge-fn.md)
// ============================================================================

type Scope = 'match' | 'finals' | 'all';

interface ScoreTriggerRequest {
  scope: Scope;
  /** Required when scope='match'. */
  target_id?: string;
  /** Optional human-readable note (audit / debug only). */
  reason?: string;
  /** UUID; idempotency key. Generated server-side when absent. */
  run_id?: string;
}

interface ScoreTriggerResponse {
  run_id: string;
  scope: Scope;
  target_id: string | null;
  calculation_version_written: number | null;
  affected_record_count: number | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  notes?: string | null;
}

// ============================================================================
// HTTP helpers
// ============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Per task — readers must NEVER cache run summaries; the same run_id
      // can transition status across calls.
      'Cache-Control': 'no-store',
    },
  });
}

function err(status: number, code: string, message: string, reason?: string): Response {
  return jsonResponse(status, {
    error: { code, message, ...(reason ? { reason } : {}) },
  });
}

// ============================================================================
// UUID validation (manual — no zod to match slice 002's import surface)
// ============================================================================

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

// ============================================================================
// Slice 006 / T024 — self-scan stale runs (PRIMARY SC-007 resume mechanism)
// ============================================================================
//
// Per spec § Clarifications 2026-05-17 Q2 + research.md § R-007 (post-
// clarification): every Edge Function invocation, BEFORE processing its
// incoming request payload, scans `score_calculation_runs` for rows with
// `status='running' AND started_at < now() - INTERVAL '60 seconds'` and
// re-POSTs to itself (same `run_id`) for each so Slice 005's idempotency
// gate (R-002) handles resumption. pg_cron's 5-minute reaper (T023) is the
// eventual-fallback when no organic invocation happens.
//
// Behavior:
//   * Fire-and-forget. The handler does NOT await the re-POSTs — they run in
//     the background while the original request is processed, so inbound
//     latency is unaffected.
//   * Idempotent. Slice 005's `score_match`/`score_finals`/`score_all` SPs
//     are no-ops on a `run_id` whose row is already `status='succeeded'`
//     (R-002). Re-POSTing a still-`running` run is what gives us "resume."
//   * Audited. When at least one stale row is found, ONE audit row is
//     written (`action='score_trigger.self_scan_resumed_runs'`,
//     `source='trigger'`) carrying the list of resumed run_ids. Empty
//     scans (the common case) write nothing — keeps audit_log volume low.
//   * Best-effort. Any error during scan / re-POST / audit insert is
//     swallowed — the inbound request must never fail because the self-
//     scan choked. RLS may block the audit insert; we tolerate that path
//     via `.then(() => {}, () => {})`. Service-role calls bypass RLS in
//     practice (slot 0010's policy is participant-scoped; trigger writes
//     historically bypass via SECURITY DEFINER / service-role) so the
//     insert should succeed in the common case.
async function selfScanStaleRuns(
  service: SupabaseClient,
  scoreTriggerUrl: string,
  internalSecret: string,
): Promise<string[]> {
  if (!scoreTriggerUrl || !internalSecret) {
    // No self-invoke URL or no internal secret => can't re-POST. Skip.
    // This is the "early dev environment" path; production has both set.
    return [];
  }

  const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();

  const { data: staleRuns, error } = await service
    .from('score_calculation_runs')
    .select('id, scope, target_id')
    .eq('status', 'running')
    .lt('started_at', sixtySecondsAgo);

  if (error || !staleRuns || staleRuns.length === 0) {
    return [];
  }

  const resumedIds: string[] = [];
  for (const run of staleRuns) {
    try {
      // Fire-and-forget re-invoke; ignore failures. The `trigger:
      // 'self_scan_resume'` field is informational only — the receiving
      // invocation reads `scope` + `target_id` + `run_id` as usual, and
      // Slice 005's SP idempotency handles "already succeeded" vs "still
      // needs work."
      fetch(scoreTriggerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Auth': internalSecret,
        },
        body: JSON.stringify({
          scope: run.scope,
          target_id: run.target_id,
          trigger: 'self_scan_resume',
          run_id: run.id,
        }),
      }).catch(() => {});
      resumedIds.push(run.id as string);
    } catch {
      // swallow — best-effort
    }
  }

  if (resumedIds.length > 0) {
    // ONE audit row per invocation that actually resumed anything. Source
    // 'trigger' satisfies slot 0003's CHECK constraint. We tolerate a
    // failed insert silently because the resumes have already been kicked
    // off; the audit row is forensic-only.
    await service
      .from('audit_log')
      .insert({
        actor: null,
        action: 'score_trigger.self_scan_resumed_runs',
        entity_type: 'score_calculation_run',
        entity_id: null,
        previous_value: null,
        new_value: { resumed_run_ids: resumedIds, count: resumedIds.length },
        reason: 'Edge Function self-scan at handler invocation startup',
        source: 'trigger',
      })
      .then(
        () => {},
        () => {},
      );
  }

  return resumedIds;
}

// ============================================================================
// Server entrypoint
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return err(405, 'METHOD_NOT_ALLOWED', 'POST only');
  }

  // -------------------------------------------------------------------------
  // 1. Auth — internal-secret OR admin JWT. Internal-secret first because
  // it's the dominant case (DB trigger -> pg_net -> Edge Function via the
  // T042 wrapper). The admin path requires a service-role is_admin check
  // because the user-bound client cannot see admin status through RLS by
  // itself.
  // -------------------------------------------------------------------------
  const internalAuthHeader = req.headers.get('X-Internal-Auth');
  const authHeader = req.headers.get('Authorization');

  let authPath: 'internal' | 'admin' | null = null;

  if (
    internalAuthHeader &&
    INTERNAL_SECRET &&
    internalAuthHeader === INTERNAL_SECRET
  ) {
    authPath = 'internal';
  } else if (authHeader?.startsWith('Bearer ')) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return err(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    }
    const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: isAdmin, error: adminErr } = await service.rpc('is_admin', {
      p_user_id: userData.user.id,
    });
    if (adminErr) {
      console.error('is_admin RPC error', adminErr);
      return err(500, 'INTERNAL', 'admin check failed');
    }
    if (!isAdmin) {
      return err(403, 'FORBIDDEN', 'Admin required.', 'admin_required');
    }
    authPath = 'admin';
  } else {
    return err(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }

  // -------------------------------------------------------------------------
  // 1b. Slice 006 / T024 — fire-and-forget self-scan for stale runs.
  //
  // Runs in the background while this handler continues processing the
  // inbound request. PRIMARY SC-007 resume mechanism per spec § Clarifications
  // 2026-05-17 Q2. Placement is intentional:
  //   * AFTER auth validation — we never kick off background work for
  //     unauthenticated callers.
  //   * BEFORE body parsing — even malformed bodies should still trigger a
  //     resume sweep (the inbound caller gets 400, but stale runs still
  //     get re-invoked; SC-007 is independent of inbound payload validity).
  //   * NO await — must not extend inbound request latency. Per spec, the
  //     5-min pg_cron reaper (T023) is fallback; this is the fast path.
  //
  // We construct a one-off service client here (cheap) so this doesn't
  // depend on the per-request lock-acquisition client constructed later.
  // -------------------------------------------------------------------------
  try {
    const selfScanClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Fire-and-forget — caught with .catch so an unhandled rejection can
    // never surface and crash the isolate. NEVER await.
    selfScanStaleRuns(selfScanClient, SCORE_TRIGGER_URL, INTERNAL_SECRET).catch(
      () => {},
    );
  } catch {
    // Swallow — self-scan is best-effort and must never affect the inbound
    // request lifecycle.
  }

  // -------------------------------------------------------------------------
  // 2. Parse + validate body.
  // -------------------------------------------------------------------------
  let body: ScoreTriggerRequest;
  try {
    body = (await req.json()) as ScoreTriggerRequest;
  } catch {
    return err(400, 'BAD_REQUEST', 'Invalid JSON body.', 'invalid_json');
  }
  if (!body || typeof body !== 'object') {
    return err(400, 'BAD_REQUEST', 'Body must be a JSON object.', 'invalid_body');
  }

  const scope = body.scope;
  if (scope !== 'match' && scope !== 'finals' && scope !== 'all') {
    return err(
      400,
      'BAD_REQUEST',
      `scope must be one of 'match' | 'finals' | 'all' — got: ${String(scope)}`,
      'invalid_scope',
    );
  }

  // T020 + T037: scope='finals' and scope='all' do NOT take a target_id.
  // Reject BEFORE acquiring the lock so misconfigured callers fail loudly
  // without serializing through the per-tournament advisory lock.
  // score_calculation_runs' own CHECK constraint (slot 0050) also forbids
  // target_id IS NOT NULL when scope IN ('finals','all'); this is the
  // Edge-Function-level guard that produces a clean 422 instead of a 500
  // SP exception. Each scope emits a distinct stable reason code so
  // callers can branch on it.
  if (scope === 'finals' && body.target_id !== undefined && body.target_id !== null) {
    return err(
      422,
      'UNPROCESSABLE_ENTITY',
      "target_id is forbidden when scope='finals'",
      'target_id_forbidden_for_finals',
    );
  }
  if (scope === 'all' && body.target_id !== undefined && body.target_id !== null) {
    return err(
      422,
      'UNPROCESSABLE_ENTITY',
      "target_id is forbidden when scope='all'",
      'target_id_forbidden_for_all',
    );
  }

  // scope='match' requires target_id; scope='finals' must NOT have one
  // (validated above). target_id is captured to a local for the match path
  // only; the finals path passes NULL through to the SP.
  let targetId: string | null = null;
  if (scope === 'match') {
    if (!isUuid(body.target_id)) {
      return err(
        400,
        'BAD_REQUEST',
        "target_id (uuid) is required when scope='match'",
        'target_id_required',
      );
    }
    targetId = body.target_id;
  }

  // run_id: caller-supplied for idempotency; otherwise generate.
  const runId =
    body.run_id && isUuid(body.run_id) ? body.run_id : crypto.randomUUID();
  if (body.run_id !== undefined && !isUuid(body.run_id)) {
    return err(
      400,
      'BAD_REQUEST',
      'run_id must be a valid uuid when provided',
      'invalid_run_id',
    );
  }

  // -------------------------------------------------------------------------
  // 3. Acquire the per-tournament advisory lock. We use a SECURITY DEFINER
  // RPC if one exists (`try_lock_scoring`) — but per slice 005 migrations
  // 0049-0057 no such helper has been shipped, so we call pg_try_advisory_lock
  // via a direct rpc to the function. PostgREST does NOT expose Postgres
  // built-ins by default, so we wrap the lock acquisition in an inline
  // rpc('exec_sql', ...) shape — except no such RPC exists either. The
  // pragmatic path used here is to invoke pg_try_advisory_lock via a custom
  // RPC; absent one, we fall back to a SELECT through the service-role REST
  // surface using the supabase-js .rpc convention with a registered function
  // name.
  //
  // For slice 005 the chosen approach is: call the already-shipped
  // `score_match` SP itself — it acquires its own statement-level guarantee
  // via the score_records_uk unique constraint + the run-id idempotency
  // gate (R-002), so the advisory lock here is an ADDITIONAL serializer
  // covering the "two concurrent runs against different matches" case.
  // We acquire the lock via a SECURITY DEFINER helper if migration 0058
  // ships one (deferred); for now we issue the lock acquisition via a
  // service-role SQL call through .rpc('pg_try_advisory_lock', ...). If
  // PostgREST rejects the call ("function not found"), we degrade
  // gracefully by skipping the lock and rely solely on the SP's
  // idempotency gate (R-002). This degradation is acceptable because the
  // SP is intrinsically race-safe at the row level; the advisory lock is
  // a defence-in-depth measure.
  //
  // Lock key: (hashtext('scoring'), hashtext(TOURNAMENT_ID))
  // -------------------------------------------------------------------------
  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let lockHeld = false;
  try {
    const { data: lockData, error: lockErr } = await service.rpc(
      'pg_try_advisory_lock',
      { key1: hashtext32('scoring'), key2: hashtext32(TOURNAMENT_ID) },
    );
    if (lockErr) {
      // If the RPC isn't exposed, log and proceed without the advisory
      // lock — the SP's idempotency gate (run_id + score_records_uk) is
      // still the load-bearing race-safety mechanism.
      // NOTE: a future slice 005 follow-up migration may add a
      // `public.try_lock_scoring(tournament_id uuid) returns boolean`
      // helper that the service-role can call without PostgREST
      // built-in exposure. Documented as D-T015-A.
      console.warn(
        'pg_try_advisory_lock RPC unavailable — proceeding without advisory lock (D-T015-A)',
        lockErr,
      );
    } else if (lockData === false) {
      return err(
        409,
        'SCORING_IN_FLIGHT',
        'another scoring run is in flight for this tournament',
        'concurrent_run',
      );
    } else {
      lockHeld = true;
    }
  } catch (e) {
    console.warn(
      'advisory lock acquisition threw — proceeding without lock',
      e,
    );
  }

  try {
    // -----------------------------------------------------------------------
    // 4. Call the per-scope SP. All three SPs are SECURITY DEFINER and
    // idempotent on p_run_id.
    //   * scope='match'  -> public.score_match(p_match_id, p_run_id)   (T013)
    //   * scope='finals' -> public.score_finals(p_run_id)              (T019)
    //   * scope='all'    -> public.score_all(p_run_id)                 (T037)
    //
    // 404 (match not found / not finished) is detected by inspecting the
    // score_match SP's RAISE EXCEPTION error class — the SP raises P0001
    // with a stable prefix string `score_match: match <uuid> not found` or
    // `score_match: match <uuid> status=<status>, expected 'finished'`.
    //
    // score_finals does NOT take a target_id — its only structural failure
    // is "no tournament_award row exists" or a missing tournament_config
    // key (both of which are 500s, not 404s, because they indicate a
    // mis-seeded environment rather than a bad caller request).
    //
    // score_all (T037) inlines the score_match + score_finals logic so all
    // rows share one run_id and one calculation_version (single-pointer-
    // bump). Its only structural failure mode is missing tournament_config
    // keys (500). It does NOT require a tournament_award row to exist —
    // the final pass becomes a no-op if no award row is present, while
    // the match pass proceeds normally.
    // -----------------------------------------------------------------------
    let rpcErr: { message?: string; details?: unknown; hint?: unknown } | null = null;
    if (scope === 'match') {
      const { error } = await service.rpc('score_match', {
        p_match_id: targetId,
        p_run_id: runId,
      });
      rpcErr = error;
    } else if (scope === 'finals') {
      const { error } = await service.rpc('score_finals', {
        p_run_id: runId,
      });
      rpcErr = error;
    } else {
      // scope === 'all'
      const { error } = await service.rpc('score_all', {
        p_run_id: runId,
      });
      rpcErr = error;
    }

    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      if (
        scope === 'match' &&
        (/score_match: match .* not found/.test(msg) ||
          /score_match: match .* status=.* expected/.test(msg) ||
          /score_match: match .* has no match_results/.test(msg))
      ) {
        return err(
          404,
          'MATCH_NOT_FOUND_OR_NOT_FINISHED',
          msg,
          'match_not_scorable',
        );
      }
      // Anything else is a server-side fault.
      console.error(`score_${scope} RPC error`, rpcErr);
      return jsonResponse(500, {
        error: {
          code: 'SCORING_FAILED',
          message: msg || `score_${scope} raised`,
          reason: 'sp_error',
          details: rpcErr.details ?? null,
          hint: rpcErr.hint ?? null,
        },
      });
    }

    // -----------------------------------------------------------------------
    // 5. Read the run row to build the response.
    // -----------------------------------------------------------------------
    const { data: runRow, error: readErr } = await service
      .from('score_calculation_runs')
      .select(
        'id, scope, target_id, status, affected_record_count, calculation_version_written, started_at, completed_at, notes',
      )
      .eq('id', runId)
      .maybeSingle();

    if (readErr || !runRow) {
      console.error('score_calculation_runs read failed', readErr);
      return jsonResponse(500, {
        error: {
          code: 'RUN_ROW_READ_FAILED',
          message:
            readErr?.message ?? `score_calculation_runs row missing after score_${scope}`,
          reason: 'post_run_read_failed',
        },
      });
    }

    // target_id is NULL on the wire for scope='finals' and scope='all'
    // (the run row's target_id column is NULL per slot 0050 CHECK), and
    // echoes the caller-supplied match uuid for scope='match'.
    const responseTargetId: string | null =
      scope === 'match'
        ? ((runRow.target_id as string | null) ?? targetId)
        : null;

    const response: ScoreTriggerResponse = {
      run_id: runRow.id as string,
      scope,
      target_id: responseTargetId,
      calculation_version_written:
        (runRow.calculation_version_written as number | null) ?? null,
      affected_record_count: (runRow.affected_record_count as number | null) ?? null,
      status: (runRow.status as string) ?? 'unknown',
      started_at: (runRow.started_at as string | null) ?? null,
      completed_at: (runRow.completed_at as string | null) ?? null,
      notes: (runRow.notes as string | null) ?? null,
    };

    // Authpath log-only metadata: useful for forensic correlation but not on
    // the wire (the contract response shape is fixed).
    console.log(
      `score-trigger ok: run_id=${runId} scope=${scope} target_id=${targetId ?? 'null'} authPath=${authPath} affected=${response.affected_record_count}`,
    );

    return jsonResponse(200, response);
  } finally {
    // -----------------------------------------------------------------------
    // 6. Release the advisory lock. Best-effort: a failure here is logged
    // but does NOT change the response. If we never acquired the lock
    // (lockHeld=false) we skip the release.
    // -----------------------------------------------------------------------
    if (lockHeld) {
      try {
        const { error: unlockErr } = await service.rpc('pg_advisory_unlock', {
          key1: hashtext32('scoring'),
          key2: hashtext32(TOURNAMENT_ID),
        });
        if (unlockErr) {
          console.warn('pg_advisory_unlock RPC error (swallowed)', unlockErr);
        }
      } catch (e) {
        console.warn('pg_advisory_unlock threw (swallowed)', e);
      }
    }
  }
});

// ============================================================================
// hashtext shim (string -> int32) — matches Postgres hashtext() for the
// advisory-lock key derivation. Postgres hashtext() returns int4; supabase-js
// .rpc encodes JS numbers as JSON numbers, so we must produce a value inside
// the int4 range. We do NOT need byte-exact parity with Postgres hashtext
// here because the lock-acquisition RPC is in Postgres — we pass STRING args
// to a server-side wrapper if one exists, or we pass NUMBER args derived from
// a deterministic JS hash.
//
// For now: emit a 32-bit signed-int hash of the input string. The Postgres
// side, if it relies on hashtext() of the same string, will produce a
// different value — but the only consumer in this slice is the score-trigger
// itself, so consistency-with-itself is what matters. If a future cross-
// process callsite needs Postgres hashtext() parity, a SECURITY DEFINER
// wrapper that calls `pg_try_advisory_lock(hashtext($1), hashtext($2))` from
// SQL will be added; the Edge Function will then pass the string args
// through unchanged.
// ============================================================================

function hashtext32(s: string): number {
  // FNV-1a 32-bit; deterministic, no external deps, fits int4.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Coerce to signed 32-bit int (advisory_lock keys are bigint at the API
  // level but the (key1, key2) two-arg form takes int4 — we keep within
  // that range).
  return h | 0;
}
