# ESP32 Hardware + WebSocket Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old LoRa firmware with an ESP32 WiFi+WebSocket controller that mirrors physical buttons and ultrasonic presence detection into the HAICI web UI, plus add a Bun WebSocket relay server inside the `web` Docker container.

**Architecture:** A `ws-server.ts` Bun script runs on port 3001 inside the `web` container and acts as a pure relay — the ESP32 connects as `?client=hardware` and browser tabs connect as `?client=browser`; messages from one group are forwarded to the other. Vite proxies `/ws` WebSocket connections to that relay. The ESP32 drives LEDs from its own connection state (no WiFi = Red, WiFi but no WS = Blue, everything OK = Green) and sends typed JSON commands to the relay when buttons are pressed or presence is detected.

**Tech Stack:** Bun (ws-server), Vite WS proxy, React hook (useHardware.ts), PlatformIO + ESP32 Arduino (WiFi.h, WebSocketsClient, Preferences, WebServer)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Merge | — | Pull `origin/haici-agent-updated` into current branch |
| Create | `web/ws-server.ts` | Bun WebSocket relay: hardware ↔ browser |
| Modify | `web/vite.config.ts` | Add `/ws` proxy entry (WebSocket) |
| Modify | `web/Dockerfile` | Start ws-server alongside Vite |
| Create | `web/src/hooks/useHardware.ts` | Browser hook: connects to relay, maps WS events → chat actions |
| Modify | `web/src/App.tsx` | Wire `useHardware`, pass faceState to it for LED feedback |
| Overwrite | `Hardware/platformio.ini` | Replace LoRa deps with WiFi + WebSockets + ESPAsyncWebServer |
| Overwrite | `Hardware/src/main.cpp` | Full ESP32 firmware: WiFi, WS client, LEDs, buttons, ultrasonic, AP config portal |
| Create | `Hardware/REPORT.md` | Wiring pinout + message protocol reference |

---

## Task 1: Merge the remote branch

**Files:**
- No file changes — git operation only

- [ ] **Step 1: Merge `origin/haici-agent-updated` into current branch**

```bash
git fetch origin haici-agent-updated
git merge origin/haici-agent-updated --no-edit
```

Expected: fast-forward or clean merge. The only overlapping file is `web/Dockerfile` which already has the Bun changes from the last session — resolve any conflict by keeping the Bun version.

- [ ] **Step 2: Verify web Dockerfile is on Bun**

Open `web/Dockerfile`. It must start with `FROM oven/bun:1-alpine`. If the merge reverted it to `node:20-alpine`, re-apply:

```dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

EXPOSE 5173

CMD ["bun", "run", "dev"]
```

- [ ] **Step 3: Commit merge**

```bash
git add -A
git commit -m "chore: merge haici-agent-updated into haici-agent-updated"
```

---

## Task 2: Add the Bun WebSocket relay server

**Files:**
- Create: `web/ws-server.ts`

`★ Insight ─────────────────────────────────────`
Bun has a native WebSocket server API (`Bun.serve` with `websocket:` key) that needs zero dependencies. The `data` field on each `ServerWebSocket` is set at upgrade time and persists for the connection's lifetime — that's how we tag hardware vs browser clients without a global map lookup per message.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Create `web/ws-server.ts`**

```typescript
// WebSocket relay: bridges ESP32 hardware client ↔ browser clients.
// Hardware connects with ?client=hardware, browsers with ?client=browser.
// Every message from one group is forwarded verbatim to all members of the other group.

type ClientType = "hardware" | "browser";

interface WsData {
  type: ClientType;
}

const hardware = new Set<import("bun").ServerWebSocket<WsData>>();
const browsers = new Set<import("bun").ServerWebSocket<WsData>>();

const server = Bun.serve<WsData>({
  port: 3001,
  fetch(req, server) {
    const url = new URL(req.url);
    const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;
    const upgraded = server.upgrade(req, { data: { type: clientType } });
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "hardware") {
        hardware.add(ws);
        console.log(`[ws] hardware connected (${hardware.size} total)`);
      } else {
        browsers.add(ws);
        console.log(`[ws] browser connected (${browsers.size} total)`);
      }
    },
    message(ws, msg) {
      const targets = ws.data.type === "hardware" ? browsers : hardware;
      for (const t of targets) {
        t.send(msg);
      }
    },
    close(ws) {
      hardware.delete(ws as import("bun").ServerWebSocket<WsData>);
      browsers.delete(ws as import("bun").ServerWebSocket<WsData>);
      console.log(`[ws] client disconnected (hw:${hardware.size} br:${browsers.size})`);
    },
  },
});

console.log(`[ws] relay listening on :${server.port}`);
```

