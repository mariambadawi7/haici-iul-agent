# HAICI ESP32 — Wiring & Protocol Report

## Wiring

### Power rail
| Source | Destination |
|--------|-------------|
| ESP32 5V (Vin) | HC-SR04 VCC |
| ESP32 3.3V | (nothing — all other devices run at 3.3V logic) |
| ESP32 GND | GND rail shared by all devices |

---

### LEDs
330 Ω resistor in series between each GPIO and the LED anode. LED cathode → GND.

| LED color | ESP32 GPIO | LED state meaning |
|-----------|-----------|-------------------|
| Red | GPIO 25 | No WiFi connection (solid) / AP config mode (blinking) |
| Blue | GPIO 26 | Solid = WiFi OK, relay unreachable. Blinking = WiFi OK but internet behind a captive sign-in page |
| Green | GPIO 27 | Fully connected — everything works |

---

### Buttons
One leg of each button → GPIO listed. Other leg → GND. `INPUT_PULLUP` enabled in firmware (active LOW, no resistor needed).

| Button color | ESP32 GPIO | Short press | Long press (hold 2 s) |
|-------------|-----------|-------------|----------------------|
| Red | GPIO 32 | Send `new_session` to chatbot | Open AP WiFi/WS config portal |
| Yellow | GPIO 33 | Start mic recording; press again = stop + send audio | — |
| Blue | GPIO 4 | Stop agent speaking / cancel recording | — |

> ⚠ **Do not use GPIO 34/35/36/39 for buttons.** Those pins are input-only and
> have **no internal pull-up resistor**, so `INPUT_PULLUP` silently leaves them
> floating and the button reads garbage. The Blue button uses GPIO 4 (a normal
> pin with a working internal pull-up). If you must use 34–39, add an external
> 10 kΩ pull-up resistor from the pin to 3.3 V.

---

### HC-SR04 Ultrasonic Sensor

| HC-SR04 pin | ESP32 | Note |
|-------------|-------|------|
| VCC | 5V (Vin) | Must be 5V supply |
| GND | GND | |
| TRIG | GPIO 5 | Direct connection |
| ECHO | GPIO 18 | **Voltage divider required** (see below) |

**Why a voltage divider on ECHO?**
The HC-SR04 ECHO pin outputs 5V logic. The ESP32 GPIO pins tolerate a maximum of 3.3V. Without a divider, the echo pulse will damage the ESP32 over time.

```
HC-SR04 ECHO ──[ 1kΩ ]──┬── GPIO 18 (ESP32)
                          │
                        [ 2kΩ ]
                          │
                         GND
```

The 1k + 2k divider brings 5V down to ~3.33V — within spec.
**Alternative:** Use an HC-SR04**P** (the 3.3V variant). No divider needed; connect ECHO directly.

---

## How the connection and messages work

Both the ESP32 and the browser connect **directly** to the Bun.serve relay on
port `3001` (the browser does **not** go through the Vite proxy — that proved
unreliable for WebSocket frames). On the kiosk the page is served over
`http://localhost:5173`, which is a secure context (so the mic still works) and
lets the page open a plain `ws://…:3001` connection with no cert/mixed-content
issues.

```
ESP32                         ws-server.ts (Bun) :3001            Browser tab
  │                                    │                               │
  │── ws://<host>:3001/ws ────────────►│                               │
  │      ?client=hardware              │◄── ws://<host>:3001/ws ────────│
  │                                    │       ?client=browser         │
  │── {"type":"new_session"} ─────────►── relay to all browsers ──────►│
  │                                    │                               │ createSession()
  │                                    │                               │ sendText("Hello!")
  │                                    │◄── {"type":"status",          │
  │                                    │     "state":"thinking"} ──────│
  │◄── forwarded ──────────────────────│                               │
  │  (logged; for future display)      │                               │
  │                                    │                               │
  │── {"type":"start_record"} ────────►── relay ─────────────────────►│
  │                                    │                               │ stt.start()
  │── {"type":"stop_record"} ─────────►── relay ─────────────────────►│
  │                                    │                               │ stt.stop() → sendAudio()
```

