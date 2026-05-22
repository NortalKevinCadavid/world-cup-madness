# Contract: `MatchDataProviderAdapter` (locked cross-slice TypeScript interface)

**Slice**: 002-match-catalog
**Date**: 2026-05-15
**Status**: Phase 1 (Plan) — **locked cross-slice contract**.

This contract defines the TypeScript interface every match-data provider adapter implements. It is the single point of decoupling between the application's domain layer and any specific provider (football-data.org, sportradar, statsperform, manual entry, etc.). Constitution Principle IV (Provider Abstraction) hinges on this interface.

**It is a locked cross-slice contract** in the sense that changing the interface signature is a coordinated change set requiring updates to:
- every concrete adapter implementation,
- the sync coordinator (`sync-runner.scheduled.md`),
- Slice 006 (admin manual-result entry — also implements the interface for the "manual" provider),
- Slice 008 (provider config admin UI surfaces fields keyed off the interface).

Body / additive changes (new optional methods, new optional fields on returned types) are allowed and non-breaking.

## File location

`supabase/functions/_shared/providers/types.ts` — co-located with the Edge Function runtime so it's importable by both the coordinator and concrete adapter files (`supabase/functions/_shared/providers/<name>/index.ts`).

The interface MUST NOT import any Node-only or browser-only types — it is Deno-compatible (Edge Function runtime). Adapter implementations can use Deno's `fetch` directly; the interface itself is type-only.

## Interface

