import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const N8N_TARGET = process.env.N8N_TARGET || "http://n8n:5678";
// Reachable over the shared `haici-vision` docker network (see docker-compose).
const OPENCAM_TARGET = process.env.OPENCAM_TARGET || "http://opencam-backend:8080";

// HTTPS is only needed for microphone access on MOBILE (accessed by LAN IP).
// On the kiosk machine itself (http://localhost) the browser already treats
// localhost as a secure context, so the mic works without TLS — and a plain
// http page can open ws:// to the relay with no mixed-content/cert friction.
// Set VITE_HTTPS=1 to enable the self-signed cert for mobile testing.
const USE_HTTPS = process.env.VITE_HTTPS === "1";

const plugins: PluginOption[] = [react()];
if (USE_HTTPS) plugins.push(basicSsl());

export default defineConfig({
  plugins,
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
    proxy: {
      // Tenant branding is served and persisted by the Bun sidecar running in
      // this same container (ws-server.ts). Proxying keeps the request
      // same-origin from the browser, exactly as /webhook does for n8n.
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      // The ESP32 relay, same Bun sidecar. Proxied rather than dialled directly
      // so it inherits whatever TLS the page has: a kiosk served over HTTPS (as
      // a tablet must be, or getUserMedia refuses the mic) cannot open a plain
      // ws:// socket, and the relay has no certificate of its own.
      //
      // Deliberately no `rewrite`: ws-server.ts upgrades any path that is not
      // an /api/branding route, so /hw-ws arrives and connects as-is. That
      // keeps this working regardless of whether Vite applies path rewrites to
      // upgrade requests, which is the fragile part of proxying a websocket.
      //
      // The ESP32 itself is unaffected — it still dials ws://<pc>:3001/ws
      // directly over the LAN, where there is no TLS requirement to satisfy.
      "/hw-ws": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
      // Vision backend (OpenCam), same-origin for the same reason as /hw-ws: an
      // HTTPS kiosk page cannot call http:// or ws:// cross-origin, and the
      // camera needs HTTPS anyway. Proxying here means one certificate, no CORS,
      // and no LAN exposure of an API that is unauthenticated by default.
      //
      // The prefix is not cosmetic. The SDK appends /api/... and /ws/... to its
      // base url, and /api on this origin already belongs to the Bun branding
      // sidecar — so the rewrite below is what keeps the two apart.
      //
      // NOTE: this proxies SIGNALLING only. The media itself is direct UDP from
      // the browser to the backend and never passes through Vite.
      "/opencam": {
        target: OPENCAM_TARGET,
        ws: true,
        rewrite: (p) => p.replace(/^\/opencam/, ""),
      },
      "/webhook": {
        target: N8N_TARGET,
        changeOrigin: true,
        timeout: 120_000,
      },
      "/webhook-test": {
        target: N8N_TARGET,
        changeOrigin: true,
        timeout: 120_000,
      },
    },
  },
});
