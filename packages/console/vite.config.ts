/// <reference types="vitest/config" />
// The console's build (main 20.3, 21.1; #348): a static single-page app in `dist/`, served by the
// server under `/console/` (#355), so it needs no server runtime of its own and deploys with the app.
//
// `pnpm console:build` writes `dist/`. `pnpm console:dev` serves the sources with live reload and
// proxies `/console/api` to `SNAPWING_URL` (default `http://localhost:3000`, the `snapwing serve`
// default). Sign-in links from chat point at the server; to sign in through the dev server, open the
// link with the dev server's origin in its place, so the session cookie is set on that origin.

import { defineConfig } from 'vite';

/** Where the server mounts the build. Every asset URL in `dist/index.html` starts with it. */
const BASE = '/console/';

export default defineConfig({
  base: BASE,
  // Preact through the automatic JSX runtime; no React, no compat layer.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The server's Content Security Policy is `default-src 'self'` (#355): no inline script or style,
    // so no module preload polyfill injected into the page.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/console/api': {
        target: process.env['SNAPWING_URL'] || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'happy-dom',
  },
});
