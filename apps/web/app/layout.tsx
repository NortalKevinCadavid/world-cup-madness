import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Cup Madness",
  description: "Internal Nortal prediction pool for the FIFA World Cup 2026.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