- [ ] **Step 2: Verify it starts without errors (Docker)**

```bash
docker compose run --rm web bun ws-server.ts
```

Expected output:
```
[ws] relay listening on :3001
```
Ctrl+C to stop.

---

## Task 3: Update Dockerfile to run relay alongside Vite

**Files:**
- Modify: `web/Dockerfile`

`★ Insight ─────────────────────────────────────`
Vite's dev server and the WS relay are two separate processes. The cleanest single-container approach is `sh -c "bun ws-server.ts & bun run dev"`. Bun's built-in process manager isn't needed — the `&` runs ws-server in background and the foreground process is Vite (so Docker sees the container alive when Vite is alive). If ws-server crashes, Docker won't restart it automatically, but for local dev this is fine.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Edit `web/Dockerfile` CMD**

Current CMD:
```dockerfile
CMD ["bun", "run", "dev"]
```

Replace with:
```dockerfile
CMD ["sh", "-c", "bun ws-server.ts & bun run dev"]
```

Full file after change:
```dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install

COPY . .

EXPOSE 5173
EXPOSE 3001

CMD ["sh", "-c", "bun ws-server.ts & bun run dev"]
```

- [ ] **Step 2: Rebuild the web service**

```bash
docker compose build web
docker compose up -d web
docker compose logs -f web
```

Expected: both `[ws] relay listening on :3001` and the Vite startup banner appear.

- [ ] **Step 3: Commit**

```bash
git add web/ws-server.ts web/Dockerfile
git commit -m "feat: add Bun WebSocket relay server and start it alongside Vite"
```

---

## Task 4: Proxy `/ws` in Vite config

**Files:**
- Modify: `web/vite.config.ts`

`★ Insight ─────────────────────────────────────`
Vite uses `http-proxy` under the hood. To proxy WebSocket connections you add `ws: true` to the proxy entry. Without it, only HTTP requests are forwarded and the WebSocket handshake is dropped. The target must be `http://localhost:3001` (not `ws://`) because http-proxy upgrades the connection internally.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Add `/ws` proxy entry to `web/vite.config.ts`**

Find the `proxy:` block and add the new entry:

```typescript
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
  "/ws": {
    target: "http://localhost:3001",
    ws: true,
    changeOrigin: true,
  },
},
```

- [ ] **Step 2: Rebuild and verify**

```bash
docker compose build web && docker compose up -d web
docker compose logs web | grep "ws"
```

Expected: relay starts, no Vite errors.

- [ ] **Step 3: Commit**

```bash
git add web/vite.config.ts
git commit -m "feat: proxy /ws WebSocket connections to relay server"
```

---

## Task 5: Add `useHardware` browser hook

**Files:**
- Create: `web/src/hooks/useHardware.ts`

This hook connects the browser to the relay and maps incoming hardware JSON messages to chat actions. It also pushes `faceState` back to the hardware so the ESP32 can update its LEDs in the future.

- [ ] **Step 1: Create `web/src/hooks/useHardware.ts`**

```typescript
import { useEffect, useRef } from "react";
import type { FaceState } from "../types";

export interface HardwareOpts {
  faceState: FaceState;
  onNewSession: () => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onStopSpeaking: () => void;
}

export function useHardware({
  faceState,
  onNewSession,
  onStartRecord,
  onStopRecord,
  onStopSpeaking,
}: HardwareOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const faceRef = useRef(faceState);
  faceRef.current = faceState;

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?client=browser`;

    let ws: WebSocket;
    let alive = true;

    function connect() {
      if (!alive) return;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.info("[hw] relay connected");
        // send current state immediately so hardware LED is correct
        ws.send(JSON.stringify({ type: "status", state: faceRef.current }));
      };

      ws.onmessage = (e) => {
        let msg: { type: string };
        try {
          msg = JSON.parse(e.data as string);
        } catch {
          return;
        }
        switch (msg.type) {
          case "new_session":
          case "presence_detected":
            onNewSession();
            break;
          case "start_record":
            onStartRecord();
            break;
          case "stop_record":
            onStopRecord();
            break;
          case "stop_speaking":
            onStopSpeaking();
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (alive) setTimeout(connect, 3000); // auto-reconnect
      };
    }

    connect();
    return () => {
      alive = false;
      ws?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // connect once; callbacks captured via refs

  // Push face state to hardware whenever it changes
  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "status", state: faceState }));
    }
  }, [faceState]);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/hooks/useHardware.ts
