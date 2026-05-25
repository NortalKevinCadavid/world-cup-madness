import "server-only";

import Link from "next/link";
import { Trophy } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { Participant } from "../../lib/types/participant";
import { cn } from "@/lib/utils";
import { Badge } from "@/app/components/ui/badge";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { LanguageSwitcher } from "@/app/components/LanguageSwitcher";
import { MobileNavSheet } from "@/app/components/MobileNavSheet";
import { UserMenu } from "@/app/components/UserMenu";

type Section = "dashboard" | "matches" | "leaderboard" | "me" | "admin";

interface TopNavProps {
  participant: Participant;
  isAdmin: boolean;
  /** Which top-level section the current page belongs to (used to highlight). */
  activeSection?: Section | null;
}

export async function TopNav({
  participant,
  isAdmin,
  activeSection = null,
}: TopNavProps) {
  const t = await getTranslations("Nav");

  // Labels resolved at render-time per active locale (see apps/web/i18n/request.ts).
  // PARTICIPANT_LINKS is rebuilt each render rather than module-scoped because
  // useTranslations is request-bound.
  const participantLinks: { href: string; label: string; section: Section }[] = [
    { href: "/dashboard", label: t("dashboard"), section: "dashboard" },
    { href: "/matches", label: t("matches"), section: "matches" },
    { href: "/leaderboard", label: t("leaderboard"), section: "leaderboard" },
    { href: "/me/finals", label: t("myPicks"), section: "me" },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <nav
        aria-label={t("primaryAriaLabel")}
        className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6"
      >
        <Link
          href="/dashboard"
          className={cn(
            "flex items-center gap-2 font-display text-base font-bold text-foreground",
            "transition-colors duration-base hover:text-primary",
          )}
        >
          <Trophy
            className="size-5 text-primary motion-safe:transition-transform motion-safe:duration-base"
            aria-hidden
          />
          <span>{t("appName")}</span>
        </Link>

        <ul className="hidden flex-1 items-center gap-1 text-sm md:flex">
          {participantLinks.map(({ href, label, section }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={activeSection === section ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium",
                  "transition-colors duration-base ease-standard",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  activeSection === section
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {label}
              </Link>
            </li>
          ))}
          {isAdmin ? (
            <li>
              <Link
                href="/admin"
                aria-current={activeSection === "admin" ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                  "transition-colors duration-base ease-standard",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  activeSection === "admin"
                    ? "bg-gold text-foreground"
                    : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {t("admin")}
                <Badge variant="gold" className="hidden lg:inline-flex">
                  {t("staffBadge")}
                </Badge>
              </Link>
            </li>
          ) : null}
        </ul>

        <div className="ml-auto flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
          <UserMenu participant={participant} />
          <MobileNavSheet
            links={participantLinks}
            isAdmin={isAdmin}
            activeSection={activeSection}
          />
        </div>
      </nav>
    </header>
  );
}
