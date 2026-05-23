import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// Slice 001 D-T021-006: /auth/callback is a ROUTE HANDLER (not a page) because
// Server Components in Next.js App Router are read-only for cookies — only
// Route Handlers and Server Actions can write them. PKCE's
// exchangeCodeForSession needs to commit the access_token + refresh_token as
// HttpOnly cookies, which requires a writable cookie surface.
//
// We return an HTML response with a JS redirect (rather than
// NextResponse.redirect) because @supabase/ssr emits CHUNKED cookies
// (sb-<ref>-auth-token.0, .1) whose base64 values are just under the 4 KB
// per-cookie limit. The plain HTML response with response.cookies.set passes
// them through correctly via the standard Set-Cookie path. NextResponse.redirect
// in some configurations would also work, but the HTML path avoids subtle
// edge cases with how middleware/server-action interplay handles redirect
// responses + multi-Set-Cookie headers.

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const next = url.searchParams.get('next') ?? '/dashboard';

  if (error) {
    console.error(
      '[auth/callback] OAuth provider error:',
      error,
      url.searchParams.get('error_description') ?? '',
    );
    return NextResponse.redirect(new URL('/auth/denied', request.url));
  }

  if (!code) {
    console.warn('[auth/callback] no code in query — no session to establish');
    return NextResponse.redirect(new URL('/auth/denied', request.url));
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const cookieStore = cookies();

  // Build an HTML response with a JS-based redirect. The setAll callback
  // writes the session cookies onto response.cookies, which Next.js converts
  // into proper Set-Cookie headers (one per cookie, correctly chunked).
  const nextUrl = new URL(next, request.url).toString();
  const body = `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=${nextUrl}"><title>Signing in…</title></head><body><script>window.location.replace(${JSON.stringify(nextUrl)});</script><p>Signing in… <a href="${nextUrl}">Continue</a></p></body></html>`;
  const response = new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set({ name, value, ...options });
        }
      },
    },
  });

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    console.error(
      '[auth/callback] exchangeCodeForSession failed:',
      exchangeError.message,
    );
    return NextResponse.redirect(new URL('/auth/denied', request.url));
  }

  return response;
}
