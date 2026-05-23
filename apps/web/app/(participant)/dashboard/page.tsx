import "server-only";

import Link from "next/link";
import { redirect } from "next/navigation";
import { Trophy, ListChecks, Award, BarChart3, ArrowRight } from "lucide-react";

import { EligibilityError } from "../../../lib/auth/requireEligible";
import { getCurrentParticipant } from "../../../lib/auth/getCurrentParticipant";
import type { Participant } from "../../../lib/types/participant";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { Separator } from "@/app/components/ui/separator";
import { Button } from "@/app/components/ui/button";

export const dynamic = "force-dynamic";

const QUICK_LINKS = [
  {
    href: "/matches",
    title: "Matches",
    description:
      "Browse the fixture catalog and lock in your score predictions before kickoff.",
    icon: ListChecks,
    accent: "primary" as const,
  },
  {
    href: "/leaderboard",
    title: "Leaderboard",
    description:
      "See the tournament-wide ranking and how you stack up against your peers.",
    icon: Trophy,
    accent: "gold" as const,
  },
  {
    href: "/me/finals",
    title: "Final picks",
    description:
      "Pick the champion, runner-up, top scorer, and best player before the first kickoff.",
    icon: Award,
    accent: "secondary" as const,
  },
  {
    href: "/me/breakdown",
    title: "Your breakdown",
    description:
      "See exactly how your points were earned, match by match.",
    icon: BarChart3,
    accent: "accent" as const,
  },
];

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default async function DashboardPage() {
  let participant: Participant;
  try {
    participant = await getCurrentParticipant();
  } catch (err) {
    if (err instanceof EligibilityError) {
      redirect("/auth/denied");
    }
    throw err;
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <header className="space-y-3">
        <Badge variant="gold" className="motion-safe:animate-in motion-safe:fade-in">
          <Trophy className="size-3" aria-hidden /> FIFA World Cup 2026
        </Badge>
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Welcome, {participant.display_name}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
          Submit your match predictions, lock in your tournament finals, and
          chase the leaderboard. It&rsquo;s the Nortal prediction pool —
          loud, friendly, and a little ridiculous.
        </p>
      </header>

      <section
        aria-label="Quick links"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {QUICK_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              href={link.href}
              className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-lg"
            >
              <Card className="h-full motion-safe:transition-transform motion-safe:duration-base motion-safe:ease-standard motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:shadow-md">
                <CardHeader className="flex-row items-start gap-3 space-y-0">
                  <div
                    className={
                      link.accent === "primary"
                        ? "rounded-md bg-primary/10 p-2 text-primary"
                        : link.accent === "gold"
                          ? "rounded-md bg-gold/15 p-2 text-gold"
                          : link.accent === "secondary"
                            ? "rounded-md bg-secondary/10 p-2 text-secondary"
                            : "rounded-md bg-accent/10 p-2 text-accent"
                    }
                  >
                    <Icon className="size-5" aria-hidden />
                  </div>
                  <div className="flex-1 space-y-1">
                    <CardTitle className="text-base">{link.title}</CardTitle>
                    <CardDescription>{link.description}</CardDescription>
                  </div>
                  <ArrowRight
                    className="size-4 text-muted-foreground motion-safe:transition-transform motion-safe:duration-base motion-safe:group-hover:translate-x-1"
                    aria-hidden
                  />
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            Your account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-medium text-foreground">{participant.email}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">Domain</dt>
              <dd className="font-medium text-foreground">
                {participant.domain}
              </dd>
            </div>
            {participant.region ? (
              <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 sm:border-0 sm:pb-0">
                <dt className="text-muted-foreground">Region</dt>
                <dd className="font-medium text-foreground">{participant.region}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 sm:border-0 sm:pb-0">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Badge
                  variant={participant.status === "active" ? "win" : "outline"}
                  className="capitalize"
                >
                  {participant.status}
                </Badge>
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Last sign-in</dt>
              <dd className="font-medium text-foreground">
                {formatRelative(participant.last_login_at)}
              </dd>
            </div>
          </dl>
        </CardContent>
        <Separator />
        <CardFooter className="pt-4 text-xs text-muted-foreground">
          <Button asChild variant="link" size="sm" className="p-0">
            <Link href="/design-system">View the design system →</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
