# `supabase/functions/_shared/`

Shared Deno modules consumed by every Edge Function in this project.

Modules placed here MUST be Deno-compatible (no Node-only or browser-only
imports) and SHOULD be type-only or stateless. Edge Functions import them via
relative paths, e.g.:

```ts
import type { MatchDataProviderAdapter } from "../_shared/providers/types.ts";
```

## Layout

- `providers/types.ts` — locked cross-slice TypeScript contract
  (`MatchDataProviderAdapter` and its supporting types). Authored in Slice 002
  / T011. See `specs/002-match-catalog/contracts/provider-adapter.contract.md`.
- `providers/<name>/index.ts` — one directory per concrete provider adapter
  (e.g., `stub/`, `football-data/`). Each default-exports an instance of
  `MatchDataProviderAdapter`. Adding a provider is a one-file change.

## Conventions

- Use Deno-style imports (relative `.ts` paths, or `https://`-prefixed URLs for
  third-party modules pinned by version). Do NOT use Node-style bare imports.
- Do NOT install npm dependencies for files under this directory.
- Adapters MUST NOT touch Postgres directly; they convert provider responses
  into the normalized types from `providers/types.ts` and return them. The
  sync coordinator (`supabase/functions/sync-catalog/`) is the sole writer.
