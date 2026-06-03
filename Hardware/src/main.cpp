#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WebServer.h>

// =============================================================================
//  WIRING GUIDE
//  Connect each device pin to the ESP32 GPIO listed below.
//
//  LEDS (use a 330 Ohm resistor in series; anode -> GPIO, cathode -> GND)
//  +----------------+----------+------------------------------------------+
//  | LED color      | ESP32    | Meaning                                  |
//  +----------------+----------+------------------------------------------+
//  | Red            | GPIO 25  | No WiFi connection                       |
//  | Blue           | GPIO 26  | WiFi OK, WebSocket server unreachable    |
//  | Green          | GPIO 27  | Fully connected -- everything works      |
//  +----------------+----------+------------------------------------------+
//
//  BUTTONS (one leg -> GPIO, other leg -> GND; internal pullup, active LOW)
//  +--------------------+----------+----------------------------------------+
//  | Button (color)     | ESP32    | Action                                 |
//  +--------------------+----------+----------------------------------------+
//  | Red                | GPIO 32  | Short press = new session              |
//  |                    |          | Long press  = open WiFi/WS config AP   |
//  | Yellow             | GPIO 33  | Press = start mic; press again = stop  |
//  |                    |          |   and send recording to chatbot        |
//  | Blue               | GPIO 4   | Press = stop speaking / cancel record  |
//  +--------------------+----------+----------------------------------------+
//  IMPORTANT: GPIOs 34-39 are input-only and have NO internal pull-up.
//  The Blue button therefore uses GPIO 4 (a normal pin with INPUT_PULLUP).
//  Do not move it to 34/35/36/39 unless you add an external 10k pull-up.
//
//  HC-SR04 ULTRASONIC SENSOR
//  +----------------+-----------+-------------------------------------------+
//  | HC-SR04 pin    | ESP32     | Note                                      |
//  +----------------+-----------+-------------------------------------------+
//  | VCC            | 5V (Vin)  | Standard HC-SR04 needs 5V                 |
//  | GND            | GND       |                                           |
//  | TRIG           | GPIO 5    | Direct connection                         |
//  | ECHO           | GPIO 18   | *** VOLTAGE DIVIDER REQUIRED ***          |
//  |                |           | ECHO = 5V; ESP32 max input = 3.3V         |
//  |                |           | Use: ECHO--[1kOhm]--GPIO18--[2kOhm]--GND |
//  |                |           | Or use HC-SR04P (3.3V variant, no div.)   |
//  +----------------+-----------+-------------------------------------------+
//
//  Voltage divider for ECHO:
//
//    HC-SR04 ECHO --[ 1k ]--+-- GPIO 18 (ESP32)
//                            |
//                          [ 2k ]
//                            |
//                           GND
//
// =============================================================================

// ── Pin assignments ───────────────────────────────────────────────────────────
#define PIN_LED_RED           25
#define PIN_LED_BLUE          26
#define PIN_LED_GREEN         27

#define PIN_BTN_RED           32
#define PIN_BTN_YELLOW        33
#define PIN_BTN_BLUE           4   // NOT 34-39: those pins have no internal pull-up

#define PIN_ULTRASONIC_TRIG    5
#define PIN_ULTRASONIC_ECHO   18

// ── Timing ────────────────────────────────────────────────────────────────────
#define BTN_DEBOUNCE_MS        50
#define BTN_LONGPRESS_MS      800
#define ULTRASONIC_POLL_MS    500
#define WS_RECONNECT_MS      5000
#define HEARTBEAT_MS        30000
#define AP_TIMEOUT_MS      300000   // reboot AP mode after 5 min

// ── Config defaults (used on first boot or if NVS is empty) ──────────────────
#define DEFAULT_WS_HOST       "192.168.1.100"
#define DEFAULT_WS_PORT       3001
#define DEFAULT_WS_PATH       "/ws?client=hardware"
#define DEFAULT_PRESENCE_CM   150
#define DEFAULT_IDLE_MIN      3

