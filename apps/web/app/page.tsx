import { Trophy } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { MagicLinkForm } from "./MagicLinkForm";
import { SignInButton } from "./SignInButton";
import { LanguageSwitcher } from "@/app/components/LanguageSwitcher";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";

export default async function LandingPage({
  searchParams,
}: {
  searchParams?: { sso?: string };
}) {
  const t = await getTranslations("Landing");
  // The Keycloak SSO button is a local dev/test sign-in stub (production uses
  // Microsoft Entra, configured separately). Hidden from the normal landing —
  // users sign in with the magic link — and only shown behind `?sso=1`, which
  // the e2e sign-in fixture appends.
  const showSso = searchParams?.sso === "1";

  return (
    <main className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-4 py-12 sm:px-6">
      {/* Top-right theme + language switchers — visible to anonymous visitors before sign-in. */}
      <div className="absolute right-4 top-4 z-20 flex items-center gap-1 sm:right-6 sm:top-6">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
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
          <Badge variant="gold">{t("wcBadge")}</Badge>
          <CardTitle className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {t("title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-sm text-muted-foreground sm:text-base">
            {t("intro")}
          </p>
          <MagicLinkForm />
          {showSso ? (
            <>
              <div className="flex w-full max-w-sm items-center gap-3 text-xs text-muted-foreground/70">
                <span className="h-px flex-1 bg-border" />
                {t("orDivider")}
                <span className="h-px flex-1 bg-border" />
              </div>
              {/* Dev/test SSO (Keycloak). Behind ?sso=1; the e2e fixture uses it. */}
              <SignInButton />
            </>
          ) : null}
          <p className="text-xs text-muted-foreground/80">{t("accessNote")}</p>
        </CardContent>
      </Card>
    </main>
  );
}
