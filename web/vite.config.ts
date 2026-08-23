import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const N8N_TARGET = process.env.N8N_TARGET || "http://n8n:5678";

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