// ── App state machine ─────────────────────────────────────────────────────────
enum class AppState { AP_CONFIG, CONNECTING_WIFI, CONNECTING_WS, RUNNING };
static AppState appState = AppState::CONNECTING_WIFI;

// ── Persistent config (stored in NVS flash, survives power cycles) ───────────
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
  prefs.begin("haici", true);
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
  prefs.begin("haici", false);
  prefs.putString("ssid",    ssid);
  prefs.putString("pass",    pass);
  prefs.putString("wshost",  wshost);
  prefs.putUShort("wsport",  wsport);
  prefs.putString("wspath",  wspath);
  prefs.putUShort("presence", presenceCm);
  prefs.putULong ("idletm",   idleTimeoutMs);
  prefs.end();
}

// ── LED helpers ───────────────────────────────────────────────────────────────
static void setLed(bool r, bool b, bool g) {
  digitalWrite(PIN_LED_RED,   r ? HIGH : LOW);
  digitalWrite(PIN_LED_BLUE,  b ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, g ? HIGH : LOW);
}

// ── Ultrasonic distance ───────────────────────────────────────────────────────
static uint16_t readDistanceCm() {
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_ULTRASONIC_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);
  long us = pulseIn(PIN_ULTRASONIC_ECHO, HIGH, 30000UL);
  return (us == 0) ? 9999 : (uint16_t)(us * 0.034f / 2.0f);
}

// ── WebSocket client ──────────────────────────────────────────────────────────
static WebSocketsClient ws;
static bool wsConnected = false;

static void wsSendRaw(const char* json) {
  if (wsConnected) ws.sendTXT(json);
}

static void wsEvent(WStype_t t, uint8_t* payload, size_t /*len*/) {
  switch (t) {
    case WStype_CONNECTED:
      wsConnected = true;
      appState = AppState::RUNNING;
      setLed(false, false, true);   // Green
      Serial.println("[WS] Connected to relay");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      appState = AppState::CONNECTING_WS;
      setLed(false, true, false);   // Blue
      Serial.println("[WS] Disconnected, retrying...");
      break;
    case WStype_TEXT: {
      StaticJsonDocument<128> doc;
      if (deserializeJson(doc, payload) == DeserializationError::Ok) {
        const char* state = doc["state"] | "?";
        Serial.printf("[WS] browser state: %s\n", state);
      }
      break;
    }
    default:
      break;
  }
}

// ── Button debounce + long-press detector ─────────────────────────────────────
struct Btn {
  uint8_t       pin;
  bool          state;        // current level (true = released / HIGH)
  unsigned long pressedAt;
  bool          longFired;
};

static Btn btnRed    = { PIN_BTN_RED,    true, 0, false };
static Btn btnYellow = { PIN_BTN_YELLOW, true, 0, false };
static Btn btnBlue   = { PIN_BTN_BLUE,   true, 0, false };

// Returns: 0 = nothing, 1 = short press, 2 = long press (fires once while held)
static int pollBtn(Btn& b) {
  bool raw = (bool)digitalRead(b.pin);
  if (raw != b.state) {
    b.state = raw;
    if (!raw) {
      b.pressedAt = millis();
      b.longFired = false;
    } else if (!b.longFired) {
      unsigned long held = millis() - b.pressedAt;
      if (held >= BTN_DEBOUNCE_MS) return 1;
    }
  }
  if (!b.state && !b.longFired &&
      millis() - b.pressedAt >= BTN_LONGPRESS_MS) {
    b.longFired = true;
    return 2;
  }
  return 0;
}

