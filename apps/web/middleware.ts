import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Slice 001 T031 (deferred): Supabase SSR middleware — refreshes the session
// cookies on every request so server components and route handlers see a fresh
// auth.users via supabase.auth.getUser(). Without this, the access_token in the
// cookie may expire (or fail validation) between sign-in and the first server
// render, surfacing as a spurious 'no_session' from requireEligible() and a
// redirect to /auth/denied. The pattern is the canonical one from
// supabase.com/docs/guides/auth/server-side/nextjs.

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // IMPORTANT: do not run any code between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard
  // to debug issues with users being randomly logged out.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Match every path except Next.js internals + static assets + auth/callback
    // (the auth-callback route handler owns its own cookie commit; running the
    // session-refresh middleware first risks clobbering its Set-Cookie output).
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
