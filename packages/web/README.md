# @herdr-mobile/web

The phone-first PWA (also desktop Chrome): Vite + React 19 + TypeScript, xterm.js for live terminals.
The bridge serves the built app (`npm run build` at the repo root, then `npm start`); for development run the
bridge and `npm run dev:web` (Vite on :5173 proxies `/api` and `/ws` to the bridge on :8787).

`src/lib` state and transport (store fed by the WS protocol, connection with resume/backoff, router, model helpers),
`src/terminal` (stream client, xterm view, zoom, input helpers), `src/notify` (client notifier + sinks: toast, sound,
vibrate, system notification, title/favicon badge), `src/components`, `src/screens`, `src/styles` (Herdr's graphite/paper tokens).
Assets from Herdr and their licenses: THIRD-PARTY.md.
