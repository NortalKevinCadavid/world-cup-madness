"use client";

/**
 * Motion preference hook + setter (slice 009-ui-beautification).
 *
 * Data model: specs/009-ui-beautification/data-model.md § Entity 2
 *   storage key:  wcm.motion
 *   value space:  "auto" | "reduce" | "full"
 *   default:      "auto" (follows prefers-reduced-motion)
 *
 * Resolution per data-model.md:
 *   effective =
 *     pref === "auto"   ? (matchMedia(prefers-reduced-motion: reduce) ? "reduce" : "full")
 *   : pref === "reduce" ? "reduce"
 *   :                     "full"
 */

import { useEffect, useState } from "react";

export type MotionPreference = "auto" | "reduce" | "full";
export type EffectiveMotion = "reduce" | "full";

const STORAGE_KEY = "wcm.motion";

function readStored(): MotionPreference {
  if (typeof window === "undefined") return "auto";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "reduce" || raw === "full" || raw === "auto") return raw;
  } catch {
    // localStorage unavailable; fall through to default.
  }
  return "auto";
}

function applyToHtml(effective: EffectiveMotion) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = effective;
}

export function setMotionPreference(pref: MotionPreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore
  }
  applyToHtml(resolveEffective(pref));
}

function resolveEffective(pref: MotionPreference): EffectiveMotion {
  if (pref === "reduce") return "reduce";
  if (pref === "full") return "full";
  if (typeof window === "undefined") return "full";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "reduce"
    : "full";
}

export function useMotionPreference(): {
  preference: MotionPreference;
  effective: EffectiveMotion;
  setPreference: (next: MotionPreference) => void;
} {
  const [preference, setPreferenceState] = useState<MotionPreference>("auto");
  const [effective, setEffective] = useState<EffectiveMotion>("full");

  useEffect(() => {
    const initial = readStored();
    setPreferenceState(initial);
    const eff = resolveEffective(initial);
    setEffective(eff);
    applyToHtml(eff);

    // React to OS-level changes while preference === "auto"
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onOsChange = () => {
      if (readStored() === "auto") {
        const next = mql.matches ? "reduce" : "full";
        setEffective(next);
        applyToHtml(next);
      }
    };
    mql.addEventListener("change", onOsChange);

    // React to cross-tab localStorage changes
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = readStored();
      setPreferenceState(next);
      const eff2 = resolveEffective(next);
      setEffective(eff2);
      applyToHtml(eff2);
    };
    window.addEventListener("storage", onStorage);

    return () => {
      mql.removeEventListener("change", onOsChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setPreference = (next: MotionPreference) => {
    setPreferenceState(next);
    const eff = resolveEffective(next);
    setEffective(eff);
    setMotionPreference(next);
  };

  return { preference, effective, setPreference };
}

/**
 * Convenience: returns just the effective motion mode.
 * Use in components that only care whether to animate.
 */
export function useReducedMotion(): EffectiveMotion {
  return useMotionPreference().effective;
}