git commit -m "feat: add useHardware hook for ESP32 relay bridge"
```

---

## Task 6: Wire `useHardware` into `App.tsx`

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Import and call `useHardware` in `App.tsx`**

Add the import at the top:
```typescript
import { useHardware } from "./hooks/useHardware";
```

Inside the `App()` function body, after the existing hooks (`tts`, `stt`, `chat`), add:

```typescript
useHardware({
  faceState,
  onNewSession: () => {
    chat.createSession();
    setView("chat");
    setTimeout(() => chat.sendText("Hello!"), 120);
  },
  onStartRecord: () => {
    if (stt.permission !== "granted") {
      stt.requestPermission();
    } else {
      stt.start();
    }
  },
  onStopRecord: async () => {
    const result = await stt.stop();
    if (result?.blob) {
      chat.sendAudio(result.blob);
    }
  },
  onStopSpeaking: () => {
    tts.stop();
  },
});
```

Note: `faceState` is defined later in the function via `useMemo`. Move the `faceState` memo **above** the `useHardware` call, or pass a ref. The simplest fix is to declare `faceState` earlier:

```typescript
// ← move this block BEFORE the useHardware call
const faceState: FaceState = useMemo(() => {
  if (tts.speaking) return "speaking";
  if (chat.pending) return "thinking";
  if (stt.status === "recording") return "listening";
  return "idle";
}, [tts.speaking, chat.pending, stt.status]);
```

- [ ] **Step 2: Rebuild web container and do a smoke test**

```bash
docker compose build web && docker compose up -d web
```

Open browser dev tools → Network → WS. You should see a `ws://localhost:5173/ws?client=browser` connection established (or pending until the ESP32 is connected).

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: wire useHardware into App — button/presence events from ESP32"
```

---

## Task 7: Rewrite `Hardware/platformio.ini`

**Files:**
- Modify: `Hardware/platformio.ini`

Remove the LoRa / OLED / old dependencies; add WebSocket client and Preferences.

- [ ] **Step 1: Replace the full contents of `Hardware/platformio.ini`**

```ini
; HAICI ESP32 Controller — WiFi + WebSocket
[env:haici]
platform        = espressif32
board           = upesy_wroom
framework       = arduino
monitor_speed   = 115200
upload_port     = /dev/ttyUSB0
monitor_port    = /dev/ttyUSB0

lib_deps =
    links2004/WebSockets @ ^2.4.1
```

`Preferences.h` and `WebServer.h` and `WiFi.h` are all built into the ESP32 Arduino core — no extra `lib_deps` lines needed.

- [ ] **Step 2: Commit**

```bash
git add Hardware/platformio.ini
git commit -m "chore(hardware): replace LoRa/OLED deps with WebSockets library"
```

---

## Task 8: Rewrite `Hardware/src/main.cpp`

**Files:**
- Modify: `Hardware/src/main.cpp`

This is a complete replacement. Delete the old LoRa code entirely.

`★ Insight ─────────────────────────────────────`
The ESP32's `Preferences` library uses NVS (Non-Volatile Storage) flash partitions — think of it as a tiny key-value store that survives power cycles. `prefs.begin("haici", true)` opens namespace "haici" in read-only mode; `false` opens it read-write. Each `putString`/`getUShort` call maps to a distinct NVS key inside that namespace.

The `WebSocketsClient` library's `ws.loop()` must be called every iteration of `loop()` when WiFi is connected — it handles ping/pong keepalives and reconnect timers internally. Skipping it for even a few hundred milliseconds can cause the server to consider the connection dead.

For buttons, active-LOW with `INPUT_PULLUP` is the standard Arduino pattern: pin reads HIGH when idle, LOW when button connects it to GND. No external resistor needed.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Replace `Hardware/src/main.cpp` with the full firmware**

```cpp
#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Preferences.h>
#include <WebServer.h>

// ─── Pin Map ──────────────────────────────────────────────────────────────────
//
//  Device               ESP32 GPIO    Notes
//  ─────────────────── ──────────── ───────────────────────────────────────────
//  LED Red              GPIO 25       OUTPUT, active HIGH, 330Ω to GND
//  LED Blue             GPIO 26       OUTPUT, active HIGH, 330Ω to GND
//  LED Green            GPIO 27       OUTPUT, active HIGH, 330Ω to GND
//
//  Button Red  (R)      GPIO 32       INPUT_PULLUP, active LOW → GND
//  Button Yellow (Y)    GPIO 33       INPUT_PULLUP, active LOW → GND
//  Button Blue (B)      GPIO 35       INPUT_PULLUP, active LOW → GND (input-only pin)
//
//  HC-SR04 TRIG         GPIO 5        OUTPUT
//  HC-SR04 ECHO         GPIO 18       INPUT  ⚠ Use voltage divider: ECHO──1kΩ──GPIO18──2kΩ──GND
//                                             HC-SR04 ECHO is 5V logic; ESP32 is 3.3V max.
//                                             Alternative: use HC-SR04P (3.3V variant, no divider needed)
//
// ─────────────────────────────────────────────────────────────────────────────

