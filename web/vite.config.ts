import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const N8N_TARGET = process.env.N8N_TARGET || "http://n8n:5678";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: { usePolling: true },
    /**
     * Reverse-proxy n8n webhooks through this dev server so the browser only
     * ever talks to localhost:5173. Same-origin requests skip the entire CORS
     * machinery — preflight, allow-origin headers, the lot — which is the
     * root cause of "Could not reach the workflow" on most n8n setups.
     *
     * Inside Docker the n8n container is reachable as `n8n:5678`.
     */
    proxy: {
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
      "/stt": {
        target: process.env.WHISPER_TARGET || "http://whisper:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stt/, ""),
      },
    },
  },
});
