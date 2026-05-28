'use client';

import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';

// Magic-link sign-in. signInWithOtp emails a single-use link to the entered
// address; clicking it lands on /auth/callback which calls verifyOtp and
// commits the session cookies. The @nortal.com check here is a UX hint — the
// authoritative gate is the auth.users trigger (handle_auth_user_created) +
// requireEligible, which reject any non-approved domain server-side.

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const APPROVED_DOMAIN = 'nortal.com';

export function MagicLinkForm() {
  const t = useTranslations('Landing');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const value = email.trim().toLowerCase();
    if (!value.endsWith(`@${APPROVED_DOMAIN}`)) {
      setError(t('invalidDomain'));
      return;
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      setError('Supabase environment variables are not configured.');
      return;
    }

    setPending(true);
    const supabase = createBrowserClient(url, anonKey);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: value,
      options: {
        emailRedirectTo: `${SITE_URL}/auth/callback`,
        shouldCreateUser: true,
      },
    });
    setPending(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="magic-link-sent"
        className="flex flex-col items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-4 py-3 text-center text-sm"
      >
        <Mail className="size-5 text-primary" aria-hidden />
        <span className="font-medium text-foreground">{t('checkEmailTitle')}</span>
        <span className="text-muted-foreground">{t('checkEmailBody', { email })}</span>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col items-stretch gap-2">
      <label htmlFor="magic-email" className="sr-only">
        {t('emailLabel')}
      </label>
      <Input
        id="magic-email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        placeholder={t('emailPlaceholder')}
        value={email}
        disabled={pending}
        onChange={(e) => setEmail(e.target.value)}
        data-testid="magic-link-email"
      />
      <Button size="lg" type="submit" disabled={pending} data-testid="magic-link-submit">
        <Mail className="size-4" aria-hidden />
        {pending ? t('sendingLink') : t('sendLink')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