#define PIN_LED_RED           25
#define PIN_LED_BLUE          26
#define PIN_LED_GREEN         27

#define PIN_BTN_RED           32
#define PIN_BTN_YELLOW        33
#define PIN_BTN_BLUE          35

#define PIN_ULTRASONIC_TRIG    5
#define PIN_ULTRASONIC_ECHO   18

// ─── Timing constants ─────────────────────────────────────────────────────────
#define BTN_DEBOUNCE_MS        50
#define BTN_LONGPRESS_MS      800
#define ULTRASONIC_POLL_MS    500
#define WS_RECONNECT_MS      5000
#define HEARTBEAT_MS        30000
#define AP_TIMEOUT_MS      300000   // auto-reboot AP mode after 5 min

// ─── Config defaults ─────────────────────────────────────────────────────────
#define DEFAULT_WS_HOST       "192.168.1.100"
#define DEFAULT_WS_PORT       3001
#define DEFAULT_WS_PATH       "/ws?client=hardware"
#define DEFAULT_PRESENCE_CM   150    // detect anyone within 1.5 m
#define DEFAULT_IDLE_MIN      3      // idle minutes before re-greeting

// ─── State machine ───────────────────────────────────────────────────────────
enum class AppState {
  AP_CONFIG,
  CONNECTING_WIFI,
  CONNECTING_WS,
  RUNNING,
};
static AppState appState = AppState::CONNECTING_WIFI;

// ─── Config ──────────────────────────────────────────────────────────────────
struct Config {
  char     wifiSsid[64];
  char     wifiPass[64];
  char     wsHost[64];
  uint16_t wsPort;
  char     wsPath[128];
  uint16_t presenceCm;
  uint32_t idleTimeoutMs;
};
static Config cfg;
static Preferences prefs;

static void loadConfig() {
  prefs.begin("haici", /*readOnly=*/true);
  prefs.getString("ssid",    cfg.wifiSsid, sizeof(cfg.wifiSsid));
  prefs.getString("pass",    cfg.wifiPass, sizeof(cfg.wifiPass));
  prefs.getString("wshost",  cfg.wsHost,   sizeof(cfg.wsHost));
  cfg.wsPort        = prefs.getUShort("wsport",   DEFAULT_WS_PORT);
  prefs.getString("wspath",  cfg.wsPath,   sizeof(cfg.wsPath));
  cfg.presenceCm    = prefs.getUShort("presence", DEFAULT_PRESENCE_CM);
  cfg.idleTimeoutMs = prefs.getULong ("idletm",   (uint32_t)DEFAULT_IDLE_MIN * 60000UL);
  prefs.end();

  if (strlen(cfg.wsHost) == 0) strlcpy(cfg.wsHost, DEFAULT_WS_HOST, sizeof(cfg.wsHost));
  if (strlen(cfg.wsPath) == 0) strlcpy(cfg.wsPath, DEFAULT_WS_PATH, sizeof(cfg.wsPath));
}

static void saveConfig(const char* ssid, const char* pass,
                       const char* wshost, uint16_t wsport, const char* wspath,
                       uint16_t presenceCm, uint32_t idleTimeoutMs) {
  prefs.begin("haici", /*readOnly=*/false);
  prefs.putString("ssid",    ssid);
  prefs.putString("pass",    pass);
  prefs.putString("wshost",  wshost);
  prefs.putUShort("wsport",  wsport);
  prefs.putString("wspath",  wspath);
  prefs.putUShort("presence", presenceCm);
  prefs.putULong ("idletm",   idleTimeoutMs);
  prefs.end();
}

// ─── LEDs ────────────────────────────────────────────────────────────────────
static void setLed(bool r, bool b, bool g) {
  digitalWrite(PIN_LED_RED,   r ? HIGH : LOW);
  digitalWrite(PIN_LED_BLUE,  b ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, g ? HIGH : LOW);
}

