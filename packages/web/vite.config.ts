import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bridge (npm start / npm run dev at the repo root) serves the API and the WebSocket.
const bridge = process.env.HERDR_MOBILE_BRIDGE ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
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
});
