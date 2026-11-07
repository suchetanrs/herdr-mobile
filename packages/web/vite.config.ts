import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** This build's id: short git sha (+ "-dirty" with uncommitted changes) and build time, e.g. `0cb1f1b 2026-11-07T16:20Z`. */
function buildId(command: string): string {
  if (command !== 'build') return 'dev';
  let sha = 'nogit';
  try {
    const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    sha = git('rev-parse', '--short=7', 'HEAD');
    if (git('status', '--porcelain', '--untracked-files=no')) sha += '-dirty';
  } catch {}
  return `${sha} ${new Date().toISOString().slice(0, 16)}Z`;
}

/** Puts the build id in index.html too, where the bridge reads it (it tells old pages to reload). */
const buildMeta = (id: string): Plugin => ({
  name: 'herdr-build-meta',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'herdr-build', content: id }, injectTo: 'head' }],
});

// The bridge (npm start / npm run dev at the repo root) serves the API and the WebSocket.
const bridge = process.env.HERDR_MOBILE_BRIDGE ?? 'http://127.0.0.1:8787';

export default defineConfig(({ command }) => {
  const id = buildId(command);
  return {
    plugins: [react(), buildMeta(id)],
    define: { __HERDR_BUILD__: JSON.stringify(id) },
    resolve: {
      alias: {
        '@herdr-mobile/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': { target: bridge, changeOrigin: false },
        '/ws': { target: bridge.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
      },
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      // No source maps: the bridge serves only what the app needs (SECURITY_AUDIT N4).
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
  };
});
