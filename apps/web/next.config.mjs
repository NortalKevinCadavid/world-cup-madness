import createNextIntlPlugin from 'next-intl/plugin';

// Cookie-based locale (no URL prefix). The request-config module resolves
// the active locale from `NEXT_LOCALE` cookie; messages live under
// `apps/web/messages/<locale>.json`. See apps/web/i18n/request.ts.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default withNextIntl(nextConfig);
