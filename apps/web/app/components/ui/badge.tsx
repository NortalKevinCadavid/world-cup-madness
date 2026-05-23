import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  cn(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
    "transition-colors duration-base ease-standard",
    "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  ),
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        accent: "border-transparent bg-accent text-accent-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground border-border",
        win: "border-transparent bg-win/20 text-win",
        loss: "border-transparent bg-loss/20 text-loss",
        draw: "border-transparent bg-draw/20 text-draw",
        open: "border-transparent bg-open/15 text-open",
        locked: "border-transparent bg-locked/15 text-locked",
        scored: "border-transparent bg-scored/15 text-scored",
        gold: "border-transparent bg-gold/20 text-gold",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
