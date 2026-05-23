"use client";

/**
 * /design-system — the cross-slice design reference.
 *
 * Spec ref: specs/009-ui-beautification/spec.md US1.
 * Page contract (anchors): tokens-colors, tokens-typography, tokens-spacing,
 *   tokens-radii, tokens-motion, components-button, components-card,
 *   components-dialog, components-dropdown-menu, components-input,
 *   components-popover, components-tooltip, components-tabs, components-toast,
 *   components-table, components-badge, components-skeleton, components-domain.
 * Tested by tests/e2e/009-ui-beautification/us1/design-system-page.spec.ts
 * + contrast/tokens.spec.ts (every swatch carries data-token-pair="bg:fg").
 */

import { useState } from "react";
import { Trophy } from "lucide-react";

import { ThemeToggle } from "@/app/components/ThemeToggle";
import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Badge } from "@/app/components/ui/badge";
import { Skeleton } from "@/app/components/ui/skeleton";
import { Separator } from "@/app/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/app/components/ui/toast";
import { Flag } from "@/app/components/Flag";
import { EmptyState } from "@/app/components/EmptyState";
import { ErrorState } from "@/app/components/ErrorState";
import { MotionToggle } from "@/app/components/MotionToggle";

type TokenPair = {
  bgVar: string;
  fgVar: string;
  label: string;
  role?: "body" | "large" | "non-text";
};

const SURFACE_PAIRS: TokenPair[] = [
  { bgVar: "background", fgVar: "foreground", label: "background / foreground" },
  { bgVar: "card", fgVar: "card-foreground", label: "card / card-foreground" },
  { bgVar: "popover", fgVar: "popover-foreground", label: "popover / popover-foreground" },
  { bgVar: "muted", fgVar: "muted-foreground", label: "muted / muted-foreground" },
];

const INTERACTION_PAIRS: TokenPair[] = [
  { bgVar: "primary", fgVar: "primary-foreground", label: "primary / primary-foreground" },
  { bgVar: "secondary", fgVar: "secondary-foreground", label: "secondary / secondary-foreground" },
  { bgVar: "accent", fgVar: "accent-foreground", label: "accent / accent-foreground" },
  { bgVar: "destructive", fgVar: "destructive-foreground", label: "destructive / destructive-foreground" },
];

const TYPE_RAMP = [
  { className: "text-xs", label: "text-xs — microcopy, badge text" },
  { className: "text-sm", label: "text-sm — default body on mobile" },
  { className: "text-base", label: "text-base — default body on desktop" },
  { className: "text-lg", label: "text-lg — card heading" },
  { className: "text-xl", label: "text-xl — section heading" },
  { className: "text-2xl", label: "text-2xl — page heading (mobile)" },
  { className: "text-3xl", label: "text-3xl — page heading (desktop)" },
  { className: "text-4xl", label: "text-4xl — hero" },
];

const SPACING_SCALE = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24] as const;

const RADII = [
  { className: "rounded-sm", label: "rounded-sm (0.25rem)" },
  { className: "rounded-md", label: "rounded-md (0.625rem)" },
  { className: "rounded-lg", label: "rounded-lg (0.75rem) — card default" },
  { className: "rounded-xl", label: "rounded-xl (1rem)" },
  { className: "rounded-full", label: "rounded-full (chip)" },
];