// ── AP config portal ──────────────────────────────────────────────────────────
static WebServer     apServer(80);
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
    <input name="pass" type="password" placeholder="leave blank to keep current">
    <label>WebSocket Host (IP or hostname of the Docker machine)</label>
    <input name="wshost" value="%WSHOST%" placeholder="192.168.1.100">
    <label>WebSocket Port</label>
    <input name="wsport" type="number" value="%WSPORT%">
    <label>WebSocket Path</label>
    <input name="wspath" value="%WSPATH%">
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
  html.replace("%SSID%",     cfg.wifiSsid);
  html.replace("%WSHOST%",   cfg.wsHost);
  html.replace("%WSPORT%",   String(cfg.wsPort));
  html.replace("%WSPATH%",   cfg.wsPath);
  html.replace("%PRESENCE%", String(cfg.presenceCm));
  html.replace("%IDLETM%",   String(cfg.idleTimeoutMs / 60000UL));
  apServer.send(200, "text/html", html);
}

static void handleAPSave() {
  String ssid  = apServer.arg("ssid");
  String pass  = apServer.arg("pass");
  if (pass.isEmpty()) pass = cfg.wifiPass;   // keep existing password if blank

  String   wshost  = apServer.arg("wshost");
  uint16_t wsport  = (uint16_t)apServer.arg("wsport").toInt();
  String   wspath  = apServer.arg("wspath");
  uint16_t pres    = (uint16_t)apServer.arg("presence").toInt();
  uint32_t idle    = (uint32_t)apServer.arg("idletm").toInt() * 60000UL;

  if (wshost.isEmpty()) wshost = cfg.wsHost;
  if (wspath.isEmpty()) wspath = cfg.wsPath;
  if (wsport == 0)      wsport = cfg.wsPort;
  if (pres == 0)        pres   = cfg.presenceCm;
  if (idle == 0)        idle   = cfg.idleTimeoutMs;

  saveConfig(ssid.c_str(), pass.c_str(), wshost.c_str(), wsport,
             wspath.c_str(), pres, idle);

  apServer.send(200, "text/html",
    "<html><body style='font-family:sans-serif;text-align:center;padding:40px'>"
    "<h2>Saved! Restarting in 2 seconds...</h2>"
    "<p style='color:#555'>You can close this page.</p>"
    "<footer style='margin-top:40px;font-size:11px;color:#aaa'>"
    "Powered by <a href='https://barmajino.com'>barmajino.com</a></footer>"
    "</body></html>");
  delay(2000);
  ESP.restart();
}

static void startAPMode() {
  ws.disconnect();
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_AP);
  WiFi.softAP("HAICI-Config", "haici1234");

  appState    = AppState::AP_CONFIG;
  apStartedMs = millis();

  Serial.printf("[AP] SSID: HAICI-Config  IP: %s\n",
                WiFi.softAPIP().toString().c_str());
  Serial.println("[AP] Password: haici1234");
  Serial.println("[AP] Open http://192.168.4.1 in a browser to configure");

  apServer.on("/",     HTTP_GET,  handleAPRoot);
  apServer.on("/save", HTTP_POST, handleAPSave);
  apServer.begin();
}

// ── Ultrasonic presence detection ─────────────────────────────────────────────
static unsigned long lastUltrasonicMs = 0;
static unsigned long lastPresenceMs   = 0;
static bool          wasPresent       = false;

