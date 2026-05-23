'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { LogIn } from 'lucide-react';
import { Button } from '@/app/components/ui/button';

// Slice 001 D-T021-005: use supabase.auth.signInWithOAuth from the browser so
// the SDK negotiates PKCE automatically. PKCE returns `?code=` on the redirect
// (consumed server-side by /auth/callback's exchangeCodeForSession), which can
// set HttpOnly cookies — required for server components to read the session
// via supabase.auth.getUser(). Direct GET to /auth/v1/authorize would use the
// implicit flow (token in URL fragment), which browser JS cannot turn into
// HttpOnly cookies.

const PROVIDER = (process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? 'keycloak') as 'keycloak' | 'azure';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      setError('Supabase environment variables are not configured.');
      setPending(false);
      return;
    }
    const supabase = createBrowserClient(url, anonKey);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: PROVIDER,
      options: {
        redirectTo: `${SITE_URL}/auth/callback`,
        scopes: 'openid profile email',
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setPending(false);
    }
    // On success, supabase-js redirects the browser; no further action needed.
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button size="lg" type="button" onClick={onClick} disabled={pending}>
        <LogIn className="size-4" aria-hidden />
        {pending ? 'Redirecting…' : 'Sign in'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
