"use client";

/**
 * Confetti — one-shot celebration affordance.
 *
 * Contract: specs/009-ui-beautification/contracts/component-api.md § Confetti.
 *
 * Behavior:
 *   - On mount: check useReducedMotion(). If "reduce", mark the localStorage
 *     key and return null (no canvas).
 *   - Otherwise: read brand tokens from CSS, spawn canvas-confetti with
 *     pointer-events:none on the canvas, mark the localStorage key, clean
 *     up after the burst.
 *
 * Deduplication: localStorage key `wcm.celebrations.<celebrationKey>`.
 * Once written, the affordance does NOT fire again for that key.
 *
 * Bundle: canvas-confetti is dynamic-imported so it doesn't ship on every
 * authenticated page — only when a Confetti component actually mounts.
 */

import { useEffect } from "react";
import { useMotion } from "@/app/components/MotionProvider";

const STORAGE_PREFIX = "wcm.celebrations.";

export type ConfettiProps = {
  /** Unique key for this celebration. e.g. "match-day-locked-2026-md3". */
  celebrationKey: string;
  /** Override palette; defaults to reading --primary/--secondary/--accent/--gold from CSS. */
  palette?: string[];
  /** Burst origin in viewport coords (0..1). Defaults to centered. */
  origin?: { x: number; y: number };
};

function alreadyFired(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

function markFired(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, new Date().toISOString());
  } catch {
    // private mode / quota — best-effort
  }
}

function readPaletteFromCss(): string[] {
  if (typeof document === "undefined") return [];
  const cs = getComputedStyle(document.documentElement);
  // Tokens are HSL triples ("12 85% 46%"). Wrap them in hsl(...) so canvas-confetti
  // can use them as fillStyle.
  return ["--primary", "--secondary", "--accent", "--gold", "--festival-500", "--field-500"]
    .map((name) => cs.getPropertyValue(name).trim())
    .filter(Boolean)
    .map((hsl) => `hsl(${hsl})`);
}

export function Confetti({ celebrationKey, palette, origin }: ConfettiProps) {
  const { effective } = useMotion();

  useEffect(() => {
    let cancelled = false;
    if (alreadyFired(celebrationKey)) return;
    if (effective === "reduce") {
      markFired(celebrationKey);
      return;
    }

    (async () => {
      try {
        const mod = await import("canvas-confetti");
        if (cancelled) return;
        const fn = mod.default;
        const colors = palette ?? readPaletteFromCss();
        markFired(celebrationKey);
        const x = origin?.x ?? 0.5;
        const y = origin?.y ?? 0.45;

        // Three quick bursts for a satisfying rhythm; finishes well under 2s.
        const baseOpts = {
          origin: { x, y },
          colors: colors.length ? colors : undefined,
          disableForReducedMotion: true,
        };
        fn({ ...baseOpts, particleCount: 90, spread: 80, startVelocity: 35 });
        setTimeout(
          () => !cancelled && fn({ ...baseOpts, particleCount: 50, spread: 100, startVelocity: 25 }),
          150,
        );
        setTimeout(
          () =>
            !cancelled &&
            fn({
              ...baseOpts,
              particleCount: 40,
              spread: 120,
              startVelocity: 20,
              scalar: 0.8,
            }),
          300,
        );
      } catch {
        // Module failed to load — silently degrade (no celebration).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [celebrationKey, palette, origin, effective]);

  return null;
}

export default Confetti;
