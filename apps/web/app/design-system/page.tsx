import type { Metadata } from "next";
import { DesignSystemClient } from "./DesignSystemClient";

export const metadata: Metadata = {
  title: "Design System — World Cup Madness",
  description:
    "Tokens and components reference for World Cup Madness — every primitive, every color, in both light and dark themes.",
};

export default function DesignSystemPage() {
  return <DesignSystemClient />;
}
