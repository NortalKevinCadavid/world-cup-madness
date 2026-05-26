# Slice 009 follow-up: 4 admin config-* tests fail because `config-preview-confirm` click doesn't trigger the upsert

> **RESOLVED 2026-05-26.** The four filed hypotheses (overlay / StrictMode /
> hydration / form-action) were ALL wrong. Live diagnosis (a throwaway
> Playwright spec capturing console + network + `elementFromPoint`) showed
> the Confirm button IS clickable and the onClick DOES fire. Two real,
> unrelated causes — both test-side:
>
> 1. **Missing `source_citation`.** Keys under `eligibility.*`, `locking.*`,
>    `scoring.*`, `providers.active`, `admin_roles.*` are security-sensitive;
>    the upsert RPC (migration 0077 step 4) rejects them with **WCG02**
>    ("Source citation required for security-sensitive key …") unless a
>    citation is supplied. The tests filled only `reason`, not the citation
>    field, so the upsert 400'd and the `config-error` element rendered
>    instead of the toast. The UI labels the field "(optional)" — misleading
>    for these key classes, but the server rule is correct (Principle V).
>
> 2. **`locator.isVisible({ timeout })` does not wait.** `config-domains`
>    and `config-tiebreaker` gated the Confirm click on
>    `preview.isVisible({ timeout: 5000 })`. `isVisible()` samples the CURRENT
>    state synchronously and ignores the timeout option, so it raced ahead of
>    the async `/api/admin/config/preview` round-trip, returned false, and
>    skipped the Confirm click entirely — the upsert never fired. Replaced
>    with `confirmButton.waitFor({ state: 'visible' })`.
>
> Also surfaced: the ScoringEditor's per-section + tie-breaker `reason` and
> `source_citation` inputs lacked `data-testid`s, so the tests' fills
> silently no-op'd. Added `scoring-${alias}-reason`,
> `scoring-${alias}-source-citation`, `tie-breaker-reason`,
> `tie-breaker-source-citation`. And `config-tiebreaker` waited for
> `config-toast` when the tie-breaker section renders `tie-breaker-toast`.
>
> Fix landed in the same commit as this doc update. All 4 config-* specs
> pass individually and together. The hypotheses below are retained for
> the record — a cautionary tale about guessing before instrumenting.

**Filed**: 2026-05-25
**Discovered by**: full-suite Playwright run after the cookie-forwarding + redirect-loop sweeps unblocked the admin config UIs (commits 92ad387 / 6451aaa / 28219ba / 85f825e / 1561ec1). With auth working and `/admin/*` no longer looping, four slice-008 admin-config specs now reliably reach the preview-warning state but cannot get past it — clicking the Confirm button does nothing observable.
**Severity**: medium — blocks 4 of slice-008's 9 config-* tests. Not a production-correctness issue (no evidence the upsert flow is broken for real admin sessions; the issue may be test-environment-specific).
**Surface**:
- `apps/web/app/admin/config/PreviewWarning.tsx` — `<button data-testid="config-preview-confirm" onClick={() => onConfirm(null)}>` (safe branch at line 60-67; affecting branch at line 118-126).
- `apps/web/app/admin/config/domains/DomainsEditor.tsx:171-224` — `handleConfirm(token)` → fetch `/api/admin/config/upsert` → `setToast(...)`.
- Same pattern in `LockingEditor.tsx`, `ScoringEditor.tsx`, `TiebreakerEditor.tsx`.
- Failing specs (all from full-suite log, 43-failure state):
  - `config-domains.spec.ts:95` — "Admin adds + removes domain"
  - `config-locking.spec.ts:138` — "Admin widens then narrows lock window"
  - `config-scoring.spec.ts:122` — "Admin changes match_points.exact"
  - `config-tiebreaker.spec.ts:116` — "Admin reorders tie-breaker"

## Symptom

The page-snapshot from the failure context shows the test reached the preview-warning step:

