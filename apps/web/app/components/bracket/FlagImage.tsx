// Slice 010 / T010 — team flag renderer (FR-002, FR-023).
//
// Renders the stored `flag_url` image when present; otherwise delegates to the
// slice-009 <Flag>, which resolves a real flag image from the team's country
// code (flagcdn) and only degrades to a 3-letter code chip for unknown codes.
// Either way the accessible name is "Flag of <team>".

import Image from "next/image";
import { Flag } from "@/app/components/Flag";
import type { BracketTeam } from "@/lib/bracket/types";

const SIZE_PX: Record<"sm" | "md" | "lg", { w: number; h: number }> = {
  sm: { w: 24, h: 16 },
  md: { w: 36, h: 24 },
  lg: { w: 48, h: 32 },
};

export interface FlagImageProps {
  team: BracketTeam;
  size?: "sm" | "md" | "lg";
}

export function FlagImage({ team, size = "md" }: FlagImageProps) {
  if (team.flag_url) {
    const { w, h } = SIZE_PX[size];
    return (
      <Image
        src={team.flag_url}
        alt={`Flag of ${team.name}`}
        width={w}
        height={h}
        className="inline-block rounded-sm object-cover"
        unoptimized
      />
    );
  }
  // No stored flag_url: <Flag> resolves a real flag from the country code
  // (flagcdn), falling back to a code chip only for unknown codes.
  return (
    <Flag
      code={team.short_code}
      size={size}
      aria-label={`Flag of ${team.name}`}
    />
  );
}