```typescript
/**
 * The locked cross-slice contract for ingesting match data into the catalog.
 * Every concrete adapter under supabase/functions/_shared/providers/<name>/ implements this.
 *
 * Adapters MUST NOT touch Postgres. They convert provider-specific responses into
 * normalized internal types and return them. The sync coordinator (sync-runner.scheduled.md)
 * is the only consumer; it owns transactions, audit, and idempotency.
 *
 * @see specs/002-match-catalog/contracts/provider-adapter.contract.md
 */
export interface MatchDataProviderAdapter {
  /** A stable identifier for this adapter (e.g., "footballdata"). Used as
   *  `provider_sync_runs.provider_name` and `match_provider_external_ids.provider_name`. */
  readonly name: string;

  /**
   * Fetch fixtures for a given window. The window MAY be ignored by adapters that
   * cannot filter server-side (they should return the full set and let the coordinator
   * filter post-hoc).
   *
   * @throws ProviderTransientError on 5xx/network failures (coordinator retries)
   * @throws ProviderRateLimitedError on 429 (coordinator honors Retry-After)
   * @throws ProviderClientError on 4xx other than 429 (coordinator does NOT retry)
   */
  fetchFixtures(window: SyncWindow): Promise<NormalizedFixture[]>;

  /**
   * Fetch confirmed results. Only returns rows for matches whose status indicates
   * the score is final (finished / penalties_shootout — NOT in_progress). The adapter
   * is responsible for filtering out half-finished matches; the coordinator additionally
   * cross-checks against matches.status to reject score_before_kickoff anomalies.
   */
  fetchResults(window: SyncWindow): Promise<NormalizedResult[]>;

  /**
   * Fetch team metadata. Called rarely (team set is largely fixed before the tournament).
   * The coordinator may skip calling this if team rows are already populated and the
   * provider doesn't expose an incremental team-update endpoint.
   */
  fetchTeams(): Promise<NormalizedTeam[]>;

  /**
   * Optional. Adapters that can resolve player metadata (top-scorer, best-player candidates)
   * implement this. Slice 002 does NOT call it; Slice 004 does. Adapters without this
   * capability return `undefined` for the property.
   *
   * The signature is reserved here so Slice 004 can begin without a contract revision.
   */
  fetchPlayers?(): Promise<NormalizedPlayer[]>;
}

/** A time window for fixture/result fetch. Adapters may treat `null` bounds as "no limit". */
export interface SyncWindow {
  fromUtc: string | null;   // ISO-8601 UTC
  toUtc:   string | null;   // ISO-8601 UTC
}

/** Normalized fixture — what the coordinator UPSERTs into matches. */
export interface NormalizedFixture {
  providerMatchId:   string;                       // adapter's native ID; mapped via match_provider_external_ids
  homeTeam:          NormalizedTeam;               // full team payload; coordinator UPSERTs teams first
  awayTeam:          NormalizedTeam;
  stage:             "group" | "r16" | "qf" | "sf" | "final" | "third_place";
  groupId:           string | null;                // "A".."L" for group stage; null otherwise
  kickoffUtc:        string;                       // ISO-8601 UTC
  venue:             string | null;
  status:            "scheduled" | "in_progress" | "finished" | "postponed" | "cancelled";
}

/** Normalized result — what the coordinator INSERTs into match_results. */
export interface NormalizedResult {
  providerMatchId:    string;
  homeScoreOfficial:  number;                      // >= 0
  awayScoreOfficial:  number;                      // >= 0
  /**
   * Provider's view of the regulation+ET score, excluding shootouts. If the provider
   * does not distinguish (e.g., it only returns the final score line), the adapter
   * MUST compute it: regulation+ET equals official when result_status is 'regulation'
   * or 'extra_time'; otherwise it equals the level score before the shootout.
   *
   * The coordinator additionally enforces the contract invariant
   *   home_score_for_scoring <= home_score_official
   * before INSERT.
   */
  homeScoreForScoring: number;                     // >= 0, <= homeScoreOfficial
  awayScoreForScoring: number;                     // >= 0, <= awayScoreOfficial
  resultStatus:        "regulation" | "extra_time" | "penalties_shootout";
}

/** Normalized team payload. */
export interface NormalizedTeam {
  providerTeamId: string;
  name:           string;
  shortCode:      string;                          // /^[A-Z]{3}$/
  flagUrl:        string | null;
}

/** Reserved for Slice 004's consumption. Defined here so adapters can ship the
 *  capability before Slice 004 begins. */
export interface NormalizedPlayer {
  providerPlayerId: string;
  fullName:         string;
  teamProviderId:   string | null;                 // links via the team-side mapping table
  aliases:          string[];                      // for manual disambiguation
}

/** Error taxonomy. Adapters MUST map provider HTTP responses to these classes; the
 *  coordinator branches retry behavior off them. */
export class ProviderTransientError extends Error  { readonly retryable = true  as const; }
export class ProviderRateLimitedError extends Error { readonly retryable = true  as const; constructor(message: string, readonly retryAfterMs: number | null) { super(message); } }
export class ProviderClientError extends Error      { readonly retryable = false as const; }
```

## Why each design choice

### Adapters return data, never write

If an adapter could write to Postgres, a misbehaving or malicious adapter could corrupt the catalog mid-transaction. Keeping adapters pure functions (in → out) means the coordinator can apply transactions, audit rows, and idempotency uniformly — a single code path, easy to reason about.

### Error taxonomy is on the contract, not inside the coordinator

The coordinator's retry policy (R-007) branches on whether an error is retryable; if the contract didn't say which is which, the coordinator would have to inspect HTTP status codes — leaking provider-protocol knowledge upward.

### `fetchPlayers` is reserved but optional

Slice 004 (Final Predictions) ingests players. Reserving the method now means adapters can ship the capability before Slice 004 begins; this slice's coordinator simply never calls it. Optional-method discipline is enforced by TypeScript (the `?` on the property).

### `homeScoreForScoring` is required, not derived

