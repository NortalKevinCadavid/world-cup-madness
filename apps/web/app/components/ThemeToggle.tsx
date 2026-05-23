"use client";

/**
 * ThemeToggle — lets the user pick light / dark / system from the top nav.
 * Contract: specs/009-ui-beautification/contracts/component-api.md § ThemeToggle.
 */

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Check, Laptop, Moon, Sun } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";

type Choice = { value: "light" | "dark" | "system"; label: string; icon: typeof Sun };

const CHOICES: Choice[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch: render the trigger only after mount.
  useEffect(() => setMounted(true), []);

  const active = (theme ?? "system") as Choice["value"];
  const TriggerIcon =
    !mounted
      ? Laptop
      : active === "system"
        ? Laptop
        : resolvedTheme === "dark"
          ? Moon
          : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle theme"
          aria-haspopup="menu"
        >
          <TriggerIcon className="size-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {CHOICES.map(({ value, label, icon: Icon }) => {
          const selected = active === value;
          return (
            <DropdownMenuItem
              key={value}
              onSelect={() => setTheme(value)}
              aria-checked={selected}
              role="menuitemradio"
            >
              <Icon className="size-4" aria-hidden />
              <span className="flex-1">{label}</span>
              {selected ? (
                <Check className="size-4 text-primary" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ThemeToggle;