```yaml
- main:
  - heading "Approved corporate domains" [level=1]
  - paragraph: eligibility.allowed_domains
  - list "Approved corporate domains":
    - listitem: text: nortal.com; button "Remove"
  - text: New domain
  - textbox "New domain": example.nortal.com   ← filled
  - button "Add"
  - text: Reason (required)
  - textbox "Reason (required)": Onboarding new entity  ← filled
  - heading "Safe to apply" [level=3]                    ← preview rendered
  - paragraph: No existing data is affected by this change.
  - button "Cancel"
  - button "Confirm"                                     ← visible, never clicked-through
  - paragraph: "Current version: 6"                      ← unchanged
```

The test:

```ts
const previewAfterAdd = page.locator('[data-testid="config-preview-warning"]');
if (await previewAfterAdd.isVisible({ timeout: 5_000 }).catch(() => false)) {
  await page.click('[data-testid="config-preview-confirm"]');
}
const toast = page.locator('[data-testid="config-toast"]');
await expect(toast, '...').toBeVisible({ timeout: 10_000 });   // ✘ TIMES OUT
```

After the 10s `toBeVisible` timeout:
- The preview-warning is STILL visible (would be cleared by `setPreview(null)` inside `handleConfirm`).
- No toast appears.
- No error renders (`config-error` testid absent from the snapshot).
- `tournament_config.eligibility.allowed_domains` is unchanged — verified via:
  ```sh
  docker exec supabase_db_world-cup-madness psql -U postgres \
    -c "SELECT value FROM public.tournament_config WHERE key='eligibility.allowed_domains'"
  -- ["nortal.com"]   ← only the original entry; example.nortal.com never written
  ```

So `handleConfirm` is **not running its body** — or running but bailing on `if (!pendingValue) return;` BEFORE the fetch fires. Either way, none of `setToast`, `setError`, `setPreview(null)` execute.

## Investigation done

1. **DOM correctness**: `config-preview-confirm` testid exists in PreviewWarning.tsx safe branch (line 62). The button is `<button type="button" onClick={() => onConfirm(null)}>` — no form interception, no anchor.
2. **`config-toast` testid lookup**: confirmed `data-testid="config-toast"` is wired in DomainsEditor.tsx:339 and renders `{toast && <div data-testid="config-toast">{toast}</div>}`. So if `toast` state becomes truthy, the element WILL render.
3. **`handleConfirm` early-return**: `if (!pendingValue) return;` at line 172. `pendingValue` is set by `handleAddDomain` (line 155) immediately before `triggerPreview` is called. `triggerPreview` does NOT clear `pendingValue` on success (only clears on reason/validation/fetch failure). So pendingValue SHOULD be set when Confirm is clicked.
4. **No fetch fired**: confirmed by inspecting the DB after the test — the upsert never persisted.
5. **No console error visible** in the snapshot.

## Hypotheses (none verified)

The investigation stopped at "click happens but onClick handler doesn't execute (or executes with stale state)". Likely causes:

### (a) Slice-009 motion/transform overlay intercepts the click

Slice 009 introduced motion components (`Confetti`, `MotionProvider`, page-transition wrappers). One of these may render a transparent overlay or transform-wrapped parent that captures clicks at the coordinates of the Confirm button. Playwright would report a successful click action even though the click landed on the overlay, not the button.

**Reproduction step:** open `/admin/config/domains` in a real browser, sign in as admin1, fill the inputs, click Add, then DevTools-inspect what element is actually at the Confirm button's click coordinates. If a motion / theme provider / Toaster portal is above it (`z-index` higher, `pointer-events: auto`), this is the culprit.

### (b) React strict-mode double-mount + stale closure

Slice 009 may have introduced `<React.StrictMode>` (which double-mounts in dev). Combined with `startTransition` inside `handleConfirm`, the `pendingValue` closure could capture a NULL value from the first (discarded) mount, so the early-return fires.

