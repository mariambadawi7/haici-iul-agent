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

import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  addFaceSample,
  clampMessages,
  countFaceSamples,
  emptyRecord,
  FACES_DIR,
  forgetVisitor,
  isValidUid,
  listVisitors,
  newUid,
  readRecord,
  sanitiseProfile,
  updateRecord,
  VISITOR_DIR,
} from "./visitor-store";

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
 * passcode, so it simply forwards the one the user typed. Branding is an
 * operator capability: only the operator passcode opens it, never the
 * analytics-only client one.
 *
 * Reads stay public — the kiosk fetches its own branding on every boot with
 * no credential. Only writes are gated, and they FAIL CLOSED: with no
 * passcode configured, writes are refused rather than waved through, so a
 * misconfigured deployment is inert instead of silently world-writable.
 */
const OPERATOR_PASSCODE =
  process.env.OPERATOR_PASSCODE ?? process.env.ADMIN_PASSCODE ?? "";

/** Guards every branding mutation. Returns null when the caller may proceed. */
function requireOperator(req: Request): Response | null {
  if (!OPERATOR_PASSCODE) {
    return json(
      {
        error:
          "Branding writes are disabled: no operator passcode is configured on the server.",
      },
      503,
    );
  }
  if (req.headers.get("X-Admin-Passcode") !== OPERATOR_PASSCODE) {
    return json({ error: "Invalid or missing operator passcode." }, 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// F-08: WebSocket relay authentication / origin gating
// ---------------------------------------------------------------------------
//
// WebSockets are exempt from the same-origin policy, so without an Origin
// check any page in any browser on the network could open a socket here and
// impersonate the hardware (broadcast forged presence/session events to every
// kiosk browser) or eavesdrop on genuine hardware traffic. This relay is
// reached two different ways — see the file header and Hardware/REPORT.md:
// the kiosk browser goes through the Vite proxy on its own HTTPS origin
// (web/vite.config.ts:/hw-ws), while the ESP32 firmware
// (Hardware/src/main.cpp, DEFAULT_WS_HOST/DEFAULT_WS_PORT) dials this port
// directly over the LAN, because it can neither speak TLS nor share the
// page's origin. That means the port cannot be restricted to loopback the
// way the other sidecars in docker-compose.yml are — doing so would sever
// every hardware kiosk from its relay — so instead: browsers are gated by
// Origin, and the hardware role (which is the privileged side: it can
// broadcast to every browser) must prove itself with a shared secret.

/** Browsers connecting to the relay must present one of these Origins. */
const ALLOWED_WS_ORIGINS = new Set(
  (process.env.WS_ALLOWED_ORIGINS ?? "https://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Shared secret the `hardware` role must present as `?token=`. Chosen over a
 * per-device credential or mTLS because the caller is a single ESP32 whose
 * WS path is already a free-form NVS field set through its own AP config
 * portal (see Hardware/REPORT.md "First-time configuration") — appending
 * `&token=<value>` there needs no firmware rebuild. Fails CLOSED like
 * OPERATOR_PASSCODE above: unset means hardware connections are refused,
 * never waved through.
 */
const HARDWARE_TOKEN = process.env.HARDWARE_TOKEN ?? "";

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

// F-14: serialises concurrent PUTs. Two operators pressing Save at the same
// moment would otherwise both truncate branding.json and interleave their
// writes (see persistBranding below for why the truncate itself is the
// bigger problem). Chained rather than a lock object because Promise
// chaining already gives FIFO ordering with no extra bookkeeping.
let brandingWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Write branding.json by writing a sibling temp file and renaming it over
 * the target, rather than writing the target directly.
 *
 * `Bun.write` truncates the destination and then writes into it, so a
 * container restart, a full disk, or the host powering off mid-write leaves
 * `branding.json` as truncated, unparseable JSON — and readBranding() then
 * 500s on every subsequent GET forever, with no self-repair (see F-14 in
 * docs/CODE-REVIEW-FINDINGS.md for the full failure chain). `rename` within
 * one filesystem is atomic on both Linux and Windows: a reader always sees
 * either the whole old file or the whole new one, never a partial write.
 *
 * The temp file MUST live in the same directory as BRANDING_FILE (the
 * `/app/branding` bind mount), not in the container's own /tmp — a rename
 * across filesystems fails with EXDEV instead of moving the file.
 */
async function persistBranding(parsed: unknown): Promise<void> {
  await mkdir(dirname(BRANDING_FILE), { recursive: true });
  const tmp = `${BRANDING_FILE}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(parsed, null, 2));
  await rename(tmp, BRANDING_FILE);
}

async function writeBranding(req: Request): Promise<Response> {
  const denied = requireOperator(req);
  if (denied) return denied;

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
    const job = brandingWriteChain.then(() => persistBranding(parsed));
    // Keep the chain alive even if this write fails, so one bad write does
    // not wedge every save after it.
    brandingWriteChain = job.catch(() => undefined);
    await job;
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
  const denied = requireOperator(req);
  if (denied) return denied;
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
// Face-bound visitor records
// ---------------------------------------------------------------------------

/** A face crop is a small JPEG. Anything larger is not one. */
const MAX_FACE_BYTES = 2 * 1024 * 1024;
/** A transcript plus a profile. Generous, but not unbounded. */
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Visitor routes are served ONLY to the local Vite proxy.
 *
 * This is the one difference from the branding API above, and it matters:
 * branding is a logo and a colour, while a visitor record is a named person's
 * transcript and whatever they volunteered about themselves. Port 3001 is
 * published on every interface — it has to be, because the ESP32 dials it
 * directly and can speak neither TLS nor the page origin (see F-08 above) — so
 * an ungated GET here would hand every transcript on the kiosk to anyone on
 * the same Wi-Fi.
 *
 * The browser never needs that published port: it reaches this process through
 * the Vite proxy in the same container (`/api` -> 127.0.0.1:3001, see
 * web/vite.config.ts), so a legitimate visitor request always arrives from
 * loopback and a LAN request never does. That makes the check free of new
 * configuration, unlike a shared secret — and a secret shipped to a browser
 * would not be secret anyway.
 *
 * The Origin gate used for websockets is NOT sufficient here: a curl from the
 * LAN simply sends no Origin, which that check deliberately permits so the
 * ESP32 can connect.
 */
function requireLoopback(
  req: Request,
  server: import("bun").Server,
): Response | null {
  const address = server.requestIP(req)?.address ?? "";
  const local =
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.");
  if (local) return null;
  console.warn(`[visitors] refused a non-local request from ${address || "an unknown address"}`);
  return json({ error: "Visitor records are only served to the local kiosk." }, 403);
}

/**
 * Enroll a face, or add another reference photo to one already enrolled.
 *
 * Deliberately NOT operator-gated: the kiosk itself calls this, unattended,
 * the moment it sees a face it does not know. The loopback check above is what
 * keeps it off the network. Deleting a face IS operator-gated, because that is
 * a staff action taken on someone's behalf.
 */
async function enrollVisitor(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return json({ error: "Expected a multipart body with a `file` field." }, 400);
  }
  if (file.size > MAX_FACE_BYTES) {
    return json({ error: "Face crop is larger than 2 MB." }, 413);
  }

  const supplied = form?.get("uid");
  let uid: string;
  let created = false;
  if (typeof supplied === "string" && supplied) {
    // Adding a sample to a visitor we already know. The uid must be one the
    // camera reported back, so it is validated exactly like any other.
    if (!isValidUid(supplied)) return json({ error: "Invalid uid." }, 400);
    uid = supplied;
  } else {
    uid = newUid();
    created = true;
  }

  let sample: number | null;
  try {
    sample = await addFaceSample(uid, file);
  } catch (err) {
    console.error("[visitors] could not write the face sample", err);
    return json({ error: "Could not store the face." }, 500);
  }

  if (sample === null) {
    // Already at MAX_SAMPLES. Not an error: the caller adds samples
    // opportunistically and simply stops being useful past the cap.
    return json({ uid, sample: null, samples: await countFaceSamples(uid), created: false });
  }

  if (created) {
    await updateRecord(uid, (record) => ({ ...record, enrolled: true }));
  }

  console.log(
    `[visitors] ${created ? "enrolled" : "added a sample for"} ${uid} (sample ${sample})`,
  );
  return json({ uid, sample, samples: await countFaceSamples(uid), created });
}

/**
 * Read a visitor. A uid with no record yet is a 200 with an empty one and
 * `exists: false`, not a 404 — a staff-enrolled face (a photo dropped into the
 * gallery by hand) is a perfectly valid identity that has simply never spoken
 * to the kiosk before, and the caller treats it identically either way.
 */
async function readVisitor(uid: string): Promise<Response> {
  if (!isValidUid(uid)) return json({ error: "Invalid uid." }, 400);
  const record = await readRecord(uid);
  return json({ exists: record !== null, record: record ?? emptyRecord(uid) });
}

async function writeVisitor(req: Request, uid: string): Promise<Response> {
  if (!isValidUid(uid)) return json({ error: "Invalid uid." }, 400);

  const raw = await req.text();
  if (raw.length > MAX_RECORD_BYTES) {
    return json({ error: "Visitor record too large." }, 413);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body is not valid JSON." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object." }, 400);
  }

  try {
    const saved = await updateRecord(uid, (record) => ({
      ...record,
      lastSeen: Date.now(),
      // The client counts conversations, not turns: it sets this only on the
      // first save of a wake. Counting here instead would tick once per
      // message and make "visits" meaningless.
      visits: body.bumpVisit ? record.visits + 1 : record.visits,
      profile: sanitiseProfile(body.profile, record.profile),
      messages: clampMessages(body.messages, record.messages),
    }));
    return json({ ok: true, record: saved });
  } catch (err) {
    console.error(`[visitors] write failed for ${uid}`, err);
    return json({ error: "Could not persist the visitor record." }, 500);
  }
}

/** Everything the kiosk has stored about everyone. Operator only. */
async function listVisitorSummaries(req: Request): Promise<Response> {
  const denied = requireOperator(req);
  if (denied) return denied;
  return json({ visitors: await listVisitors() });
}

/**
 * How long after enrollment a visitor may still undo it themselves.
 *
 * Bounds the unauthenticated route below to the conversation that created the
 * record. Generous enough for a long conversation, far short of "any record
 * that happens to be a generated uid".
 */
const UNDO_WINDOW_MS = 30 * 60 * 1000;

/**
 * "Don't recognise me" — the visitor undoes an enrollment nobody asked them
 * about.
 *
 * Unlike every other destructive route here this one takes NO operator
 * passcode, and it cannot: the person standing at the kiosk does not have one,
 * and a control they cannot reach is not a control. What keeps that safe is
 * that it can only ever delete what the kiosk itself just created —
 *
 *   - a generated uid, never a `Mariam_Badawi` a member of staff curated;
 *   - a record created inside UNDO_WINDOW_MS, so it is this session's;
 *   - a record with no completed visit behind it, so no returning visitor's
 *     history can be destroyed by a tap.
 *
 * Anything outside that is refused and stays a staff decision. The route is
 * also inside the loopback-gated block, so only the Vite proxy reaches it.
 */
async function undoEnrollment(uid: string): Promise<Response> {
  if (!isValidUid(uid) || !/^v[0-9a-f]{10}$/.test(uid)) {
    return json({ error: "Not a kiosk-enrolled visitor." }, 403);
  }
  const record = await readRecord(uid);
  // Already gone is the outcome the caller wanted; saying so would only make
  // the kiosk apologise for something that is not a problem.
  if (!record) return json({ ok: true });

  if (Date.now() - record.createdAt > UNDO_WINDOW_MS || record.visits > 1) {
    console.warn(`[visitors] refused a self-undo for ${uid}; not a fresh enrollment`);
    return json({ error: "This record is no longer self-removable." }, 403);
  }

  try {
    await forgetVisitor(uid);
  } catch (err) {
    console.error(`[visitors] self-undo failed for ${uid}`, err);
    return json({ error: "Could not remove the enrollment." }, 500);
  }
  console.log(`[visitors] ${uid} undid their own enrollment (record and face)`);
  return json({ ok: true });
}

/**
 * Forget a visitor: transcript, profile and face. Operator only, and the one
 * route that must keep working — it is how a person who asks to be removed
 * actually gets removed.
 */
async function deleteVisitor(req: Request, uid: string): Promise<Response> {
  const denied = requireOperator(req);
  if (denied) return denied;
  if (!isValidUid(uid)) return json({ error: "Invalid uid." }, 400);
  try {
    await forgetVisitor(uid);
  } catch (err) {
    console.error(`[visitors] delete failed for ${uid}`, err);
    return json({ error: "Could not delete the visitor." }, 500);
  }
  console.log(`[visitors] forgot ${uid} (record and face)`);
  return json({ ok: true });
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

    if (url.pathname === "/api/visitors" || url.pathname.startsWith("/api/visitors/")) {
      const denied = requireLoopback(req, server);
      if (denied) return denied;

      if (url.pathname === "/api/visitors") {
        if (req.method === "GET") return listVisitorSummaries(req);
        return json({ error: "Method not allowed." }, 405);
      }

      const rest = decodeURIComponent(url.pathname.slice("/api/visitors/".length));

      // Checked before the uid routes below, or an enrollment would be read as
      // a request for the visitor whose uid is literally "enroll".
      if (rest === "enroll") {
        if (req.method === "POST") return enrollVisitor(req);
        return json({ error: "Method not allowed." }, 405);
      }

      // Checked before the bare-uid routes for the same reason `enroll` is:
      // `rest` still holds the trailing segment at this point.
      if (rest.endsWith("/undo-enrollment")) {
        if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
        return undoEnrollment(rest.slice(0, -"/undo-enrollment".length));
      }

      if (req.method === "GET") return readVisitor(rest);
      if (req.method === "PUT") return writeVisitor(req, rest);
      if (req.method === "DELETE") return deleteVisitor(req, rest);
      return json({ error: "Method not allowed." }, 405);
    }

    const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;

    // The two roles are authenticated by different things, so the checks are
    // not interchangeable. Hardware proves itself with the shared secret;
    // browsers, which cannot hold a secret, are gated on Origin.
    //
    // The hardware check MUST come first and the Origin gate must not apply to
    // it: links2004/WebSockets (Hardware/platformio.ini) hardcodes
    // `Origin: file://` into its client handshake, so the ESP32 does send an
    // Origin — just never an allowed one. Gating hardware on it rejected every
    // connection the firmware ever made, five seconds apart, forever.
    if (clientType === "hardware") {
      if (!HARDWARE_TOKEN) {
        console.error("[ws] HARDWARE_TOKEN is not set; refusing hardware connections");
        return new Response("Relay not configured", { status: 503 });
      }
      if (url.searchParams.get("token") !== HARDWARE_TOKEN) {
        console.warn("[ws] rejected hardware upgrade with a bad or missing token");
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      // A browser always sends an Origin. A null one here means a non-browser
      // client asked for the browser role, which has no secret to check, so
      // refuse it rather than let it in unauthenticated.
      const origin = req.headers.get("origin");
      if (origin === null || !ALLOWED_WS_ORIGINS.has(origin)) {
        console.warn(`[ws] rejected upgrade from origin ${origin ?? "(none)"}`);
        return new Response("Forbidden", { status: 403 });
      }
    }

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
console.log(`[ws] allowed browser origins: ${[...ALLOWED_WS_ORIGINS].join(", ") || "(none)"}`);
if (!HARDWARE_TOKEN) {
  console.warn(
    "[ws] HARDWARE_TOKEN is not set — hardware connections are DISABLED (503). " +
      "Set it in docker-compose.yml/.env and in the ESP32's WS path (?token=...) to re-enable.",
  );
} else {
  console.log("[ws] hardware connections require a token");
}
console.log(`[branding] config file: ${BRANDING_FILE}`);
console.log(`[branding] asset dir:   ${ASSET_DIR}`);
console.log(`[visitors] record dir:  ${VISITOR_DIR}`);
console.log(`[visitors] face gallery: ${FACES_DIR}`);
if (!OPERATOR_PASSCODE) {
  console.warn(
    "[branding] OPERATOR_PASSCODE is not set — branding writes are DISABLED (503). " +
      "Set it in docker-compose.yml to enable the operator console's Branding tab.",
  );
} else {
  console.log("[branding] writes require the operator passcode");
}