> **Mobile note:** the relay speaks plain `ws` only. The ESP→browser hardware
> control therefore targets the **kiosk** browser (localhost). Phones opening the
> UI over `https` (VITE_HTTPS=1) still get full chat/voice via the n8n webhook,
> but not the ESP relay. Override the relay URL with `VITE_HW_WS_URL` if needed.

### Message reference

#### ESP32 → Browser

| `type` | Extra fields | When sent |
|--------|-------------|-----------|
| `new_session` | — | Red button short press |
| `presence_detected` | — | Ultrasonic: person appeared after idle timeout |
| `start_record` | — | Yellow button first press |
| `stop_record` | — | Yellow button second press (stop + send) |
| `stop_speaking` | — | Blue button press |
| `heartbeat` | `uptime` (seconds) | Every 30 seconds |

#### Browser → ESP32

| `type` | Extra fields | When sent |
|--------|-------------|-----------|
| `status` | `state`: `idle` / `listening` / `thinking` / `speaking` | Every time `faceState` changes in the UI |

---

## First-time configuration

1. Flash the firmware. On first boot (no WiFi saved in NVS) the ESP32 creates a hotspot:
   - **SSID:** `HAICI-Config`
   - **Password:** `haici1234`
2. Connect your phone or laptop to that hotspot.
3. Open **http://192.168.4.1** in a browser.
4. Fill in:
   - **WiFi network** — pick it from the **dropdown** (the ESP scans live; tap *Rescan* to refresh). 🔒 marks password-protected networks and the dBm value shows signal strength. For a hidden SSID, type it in the *manual* field instead (manual overrides the dropdown).
   - WiFi password
   - The IP address of the machine running Docker (run `hostname -I` on it)
   - Port: `3001`
   - Path: `/ws?client=hardware`
5. Submit → ESP32 saves to NVS and reboots.
6. After reboot: Red LED (connecting) → Blue LED (WiFi up, finding WS) → **Green LED** (all good).

To re-enter config at any time: **hold the Red button for 2 seconds**. The Red
LED will start **blinking** to confirm AP config mode is active.

Once you join the `HAICI-Config` hotspot, the config page should **pop up
automatically** (captive-portal DNS). If it doesn't, open **http://192.168.4.1**
manually — any address you type will redirect to the config page.

### How the WiFi scan works
In config mode the ESP32 runs in `WIFI_AP_STA` mode, so it can scan for networks
(`/scan` endpoint → JSON) *while* still serving the config hotspot to your phone.
The dropdown is populated by JavaScript on page load and on every *Rescan*.

---

## Captive-portal WiFi (networks with a "Sign in" page)

Some public networks (campus, café, hotel) block traffic until a human opens a
browser and clicks **Sign in / Accept**. A headless ESP32 cannot complete a
credential or SMS login. Here is exactly what the firmware does:

1. **Detection** — after connecting, the ESP probes
   `http://connectivitycheck.gstatic.com/generate_204`.
   - HTTP **204** → open internet, no portal.
   - **Redirect / 200** → a captive portal is intercepting traffic.
2. **Best-effort auto-accept** — for *simple click-through* "I accept the terms"
   gateways, the ESP fetches the portal page, finds the first `<form action=…>`
   and submits it. This clears trivial portals but **cannot** do username/password
   or SMS-code logins.
3. **The important part** — the **HAICI relay lives on your LAN**, and captive
   portals gate *internet (WAN)* traffic, **not** LAN-to-LAN. So the ESP→relay
   WebSocket — and therefore the whole button/voice/presence flow — **usually
   works even on an un-signed-in captive network**. The chatbot's own internet
   needs (LLM, etc.) are handled server-side on your Docker host, which you sign
   in once.

**LED hint:** if a captive portal is detected and the WebSocket isn't connected
yet, the Blue LED **blinks** (instead of solid). Solid Blue = WiFi OK but relay
unreachable; blinking Blue = WiFi OK but internet is behind a sign-in page.

> If your network has **client isolation** enabled (LAN-to-LAN blocked too),
> the ESP can't reach the relay at all — use a network without isolation, a
> phone hotspot, or a dedicated AP for the kiosk.

---

*Powered by [barmajino.com](https://barmajino.com)*
