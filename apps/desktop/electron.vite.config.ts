import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Dev server only: Vite injects CSS as <style> elements, which the strict CSP in index.html
 * blocks. Packaged builds load a CSS file and keep `style-src 'self'`.
 */
const devStyleCsp: Plugin = {
  name: 'tabreach-dev-style-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
};

/**
 * linkedom (research page parsing in core) tries `require('canvas')` and falls back to its own shim.
 * Vite turns that optional import into a stub that throws at load time in development builds, which
 * crashed core in `pnpm dev`. Point `canvas` at linkedom's shim in every build.
 */
const linkedomDir = dirname(
  createRequire(resolve(__dirname, '../../packages/core/package.json')).resolve('linkedom/package.json'),
);
const canvasShim = join(linkedomDir, 'commonjs/canvas-shim.cjs');

// Runtime `dependencies` (playwright-core, pino) stay external and ship in the app's node_modules;
// workspace packages and everything else are bundled.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { canvas: canvasShim } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, 'src/processes/core.ts'),
          worker: resolve(__dirname, 'src/processes/worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss(), devStyleCsp],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
