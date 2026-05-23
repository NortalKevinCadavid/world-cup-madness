import { SignInButton } from './SignInButton';

export default function LandingPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold">World Cup Madness</h1>
      <p className="text-sm text-neutral-600 max-w-md text-center">
        Internal Nortal prediction pool for the FIFA World Cup 2026. Sign in with your
        approved Nortal corporate identity to start picking.
      </p>
      <SignInButton />
    </main>
  );
}
