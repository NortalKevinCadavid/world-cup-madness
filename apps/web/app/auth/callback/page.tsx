import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

import {
  EligibilityError,
  requireEligible,
} from '../../../lib/auth/requireEligible';

/**
 * OAuth callback endpoint. Supabase Auth redirects here with `?code=...` after
 * the IdP completes the round-trip. By the time this page renders, the
 * server-side auth hook has already made the eligibility decision (R-004):
 *
 *  - Eligible user → hook admitted the sign-in and provisioned the
 *    `participants` row. We exchange the code for a session and redirect to
 *    `/dashboard`.
 *  - Ineligible user → hook rejected the sign-in. The `exchangeCodeForSession`
 *    call (or the subsequent `requireEligible` guard) surfaces the denial,
 *    and we redirect to `/auth/denied`.
 *
 * Server component only. Never imports client code. Never uses the
 * service-role key.
 *
 * @see specs/001-eligibility-login/contracts/auth-callback.page.md
 * @see specs/001-eligibility-login/research.md (R-004)
 */
export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: {
    code?: string;
    error?: string;
    error_description?: string;
  };
}) {
  // Provider returned an error in the query string (e.g. user cancelled,
  // hook rejected). Treat as a denial — no session was issued.
  if (searchParams.error) {
    console.error(
      '[auth/callback] OAuth provider returned error:',
      searchParams.error,
      searchParams.error_description ?? '',
    );
    redirect('/auth/denied');
  }

  // No code, no error → page was hit directly. There is no session to
  // establish; treat as a missing-session denial rather than a 500.
  if (!searchParams.code) {
    redirect('/auth/denied');
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // Mis-configured deployment — bubble up so Next.js renders the error
    // boundary instead of silently redirecting to denied.
    throw new Error('Supabase environment variables are not configured.');
  }

  const cookieStore = cookies();

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map(({ name, value }) => ({ name, value }));
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Cookie mutation outside of a Server Action / Route Handler is a
            // no-op in Next.js. The Next.js middleware refreshes session
            // cookies on subsequent requests (T031); swallow here.
          }
        }
      },
    },
  });

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
    searchParams.code,
  );

  if (exchangeError) {
    console.error(
      '[auth/callback] exchangeCodeForSession failed:',
      exchangeError.message,
    );
    redirect('/auth/denied');
  }

  try {
    await requireEligible();
  } catch (err) {
    if (err instanceof EligibilityError) {
      if (
        err.reason === 'no_session' ||
        err.reason === 'not_eligible' ||
        err.reason === 'participant_not_provisioned'
      ) {
        redirect('/auth/denied');
      }
      // `internal` — bubble up so Next.js renders the error boundary.
      throw err;
    }
    throw err;
  }

  redirect('/dashboard');
}
