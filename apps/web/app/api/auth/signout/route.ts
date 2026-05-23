import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// Sign-out route handler. POST clears the Supabase session via signOut(),
// which deletes the session row in auth.sessions AND emits Set-Cookie headers
// with Max-Age=0 to clear the browser-side auth cookies. Then redirects to /.
//
// POST (not GET) so a stray prefetch / nav from a logged-in tab can't
// accidentally sign the user out.

export const runtime = 'nodejs';

async function handle(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const cookieStore = cookies();
  const response = NextResponse.redirect(new URL('/', request.url), { status: 303 });

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

  await supabase.auth.signOut().catch(() => {
    // Best-effort: even if the server-side signOut fails, the redirect
    // still goes back to /. The browser cookies are cleared by setAll
    // above when supabase-js sends the clear instructions.
  });

  return response;
}

export const POST = handle;
