import type { Metadata } from "next";
import { Inter, Manrope } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import ThemeProvider from "@/app/components/ThemeProvider";
import { MotionProvider } from "@/app/components/MotionProvider";

const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fontDisplay = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

export const metadata: Metadata = {
  title: "World Cup Madness",
  description: "Internal Nortal prediction pool for the FIFA World Cup 2026.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Locale is resolved from the NEXT_LOCALE cookie by next-intl's
  // getRequestConfig (see apps/web/i18n/request.ts). Falls back to 'en'.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontDisplay.variable}`}
    >
      <body className="antialiased min-h-screen bg-background text-foreground">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            <MotionProvider>{children}</MotionProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
