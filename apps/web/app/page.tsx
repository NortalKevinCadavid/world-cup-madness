import { Trophy } from "lucide-react";

import { SignInButton } from "./SignInButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";

export default function LandingPage() {
  return (
    <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-4 py-12 sm:px-6">
      {/* Festive backdrop accents — purely decorative, suppressed under reduced motion. */}
      <div
        aria-hidden
        data-motion-decorative
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.18),transparent_60%)] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-deliberate"
      />

      <Card className="relative z-10 w-full max-w-lg border-border bg-card/95 backdrop-blur">
        <CardHeader className="items-center gap-3 text-center">
          <div className="rounded-full bg-primary/10 p-3 text-primary">
            <Trophy className="size-8" aria-hidden />
          </div>
          <Badge variant="gold">FIFA World Cup 2026</Badge>
          <CardTitle className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            World Cup Madness
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-sm text-muted-foreground sm:text-base">
            Internal Nortal prediction pool. Sign in with your approved Nortal
            corporate identity to start picking match scores, locking your
            tournament finals, and chasing the leaderboard.
          </p>
          <SignInButton />
          <p className="text-xs text-muted-foreground/80">
            Access is restricted to approved Nortal corporate identities.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
