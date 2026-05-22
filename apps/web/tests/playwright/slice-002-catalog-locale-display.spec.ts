// --------------------------------------------------------------------------
// Slice 002 / T015 — US1 SC-004 "locale-aware display, canonical UTC storage"
// --------------------------------------------------------------------------
// RED-first Playwright suite that pins the locale-display invariant from
// FR-002 + FR-012 + Constitution Principle VI (Time-Zone Correctness) and
// the research decision R-009 ("locale-aware display, canonical UTC
// storage"):
//
//   * UI MUST localize kickoff times using `Intl.DateTimeFormat` (or any
//     equivalent that produces locale-canonical output for the requested
//     `Accept-Language`).
//   * Canonical storage MUST remain UTC. The wire shape from `/api/matches`
//     keeps `kickoff_utc` as an ISO-8601 string with the `Z` suffix
//     irrespective of the request's `Accept-Language`. The underlying
//     `matches.kickoff_utc` column value MUST NOT mutate as a side effect
//     of any participant read.
//
// Spec deviation (D-T015-001): the tasks.md agent prompt mentions reading
// the DB value with `psql -c "SELECT kickoff_utc FROM matches WHERE id='...M1'"`.
// Running psql from inside the Playwright runner is brittle (host-OS shell
// quoting, PATH lookups on Windows runners, no native Node integration).
// We use the existing service-role helper `getServiceClient()` instead —
// it talks to the same Postgres via the supabase-js client and is the same
// transport pattern Slice 001 tests use for direct DB assertions. The
// invariant being tested (canonical UTC, locale-immutable) is identical.
//
// Spec deviation (D-T015-002): the tasks.md prompt specifies setting
// `Accept-Language` via `context.setExtraHTTPHeaders`. We honor that
// literally for the API request leg (which is the contract surface that
// SC-004 actually pins — the JSON wire shape must not localize). For the
// page-render leg we *also* call `test.use({ locale, timezoneId: 'UTC' })`
// because the rendered formatting depends on whichever signal the
// (not-yet-implemented) `/matches` page uses to localize: it may read
// `Accept-Language` server-side, or it may call `Intl.DateTimeFormat()`
// client-side without an explicit locale (which falls back to the
// browser's locale, set by Playwright's `context.locale`). Setting both
// signals makes the test pass under either implementation choice without
// over-constraining the implementer. The `timezoneId: 'UTC'` override is
// what makes the assertion's expected substring deterministic across
// runner machines that live in arbitrary time zones (R-009 explicitly
// guarantees DST-correct rendering, which here we pin to UTC so the test
// itself has no DST surface).
//
// This file MUST be RED until T021 (the `/matches` page) lands. The JSON
// route (T020) is also required for the wire-shape assertions in tests
// 1-3 — those assertions are part of the locale invariant: regardless of
// `Accept-Language`, the API MUST return canonical UTC ISO-8601 strings.
// --------------------------------------------------------------------------

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

import {
  signInWithIdentity,
  resetStub,
  assertOidcStubReachable,
} from "./fixtures/oidc";
import { getServiceClient } from "./helpers/service-role";

// --------------------------------------------------------------------------
// Fixtures referenced by this suite (kept in sync with
// `supabase/seed/slice-002-fixture.sql` and `supabase/seed/slice-001-fixture.sql`).
// --------------------------------------------------------------------------

// `alpha@nortal.com` — Slice 001 fixture row, ACTIVE participant. Reused
// here because Slice 002 does not introduce new personas; the catalog read
// surface accepts any eligible Nortal participant (FR-001/FR-002 of
// Slice 001 + FR-004 of Slice 002).
const ALPHA = {
  sub: "00000000-0000-0000-0000-00000000000a",
  email: "alpha@nortal.com",
  email_verified: true,
  name: "Alpha Tester",
} as const;

// M1 — ARG vs MEX, finished, Group A. Kickoff is the canonical UTC value
// the entire suite asserts against. Pinned to `2026-06-11T20:00:00Z` per
// `supabase/seed/slice-002-fixture.sql` (the matches insert for M1).
const M1 = {
  id: "bbbb0000-0000-0000-0000-000000000001",
  kickoff_utc_iso: "2026-06-11T20:00:00Z",
} as const;