The coordinator could compute the for-scoring split from `homeScoreOfficial` + `resultStatus`. Requiring the adapter to ship the value pushes provider-specific shootout encoding (some providers conflate official and regulation scores; some don't) into the adapter, where it belongs. The coordinator's CHECK `_for_scoring <= _official` catches adapter bugs without re-implementing the logic.

### Adapters are stateless functions, not class instances

Concrete adapters live as plain modules exporting an object that satisfies the interface. No `class` ceremony, no constructor injection. Provider credentials are read from Deno env at call time (`Deno.env.get('FOOTBALLDATA_API_TOKEN')`) — adapters MUST NOT cache credentials in module-level constants.

## Implementation example (illustrative — not normative)

```typescript
// supabase/functions/_shared/providers/footballdata/index.ts
import type { MatchDataProviderAdapter, NormalizedFixture, ... } from "../types.ts";
import { ProviderTransientError, ProviderRateLimitedError, ProviderClientError } from "../types.ts";

const BASE_URL = "https://api.football-data.org/v4";

export const footballDataAdapter: MatchDataProviderAdapter = {
  name: "footballdata",

  async fetchFixtures(window) {
    const token = Deno.env.get("FOOTBALLDATA_API_TOKEN");
    if (!token) throw new ProviderClientError("FOOTBALLDATA_API_TOKEN missing");

    const r = await fetch(`${BASE_URL}/competitions/WC/matches`, {
      headers: { "X-Auth-Token": token },
    });

    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get("Retry-After") ?? "0", 10) * 1000;
      throw new ProviderRateLimitedError(`rate-limited`, retryAfter || null);
    }
    if (r.status >= 500) throw new ProviderTransientError(`provider 5xx: ${r.status}`);
    if (r.status >= 400) throw new ProviderClientError(`provider 4xx: ${r.status}`);

    const json = await r.json();
    return json.matches.map(normalizeFixture);   // map provider's schema → NormalizedFixture
  },

  // fetchResults, fetchTeams, fetchPlayers (optional) follow the same pattern
};
```

## Test surface

This contract's adherence is verified at multiple layers:

| File | Test |
|---|---|
| `apps/web/lib/providers/types.test.ts` or equivalent | Type-level: any concrete adapter assigned to `MatchDataProviderAdapter` compiles only if all required methods exist with correct signatures. Tests are TypeScript compile-time only — `tsc --noEmit` is the verification. |
| `supabase/functions/sync-catalog/tests/stub_provider.test.ts` | Stub adapter implementing the interface returns canned `NormalizedFixture[]`; coordinator UPSERTs into `matches`; assertions confirm catalog matches the stub's output. **Proves the swap test required by SC-005.** |
| `supabase/functions/sync-catalog/tests/two_providers_same_data.test.ts` | Two stub adapters with deliberately different internal schemas but identical contract-compliant output; coordinator runs against each; assert resulting `matches` rows are byte-identical. **Proves Principle IV.** |
| Slice 004 / Slice 006 future regression | Confirm `fetchPlayers?` / manual-entry adapter can plug in without touching coordinator code. |

## Versioning policy

The interface name `MatchDataProviderAdapter` MUST NOT change after this slice ships. Method signatures are locked for backward compatibility:

- Adding a new optional method (with `?`) is non-breaking.
- Adding a new optional field to a `Normalized*` return type is non-breaking.
- Removing a method, renaming a method, removing a field, narrowing a return type — all breaking. Require coordinating updates to every adapter implementation in the same change set (Constitution Principle XI).

The interface is **deliberately not versioned** (no `_v1` / `_v2` suffix): consumers reference the name; version drift would require renaming references in every concrete adapter and in the coordinator — exactly the lock-in this contract prevents.

## Cross-slice handoffs

| Slice | Touch point |
|---|---|
| 004 (Final Predictions) | Begins calling `fetchPlayers?()`; defines its own player storage contract for the rows returned |
| 006 (Admin Overrides) | Ships a `manual` adapter implementing the interface so admin manual-result entry goes through the same coordinator path |
| 007 (Audit Trail) | Hardens the `provider_sync_runs` ledger; reads `provider_name` written by adapters |
| 008 (Configuration) | Admin UI for `tournament_config.provider.active`; reads `name` from adapters to populate the selector |
