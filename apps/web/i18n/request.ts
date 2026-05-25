import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Supported locales. Adding a new one requires:
//   1. Add the code to SUPPORTED_LOCALES
//   2. Create apps/web/messages/<code>.json
//   3. Add the human-readable label to LanguageSwitcher.tsx
export const SUPPORTED_LOCALES = ['en', 'es', 'pt'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'NEXT_LOCALE';

function isLocale(value: string | undefined): value is Locale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Resolve the active locale from the request's `NEXT_LOCALE` cookie. Falls
 * back to DEFAULT_LOCALE on missing or unknown values (fail-safe — an
 * attacker-supplied cookie can never reach a non-supported messages file).
 */
export default getRequestConfig(async () => {
  const raw = cookies().get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
