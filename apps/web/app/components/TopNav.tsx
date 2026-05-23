import "server-only";

import Link from "next/link";
import { Trophy } from "lucide-react";

import type { Participant } from "../../lib/types/participant";
import { cn } from "@/lib/utils";
import { Badge } from "@/app/components/ui/badge";
import { ThemeToggle } from "@/app/components/ThemeToggle";
import { MobileNavSheet } from "@/app/components/MobileNavSheet";
import { UserMenu } from "@/app/components/UserMenu";

type Section = "dashboard" | "matches" | "leaderboard" | "me" | "admin";

interface TopNavProps {
  participant: Participant;
  isAdmin: boolean;
  /** Which top-level section the current page belongs to (used to highlight). */
  activeSection?: Section | null;
}

const PARTICIPANT_LINKS: { href: string; label: string; section: Section }[] = [
  { href: "/dashboard", label: "Dashboard", section: "dashboard" },
  { href: "/matches", label: "Matches", section: "matches" },
  { href: "/leaderboard", label: "Leaderboard", section: "leaderboard" },
  { href: "/me/finals", label: "My picks", section: "me" },
];

export function TopNav({
  participant,
  isAdmin,
  activeSection = null,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <nav
        aria-label="Primary"
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
          <span>World Cup Madness</span>
        </Link>

        <ul className="hidden flex-1 items-center gap-1 text-sm md:flex">
          {PARTICIPANT_LINKS.map(({ href, label, section }) => (
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
                Admin
                <Badge variant="gold" className="hidden lg:inline-flex">
                  Staff
                </Badge>
              </Link>
            </li>
          ) : null}
        </ul>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <UserMenu participant={participant} />
          <MobileNavSheet
            links={PARTICIPANT_LINKS}
            isAdmin={isAdmin}
            activeSection={activeSection}
          />
        </div>
      </nav>
    </header>
  );
}