**Reproduction step:** check `apps/web/app/layout.tsx` for `<StrictMode>` insertion. If present and absent pre-slice-009, hypothesis (b) is plausible.

### (c) Hydration mismatch leaves the button as a static DOM node

If the slice-009 redesign introduced a server/client divergence on the PreviewWarning component, React might fail to hydrate it, leaving the `onClick` prop UNATTACHED. The button is in the DOM but doesn't call into React.

**Reproduction step:** run `pnpm dev`, navigate to `/admin/config/domains`, fill + click Add. Open browser console — look for "Hydration failed" warnings. If present, hypothesis (c) is confirmed.

### (d) Server action / form action overrides React onClick

Slice 009's redesign might have wrapped the buttons in a `<form action={serverAction}>` that swallows the JS onClick and submits a form action instead. The server action then 405s silently (no `formMethod="POST"`).

**Reproduction step:** check git diff against pre-slice-009 PreviewWarning.tsx for form/action additions.

## Why we ruled out the easy answers

- **It's not auth.** The cookie-forwarding sweep is already in (commit 92ad387). Other admin tests that GET via session cookies (admin-dashboard, admin-audit-search) pass.
- **It's not the testid.** Both `config-preview-confirm` and `config-toast` are present in the source tree.
- **It's not test order.** Reproduces in isolation: `pnpm exec playwright test config-domains.spec.ts` fails the same way.
- **It's not the route.** `/api/admin/config/upsert` is exercised successfully by other code paths (admin-config-roles tests pass).

## Recommendation

Live-debug session — open `/admin/config/domains` in a browser, paste a Playwright-like Add → Confirm sequence into DevTools, and watch which hypothesis fires:

```js
// In browser console, after the test's preview has appeared:
const btn = document.querySelector('[data-testid="config-preview-confirm"]');
console.log('button rect:', btn.getBoundingClientRect());
console.log('element at click coords:',
  document.elementFromPoint(
    btn.getBoundingClientRect().left + 10,
    btn.getBoundingClientRect().top + 10
  ));
// If `elementFromPoint` returns btn → hypothesis (a) ruled out
// If it returns a motion/overlay div → hypothesis (a) confirmed

btn.click();
// Wait 1s, check DB:
//   psql -c "SELECT updated_at FROM tournament_config WHERE key='eligibility.allowed_domains'"
// If updated_at advanced → onClick fires, the bug is in setToast (or the toast container)
// If unchanged → onClick doesn't fire, hypothesis (a/b/c/d)
```

Filing this as a follow-up because:
1. The fix path is unknown (requires browser inspection / strict-mode toggling).
2. Same-class symptom across 4 specs — one fix likely unblocks all 4.
3. The other slice-009 selector follow-up (`f986d6d`) covered the mechanical regex/testid fixes; this one needs a deeper diagnosis.

## Affected count

4 specs fail outright + cascading effects:
- `config-domains.spec.ts:95` (US1 — Approved corporate domains)
- `config-locking.spec.ts:138` (US2 — Match-prediction lock window)
- `config-scoring.spec.ts:122` (US3 — Scoring values; this one in particular also blocks the "recalc pending banner" downstream assertion since the scoring change is never persisted)
- `config-tiebreaker.spec.ts:116` (US3 — Tie-breaker order)

May also explain residual failures in `config-history-rollback.spec.ts:278` and `slice-006-recalc-pending-banner.spec.ts:186` — both depend on a config upsert having happened first.

## Status

**Open** — investigation needed before fix.

## Related follow-ups

- [follow-up-test-cookie-forwarding-after-keycloak.md](../001-eligibility-login/follow-up-test-cookie-forwarding-after-keycloak.md) — the cookie sweep that unblocked the auth gate and revealed this latent bug.
- [follow-up-leaderboard-rls-design-gap.md](../005-scoring-leaderboard/follow-up-leaderboard-rls-design-gap.md) — class precedent for "slice-009 unblocks earlier work, reveals deeper issue."
