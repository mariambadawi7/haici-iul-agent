import { config } from "./api";

export type HealthState =
  | { status: "checking" }
  | { status: "ok" }
  | { status: "down"; reason: string };

/**
 * Probes the chat webhook with a plain GET. n8n responds in three ways:
 *   - 200/204         → workflow is Active and the route exists
 *   - 404             → n8n is up but the workflow isn't Active
 *   - 405 / 400       → workflow Active but the route only takes POST (OK!)
 *   - fetch throws    → n8n unreachable (container down, wrong URL, …)
 *
 * Because the URL is proxied by Vite (/webhook/* → n8n:5678/webhook/*) the
 * request is same-origin from the browser's view, so CORS never gets a vote.
 */
export async function checkHealth(timeoutMs = 5000): Promise<HealthState> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(config.chatUrl, {
      method: "OPTIONS",
      signal: ctl.signal,
    });
    if (res.status === 404) {
      return {
        status: "down",
        reason:
          "n8n is reachable but the workflow isn't Active. Toggle Active in the n8n editor.",
      };
    }
    // 200, 204, 405, 400 — any response means n8n is up and responding.
    return { status: "ok" };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return {
        status: "down",
        reason: `Could not reach n8n within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }
    return {
      status: "down",
      reason:
        "Could not reach n8n through the Vite proxy. Make sure the n8n container is running and reachable as `n8n:5678` from inside the web container.",
    };
  } finally {
    clearTimeout(timer);
  }
}
