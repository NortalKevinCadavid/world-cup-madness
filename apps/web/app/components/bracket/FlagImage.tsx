// Slice 010 / T010 — team flag renderer with graceful fallback (FR-002, FR-023).
//
// Renders the real flag image from `flag_url` when present, with descriptive
// alt text. When the URL is missing, falls back to the slice-009 <Flag>
// code-chip (which itself degrades to a 3-letter code). Alt text distinguishes
// the two cases for screen readers.

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
  // Fallback: slice-009 code-chip + alt text signaling the flag is unavailable.
  return (
    <Flag
      code={team.short_code}
      size={size}
      aria-label={`Flag unavailable for ${team.name}`}
    />
  );
}