static void checkPresence() {
  if (millis() - lastUltrasonicMs < ULTRASONIC_POLL_MS) return;
  lastUltrasonicMs = millis();

  uint16_t dist  = readDistanceCm();
  bool     present = (dist < cfg.presenceCm);

  if (present) {
    if (!wasPresent) {
      unsigned long idleMs = millis() - lastPresenceMs;
      if (idleMs >= cfg.idleTimeoutMs) {
        Serial.printf("[ULTRA] Person detected after %.1f min idle -> presence_detected\n",
                      idleMs / 60000.0f);
        wsSendRaw("{\"type\":\"presence_detected\"}");
      }
      wasPresent = true;
    }
    lastPresenceMs = millis();
  } else {
    wasPresent = false;
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
static unsigned long lastHeartbeatMs = 0;

static void sendHeartbeat() {
  if (millis() - lastHeartbeatMs < HEARTBEAT_MS) return;
  lastHeartbeatMs = millis();
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"type\":\"heartbeat\",\"uptime\":%lu}",
           millis() / 1000UL);
  wsSendRaw(buf);
}

// ── Button handler ────────────────────────────────────────────────────────────
static bool recording = false;

static void handleButtons() {
  int r  = pollBtn(btnRed);
  int y  = pollBtn(btnYellow);
  int bl = pollBtn(btnBlue);

  if (r == 1) {
    Serial.println("[BTN] Red short -> new_session");
    wsSendRaw("{\"type\":\"new_session\"}");
  } else if (r == 2) {
    Serial.println("[BTN] Red long -> AP config mode");
    startAPMode();
    return;
  }

  if (y == 1) {
    if (!recording) {
      recording = true;
      Serial.println("[BTN] Yellow -> start_record");
      wsSendRaw("{\"type\":\"start_record\"}");
    } else {
      recording = false;
      Serial.println("[BTN] Yellow -> stop_record");
      wsSendRaw("{\"type\":\"stop_record\"}");
    }
  }

  if (bl == 1) {
    recording = false;
    Serial.println("[BTN] Blue -> stop_speaking");
    wsSendRaw("{\"type\":\"stop_speaking\"}");
  }
}

// =============================================================================
//  SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[HAICI] Booting...");

  pinMode(PIN_LED_RED,   OUTPUT);
  pinMode(PIN_LED_BLUE,  OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  setLed(true, false, false);       // Red while booting

  pinMode(PIN_BTN_RED,    INPUT_PULLUP);
  pinMode(PIN_BTN_YELLOW, INPUT_PULLUP);
  pinMode(PIN_BTN_BLUE,   INPUT_PULLUP);

  pinMode(PIN_ULTRASONIC_TRIG, OUTPUT);
  pinMode(PIN_ULTRASONIC_ECHO, INPUT);
  digitalWrite(PIN_ULTRASONIC_TRIG, LOW);

  loadConfig();

  if (strlen(cfg.wifiSsid) == 0) {
    Serial.println("[HAICI] No WiFi configured -> entering AP mode");
    startAPMode();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfg.wifiSsid, cfg.wifiPass);
  Serial.printf("[WiFi] Connecting to \"%s\"...\n", cfg.wifiSsid);
}

// =============================================================================
//  LOOP
// =============================================================================
static bool wsPending = false;

void loop() {

  // AP config portal mode
  if (appState == AppState::AP_CONFIG) {
    apServer.handleClient();
    setLed(millis() % 1000 < 500, false, false);   // blink red
    if (millis() - apStartedMs > AP_TIMEOUT_MS) {
      Serial.println("[AP] Timeout -> rebooting");
      ESP.restart();
    }
    return;
  }

  // Buttons always polled, even while connecting
  handleButtons();

  // WiFi watchdog
  if (WiFi.status() != WL_CONNECTED) {
    if (appState != AppState::CONNECTING_WIFI) {
      appState  = AppState::CONNECTING_WIFI;
      wsPending = false;
      setLed(true, false, false);   // Red
      Serial.println("[WiFi] Lost connection, waiting...");
    }
    return;
  }

  // WiFi just connected -- kick off WS once
  if (!wsPending) {
    wsPending = true;
    appState  = AppState::CONNECTING_WS;
    setLed(false, true, false);   // Blue
    ws.begin(cfg.wsHost, cfg.wsPort, cfg.wsPath);
    ws.onEvent(wsEvent);
    ws.setReconnectInterval(WS_RECONNECT_MS);
    Serial.printf("[WS] Connecting to ws://%s:%d%s\n",
                  cfg.wsHost, cfg.wsPort, cfg.wsPath);
  }

  ws.loop();   // must be called every iteration when WiFi is up

  if (!wsConnected) return;

  // Fully connected
  checkPresence();
  sendHeartbeat();
}
