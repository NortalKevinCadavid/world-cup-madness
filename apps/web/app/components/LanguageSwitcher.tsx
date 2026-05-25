"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Globe } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Button } from "@/app/components/ui/button";

// Mirrors apps/web/i18n/request.ts § SUPPORTED_LOCALES. Kept in sync by
// hand because next-intl resolves locales on the server and the static
// JSON files don't surface a type-safe enum to the client bundle.
const LOCALES = ["en", "es", "pt"] as const;
type Locale = (typeof LOCALES)[number];

const LOCALE_COOKIE = "NEXT_LOCALE";

export function LanguageSwitcher() {
  const t = useTranslations("LanguageSwitcher");
  const current = useLocale() as Locale;
  const [isPending, startTransition] = useTransition();

  function setLocale(next: Locale) {
    if (next === current) return;
    // 1-year cookie, lax samesite so the language survives across
    // Keycloak/Supabase auth redirects.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // Full reload — every server component re-reads getRequestConfig and
    // re-imports the new messages catalog. A simple router.refresh() would
    // miss client components' useTranslations() bindings (next-intl
    // client provider is per-mount, not reactive to cookie changes).
    startTransition(() => {
      window.location.reload();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("label")}
          disabled={isPending}
          data-testid="language-switcher"
        >
          <Globe className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale}
            onClick={() => setLocale(locale)}
            aria-current={locale === current ? "true" : undefined}
            data-testid={`language-switcher-option-${locale}`}
            className={
              locale === current ? "font-semibold text-foreground" : undefined
            }
          >
            {t(locale)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
