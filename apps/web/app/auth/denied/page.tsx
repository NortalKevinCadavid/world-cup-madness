import "server-only";

import Link from "next/link";
import { ShieldX } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Button } from "@/app/components/ui/button";

/**
 * Static denial screen.
 *
 * Reached when the auth hook rejected sign-in or when `/api/me` returned 403
 * on a still-active session. **This page never re-decides eligibility** — it
 * only renders the matching message for the `?reason=` code emitted upstream.
 *
 * The page is a server component, ships only the inline icon + Link/Button JS,
 * and renders identically whether or not a session cookie is present. It MUST
 * NOT reveal:
 *   - whether a participant exists for the attempted identity,
 *   - the approved-domain list,
 *   - whether the rejection came from the auth hook, RLS, or the API guard.
 *
 * Slice 009 restyle: dressed in the new design system without changing the
 * underlying decision text or the `?reason=` code mapping.
 *
 * @see specs/001-eligibility-login/contracts/auth-callback.page.md § Behavior — /auth/denied
 */

const DENIAL_TITLE = "Access denied";

const GENERIC_MESSAGE =
  "We could not complete sign-in. Please try again, or contact your administrator.";

const REASON_MESSAGES: Readonly<Record<string, string>> = {
  domain_not_approved:
    "This application is restricted to approved Nortal corporate identities. Contact the tournament administrator if you believe this is a mistake.",
  missing_claims:
    "We could not complete sign-in because your identity provider did not return the information we need. Please try again, or contact your administrator.",
  config_unavailable:
    "We could not verify eligibility right now. Please try again in a moment.",
  deactivated:
    "This account is currently deactivated. Contact the tournament administrator.",
};

function resolveMessage(reason: string | undefined): string {
  if (reason && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason)) {
    return REASON_MESSAGES[reason];
  }
  return GENERIC_MESSAGE;
}

export default function AuthDeniedPage({
  searchParams,
}: {
  searchParams: { reason?: string };
}) {
  const message = resolveMessage(searchParams.reason);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center justify-center px-4 py-12 sm:px-6">
      <Card className="w-full border-destructive/30" role="alert">
        <CardHeader className="items-center gap-3 text-center">
          <div className="rounded-full bg-destructive/10 p-3 text-destructive">
            <ShieldX className="size-6" aria-hidden />
          </div>
          <CardTitle className="font-display text-2xl">{DENIAL_TITLE}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-center">
          <p className="text-sm text-foreground">{message}</p>
          <div className="flex flex-col items-center gap-2">
            <Button asChild>
              <Link href="/">Sign in with a different account</Link>
            </Button>
            <p className="text-xs text-muted-foreground">
              To fully sign out of your identity provider, close this browser
              window after returning to the home page.
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