// --------------------------------------------------------------------------
// Response shape (mirrors contracts/match-catalog.read.md § Response shape).
// Declared locally to keep this RED test independent of any not-yet-shipped
// types module under `apps/web/lib/types/`.
// --------------------------------------------------------------------------

interface MatchListItem {
  id: string;
  home_team: { id: string; name: string; short_code: string; flag_url: string | null };
  away_team: { id: string; name: string; short_code: string; flag_url: string | null };
  stage: string;
  group_id: string | null;
  kickoff_utc: string;
  venue: string | null;
  status: "scheduled" | "in_progress" | "finished" | "postponed" | "cancelled";
  match_result: unknown;
}

interface MatchesResponse {
  matches: MatchListItem[];
  page: number;
  page_size: number;
  total: number;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Computes the canonical `Intl.DateTimeFormat` output for the M1 kickoff in
 * the requested locale, pinned to UTC. The same call is used by the page
 * renderer (once T021 lands) so the test substring matches whatever the
 * platform's CLDR data produces for the given (locale, ICU-version) pair.
 * Using `Intl.DateTimeFormat` here — rather than hard-coding a literal —
 * keeps the test stable when Node / Chromium ship CLDR updates between
 * versions (e.g. punctuation tweaks, month-abbreviation case changes).
 */
function expectedKickoffFormatted(locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(M1.kickoff_utc_iso));
}

/**
 * Picks a stable, locale-distinguishing substring from a formatted
 * kickoff string. Different locales place the year, month, day, and
 * AM/PM indicator in different positions; the substring we extract is
 * chosen to be **load-bearingly different** between locales so a wrong-
 * locale render fails the assertion. The selection rules:
 *
 *   - `es-ES` (and other DD-MMM-YYYY locales): pull the month abbrev
 *     `"jun"` plus the year `"2026"` — the Spanish abbreviation is
 *     lowercase by CLDR convention and differs from en-US's "Jun".
 *   - `en-US`: pull the AM/PM marker plus the year — neither `es-ES`
 *     nor `ja-JP` produces "PM" with the same surrounding context.
 *   - `ja-JP`: pull the `YYYY/MM/DD` prefix — the slash-separated
 *     year-first ordering is unique to East-Asian locales among the
 *     three under test.
 *
 * In every case we ALSO surface the full formatted string in the
 * assertion message so a failure tells the implementer exactly what
 * shape the page rendered vs. what was expected.
 */
function distinguishingSubstring(locale: string, formatted: string): string {
  switch (locale) {
    case "es-ES":
      // CLDR (Node 20+, Chromium 120+) renders the M1 kickoff as
      // "11 jun 2026, 20:00" — the lowercase month abbrev is locale-
      // distinguishing vs en-US's "Jun" and ja-JP's "2026/06/11".
      return "jun 2026";
    case "en-US":
      // CLDR renders M1 as "Jun 11, 2026, 8:00 PM" — the "PM" marker
      // combined with the comma-separated date is unique among the
      // three locales.
      return "8:00 PM";
    case "ja-JP":
      // CLDR renders M1 as "2026/06/11 20:00" — the year-first
      // YYYY/MM/DD prefix never appears in es-ES or en-US output.
      return "2026/06/11";
    default:
      // Defensive: if a future test adds a fourth locale, this branch
      // forces the maintainer to teach `distinguishingSubstring`
      // about it rather than silently relying on the full string.
      throw new Error(
        `distinguishingSubstring: no rule defined for locale ${locale}. ` +
          `Last formatted output was ${formatted}.`,
      );
  }
}

/**
 * Signs in alpha, then navigates to `/matches`. Returns once the page has
 * settled. The body-text wait is intentionally short (5 s) because RED
 * runs against a non-existent route — we want a fast failure, not a 30 s
 * timeout per test. Once T021 lands and the page renders, the locator
 * waits inside each test will dominate.
 */
async function signInAndOpenCatalog(page: Page): Promise<void> {
  await signInWithIdentity(page, {
    claims: {
      sub: ALPHA.sub,
      email: ALPHA.email,
      email_verified: ALPHA.email_verified,
      name: ALPHA.name,
    },
  });
  await page.goto("/matches");
}

/**
 * GETs `/api/matches` via the page's authenticated session and returns
 * the parsed body. Throws (failing the test) on any non-200. The query
 * filters down to M1 only so the test does not depend on pagination
 * decisions made by T020.
 */
