// Bun sidecar for the web container. Two unrelated jobs share one process
// (and one port) because the container already runs it alongside Vite:
//
//   1. WebSocket relay bridging the ESP32 hardware client and browser clients.
//   2. A tiny HTTP API for tenant branding — GET/PUT /api/branding — which is
//      what lets non-technical staff rebrand the kiosk from the admin UI
//      without a rebuild. Vite proxies /api/* here, so the browser only ever
//      talks to its own origin (same arrangement as /webhook → n8n).
//
// Bun's native WebSocket server is used deliberately: the `ws` npm package does
// not handshake reliably under Bun and the ESP32 (Arduino WebSocketsClient)
// drops immediately against it. Bun.serve is solid with both the ESP and browsers.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type ClientType = "hardware" | "browser";

interface WsData {
  type: ClientType;
}

const hardware = new Set<import("bun").ServerWebSocket<WsData>>();
const browsers = new Set<import("bun").ServerWebSocket<WsData>>();

// ---------------------------------------------------------------------------
// Tenant branding storage
// ---------------------------------------------------------------------------

/** Bind-mount this path to keep branding out of the source tree. */
const BRANDING_FILE = process.env.BRANDING_FILE ?? "/app/branding/branding.json";

/**
 * Shared secret for writes. When set, a PUT must present it as
 * `X-Admin-Passcode` — the admin dashboard already holds the operator's
 * passcode, so it simply forwards the one the user typed. When unset, writes
 * are open; that is convenient for local development and logged loudly,
 * because on a networked kiosk it means anyone who can reach the port can
 * rebrand it.
 */
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE ?? "";

/** Refuse absurd payloads outright rather than filling the disk. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** Uploaded logos, mascots and avatar models live beside the config. */
const ASSET_DIR = process.env.BRANDING_ASSET_DIR ?? "/app/branding/assets";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Fixed upload slots. Naming the destinations here — rather than deriving a
 * filename from the upload — means a hostile `slot` can never escape
 * ASSET_DIR, and re-uploading a logo replaces the old one instead of
 * accumulating orphans.
 */
const ASSET_SLOTS = new Set([
  "logo-primary",
  "logo-secondary",
  "favicon",
  "avatar-image",
  "avatar-model",
]);

const ASSET_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  glb: "model/gltf-binary",
};

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

async function readBranding(): Promise<Response> {
  const file = Bun.file(BRANDING_FILE);
  if (!(await file.exists())) {
    // No config yet — the client falls back to its built-in defaults.
    return json({});
  }
  try {
    return json(await file.json());
  } catch (err) {
    console.error("[branding] stored config is not valid JSON", err);
    return json(
      { error: "Stored branding config is corrupt; serving defaults." },
      500,
    );
  }
}

async function writeBranding(req: Request): Promise<Response> {
  if (ADMIN_PASSCODE && req.headers.get("X-Admin-Passcode") !== ADMIN_PASSCODE) {
    return json({ error: "Invalid or missing admin passcode." }, 401);
  }

  const raw = await req.text();
  if (raw.length > MAX_CONFIG_BYTES) {
    return json({ error: "Config too large." }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "Body is not valid JSON." }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json({ error: "Config must be a JSON object." }, 400);
  }

  try {
    await mkdir(dirname(BRANDING_FILE), { recursive: true });
    await Bun.write(BRANDING_FILE, JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error("[branding] write failed", err);
    return json({ error: "Could not persist the config to disk." }, 500);
  }

  console.log(`[branding] config updated (${raw.length} bytes)`);
  return json({ ok: true });
}

/**
 * Accept one file into a named slot. The extension is checked against an
 * allowlist (so the store cannot become a way to drop executable content) and
 * the resulting URL is what the branding config then points at.
 */
async function uploadAsset(req: Request, slot: string): Promise<Response> {
  if (ADMIN_PASSCODE && req.headers.get("X-Admin-Passcode") !== ADMIN_PASSCODE) {
    return json({ error: "Invalid or missing admin passcode." }, 401);
  }
  if (!ASSET_SLOTS.has(slot)) {
    return json({ error: `Unknown asset slot "${slot}".` }, 400);
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return json({ error: "Expected a multipart body with a `file` field." }, 400);
  }
  if (file.size > MAX_ASSET_BYTES) {
    return json({ error: "File is larger than 8 MB." }, 413);
  }

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ASSET_TYPES[ext]) {
    return json(
      { error: `Unsupported file type ".${ext}". Allowed: ${Object.keys(ASSET_TYPES).join(", ")}.` },
      415,
    );
  }

  try {
    await mkdir(ASSET_DIR, { recursive: true });
    await Bun.write(`${ASSET_DIR}/${slot}.${ext}`, file);
  } catch (err) {
    console.error("[branding] asset write failed", err);
    return json({ error: "Could not store the file." }, 500);
  }

  console.log(`[branding] asset "${slot}.${ext}" stored (${file.size} bytes)`);
  return json({ ok: true, url: `/api/branding/asset/${slot}.${ext}` });
}

/** Serve a stored asset. Only `<known-slot>.<allowed-ext>` names resolve. */
async function readAsset(name: string): Promise<Response> {
  const dot = name.lastIndexOf(".");
  const slot = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  if (!ASSET_SLOTS.has(slot) || !ASSET_TYPES[ext]) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(`${ASSET_DIR}/${slot}.${ext}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  return new Response(file, {
    headers: {
      "Content-Type": ASSET_TYPES[ext],
      // Short cache: a rebrand must show up on the next reload, but the kiosk
      // should not refetch the logo on every navigation either.
      "Cache-Control": "public, max-age=60",
    },
  });
}

// ---------------------------------------------------------------------------

const server = Bun.serve<WsData>({
  port: 3001,
  hostname: "0.0.0.0",
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/api/branding") {
      if (req.method === "GET") return readBranding();
      if (req.method === "PUT") return writeBranding(req);
      return json({ error: "Method not allowed." }, 405);
    }

    if (url.pathname.startsWith("/api/branding/asset/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/branding/asset/".length));
      if (req.method === "GET") return readAsset(name);
      if (req.method === "POST") return uploadAsset(req, name);
      return json({ error: "Method not allowed." }, 405);
    }

    const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;
    const upgraded = server.upgrade(req, { data: { type: clientType } });
    if (upgraded) return undefined;
    return new Response("WebSocket relay — upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "hardware") hardware.add(ws);
      else browsers.add(ws);
      console.log(`[ws] ${ws.data.type} connected (hw:${hardware.size} br:${browsers.size})`);
    },
    message(ws, msg) {
      const targets = ws.data.type === "hardware" ? browsers : hardware;
      for (const t of targets) t.send(msg);
    },
    close(ws) {
      hardware.delete(ws as import("bun").ServerWebSocket<WsData>);
      browsers.delete(ws as import("bun").ServerWebSocket<WsData>);
      console.log(`[ws] ${ws.data.type} disconnected (hw:${hardware.size} br:${browsers.size})`);
    },
  },
});

console.log(`[ws] relay listening on :${server.port}`);
console.log(`[branding] config file: ${BRANDING_FILE}`);
console.log(`[branding] asset dir:   ${ASSET_DIR}`);
if (!ADMIN_PASSCODE) {
  console.warn(
    "[branding] ADMIN_PASSCODE is not set — branding writes are UNAUTHENTICATED. " +
      "Set it in docker-compose.yml before exposing this host to a network.",
  );
}
