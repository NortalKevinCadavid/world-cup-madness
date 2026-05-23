# Red-gate: User Story 1 (design system + dark mode)

**Slice**: 009-ui-beautification
**User story**: US1 — Design system foundation & dark mode (P1, 🎯 MVP-1)
**Authored**: 2026-05-23

This artifact records that the US1 red-gate test suite has been **authored** in `apps/web/tests/e2e/009-ui-beautification/`.

Per Constitution Principle IX (TDD via BDD, NON-NEGOTIABLE), these tests MUST fail (red) against the current codebase before any implementation lands. The implementation tasks (T021–T037) then turn them green.

## Authored spec files

| File | Tasks | Spec scenarios covered |
|------|-------|------------------------|
| `us1/theme-os-default.spec.ts` | T011 | US1 AS-1, AS-2 |
| `us1/theme-toggle-keyboard.spec.ts` | T012 | US1 AS-3, AS-6 |
| `us1/design-system-page.spec.ts` | T013 | US1 AS-4 |
| `us1/reduced-motion.spec.ts` | T014 | US1 AS-5 |
| `us1/cross-tab-sync.spec.ts` | T019 | contracts/theme-toggle.md § Cross-tab |
| `a11y/design-system.spec.ts` | T015 | SC-001 |
| `contrast/tokens.spec.ts` | T016 | SC-002 |
| `viewport/375.spec.ts` | T017 | SC-003 (for /design-system) |
| `keyboard/design-system.spec.ts` | T018 | SC-004 (for /design-system) |

## Run command (user — local environment)

```sh
cd apps/web
pnpm exec playwright test \
  tests/e2e/009-ui-beautification/us1 \
  tests/e2e/009-ui-beautification/a11y/design-system.spec.ts \
  tests/e2e/009-ui-beautification/contrast \
  tests/e2e/009-ui-beautification/viewport/375.spec.ts \
  tests/e2e/009-ui-beautification/keyboard/design-system.spec.ts \
  --project=chromium \
  --reporter=list
```

## Expected status (pre-implementation)

**ALL RED.** Reasons each spec fails before US1 implementation lands:
- `/design-system` route does not exist yet → 404 → most specs fail at first `goto`.
- `<html>` does not gain a `dark` class on theme change → theme/reduced-motion specs fail.
- `[data-token-pair]` swatches do not exist yet → contrast spec fails.
- `[data-motion-decorative]` markers do not exist yet → reduced-motion spec fails.
- `ThemeToggle` component does not exist yet → toggle keyboard spec fails.
- Without the new layout wrappers, `data-motion="reduce"` on `<html>` is absent → reduced-motion fails its data attribute check.

## Green-gate confirmation

Once T021–T037 have all landed, append the green run output below this line as proof of the red→green transition. Format:

```
=== Green run (yyyy-mm-dd, commit <sha>) ===
<pnpm exec playwright test ... --reporter=list output>
```

Until that section exists, the US1 implementation is NOT mergeable.

## Notes

- Tests are authored against the contracts in `specs/009-ui-beautification/contracts/`. If implementation diverges from a contract, the test must be updated AND the divergence must be justified in the slice's plan or a follow-up ADR — never silently weaken the contract.
- The specs do not depend on Supabase. They run against the `/design-system` route which is unauthenticated.
- `@axe-core/playwright` is now installed (T002) — the `a11y/design-system.spec.ts` suite should be runnable as soon as the route exists.