// ─── Ultrasonic ──────────────────────────────────────────────────────────────
static uint16_t readDistanceCm() {
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  long us = pulseIn(PIN_ULTRASONIC_ECHO, HIGH, 30000UL);
  return (us == 0) ? 9999 : (uint16_t)(us * 0.034f / 2.0f);
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
static WebSocketsClient ws;
static bool wsConnected = false;

static void wsSend(const char* type, const char* extra = nullptr) {
  if (!wsConnected) return;
  char buf[160];
  if (extra) snprintf(buf, sizeof(buf), "{\"type\":\"%s\",%s}", type, extra);
  else       snprintf(buf, sizeof(buf), "{\"type\":\"%s\"}", type);
  ws.sendTXT(buf);
}

static void wsEvent(WStype_t t, uint8_t* payload, size_t /*len*/) {
  switch (t) {
    case WStype_CONNECTED:
      wsConnected = true;
      appState = AppState::RUNNING;
      setLed(false, false, true);   // ● Green
      Serial.println("[WS] Connected");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      appState = AppState::CONNECTING_WS;
      setLed(false, true, false);   // ● Blue (wifi ok, no server)
      Serial.println("[WS] Disconnected, will retry");
      break;
    case WStype_TEXT:
      // Browser pushes {"type":"status","state":"thinking"} etc.
      Serial.printf("[WS] <- %s\n", payload);
      break;
    default:
      break;
  }
}

static void startWsConnect() {
  setLed(false, true, false);       // ● Blue
  ws.begin(cfg.wsHost, cfg.wsPort, cfg.wsPath);
  ws.onEvent(wsEvent);
  ws.setReconnectInterval(WS_RECONNECT_MS);
  Serial.printf("[WS] Connecting to %s:%d%s\n", cfg.wsHost, cfg.wsPort, cfg.wsPath);
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
struct Btn {
  uint8_t       pin;
  bool          state;       // current debounced state (true = released)
  unsigned long pressedAt;
  bool          longFired;
};

static Btn btnRed    = { PIN_BTN_RED,    true, 0, false };
static Btn btnYellow = { PIN_BTN_YELLOW, true, 0, false };
static Btn btnBlue   = { PIN_BTN_BLUE,   true, 0, false };

// Returns 0=nothing, 1=short press released, 2=long press (fires while held)
static int pollBtn(Btn& b) {
  bool raw = (bool)digitalRead(b.pin);
  if (raw != b.state) {
    b.state = raw;
    if (!raw) {                                       // just pressed (active LOW)
      b.pressedAt = millis();
      b.longFired = false;
    } else if (!b.longFired) {                        // just released without long-fire
      unsigned long held = millis() - b.pressedAt;
      if (held >= BTN_DEBOUNCE_MS) return 1;          // short press
    }
  }
  if (!b.state && !b.longFired && millis() - b.pressedAt >= BTN_LONGPRESS_MS) {
    b.longFired = true;
    return 2;                                         // long press
  }
  return 0;
}

static bool recording = false;
static void startAPMode();  // forward declaration

static void handleButtons() {
  int r = pollBtn(btnRed);
  int y = pollBtn(btnYellow);
  int bl = pollBtn(btnBlue);

  if (r == 1) {
    Serial.println("[BTN] Red short → new_session");
    wsSend("new_session");
  } else if (r == 2) {
    Serial.println("[BTN] Red long → AP config");
    startAPMode();
  }

  if (y == 1) {
    if (!recording) {
      recording = true;
      Serial.println("[BTN] Yellow → start_record");
      wsSend("start_record");
    } else {
      recording = false;
      Serial.println("[BTN] Yellow → stop_record");
      wsSend("stop_record");
    }
  }

  if (bl == 1) {
    recording = false;
    Serial.println("[BTN] Blue → stop_speaking");
    wsSend("stop_speaking");
  }
}

// ─── AP Config Portal ────────────────────────────────────────────────────────
static WebServer apServer(80);
static unsigned long apStartedMs = 0;

static const char AP_HTML[] PROGMEM = R"html(
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>HAICI Setup</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:sans-serif;max-width:440px;margin:40px auto;padding:20px;background:#f5f5f5}
    h1{color:#0d6efd;margin-bottom:4px}
    p.sub{color:#555;font-size:13px;margin-top:0}
    label{display:block;margin-top:14px;font-size:13px;font-weight:600;color:#333}
    input{width:100%;padding:9px 10px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px}
    button{margin-top:22px;width:100%;padding:13px;background:#0d6efd;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer}
    button:hover{background:#0b5ed7}
    footer{margin-top:28px;text-align:center;font-size:11px;color:#aaa}
    a{color:#0d6efd;text-decoration:none}
  </style>
</head>
<body>
  <h1>HAICI Configuration</h1>
  <p class="sub">Connect the ESP32 to your network and WebSocket server.</p>
  <form method="POST" action="/save">
    <label>WiFi SSID</label>
    <input name="ssid" value="%SSID%" required placeholder="YourWiFi">
    <label>WiFi Password</label>
    <input name="pass" type="password" value="%PASS%" placeholder="••••••••">
    <label>WebSocket Host (IP or hostname)</label>
    <input name="wshost" value="%WSHOST%" placeholder="192.168.1.100">
    <label>WebSocket Port</label>
    <input name="wsport" type="number" value="%WSPORT%" placeholder="3001">
    <label>WebSocket Path</label>
    <input name="wspath" value="%WSPATH%" placeholder="/ws?client=hardware">
    <label>Presence Threshold (cm)</label>
    <input name="presence" type="number" value="%PRESENCE%" min="10" max="400">
    <label>Idle Timeout Before Re-greeting (minutes)</label>
    <input name="idletm" type="number" value="%IDLETM%" min="1" max="60">
    <button type="submit">Save &amp; Restart</button>
  </form>
  <footer>Powered by <a href="https://barmajino.com" target="_blank">barmajino.com</a></footer>
</body>
</html>
)html";

static void handleAPRoot() {
  String html = FPSTR(AP_HTML);
  html.replace("%SSID%",    cfg.wifiSsid);
  html.replace("%PASS%",    cfg.wifiPass);
  html.replace("%WSHOST%",  cfg.wsHost);
  html.replace("%WSPORT%",  String(cfg.wsPort));
  html.replace("%WSPATH%",  cfg.wsPath);
  html.replace("%PRESENCE%", String(cfg.presenceCm));
  html.replace("%IDLETM%",  String(cfg.idleTimeoutMs / 60000UL));
  apServer.send(200, "text/html", html);
}

static void handleAPSave() {
  String ssid    = apServer.arg("ssid");
  String pass    = apServer.arg("pass");
  String wshost  = apServer.arg("wshost");
  uint16_t wsport = (uint16_t)apServer.arg("wsport").toInt();
  String wspath  = apServer.arg("wspath");
  uint16_t pres  = (uint16_t)apServer.arg("presence").toInt();
  uint32_t idle  = (uint32_t)apServer.arg("idletm").toInt() * 60000UL;

  saveConfig(ssid.c_str(), pass.c_str(), wshost.c_str(), wsport,
             wspath.c_str(), pres, idle);

  apServer.send(200, "text/html",
    "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
    "<h2>Saved! Restarting in 2 seconds...</h2>"
    "<footer style='margin-top:40px;font-size:11px;color:#aaa'>"
    "Powered by <a href='https://barmajino.com'>barmajino.com</a></footer>"
    "</body></html>");
  delay(2000);
  ESP.restart();
}

static void startAPMode() {
  ws.disconnect();
  WiFi.disconnect();
  WiFi.mode(WIFI_AP);
  WiFi.softAP("HAICI-Config", "haici1234");
  appState = AppState::AP_CONFIG;
  setLed(true, false, false);       // ● Red blink (handled in loop)

  Serial.printf("[AP] SSID: HAICI-Config  IP: %s\n",
                WiFi.softAPIP().toString().c_str());
  Serial.println("[AP] Password: haici1234");
  Serial.println("[AP] Open http://192.168.4.1 to configure");

  apServer.on("/",     HTTP_GET,  handleAPRoot);
  apServer.on("/save", HTTP_POST, handleAPSave);
  apServer.begin();
  apStartedMs = millis();
}

// ─── Ultrasonic Presence ─────────────────────────────────────────────────────
static unsigned long lastUltrasonicMs = 0;
static unsigned long lastPresenceMs   = 0;
static bool          wasPresent       = false;

static void checkPresence() {
  if (millis() - lastUltrasonicMs < ULTRASONIC_POLL_MS) return;
  lastUltrasonicMs = millis();

  uint16_t dist    = readDistanceCm();
  bool     present = (dist < cfg.presenceCm);

  if (present) {
    if (!wasPresent) {
      // Transition: nobody → somebody
      unsigned long idleMs = millis() - lastPresenceMs;
      if (idleMs >= cfg.idleTimeoutMs) {
        Serial.printf("[ULTRA] Presence after %.1f min idle → presence_detected\n",
                      idleMs / 60000.0f);
        wsSend("presence_detected");
      }
      wasPresent = true;
    }
    lastPresenceMs = millis();
  } else {
    wasPresent = false;
  }
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────
static unsigned long lastHeartbeatMs = 0;

static void sendHeartbeat() {
  if (millis() - lastHeartbeatMs < HEARTBEAT_MS) return;
  lastHeartbeatMs = millis();
  char extra[40];
  snprintf(extra, sizeof(extra), "\"uptime\":%lu", millis() / 1000UL);
  wsSend("heartbeat", extra);
}

// ─── Setup ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[HAICI] booting...");

  pinMode(PIN_LED_RED,   OUTPUT);
  pinMode(PIN_LED_BLUE,  OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  setLed(true, false, false);       // ● Red while booting

  pinMode(PIN_BTN_RED,    INPUT_PULLUP);
  pinMode(PIN_BTN_YELLOW, INPUT_PULLUP);
  pinMode(PIN_BTN_BLUE,   INPUT_PULLUP);

  pinMode(PIN_ULTRASONIC_TRIG, OUTPUT);
  pinMode(PIN_ULTRASONIC_ECHO, INPUT);
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);

  loadConfig();

  if (strlen(cfg.wifiSsid) == 0) {
    Serial.println("[HAICI] No WiFi config → entering AP mode");
    startAPMode();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfg.wifiSsid, cfg.wifiPass);
  Serial.printf("[WiFi] Connecting to \"%s\"...\n", cfg.wifiSsid);
}

// ─── Loop ────────────────────────────────────────────────────────────────────
static unsigned long lastWifiCheckMs = 0;
static bool wsPending = false;

void loop() {

  // ── AP Mode ──────────────────────────────────────────────────────────────
  if (appState == AppState::AP_CONFIG) {
    apServer.handleClient();
    // Blink red LED while in AP mode to signal "needs config"
    setLed(millis() % 1000 < 500, false, false);
    if (millis() - apStartedMs > AP_TIMEOUT_MS) {
      Serial.println("[AP] Timeout → rebooting");
      ESP.restart();
    }
    return;
  }

  // Always poll buttons (even while WiFi/WS are connecting)
  handleButtons();

  // ── WiFi ─────────────────────────────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    if (appState != AppState::CONNECTING_WIFI) {
      appState  = AppState::CONNECTING_WIFI;
      wsPending = false;
      setLed(true, false, false);   // ● Red
      Serial.println("[WiFi] Lost connection");
    }
    return;
  }

  // WiFi just came up — kick off WS connect once
  if (!wsPending) {
    wsPending = true;
    appState   = AppState::CONNECTING_WS;
    startWsConnect();
  }

  ws.loop();   // must be called every iteration when WiFi is up

  if (!wsConnected) return;

  // ── Fully connected ──────────────────────────────────────────────────────
  checkPresence();
  sendHeartbeat();
}
```

- [ ] **Step 2: Build with PlatformIO (do NOT flash yet — just verify it compiles)**

```bash
cd Hardware
pio run -e haici
```

Expected: `SUCCESS` with no errors. Warnings about unused variables are OK.

- [ ] **Step 3: Flash to the ESP32**

```bash
pio run -e haici --target upload
pio device monitor -e haici
```

Expected serial output on cold boot (no WiFi config yet):
```
[HAICI] booting...
[HAICI] No WiFi config → entering AP mode
[AP] SSID: HAICI-Config  IP: 192.168.4.1
[AP] Password: haici1234
```

The Red LED should blink.

- [ ] **Step 4: Configure via AP portal**

On a phone or laptop: connect to WiFi `HAICI-Config` (password `haici1234`), open `http://192.168.4.1`, fill in your home WiFi credentials and the IP of the machine running Docker (check with `hostname -I`), port `3001`, path `/ws?client=hardware`. Submit → ESP reboots.

Expected serial after reboot:
```
[WiFi] Connecting to "YourWiFi"...
[WS] Connecting to 192.168.x.x:3001/ws?client=hardware
[WS] Connected
```
Green LED solid.

- [ ] **Step 5: Commit**

```bash
cd ..
git add Hardware/src/main.cpp
git commit -m "feat(hardware): full ESP32 WiFi+WebSocket firmware with buttons, LEDs, ultrasonic, AP config"
```

---

## Task 9: Write the wiring + protocol report

**Files:**
- Create: `Hardware/REPORT.md`

- [ ] **Step 1: Create `Hardware/REPORT.md`**

```markdown
# HAICI ESP32 — Wiring & Protocol Report

## Wiring

### Power
| Source          | Destination  |
|-----------------|-------------|
| ESP32 3V3       | HC-SR04P VCC (if using 3.3 V variant) |
| ESP32 5V (Vin)  | HC-SR04 VCC (standard 5 V variant) |
| ESP32 GND       | GND rail (all devices share this rail) |

### LEDs (330 Ω series resistor, anode → GPIO, cathode → GND)
| LED   | GPIO | Meaning |
|-------|------|---------|
| Red   | 25   | No WiFi |
| Blue  | 26   | WiFi OK, WebSocket unreachable |
| Green | 27   | Everything connected |

### Buttons (one leg → GPIO, other leg → GND; internal pullup enabled)
| Button | GPIO | Short press | Long press |
|--------|------|-------------|------------|
| Red    | 32   | New session | Open AP config portal |
| Yellow | 33   | Toggle mic recording (start / stop+send) | — |
| Blue   | 35   | Stop speaking / cancel recording | — |

### Ultrasonic HC-SR04
| HC-SR04 Pin | ESP32 GPIO | Note |
|-------------|-----------|------|
| VCC         | 5V (Vin)  | 5 V supply |
| GND         | GND       | |
| TRIG        | GPIO 5    | Direct connection |
| ECHO        | GPIO 18   | **⚠ Voltage divider required!** ECHO is 5 V; ESP32 inputs max 3.3 V. Wire: ECHO → 1 kΩ → GPIO18, GPIO18 → 2 kΩ → GND. Or use HC-SR04P (3.3 V). |

### Voltage Divider for ECHO
```
HC-SR04 ECHO ──[ 1kΩ ]──┬── GPIO 18
                         │
                       [2kΩ]
                         │
                        GND
```
This divides 5 V to ≈ 3.33 V — within ESP32 spec.

---

## Message Protocol

All messages are JSON over WebSocket.

### ESP32 → Browser (via relay)
| `type`             | Extra fields          | Meaning |
|--------------------|-----------------------|---------|
| `new_session`      | —                     | Red button short press |
| `presence_detected`| —                     | Ultrasonic: someone arrived after idle timeout |
| `start_record`     | —                     | Yellow button pressed (mic on) |
| `stop_record`      | —                     | Yellow button pressed again (stop + send) |
| `stop_speaking`    | —                     | Blue button pressed |
| `heartbeat`        | `uptime: <seconds>`   | Sent every 30 s |

### Browser → ESP32 (via relay)
| `type`   | Extra fields          | Meaning |
|----------|-----------------------|---------|
| `status` | `state: idle\|listening\|thinking\|speaking` | App face state — used for future display / LED animation |

### Connection Flow
```
ESP32                    ws-server.ts (port 3001)         Browser
  │                              │                            │
  │── WS connect (/ws?client=hardware) ──►                   │
  │                              │◄── WS connect (/ws?client=browser) ──│
  │                              │                            │
  │── {"type":"new_session"} ───►│── broadcast ──────────────►│
  │                              │                            │ creates session
  │                              │◄── {"type":"status","state":"thinking"} ──│
  │◄── forwarded ────────────────│                            │
  │ (LEDs / future display)      │                            │
```

### LED State Summary
| LED    | GPIO | State meaning |
|--------|------|---------------|
| Red    | 25   | No WiFi connection |
| Blue   | 26   | WiFi connected, WebSocket server not reachable |
| Green  | 27   | Fully connected and operational |
| Red blink | 25 | AP config portal is active |

### AP Portal
- Hotspot SSID: `HAICI-Config`
- Password: `haici1234`
- URL: `http://192.168.4.1`
- Auto-closes after 5 minutes (ESP reboots)
- Footer: *Powered by [barmajino.com](https://barmajino.com)*
```

- [ ] **Step 2: Commit report**

```bash
git add Hardware/REPORT.md
git commit -m "docs(hardware): wiring pinout and WebSocket message protocol report"
```

---

## Self-Review: Spec Coverage Check

| Requirement | Task |
|---|---|
| Merge haici-agent-updated | Task 1 |
| WiFi + WebSocket | Tasks 2-4, 8 |
| Relay server in web Docker container | Tasks 2-3 |
| Red LED = no WiFi | Task 8 (wsEvent + setup) |
| Blue LED = WiFi but no server | Task 8 (wsEvent + startWsConnect) |
| Green LED = all good | Task 8 (wsEvent WStype_CONNECTED) |
| Red button short = new session | Task 8 (handleButtons) |
| Red button long = AP config mode | Task 8 (handleButtons + startAPMode) |
| Yellow = start/stop record + send | Task 8 (handleButtons), Task 6 (useHardware) |
| Blue = stop speaking / cancel | Task 8 (handleButtons), Task 6 (useHardware) |
| Ultrasonic presence detection after idle | Task 8 (checkPresence) |
| AP config portal | Task 8 (startAPMode, handleAPRoot, handleAPSave) |
| AP portal "powered by barmajino.com" | Task 8 (AP_HTML footer) |
| Ignore LoRa | Task 7 (platformio.ini removes RadioLib), Task 8 (no LoRa code) |
| Wiring diagram with pin comments | Task 8 (header comment block), Task 9 (REPORT.md) |
| Protocol report | Task 9 |
| Browser hook for hardware events | Task 5 (useHardware.ts) |
| Wire hook into App | Task 6 (App.tsx) |
