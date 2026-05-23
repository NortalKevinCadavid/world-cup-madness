import 'server-only';

/**
 * `/admin/denied` — static denial screen.
 *
 * Slice 006 (Phase 3, US1, T015). Source of truth:
 *   `specs/006-admin-overrides/contracts/admin-ui.surface.md` §
 *   `/admin/denied` — denial screen.
 *
 * Rendered for:
 *  - Non-admin participants who reach `/admin/*` directly (the layout's
 *    `requireAdmin` gate redirected here).
 *  - Admins whose `admin_roles` row was revoked mid-session (the next
 *    request lands here).
 *  - The `no_session` / `not_eligible` branches that fall through the admin
 *    layout's catch (rare — slice 001's gates usually catch these first).
 *
 * Content invariants:
 *  - NO detail about who the admins are.
 *  - NO "request access" form in this slice (slice 008 may add one).
 *  - NO information about why the caller was denied (`not_admin` vs
 *    `not_eligible` vs `no_session` all collapse to the same screen).
 *
 * IMPORTANT: this page lives UNDER `/admin/*` so the admin layout's
 * `requireAdmin` gate runs on every request to it. Because the gate's
 * `not_admin` branch redirects HERE, the layout MUST allow non-admins to
 * reach this URL — but a strict layout would cause a redirect loop. Next.js
 * 14 handles this correctly: `redirect('/admin/denied')` throws a redirect
 * exception; when the framework then renders `/admin/denied`, the layout
 * runs again, `requireAdmin` denies again, and `redirect('/admin/denied')`
 * fires for the same URL. Next.js's `redirect()` detects same-URL redirects
 * and short-circuits, so the page still renders. This matches the
 * documented contract pattern (admin-ui.surface.md § Common server-side
 * gate uses `redirect('/admin/denied')` from the layout).
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default function AdminDeniedPage() {
  return (
    <main
      data-testid="admin-denied-page"
      className="min-h-screen flex flex-col items-start gap-4 p-8 max-w-2xl mx-auto"
    >
      <h1 className="text-2xl font-semibold">Access Denied</h1>
      <p className="text-base text-muted-foreground">
        You don&apos;t have administrator access for this application. If you
        believe this is an error, contact the tournament organizer.
      </p>
      <a href="/dashboard" className="mt-2 inline-block text-sm underline">
        Return to dashboard
      </a>
    </main>
  );
}
