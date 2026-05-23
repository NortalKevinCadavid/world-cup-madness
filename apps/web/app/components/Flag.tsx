/**
 * Flag — country-flag renderer for slice 009-ui-beautification.
 *
 * Contract: specs/009-ui-beautification/contracts/component-api.md § Flag
 *
 * - Accepts an ISO-3 country code (case-insensitive).
 * - Renders a stylized country chip with the code + country name (when known).
 * - Always renders a 3-letter-code chip fallback even when the code IS known,
 *   so the component degrades gracefully if real SVG flag assets are missing.
 *   When real flag SVGs are vendored later, swap this implementation to import
 *   them via a code → React node map without changing the public API.
 *
 * Accessibility: role="img" + aria-label.
 *   Decorative usage (next to a redundant team-name label) MAY set
 *   aria-hidden="true" instead by passing aria-hidden via the rest props.
 */

import { forwardRef } from "react";

export type FlagSize = "sm" | "md" | "lg";

export type FlagProps = {
  code: string;
  size?: FlagSize;
  className?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

const DIMENSIONS: Record<FlagSize, { width: number; height: number; fontSize: string }> = {
  sm: { width: 24, height: 16, fontSize: "0.625rem" },
  md: { width: 36, height: 24, fontSize: "0.75rem" },
  lg: { width: 48, height: 32, fontSize: "0.875rem" },
};

// Minimal name table — extend with the 48 FIFA WC 2026 nations as they are confirmed.
// Missing entries fall back to the raw 3-letter code.
const COUNTRY_NAMES: Record<string, string> = {
  ARG: "Argentina",
  AUS: "Australia",
  BEL: "Belgium",
  BRA: "Brazil",
  CAN: "Canada",
  COL: "Colombia",
  CRO: "Croatia",
  DEN: "Denmark",
  ECU: "Ecuador",
  ENG: "England",
  ESP: "Spain",
  FRA: "France",
  GER: "Germany",
  GHA: "Ghana",
  IRN: "Iran",
  ITA: "Italy",
  JPN: "Japan",
  KOR: "South Korea",
  MAR: "Morocco",
  MEX: "Mexico",
  NED: "Netherlands",
  NGA: "Nigeria",
  NOR: "Norway",
  POL: "Poland",
  POR: "Portugal",
  SCO: "Scotland",
  SEN: "Senegal",
  SRB: "Serbia",
  SUI: "Switzerland",
  SWE: "Sweden",
  TUR: "Turkey",
  URU: "Uruguay",
  USA: "United States",
};

export const Flag = forwardRef<HTMLSpanElement, FlagProps>(function Flag(
  { code, size = "md", className, ...rest },
  ref,
) {
  const normalized = code.toUpperCase().slice(0, 3);
  const countryName = COUNTRY_NAMES[normalized] ?? normalized;
  const dims = DIMENSIONS[size];

  const ariaHidden = rest["aria-hidden"];
  const ariaLabel = rest["aria-label"] ?? countryName;
  const isDecorative = ariaHidden === true || ariaHidden === "true";

  return (
    <span
      ref={ref}
      role={isDecorative ? undefined : "img"}
      aria-label={isDecorative ? undefined : ariaLabel}
      aria-hidden={isDecorative ? "true" : undefined}
      className={[
        "inline-flex items-center justify-center select-none",
        "rounded-sm bg-muted text-muted-foreground border border-border",
        "font-display font-semibold tabular-nums",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        width: dims.width,
        height: dims.height,
        fontSize: dims.fontSize,
        lineHeight: 1,
      }}
    >
      {normalized}
    </span>
  );
});

export default Flag;
