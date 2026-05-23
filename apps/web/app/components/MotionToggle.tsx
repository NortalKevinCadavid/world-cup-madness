"use client";

/**
 * MotionToggle — overrides prefers-reduced-motion per browser.
 * Contract: specs/009-ui-beautification/contracts/component-api.md § MotionToggle.
 */

import { Label } from "@/app/components/ui/label";
import { Switch } from "@/app/components/ui/switch";
import { useMotion } from "@/app/components/MotionProvider";

export function MotionToggle() {
  const { preference, effective, setPreference } = useMotion();
  const checked = preference === "reduce";

  function onToggle(next: boolean) {
    setPreference(next ? "reduce" : "full");
  }

  const subline =
    preference === "auto"
      ? `Following your system setting (currently ${effective === "reduce" ? "reduced" : "full"} motion)`
      : preference === "reduce"
        ? "Motion is reduced"
        : "Motion is at full strength";

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
      <div className="flex-1 space-y-1">
        <Label htmlFor="motion-toggle" className="font-medium">
          Reduce motion
        </Label>
        <p className="text-xs text-muted-foreground">{subline}</p>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setPreference("auto")}
        >
          Follow my system setting
        </button>
      </div>
      <Switch
        id="motion-toggle"
        checked={checked}
        onCheckedChange={onToggle}
        aria-label="Toggle reduced motion"
      />
    </div>
  );
}

export default MotionToggle;