export function DesignSystemClient() {
  const [toastOpen, setToastOpen] = useState(false);

  return (
    <ToastProvider>
      <TooltipProvider>
        <main className="min-h-screen bg-background text-foreground">
          <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
            <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-2 font-display font-bold">
                <Trophy className="size-5 text-primary" aria-hidden />
                <span>World Cup Madness — Design System</span>
              </div>
              <ThemeToggle />
            </div>
          </header>

          <div className="mx-auto max-w-5xl space-y-12 px-4 py-8 sm:px-6">
            <section>
              <h1 className="font-display text-3xl font-bold sm:text-4xl">
                Design System
              </h1>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                The living reference for every token and component in World
                Cup Madness. Toggle the theme above; everything flips. Every
                token is locked by{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  contracts/design-tokens.md
                </code>
                .
              </p>
            </section>

            <section id="tokens-colors" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">
                Color tokens
              </h2>
              <TokenGroup title="Surface tokens" pairs={SURFACE_PAIRS} />
              <TokenGroup
                title="Interaction tokens"
                pairs={INTERACTION_PAIRS}
              />
              <DomainTokenRow />
            </section>

            <section id="tokens-typography" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">
                Typography
              </h2>
              <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                {TYPE_RAMP.map((row) => (
                  <p key={row.className} className={row.className}>
                    {row.label}
                  </p>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="font-sans text-base">
                    Body — font-sans (Inter). The quick brown fox jumps over
                    the lazy dog.
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                  <p className="font-display text-2xl font-semibold tabular-nums">
                    Display — 12 : 34 : 56
                  </p>
                </div>
              </div>
            </section>

            <section id="tokens-spacing" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">
                Spacing scale
              </h2>
              <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                {SPACING_SCALE.map((unit) => (
                  <div key={unit} className="flex items-center gap-3">
                    <span className="w-12 font-mono text-xs text-muted-foreground">
                      {unit}
                    </span>
                    <div
                      className="h-3 rounded bg-primary/30"
                      style={{ width: `${unit * 0.25}rem` }}
                    />
                  </div>
                ))}
              </div>
            </section>

            <section id="tokens-radii" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Radii</h2>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {RADII.map((r) => (
                  <div
                    key={r.className}
                    className={`flex h-24 items-center justify-center border border-border bg-card text-center text-xs text-muted-foreground ${r.className}`}
                  >
                    {r.label}
                  </div>
                ))}
              </div>
            </section>

            <section id="tokens-motion" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">
                Motion samples
              </h2>
              <p className="text-sm text-muted-foreground">
                Hover the card. Under <em>prefers-reduced-motion: reduce</em>{" "}
                or the in-app motion toggle, the animation is suppressed.
              </p>
              <div
                data-motion-decorative
                className="grid cursor-default place-items-center rounded-lg border border-border bg-card p-12 motion-safe:transition-transform motion-safe:duration-base motion-safe:ease-standard hover:motion-safe:scale-[1.02] hover:motion-safe:bg-accent/10"
              >
                <span className="font-display text-xl">Hover me</span>
              </div>
              <div className="rounded-lg border border-border bg-card p-4">
                <h3 className="font-display text-sm font-semibold">
                  Motion override
                </h3>
                <div className="mt-3">
                  <MotionToggle />
                </div>
              </div>
            </section>

            <Separator />

            <section id="components-button" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Button</h2>
              <div className="flex flex-wrap gap-3">
                <Button>Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="link">Link</Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm">Small</Button>
                <Button>Default</Button>
                <Button size="lg">Large</Button>
                <Button size="icon" aria-label="Icon">
                  <Trophy aria-hidden />
                </Button>
              </div>
            </section>

            <section id="components-card" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Card</h2>
              <Card className="max-w-sm">
                <CardHeader>
                  <CardTitle>Argentina vs France</CardTitle>
                  <CardDescription>
                    Sunday • 18:00 local • Group C
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center gap-3">
                  <Flag code="ARG" /> <span className="text-2xl font-display">vs</span>{" "}
                  <Flag code="FRA" />
                </CardContent>
                <CardFooter className="gap-2">
                  <Badge variant="open">Open</Badge>
                  <Button size="sm">Make your pick</Button>
                </CardFooter>
              </Card>
            </section>

            <section id="components-input" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Input</h2>
              <div className="grid max-w-sm gap-2">
                <Label htmlFor="ds-input">Display name</Label>
                <Input id="ds-input" placeholder="Type here…" />
              </div>
            </section>

            <section id="components-badge" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Badge</h2>
              <div className="flex flex-wrap gap-2">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="accent">Accent</Badge>
                <Badge variant="destructive">Destructive</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="win">Win</Badge>
                <Badge variant="loss">Loss</Badge>
                <Badge variant="draw">Draw</Badge>
                <Badge variant="open">Open</Badge>
                <Badge variant="locked">Locked</Badge>
                <Badge variant="scored">Scored</Badge>
                <Badge variant="gold">Top 3</Badge>
              </div>
            </section>

            <section
              id="components-skeleton"
              className="scroll-mt-20 space-y-4"
            >
              <h2 className="font-display text-2xl font-semibold">Skeleton</h2>
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-24 w-full" />
              </div>
            </section>

            <section id="components-tabs" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Tabs</h2>
              <Tabs defaultValue="overview" className="max-w-md">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="picks">Picks</TabsTrigger>
                  <TabsTrigger value="stats">Stats</TabsTrigger>
                </TabsList>
                <TabsContent value="overview">
                  <p className="text-sm text-muted-foreground">
                    Your tournament at a glance.
                  </p>
                </TabsContent>
                <TabsContent value="picks">
                  <p className="text-sm text-muted-foreground">
                    Your locked-in match-day picks.
                  </p>
                </TabsContent>
                <TabsContent value="stats">
                  <p className="text-sm text-muted-foreground">
                    Accuracy and streak.
                  </p>
                </TabsContent>
              </Tabs>
            </section>

            <section
              id="components-dropdown-menu"
              className="scroll-mt-20 space-y-4"
            >
              <h2 className="font-display text-2xl font-semibold">
                Dropdown menu
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">Open menu</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem>Profile</DropdownMenuItem>
                  <DropdownMenuItem>Settings</DropdownMenuItem>
                  <DropdownMenuItem>Sign out</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </section>

            <section id="components-tooltip" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Tooltip</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>Tooltips disclose details on hover.</TooltipContent>
              </Tooltip>
            </section>

            <section id="components-popover" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Popover</h2>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">Open popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <p className="text-sm">
                    Popovers carry richer content than tooltips.
                  </p>
                </PopoverContent>
              </Popover>
            </section>

            <section id="components-dialog" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Dialog</h2>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Confirm pick</DialogTitle>
                    <DialogDescription>
                      Are you sure you want to lock your prediction?
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline">Cancel</Button>
                    <Button>Lock it</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </section>

            <section id="components-toast" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Toast</h2>
              <Button onClick={() => setToastOpen(true)}>Fire toast</Button>
              <Toast open={toastOpen} onOpenChange={setToastOpen} variant="success">
                <div className="grid gap-1">
                  <ToastTitle>Pick locked</ToastTitle>
                  <ToastDescription>Argentina 2 – 1 France saved.</ToastDescription>
                </div>
                <ToastClose />
              </Toast>
            </section>

            <section id="components-table" className="scroll-mt-20 space-y-4">
              <h2 className="font-display text-2xl font-semibold">Table</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rank</TableHead>
                    <TableHead>Player</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow aria-current="true">
                    <TableCell className="tabular-nums">1</TableCell>
                    <TableCell>You</TableCell>
                    <TableCell className="text-right tabular-nums">230</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="tabular-nums">2</TableCell>
                    <TableCell>A. Colleague</TableCell>
                    <TableCell className="text-right tabular-nums">215</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </section>

            <section
              id="components-domain"
              className="scroll-mt-20 space-y-4"
            >
              <h2 className="font-display text-2xl font-semibold">
                Domain components
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border bg-card p-4">
                  <h3 className="font-display text-sm font-semibold">Flag</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Flag code="ARG" />
                    <Flag code="FRA" />
                    <Flag code="BRA" size="sm" />
                    <Flag code="JPN" />
                    <Flag code="USA" size="lg" />
                    <Flag code="XYZ" />
                  </div>
                </div>
                <EmptyState
                  title="No picks yet"
                  description="Once predictions open, you'll see your match cards here."
                  icon={<Trophy className="size-5" aria-hidden />}
                  action={{ label: "Browse matches", href: "/matches" }}
                />
              </div>
              <ErrorState
                description="We couldn't load your standings. Try again in a moment."
                onRetry={() => {}}
                correlationId="ds-demo"
              />
            </section>
          </div>

          <ToastViewport />
        </main>
      </TooltipProvider>
    </ToastProvider>
  );
}

function TokenGroup({
  title,
  pairs,
}: {
  title: string;
  pairs: TokenPair[];
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-display text-sm font-semibold text-muted-foreground">
        {title}
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {pairs.map((p) => (
          <div
            key={p.label}
            data-token-pair={`${p.bgVar}:${p.fgVar}`}
            data-token-role={p.role ?? "body"}
            className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
            style={{
              backgroundColor: `hsl(var(--${p.bgVar}))`,
              color: `hsl(var(--${p.fgVar}))`,
            }}
          >
            <span className="font-medium">{p.label}</span>
            <code className="text-xs opacity-70">--{p.bgVar}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function DomainTokenRow() {
  const domain: { bg: string; label: string }[] = [
    { bg: "win", label: "win" },
    { bg: "loss", label: "loss" },
    { bg: "draw", label: "draw" },
    { bg: "rank-up", label: "rank-up" },
    { bg: "rank-down", label: "rank-down" },
    { bg: "rank-same", label: "rank-same" },
    { bg: "locked", label: "locked" },
    { bg: "open", label: "open" },
    { bg: "scored", label: "scored" },
    { bg: "gold", label: "gold" },
  ];
  return (
    <div className="space-y-2">
      <h3 className="font-display text-sm font-semibold text-muted-foreground">
        Domain tokens
      </h3>
      <div className="flex flex-wrap gap-2">
        {domain.map((d) => (
          <div
            key={d.label}
            data-token-pair={`${d.bg}:foreground`}
            data-token-role="non-text"
            className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
          >
            <span
              className="inline-block size-3 rounded-sm"
              style={{ backgroundColor: `hsl(var(--${d.bg}))` }}
              aria-hidden
            />
            <code>--{d.label}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
