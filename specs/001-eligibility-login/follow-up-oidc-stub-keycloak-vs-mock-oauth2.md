# Slice 001 follow-up: OIDC test fixture is incompatible with the running Keycloak container

**Filed**: 2026-05-23
**Discovered by**: full slice 005 Playwright suite run (during slice 009 / slice 005 follow-up work)
**Severity**: medium — blocks the slice 001 / 002 / 003 / 004 / 005 / 006 Playwright suites from running locally; CI impact depends on whether CI's stack matches the README or the current local-dev override.
**Surface**:
- `apps/web/tests/playwright/fixtures/oidc.ts`
- `infra/oidc-stub/README.md`
- `docker-compose.override.yml` (oidc-stub service)

## Problem

The slice 001 OIDC test fixture and the OIDC stub container disagree about which OIDC product is in play.

- **Container actually running** (per `docker-compose.override.yml` line "oidc-stub" → `quay.io/keycloak/keycloak:25.0`): real **Keycloak 25.0.6** with the realm at `infra/keycloak/realm-export.json` and a seeded set of dev users (alpha, bravo, charlie, admin1, newuser; each with password `dev-password`).
- **Fixture is written for** (`apps/web/tests/playwright/fixtures/oidc.ts`): `navikt/mock-oauth2-server` — a test-only OIDC issuer that exposes a runtime config endpoint (`PUT /<issuerId>`) to register the next token's claim payload. The fixture probes that server's discovery document at `http://localhost:8090/default/.well-known/openid-configuration` as a pre-flight check.
- **README still describes the mock**: `infra/oidc-stub/README.md` still says "A sidecar Docker container running `ghcr.io/navikt/mock-oauth2-server` (image tag pinned to **`3.0.3`**)". This is stale.

## Empirical confirmation

```sh
# Discovery doc — Keycloak's path:
curl -i http://localhost:8090/realms/default/.well-known/openid-configuration   # HTTP 200

# Discovery doc — what the fixture expects (mock-oauth2-server's path):
curl -i http://localhost:8090/default/.well-known/openid-configuration          # HTTP 404

# Container image:
docker inspect wcm-oidc-stub --format '{{.Config.Image}}'                       # quay.io/keycloak/keycloak:25.0
```

## Why the swap happened (per the override file)

`docker-compose.override.yml` carries a comment block explaining the original choice:

> Supabase Auth's `keycloak` external provider hardcodes Keycloak's URL conventions
> (`{issuer}/protocol/openid-connect/auth` etc.). The previous `mock-oauth2-server:3.0.3`
> sidecar follows the OIDC discovery spec but uses different paths (`{issuer}/authorize`),
> so Supabase's redirects 404'd. Keycloak natively serves the URLs Supabase expects.

So the swap from mock-oauth2-server → Keycloak was deliberate and was driven by Supabase Auth's URL expectations. The fix to the test fixture was never landed in the same change-set.

## Impact

Full slice 005 Playwright suite run on 2026-05-23, with `pnpm exec playwright test tests/playwright/slice-005-*.spec.ts --project=chromium`:

