import 'server-only';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  AdminAccessDeniedError,
  requireAdmin,
} from '../../lib/auth/requireAdmin';
import { TopNav } from '../components/TopNav';

/**
 * `/admin/*` root layout — server-rendered admin shell.
 *
 * Slice 006 (Phase 3, US1, T015). Source of truth:
 *   `specs/006-admin-overrides/contracts/admin-ui.surface.md` § Common
 *   server-side gate.
 *
 * Behaviour:
 *  1. Build a session-bound (user-JWT) Supabase client from the caller's
 *     cookies — same anon-key pattern as the slice 003/004 route handlers.
 *     Never uses the service-role key.
 *  2. `await requireAdmin(client)`. This composes slice 001's
 *     `requireEligible()` with the slot 0062 `is_admin(p_user_id)` RPC. On
 *     denial it throws `AdminAccessDeniedError`:
 *       - `no_session`   — eligibility helper found no Supabase session
 *       - `not_eligible` — session present but caller is not an eligible
 *                          Nortal participant (audit row already written by
 *                          slice 001's `writeApiGuardDenial`)
 *       - `not_admin`    — eligible participant without an active
 *                          `admin_roles` row (audit row written by
 *                          `requireAdmin` itself via slot 0073's narrow RLS
 *                          INSERT policy)
 *     Every denial path → `redirect('/admin/denied')`. The denial screen
 *     deliberately leaks NO detail about which gate failed (admin-ui.surface.md
 *     § `/admin/denied` — "No detail about who the admins are.").
 *  3. On success: render the admin shell wrapper that frames every nested
 *     `/admin/*` page.
 *
 * Per the contract: "Each page additionally re-checks `requireAdmin` for
 * defense-in-depth (Next.js layouts run independently of pages)." This
 * layout is the FIRST gate; pages MUST not assume the layout ran.
 *
 * Forces dynamic rendering — the admin gate is per-request and depends on
 * cookies; static rendering would either crash on `cookies()` access or
 * cache a denial.
 *
 * @see specs/006-admin-overrides/contracts/admin-ui.surface.md
 * @see apps/web/lib/auth/requireAdmin.ts
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Session-bound Supabase client — anon key + caller cookies. Mirrors the
// helper in slice 003's /api/predictions and slice 004's /api/me/finals
// routes. Never uses the service-role key.
// ---------------------------------------------------------------------------

function createSessionBoundClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const cookieStore = cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setAll(_cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // Read-only: cookie refresh is owned by middleware.
      },
    },
  });
}

/**
 * Detect whether the layout is currently rendering the `/admin/denied`
 * page itself. Returning `true` here causes the gate to be skipped — the
 * denial page MUST be reachable for non-admins (it is exactly where they
 * land after the redirect) without triggering an infinite redirect loop.
 *
 * The reliable signal is `x-pathname`, set by middleware on EVERY request
 * (see apps/web/middleware.ts). Earlier versions of this gate tried
 * Next.js internal headers (`next-url`, `x-invoke-path`, `x-matched-path`)
 * but those are only set on RSC client-cache navigations, not on the
 * full-page reload that the redirect() target triggers — which made the
 * gate silently fall through and produce ERR_TOO_MANY_REDIRECTS for
 * every non-admin visit to /admin/*.
 *
 * The legacy headers are kept as fallbacks for defense-in-depth in case
 * middleware is bypassed (it shouldn't be — its matcher excludes only
 * Next.js internals + static assets), but x-pathname is the load-bearing
 * primary signal.
 */
function isRenderingDeniedPage(): boolean {
  const h = headers();
  const candidates = [
    h.get('x-pathname'),
    h.get('next-url'),
    h.get('x-invoke-path'),
    h.get('x-matched-path'),
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.length > 0) {
      // Strip query string for the match.
      const path = raw.split('?')[0];
      if (path === '/admin/denied' || path.endsWith('/admin/denied')) {
        return true;
      }
    }
  }
  return false;
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Skip the gate when the layout is itself rendering the denial page —
  // otherwise the redirect target would re-enter the gate and loop.
  if (isRenderingDeniedPage()) {
    return <div className="admin-shell">{children}</div>;
  }

  let client: ReturnType<typeof createSessionBoundClient>;
  try {
    client = createSessionBoundClient();
  } catch {
    // Environment misconfiguration — fail closed. The denial page is a safe
    // static surface that does not depend on Supabase.
    redirect('/admin/denied');
  }

  let participant;
  try {
    participant = await requireAdmin(client);
  } catch (err) {
    if (err instanceof AdminAccessDeniedError) {
      // Audit emission policy:
      //   - 'not_admin'   : audit row was written by `requireAdmin` itself.
      //   - 'not_eligible': audit row was written by slice 001's
      //                     `writeApiGuardDenial` inside `requireEligible`.
      //   - 'no_session'  : no participant row to attribute an audit row to
      //                     (slice 001 also skips audit in this branch).
      // The denial screen leaks no detail about which reason fired.
      redirect('/admin/denied');
    }
    // Unexpected error (infrastructure failure, etc.): surface as 500 by
    // re-throwing — the Next.js error boundary will own the response.
    throw err;
  }

  return (
    <div className="admin-shell min-h-screen flex flex-col bg-muted/30">
      <TopNav participant={participant} isAdmin={true} activeSection="admin" />
      <div className="flex-1">{children}</div>
      <footer className="border-t border-border bg-card/50">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground sm:px-6">
          <span>Admin — World Cup Madness</span>
          <a
            href="/design-system"
            className="rounded text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            Design system
          </a>
        </div>
      </footer>
    </div>
  );
}
