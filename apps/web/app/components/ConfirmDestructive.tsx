"use client";

/**
 * ConfirmDestructive — shared confirmation pattern for irreversible admin actions.
 *
 * Spec ref: specs/009-ui-beautification/spec.md FR-UI-014, US4 AS-3.
 *
 * Two confirmation levels:
 *   - "click" (default): a single click on the explicitly-labelled "Confirm"
 *     button triggers the action. Two-click pattern: open dialog → click
 *     confirm. Single-click destruction is impossible.
 *   - "typed": user must type the affected entity's name verbatim into a
 *     text input before the confirm button enables. Use for high-risk
 *     actions: participant deactivation, config rollback, audit purge.
 *
 * Composition pattern:
 *   <ConfirmDestructive
 *     trigger={<Button variant="destructive">Delete X</Button>}
 *     title="Delete X?"
 *     description="This cannot be undone."
 *     confirmLabel="Delete"
 *     confirmation={{ kind: "typed", value: "DELETE X" }}
 *     onConfirm={async () => { await fetch(...); }}
 *   />
 */

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";

export type ConfirmationMode =
  | { kind: "click" }
  | { kind: "typed"; value: string; label?: string };

export type ConfirmDestructiveProps = {
  trigger: ReactNode;
  title: string;
  description?: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmation?: ConfirmationMode;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmDestructive({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmation = { kind: "click" },
  onConfirm,
}: ConfirmDestructiveProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled =
    confirmation.kind === "click" || typed === confirmation.value;

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
      setTyped("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The action failed. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {confirmation.kind === "typed" ? (
          <div className="space-y-2">
            <Label htmlFor="confirm-input" className="text-sm">
              {confirmation.label ?? (
                <>
                  Type <code className="rounded bg-muted px-1 py-0.5 text-xs font-semibold">{confirmation.value}</code>{" "}
                  to confirm
                </>
              )}
            </Label>
            <Input
              id="confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={pending}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            disabled={!enabled || pending}
            onClick={handleConfirm}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConfirmDestructive;
