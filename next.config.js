/**
 * Next.js config — both knobs below are environment-driven so the same source
 * tree works in every deployment scenario without editing this file.
 *
 * Development output is isolated in `.next-dev` so `next build` cannot delete
 * chunks or manifests used by `next dev`. The package scripts also prevent
 * `next dev` and `next build` from running concurrently in this source tree,
 * because Next 15 rewrites the shared `next-env.d.ts` for the active distDir.
 *
 *   BASE_PATH    Path prefix the app is mounted at (e.g. "/mrp" when reverse-
 *                proxied at fdtw.app/mrp/). Leave UNSET for root-mounted
 *                deployments (Cloudflare tunnel, local dev, most simple setups).
 *                If set incorrectly, all client-side fetch('/api/...') calls
 *                hit the wrong URL — the server returns 404 HTML and the UI
 *                fails with "String did not match expected pattern" because the
 *                client tries to JSON.parse the HTML 404 page.
 *
 *   STANDALONE   Set to "1" only when building a Docker image (the Dockerfile
 *                copies from .next/standalone, which only exists when this is
 *                enabled). Leave unset for bare-metal `npm start` / pm2.
 *
 * Examples:
 *
 *   # Local dev (both unset)
 *   npm run dev
 *
 *   # Bare-metal at root URL (Cloudflare tunnel → mrp.example.com)
 *   npm run build && npm start
 *
 *   # Deploy at a subpath (nginx → fdtw.app/mrp/)
 *   BASE_PATH=/mrp npm run build
 *   BASE_PATH=/mrp npm start
 *
 *   # Docker image (the Dockerfile sets STANDALONE=1 internally)
 *   docker build .
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');

const basePath = '';
const databaseBackupNodeModules = new Set([
  'node:child_process',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:os',
  'node:path',
]);

function externalizeDatabaseBackupNodeModules(config, nextRuntime) {
  if (nextRuntime !== 'edge') return;

  const externals = Array.isArray(config.externals)
    ? config.externals
    : config.externals
      ? [config.externals]
      : [];

  config.externals = [
    ...externals,
    ({ request, contextInfo }, callback) => {
      const issuer = contextInfo?.issuer ?? '';
      if (
        databaseBackupNodeModules.has(request ?? '') &&
        /[/\\]src[/\\]lib[/\\]database-backup(?:-scheduler)?\.ts$/.test(issuer)
      ) {
        callback(null, `commonjs ${request}`);
        return;
      }
      callback();
    },
  ];
}

module.exports = (phase) => {
  /** @type {import('next').NextConfig} */
  const nextConfig = {
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
    ...(basePath ? { basePath } : {}),
    output: 'standalone',
    outputFileTracingExcludes: { '*': ['demo-data/**', 'demo-data-backup-*/**', '.env*'] },
    async rewrites() {
      return { beforeFiles: [{ source: '/api/:path*', destination: '/demo-api/:path*' }] };
    },
    poweredByHeader: false,
    webpack(config, { nextRuntime }) {
      // The Node-only backup scheduler is conditionally skipped in Edge instrumentation.
      externalizeDatabaseBackupNodeModules(config, nextRuntime);
      return config;
    },
  };

  return nextConfig;
};
