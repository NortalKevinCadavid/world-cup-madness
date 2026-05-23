"use client";

/**
 * MotionProvider — exposes the effective motion preference as
 * React context AND mirrors it to <html data-motion="..."> so CSS
 * can react instantly.
 *
 * Hook source: apps/web/lib/motion.ts
 * Contract: specs/009-ui-beautification/data-model.md § Entity 2
 */

import { createContext, useContext, type ReactNode } from "react";
import {
  useMotionPreference,
  type EffectiveMotion,
  type MotionPreference,
} from "@/lib/motion";

type MotionContextValue = {
  preference: MotionPreference;
  effective: EffectiveMotion;
  setPreference: (next: MotionPreference) => void;
};

const MotionContext = createContext<MotionContextValue | null>(null);

export function MotionProvider({ children }: { children: ReactNode }) {
  const value = useMotionPreference();
  return (
    <MotionContext.Provider value={value}>{children}</MotionContext.Provider>
  );
}

export function useMotion(): MotionContextValue {
  const ctx = useContext(MotionContext);
  if (!ctx) {
    throw new Error("useMotion must be used inside <MotionProvider>");
  }
  return ctx;
}
