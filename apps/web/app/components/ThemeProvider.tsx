"use client";

/**
 * ThemeProvider — wraps next-themes with the slice 009 contract.
 *
 * Contract: specs/009-ui-beautification/contracts/theme-toggle.md
 *   - attribute="class"
 *   - defaultTheme="system"
 *   - enableSystem
 *   - storageKey="wcm.theme"
 *
 * Used by app/layout.tsx around the entire app body.
 */

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

export default function ThemeProvider({ children }: Props) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="wcm.theme"
      disableTransitionOnChange={false}
    >
      {children}
    </NextThemesProvider>
  );
}