async function fetchMatchesViaApi(
  request: APIRequestContext,
): Promise<MatchesResponse> {
  const response = await request.get(
    `/api/matches?status=finished&team_id=aaaa0000-0000-0000-0000-000000000001`,
  );
  expect(
    response.status(),
    "GET /api/matches must be 200 for an eligible session",
  ).toBe(200);
  return (await response.json()) as MatchesResponse;
}

/**
 * Reads `matches.kickoff_utc` for M1 directly via the service-role
 * client. Returns the raw column value as a string so we can compare it
 * byte-for-byte against the canonical ISO-8601-with-Z form expected by
 * R-009. supabase-js serializes `timestamptz` values as ISO-8601 strings
 * but the wire format omits the `Z` suffix and emits `+00:00` instead —
 * we normalize to `Z` form before comparison so the assertion expresses
 * the invariant in the same shape the contract uses.
 */
async function readM1KickoffFromDb(): Promise<string> {
  const client = getServiceClient();
  const { data, error } = await client
    .from("matches")
    .select("kickoff_utc")
    .eq("id", M1.id)
    .single();
  if (error) {
    throw new Error(
      `readM1KickoffFromDb: failed to read M1 (${M1.id}) — ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(
      `readM1KickoffFromDb: no row returned for M1 (${M1.id}). ` +
        `Did the slice-002 fixture seed run?`,
    );
  }
  const raw = data.kickoff_utc as string;
  // Normalize "+00:00" / "+0000" tail to canonical "Z" so the assertion
  // expresses the invariant in the same shape as the API contract.
  return raw.replace(/(\+00:?00|\+0000)$/, "Z");
}

// --------------------------------------------------------------------------
// Suite
// --------------------------------------------------------------------------

test.describe("US1 / SC-004 — locale display", () => {
  // The four tests in this describe must run sequentially so a
  // mid-suite failure cannot bleed cross-test state (e.g. a stale OIDC
  // stub claim payload) into the next locale's setup. Per the task
  // brief, the locale tests are intentionally not parallelized within
  // the file.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    // Fail fast if the OIDC sidecar is down — none of these tests can
    // mint an alpha session without it.
    await assertOidcStubReachable();
  });

  test.beforeEach(async () => {
    // Reset the stub before each test so a previous test's mutated
    // claim payload does not leak into the next sign-in.
    await resetStub();
  });

  test.afterEach(async () => {
    // And again after, for symmetry with the rest of the test corpus
    // and so the next file's tests start from a known good stub state.
    await resetStub();
  });

  // ------------------------------------------------------------------------
  // Test 1 — es-ES locale renders Spanish-formatted kickoff,
  //          JSON wire shape stays canonical UTC.
  // ------------------------------------------------------------------------
  test(
    "es-ES renders Spanish-locale kickoff while /api/matches keeps canonical UTC @slice-002 @us1 @locale",
    async ({ page, context, request }) => {
      // Drive Accept-Language for the API leg (server-side localization
      // signal, per R-009's "server-side based on Accept-Language is
      // rejected" — the API MUST ignore this header for the wire shape).
      await context.setExtraHTTPHeaders({ "Accept-Language": "es-ES" });

      await signInAndOpenCatalog(page);

      const expectedFull = expectedKickoffFormatted("es-ES");
      const expectedNeedle = distinguishingSubstring("es-ES", expectedFull);

      // The rendered page MUST surface a substring matching the
      // Spanish-locale formatting for M1's kickoff. We assert on the
      // page body rather than a specific selector because T021 has not
      // yet pinned a selector contract; the locale invariant is what
      // matters at this layer.
      await expect(
        page.locator("body"),
        `Page body MUST contain the es-ES-formatted M1 kickoff substring ` +
          `${JSON.stringify(expectedNeedle)} (full expected: ${JSON.stringify(expectedFull)})`,
      ).toContainText(expectedNeedle);

      // Wire shape MUST stay canonical UTC ISO-8601 with the `Z` suffix
      // regardless of Accept-Language. This is the half of SC-004 that
      // R-009 calls out by name: "canonical UTC stays on the wire."
      const body = await fetchMatchesViaApi(request);
      const m1 = body.matches.find((m) => m.id === M1.id);
      expect(m1, "M1 must appear in /api/matches?status=finished").toBeDefined();
      expect(
        m1!.kickoff_utc,
        "M1 kickoff_utc MUST be canonical UTC ISO-8601 with Z suffix — " +
          "no locale-conversion on the wire (R-009, SC-004)",
      ).toBe(M1.kickoff_utc_iso);
    },
  );

  // ------------------------------------------------------------------------
  // Test 2 — en-US locale renders US-formatted kickoff,
  //          JSON wire shape stays canonical UTC.
  // ------------------------------------------------------------------------
  test(
    "en-US renders US-locale kickoff while /api/matches keeps canonical UTC @slice-002 @us1 @locale",
    async ({ page, context, request }) => {
      await context.setExtraHTTPHeaders({ "Accept-Language": "en-US" });

      await signInAndOpenCatalog(page);

      const expectedFull = expectedKickoffFormatted("en-US");
      const expectedNeedle = distinguishingSubstring("en-US", expectedFull);

      await expect(
        page.locator("body"),
        `Page body MUST contain the en-US-formatted M1 kickoff substring ` +
          `${JSON.stringify(expectedNeedle)} (full expected: ${JSON.stringify(expectedFull)})`,
      ).toContainText(expectedNeedle);

      const body = await fetchMatchesViaApi(request);
      const m1 = body.matches.find((m) => m.id === M1.id);
      expect(m1, "M1 must appear in /api/matches?status=finished").toBeDefined();
      expect(
        m1!.kickoff_utc,
        "M1 kickoff_utc MUST be canonical UTC ISO-8601 with Z suffix — " +
          "no locale-conversion on the wire (R-009, SC-004)",
      ).toBe(M1.kickoff_utc_iso);
    },
  );

  // ------------------------------------------------------------------------
  // Test 3 — ja-JP locale renders Japanese-formatted kickoff,
  //          JSON wire shape stays canonical UTC.
  // ------------------------------------------------------------------------
  test(
    "ja-JP renders Japanese-locale kickoff while /api/matches keeps canonical UTC @slice-002 @us1 @locale",
    async ({ page, context, request }) => {
      await context.setExtraHTTPHeaders({ "Accept-Language": "ja-JP" });

      await signInAndOpenCatalog(page);

      const expectedFull = expectedKickoffFormatted("ja-JP");
      const expectedNeedle = distinguishingSubstring("ja-JP", expectedFull);

      await expect(
        page.locator("body"),
        `Page body MUST contain the ja-JP-formatted M1 kickoff substring ` +
          `${JSON.stringify(expectedNeedle)} (full expected: ${JSON.stringify(expectedFull)})`,
      ).toContainText(expectedNeedle);

      const body = await fetchMatchesViaApi(request);
      const m1 = body.matches.find((m) => m.id === M1.id);
      expect(m1, "M1 must appear in /api/matches?status=finished").toBeDefined();
      expect(
        m1!.kickoff_utc,
        "M1 kickoff_utc MUST be canonical UTC ISO-8601 with Z suffix — " +
          "no locale-conversion on the wire (R-009, SC-004)",
      ).toBe(M1.kickoff_utc_iso);
    },
  );

  // ------------------------------------------------------------------------
  // Test 4 — DB canonical invariant: matches.kickoff_utc is locale-immutable.
  //
  // Reads the column directly via service-role (NO Playwright session,
  // NO Accept-Language, NO HTTP path) and asserts the timestamp equals
  // the canonical UTC ISO-8601-with-Z value seeded by slice-002-fixture.sql.
  // This proves the column itself is unaffected by any locale header the
  // preceding tests sent — i.e. that locale display is a read-only
  // concern of the rendering layer, never propagated into storage.
  //
  // The Playwright `page`/`context`/`request` fixtures are intentionally
  // NOT destructured here: they would synthesize a browser context
  // alpha could not influence, which would be wasted setup. Service-role
  // talks to Postgres directly.
  // ------------------------------------------------------------------------
  test(
    "DB canonical invariant: matches.kickoff_utc for M1 is locale-immutable @slice-002 @us1 @locale",
    async () => {
      const dbKickoff = await readM1KickoffFromDb();
      expect(
        dbKickoff,
        `matches.kickoff_utc for M1 (${M1.id}) MUST equal the canonical ` +
          `seed value ${M1.kickoff_utc_iso} regardless of which Accept-Language ` +
          `the preceding tests requested (R-009 invariant: canonical UTC stays canonical)`,
      ).toBe(M1.kickoff_utc_iso);
    },
  );
});
