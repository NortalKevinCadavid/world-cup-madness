"use client";

/**
 * MobileNavSheet — collapses primary nav into a side sheet on small screens.
 * Replaces the row of nav links that the desktop TopNav exposes.
 */

import Link from "next/link";
import { useState } from "react";
import { Menu } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/app/components/ui/sheet";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/lib/utils";

type Section = "dashboard" | "matches" | "leaderboard" | "me" | "admin";

type Props = {
  links: { href: string; label: string; section: Section }[];
  isAdmin: boolean;
  activeSection: Section | null;
};

export function MobileNavSheet({ links, isAdmin, activeSection }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="size-5" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-72">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
        </SheetHeader>
        <nav aria-label="Mobile primary" className="mt-6">
          <ul className="flex flex-col gap-1">
            {links.map(({ href, label, section }) => (
              <li key={href}>
                <Link
                  href={href}
                  onClick={() => setOpen(false)}
                  aria-current={activeSection === section ? "page" : undefined}
                  className={cn(
                    "flex h-11 items-center rounded-md px-3 text-sm font-medium",
                    "transition-colors duration-base ease-standard",
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
                  onClick={() => setOpen(false)}
                  aria-current={activeSection === "admin" ? "page" : undefined}
                  className={cn(
                    "flex h-11 items-center justify-between rounded-md px-3 text-sm font-medium",
                    "transition-colors duration-base ease-standard",
                    activeSection === "admin"
                      ? "bg-gold text-foreground"
                      : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  Admin
                  <Badge variant="gold">Staff</Badge>
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

export default MobileNavSheet;
