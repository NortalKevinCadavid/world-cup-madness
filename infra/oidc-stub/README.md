# OIDC stub — local & CI fake identity provider

> **-- DEV-ONLY: not used in any production environment.**
>
> Production authentication is **Microsoft Entra ID** via Supabase Auth's
> `[auth.external.azure]` block. This stub exists solely so that
> Playwright tests can synthesize arbitrary identity payloads (eligible,
> ineligible, missing-claims, email-drift, etc.) without depending on
> Entra ID during dev or CI. See
> [`specs/001-eligibility-login/research.md` § R-001](../../specs/001-eligibility-login/research.md)
> for the provider-abstraction rationale.

---

## What this is

A sidecar Docker container running
[`ghcr.io/navikt/mock-oauth2-server`](https://github.com/navikt/mock-oauth2-server)
(image tag pinned to **`3.0.3`** in
[`docker-compose.override.yml`](../../docker-compose.override.yml) at the
repo root). It exposes a fully-featured OIDC issuer at
`http://localhost:8090/default` with:

- A discovery document at `/default/.well-known/openid-configuration`
- A JWKS endpoint at `/default/jwks` serving the **public** half of the
  RSA keypair under [`./keys/`](./keys/)
- Authorization, token, and userinfo endpoints
- An HTTP "config" endpoint that lets test code register per-test claim
  payloads at runtime (the Playwright fixture uses this)

The sidecar is wired to Supabase Auth via
[`supabase/config.toml`](../../supabase/config.toml) under
`[auth.external.keycloak]` — Supabase treats `keycloak` as a generic OIDC
provider, which is exactly what we need for the stub.

---

## File layout

| Path | Purpose |
| --- | --- |
| `keys/rsa-private.pem` | **DEV-ONLY** 2048-bit RSA private key the sidecar uses to sign issued JWTs. |
| `keys/rsa-public.pem`  | **DEV-ONLY** matching public key, served by the sidecar's JWKS endpoint. |
| `README.md`            | This file. |

The PEM files themselves are standard PEM (no inline comments — PEM format
does not permit them). The "DEV-ONLY" marker lives in this README and in
`apps/web/.env.example`, and is the canonical anchor for the rule
"never reuse this keypair outside dev/CI."

---

## Bringing it up

The sidecar starts automatically with the rest of the Supabase local stack:

```bash
# From the repo root:
supabase start
```

`supabase start` invokes `docker compose up` with both Supabase's bundled
compose file and our `docker-compose.override.yml`, so the `oidc-stub`
service comes up alongside Postgres, Auth, Studio, etc.

Verify it is healthy:

```bash
curl http://localhost:8090/default/.well-known/openid-configuration
# → JSON document with issuer, authorization_endpoint, token_endpoint,
#   jwks_uri, etc., all rooted at http://localhost:8090/default
```

The discovery document MUST list:

- `issuer = "http://localhost:8090/default"`
- `jwks_uri = "http://localhost:8090/default/jwks"`
- `authorization_endpoint = "http://localhost:8090/default/authorize"`
- `token_endpoint = "http://localhost:8090/default/token"`

If any of those are missing or point at a different host, the Supabase
Auth callback will fail with `invalid_issuer` or `jwks_unreachable`.

---

## Minting test JWTs

Tests should NOT hit the OIDC endpoints directly — use the Playwright
fixture instead:

```ts
import { mintIdentity } from '@/tests/playwright/fixtures/oidc';

await mintIdentity(page, {
  email: 'alpha@nortal.com',
  email_verified: true,
  name: 'Alpha Tester',
  sub: '00000000-0000-0000-0000-000000000001',
});
// → drives the Next.js sign-in flow against the stub, ending on /dashboard.
```

See [`apps/web/tests/playwright/fixtures/oidc.ts`](../../apps/web/tests/playwright/fixtures/oidc.ts)
for the full API surface. The fixture posts to the mock provider's
configuration endpoint to register a one-shot identity payload, then
clicks through the Next.js sign-in button to trigger the
Supabase-Auth-mediated OIDC dance.

---

## Why these specific choices

- **Image: `navikt/mock-oauth2-server`** — it has the simplest signed-token
  control API of the mock OIDC servers we evaluated; per-request claim
  shaping is a single HTTP call and the issuer URL is configurable via
  `JSON_CONFIG`. Compared to `oauth2-proxy/mockoidc` it has a richer
  claim-injection model that matches the variety we need for slice 001
  acceptance scenarios.
- **Tag `3.0.3` (pinned)** — last stable 3.x release at the time of T006;
  pinning prevents drift between dev and CI. Bumping the tag MUST come
  with a re-run of the full slice-001 Playwright suite (T016+).
- **Port `8090`** — chosen to avoid the entire 543xx range Supabase
  reserves (API 54321, DB 54322, Studio 54323, Inbucket 54324/5/6,
  Analytics 54327, Pooler 54329, shadow DB 54320) and the Next.js dev port
  (3000).
- **Provider key `keycloak`** in `supabase/config.toml` — Supabase Auth
  whitelists a fixed set of provider keys; `keycloak` is the supported key
  that allows an arbitrary issuer `url`, which is what we need for a
  stub. We are NOT running Keycloak; we are reusing Supabase's
  "generic OIDC" code path.

---

## Production swap

When deploying, the production environment:

1. Sets `[auth.external.keycloak].enabled = false` (or strips the block).
2. Sets `[auth.external.azure].enabled = true` with the real client_id,
   secret, redirect_uri, and tenant URL from secrets.
3. Does NOT include this `docker-compose.override.yml` in the deployment
   bundle.

No application code changes — just config. That is the whole point of the
provider-abstraction pattern.
