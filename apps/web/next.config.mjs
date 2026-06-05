import createNextIntlPlugin from 'next-intl/plugin';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cookie-based locale (no URL prefix). The request-config module resolves
// the active locale from `NEXT_LOCALE` cookie; messages live under
// `apps/web/messages/<locale>.json`. See apps/web/i18n/request.ts.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Slim production image for Azure Container Apps: `pnpm build` writes
  // `apps/web/.next/standalone` — a self-contained server.js + minimal
  // node_modules — which the runner stage of the repo-root Dockerfile copies.
  output: 'standalone',
  // Monorepo: trace deps from the workspace root so the standalone bundle
  // resolves workspace packages and pnpm's node_modules layout correctly.
  // In Next 14 this lives under `experimental`; it becomes top-level in 15.
  // Skipped on Vercel — its deploy pipeline computes the trace root itself,
  // and our override produces a doubled `/vercel/path0/vercel/path0/...`
  // path that fails the routes-manifest lookup during artifact upload.
  experimental: process.env.VERCEL === '1'
    ? {}
    : { outputFileTracingRoot: path.join(__dirname, '../..') },
};

export default withNextIntl(nextConfig);
