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
| Blue | GPIO 26 | WiFi connected but WebSocket server unreachable |
| Green | GPIO 27 | Fully connected — everything works |

---

### Buttons
One leg of each button → GPIO listed. Other leg → GND. `INPUT_PULLUP` enabled in firmware (active LOW, no resistor needed).

| Button color | ESP32 GPIO | Short press | Long press (800 ms) |
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

```
ESP32                      ws-server.ts :3001                 Browser tab
  │                                │                               │
  │── WebSocket connect ───────────►  (?client=hardware)          │
  │   ws://192.168.x.x:3001/ws     │                               │
  │   ?client=hardware             │◄── WebSocket connect ─────────│
  │                                │    (/ws?client=browser        │
  │                                │     proxied by Vite)          │
  │── {"type":"new_session"} ──────►── relay to all browsers ──────►│
  │                                │                               │ createSession()
  │                                │                               │ sendText("Hello!")
  │                                │◄── {"type":"status",          │
  │                                │     "state":"thinking"} ──────│
  │◄── forwarded ──────────────────│                               │
  │  (for future display/LEDs)     │                               │
  │                                │                               │
  │── {"type":"start_record"} ─────►── relay ─────────────────────►│
  │                                │                               │ stt.start()
  │── {"type":"stop_record"} ──────►── relay ─────────────────────►│
  │                                │                               │ stt.stop() → sendAudio()
```

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
   - Your home/office WiFi SSID and password
   - The IP address of the machine running Docker (run `hostname -I` on it)
   - Port: `3001`
   - Path: `/ws?client=hardware`
5. Submit → ESP32 saves to NVS and reboots.
6. After reboot: Red LED (connecting) → Blue LED (WiFi up, finding WS) → **Green LED** (all good).

To re-enter config at any time: **long-press the Red button** for 800 ms.

---

*Powered by [barmajino.com](https://barmajino.com)*
