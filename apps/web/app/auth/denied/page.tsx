import 'server-only';

/**
 * Static denial screen.
 *
 * Reached when the auth hook rejected sign-in or when `/api/me` returned 403
 * on a still-active session. **This page never re-decides eligibility** — it
 * only renders the matching message for the `?reason=` code emitted upstream.
 *
 * The page is a server component, ships zero JavaScript, and renders
 * identically whether or not a session cookie is present. It MUST NOT reveal:
 *   - whether a participant exists for the attempted identity,
 *   - the approved-domain list,
 *   - whether the rejection came from the auth hook, RLS, or the API guard.
 *
 * @see specs/001-eligibility-login/contracts/auth-callback.page.md § Behavior — /auth/denied
 */

const DENIAL_TITLE = 'Access denied';

const GENERIC_MESSAGE =
  'We could not complete sign-in. Please try again, or contact your administrator.';

// Closed set of reason codes. Keep aligned with the auth hook and `/api/me`'s
// 403 body. Any reason not in this map falls through to GENERIC_MESSAGE — no
// information leak even on unknown codes.
const REASON_MESSAGES: Readonly<Record<string, string>> = {
  domain_not_approved:
    'This application is restricted to approved Nortal corporate identities. Contact the tournament administrator if you believe this is a mistake.',
  missing_claims:
    'We could not complete sign-in because your identity provider did not return the information we need. Please try again, or contact your administrator.',
  config_unavailable:
    'We could not verify eligibility right now. Please try again in a moment.',
  deactivated:
    'This account is currently deactivated. Contact the tournament administrator.',
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
    <main className="min-h-screen flex flex-col items-start gap-6 p-6 max-w-2xl mx-auto">
      <h1 className="text-3xl font-semibold">{DENIAL_TITLE}</h1>
      <p className="text-base text-neutral-800">{message}</p>
      <div className="flex flex-col gap-2">
        <a
          href="/"
          className="inline-block text-sm font-medium text-blue-700 underline underline-offset-2"
        >
          Sign in with a different account
        </a>
        <p className="text-xs text-neutral-500">
          To fully sign out of your identity provider, close this browser
          window after returning to the home page.
        </p>
      </div>
    </main>
  );
}
