"use client";

/**
 * UserMenu — top-nav avatar/name button that opens a popover with
 * the user's display name, sign-out form, and the MotionToggle.
 */

import { LogOut, User as UserIcon } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { Separator } from "@/app/components/ui/separator";
import { MotionToggle } from "@/app/components/MotionToggle";

type Props = {
  participant: { display_name: string; email?: string };
};

export function UserMenu({ participant }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`User menu for ${participant.display_name}`}
        >
          <UserIcon className="size-5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <div>
            <p className="font-display text-sm font-semibold text-foreground">
              {participant.display_name}
            </p>
            {participant.email ? (
              <p className="text-xs text-muted-foreground">{participant.email}</p>
            ) : null}
          </div>
          <Separator />
          <MotionToggle />
          <Separator />
          <form action="/api/auth/signout" method="post" className="m-0">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2"
            >
              <LogOut className="size-4" aria-hidden />
              Sign out
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default UserMenu;