| Result | Count |
|--------|-------|
| Passed | 1 (the slice 005 follow-up regression test, which drives Keycloak's login form directly and does NOT use this fixture) |
| **Failed** | **23** — all with the same `assertOidcStubReachable` 404 error |
| Skipped | 2 |
| Did not run | 11 |

Every failing test fails in the fixture's pre-flight check, never reaching its actual assertions. The same impact applies to any slice 001 / 002 / 003 / 004 / 006 test that imports `signInWithIdentity` or `mintIdentity` from this fixture.

The slice 005 `regression-final.md` from 2026-05-21 hints at this latent state: it lists Docker/Deno/Supabase prerequisites and marks runtime verification as `DEFERRED`. The mismatch has been silently latent across that interval.

## Recommended fix (one of two paths)

### Path A — rewrite the OIDC fixture to drive Keycloak (recommended)

Replace `signInWithIdentity` so it:

1. Drops the discovery-doc pre-flight probe (or points it at `/realms/default/.well-known/openid-configuration`).
2. Drops the `registerNextTokenClaims` step (Keycloak doesn't support runtime claim injection).
3. Drives the Keycloak login form interactively: fills the username + password fields, clicks the **Sign In** button, waits for the Supabase callback.
4. Maps the existing `OidcIdentityClaims` argument to a seeded Keycloak username (alpha / bravo / charlie / admin1 / newuser) by `email` or `sub`. Tests that supply custom email-drift / missing-claims payloads need a different strategy — see "Limitations" below.

A working reference implementation already exists at `apps/web/tests/playwright/slice-005-breakdown-after-rename.spec.ts`. It's 65 lines and is the regression test we landed today for the 0054b → 0078 rename. Generalize that file into a fixture.

**Pros**: aligns with the production reality (real Keycloak with seeded users); no infrastructure changes; no Supabase URL conflict.

**Cons / limitations**:
- Tests that exercise *email-drift*, *missing-claims*, or *domain-removed* edge cases (slice 001 US1/US2/US3 acceptance scenarios) currently rely on `registerNextTokenClaims` injecting arbitrary claim payloads. With real Keycloak we cannot mint arbitrary claims on the fly — the test would need to either (a) admin-API into Keycloak to mutate the seeded user mid-test, or (b) keep using mock-oauth2-server for those specific tests via a second sidecar.

### Path B — restore mock-oauth2-server AND patch Supabase Auth's URL expectations

Switch `docker-compose.override.yml`'s `oidc-stub` service back to `ghcr.io/navikt/mock-oauth2-server:3.0.3`. Then either:

1. Tell Supabase Auth to use a generic OIDC provider instead of `[auth.external.keycloak]` — possibly via `[auth.external.<custom>]` if Supabase supports a non-name-locked OIDC profile.
2. Override Supabase Auth's URL builder via a custom auth hook so it constructs the mock-oauth2-server's URLs.
3. Add a tiny reverse-proxy sidecar that rewrites `/realms/default/*` → `/default/*` between Supabase Auth and the mock.

**Pros**: brings back runtime claim injection, which is the original design and matters for the slice 001 edge-case suite.

**Cons**: more infra work; Supabase config is touchy; one of the workarounds may not survive a Supabase CLI upgrade.

### Path C — keep both (compromise)

Run two sidecars in parallel:

- `keycloak:25` on its existing port → continues to back the Next.js sign-in flow that users actually exercise.
- `mock-oauth2-server:3.0.3` on a different port (e.g., 8091) → exclusively for tests that need claim injection.

`signInWithIdentity` is split into `signInWithKeycloak` (real-user smoke) and `signInWithInjectedClaims` (edge-case fixture). Most slice 005 tests use the former (their identities map to seeded users); slice 001's edge-case suite uses the latter.

**Pros**: covers both use cases honestly.

**Cons**: two stacks to keep alive, two fixtures to maintain.

## Recommended path: A → C if/when slice 001's edge cases come back

Path A unblocks the slice 005 / 002 / 003 / 004 / 006 suites — those map 1-to-1 to seeded users, no claim-injection needed. It's the lowest-effort path that gets us the most coverage back.

Slice 001's email-drift / missing-claims / domain-removed scenarios (which DO need claim injection) become "Path C work" if and when they're prioritized. Until then, those specific tests can be `.fixme`'d with a pointer to this doc.

## Also update — the README

`infra/oidc-stub/README.md` is now stale (describes mock-oauth2-server). Either:
- Rewrite it to describe the Keycloak-25 sidecar as it actually exists today, OR
- Move the mock-oauth2-server description to an "Original design — superseded" appendix and add a "Current state" section up top.

## Owner

Slice 001 owner, or whoever next opens a fixture/infra cleanup chore. This is **not** a 5-minute change — Path A is realistically an afternoon (mostly rewriting test helpers and updating the imports across ~6 fixtures-consuming spec files).

## Status

**Open** — pending implementation.

## Cross-references

- `docker-compose.override.yml` (Keycloak sidecar config + the rationale comment).
- `infra/oidc-stub/README.md` (stale — describes mock-oauth2-server).
- `apps/web/tests/playwright/fixtures/oidc.ts` (the fixture to rewrite).
- `apps/web/tests/playwright/slice-005-breakdown-after-rename.spec.ts` (working reference impl for the Keycloak-driven sign-in flow).
- `infra/keycloak/realm-export.json` (seeded users — alpha, bravo, charlie, admin1, newuser; passwords all `dev-password`).
- `specs/005-scoring-leaderboard/regression-final.md` (notes runtime verification as `DEFERRED` — this is one of the unblocked items).
