import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * cn — composes class names while merging conflicting Tailwind utilities.
 * Standard shadcn/ui helper. Used by every primitive in app/components/ui/.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
