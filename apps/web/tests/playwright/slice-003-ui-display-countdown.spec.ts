// --------------------------------------------------------------------------
// Slice 003 / T030 — `/matches` page UI display: lock state badge + form
// gating + locale-aware kickoff rendering. US4 / FR-010.
// --------------------------------------------------------------------------
// 4 tests covering the three lock-state visual variants (editable / finished
// / in_progress) + locale rendering.
//
// RED until T033 ships the `lock_state`-aware page render (LockCountdown
// component + conditional form gating).
// --------------------------------------------------------------------------

import { test, expect } from "@playwright/test";

import {
  assertOidcStubReachable,
  resetStub,
  signInWithIdentity,
} from "./fixtures/oidc";

const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

const CHARLIE = {
  sub: "00000000-0000-0000-0000-00000000000c",
  email: "charlie@nortal.com",
  email_verified: true,
  name: "Charlie Tester",
} as const;

const M1_FINISHED = "bbbb0000-0000-0000-0000-000000000001";
const M2_IN_PROGRESS = "bbbb0000-0000-0000-0000-000000000002";
const M3_SCHEDULED = "bbbb0000-0000-0000-0000-000000000003";

test.describe(
  "US4 / UI display — countdown + lock state @slice-003 @us4 @ui",
  () => {
    test.beforeAll(async () => { await assertOidcStubReachable(); });
    test.beforeEach(async () => { await resetStub(); });
    test.afterEach(async () => { await resetStub(); });

    test("M3 (far-future scheduled) shows form + editable indicator", async ({ page }) => {
      await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });
      await page.goto("/matches");

      // Scope to the M3 row by its id attribute or a data-match-id selector.
      const m3Row = page.locator(`[data-match-id="${M3_SCHEDULED}"]`);
      await expect(m3Row, "M3 row must be present in catalog").toBeVisible();

      // Editable rows render a PredictionForm with number inputs.
      await expect(m3Row.locator('form input[type="number"]').first(), "editable row must show prediction form input").toBeVisible();

      // Either an explicit Editable badge OR a "locks in" countdown is visible.
      const indicator = m3Row.locator('text=/Editable|locks in/i');
      await expect(indicator, "editable row must show 'Editable' badge or 'locks in' countdown").toBeVisible();
    });

    test("M1 (finished) shows Locked badge + final score, no form", async ({ page }) => {
      await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });
      await page.goto("/matches");

      const m1Row = page.locator(`[data-match-id="${M1_FINISHED}"]`);
      await expect(m1Row).toBeVisible();

      // No editable form on a finished row.
      await expect(m1Row.locator('form input[type="number"]'), "finished row must NOT render prediction form input").toHaveCount(0);

      // Locked badge visible.
      await expect(m1Row.locator('text=/Locked/i'), "finished row must show 'Locked' badge").toBeVisible();

      // M1 ARG-MEX final score 2-0 from slice-002 fixture is visible.
      // Use an exact-text locator anchored on the score cell — the broader
      // regex /2.*0|2-0/ false-positives on "Jun 11, 2026" (slice-009 added
      // a kickoff_utc <time> element to every row, where "2026" matches
      // /2.*0/ via regex backtracking).
      await expect(
        m1Row.getByRole("cell", { name: "2-0", exact: true }),
        "finished row must show final score 2-0 in its score cell",
      ).toBeVisible();
    });

    test("M2 (in_progress) shows Locked + charlie's pre-lock prediction", async ({ page }) => {
      // Sign in as charlie — has a fixture prediction (1-1) on M2 (slice-003
      // fixture Row 8).
      await signInWithIdentity(page, { claims: { sub: CHARLIE.sub, email: CHARLIE.email, email_verified: CHARLIE.email_verified, name: CHARLIE.name } });
      await page.goto("/matches");

      const m2Row = page.locator(`[data-match-id="${M2_IN_PROGRESS}"]`);
      await expect(m2Row).toBeVisible();

      // No form on an in_progress match.
      await expect(m2Row.locator('form input[type="number"]'), "in_progress row must NOT render form").toHaveCount(0);

      await expect(m2Row.locator('text=/Locked/i'), "in_progress row must show 'Locked' badge").toBeVisible();

      // Charlie's pre-lock 1-1 prediction visible read-only.
      await expect(m2Row.locator('text=/1.*1|1-1/'), "charlie's locked pick 1-1 must be visible").toBeVisible();
    });

    test("es-ES locale renders kickoff time in Spanish", async ({ browser }) => {
      const context = await browser.newContext({ locale: "es-ES" });
      const page = await context.newPage();
      await context.setExtraHTTPHeaders({ "Accept-Language": "es-ES" });

      await signInWithIdentity(page, { claims: { sub: ALPHA.sub, email: ALPHA.email, email_verified: ALPHA.email_verified, name: ALPHA.name } });
      await page.goto("/matches");

      const m3Row = page.locator(`[data-match-id="${M3_SCHEDULED}"]`);
      await expect(m3Row).toBeVisible();

      // Spanish locale: month is rendered as 'jun' / 'junio' for June.
      await expect(m3Row.locator('text=/jun/i'), "es-ES locale must render Spanish month abbreviation for June kickoff").toBeVisible();

      await context.close();
    });
  },
);
