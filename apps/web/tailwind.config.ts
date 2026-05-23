import type { Config } from "tailwindcss";

// Slice 009-ui-beautification:
//   Tokens are defined as HSL component triples in app/globals.css
//   (e.g. `--background: 30 14% 98%`). Tailwind utilities resolve
//   them via `hsl(var(--token) / <alpha-value>)` so opacity utilities
//   (`bg-primary/80`) still work.
//   Names below MUST track contracts/design-tokens.md.

const config: Config = {
  darkMode: ["class"],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",

        // Domain-specific tokens (sport context)
        win: "hsl(var(--win) / <alpha-value>)",
        loss: "hsl(var(--loss) / <alpha-value>)",
        draw: "hsl(var(--draw) / <alpha-value>)",
        rank: {
          up: "hsl(var(--rank-up) / <alpha-value>)",
          down: "hsl(var(--rank-down) / <alpha-value>)",
          same: "hsl(var(--rank-same) / <alpha-value>)",
        },
        locked: "hsl(var(--locked) / <alpha-value>)",
        open: "hsl(var(--open) / <alpha-value>)",
        scored: "hsl(var(--scored) / <alpha-value>)",
        gold: "hsl(var(--gold) / <alpha-value>)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        full: "var(--radius-full)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
      },
      transitionDuration: {
        fast: "var(--motion-duration-fast)",
        base: "var(--motion-duration-base)",
        slow: "var(--motion-duration-slow)",
        deliberate: "var(--motion-duration-deliberate)",
      },
      transitionTimingFunction: {
        standard: "var(--motion-easing-standard)",
        emphasis: "var(--motion-easing-emphasis)",
        exit: "var(--motion-easing-exit)",
      },
    },
  },
  plugins: [],
};
export default config;
