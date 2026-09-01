# Camera module — OpenCam, and the tablet kiosk

Status: OpenCam is cloned to `C:\Users\USER\Desktop\opencam` and adapted to run on
this Windows machine. This document records what it gives us, what had to change
to run it here, and how it fits the plan to collapse the ESP32 peripherals into a
single tablet.

---

## 0. Where this stands

**Running and verified end-to-end**

- Backend and frontend containers up and healthy. `GET /api/config` reports all
  five stages loaded: objects, faces, face recognition, emotion, OCR.
- Headless pipeline test passes (`tools/smoke_publish.py`): WHIP negotiated,
  523 inference frames, OCR read `opencam` off a synthetic frame, telemetry sane.
- `/opencam` proxy verified for **both** transports: `GET /opencam/api/config`
  returns the backend's config, and `ws://…/opencam/ws/<id>` upgrades (`server:
  uvicorn` in the response proves it reached the backend, not Vite).
- Vision metadata verified reaching a client **at the kiosk origin**: 70
  inference frames through the Vite proxy while the publisher ran.
- `usePresence` / `useVision` wired into `App.tsx`; `tsc --noEmit` clean.
- Detector disabled after measurement (see §4) — 51 ms end-to-end, 21.4 fps.

**The tablet works. End-to-end, over the LAN, over TLS.**

A tablet at `https://192.168.0.104:5173` pressing *Begin Conversation* publishes
to the vision backend and is recognised as a person:

```
publishing: true   source: webrtc   has_audio: true
frames in 8s: 125          people: 1        faces: 1
distance: 0.65 m (ipd)     emotion: Neutral / Happy / Sad / Surprised
end_to_end_ms: 81          capture 30 fps, inference 20.3 fps
```

That single result validates the whole chain at once: TLS on a LAN IP, camera
and mic permission on a non-localhost origin, WHIP signalling through the
`/opencam` Vite proxy, and — the part that could not be reasoned about — **WebRTC
media from a device on the LAN into the Docker VM, with no TURN relay.**

**Browser → VM ICE: confirmed working, no TURN needed**

Tested from Chrome on the host at <http://localhost:5273>: video flows and boxes
track a real face. This was the one claim that could not be verified from inside
Docker — every automated test above has both peers in the VM — and it settles the
open question in §2. Bridge networking on Docker Desktop does **not** need the
coturn relay upstream's README calls for, because ICE only needs one direction to
get through and the browser's candidates are reachable from the VM.

**Found by testing, not by reading: `"Unknown"` is a string**

An unmatched face comes back with `name: "Unknown"`, not `name: null`
(`pipeline/face_matcher.py:238`; the backend guards against the same sentinel in
`pipeline/people.py:109`). `useVision` originally took `name` at face value,
which would have greeted a stranger as *"Hello! I'm Unknown."* and — less
visibly but worse — made `hasUnidentifiedFace` permanently false, so a wake
would never have waited for a real identity to resolve. Normalised in
`identityOf()`. Live output is the only thing that would have caught this.

**Face recognition, measured**

One reference photo (`faces/Mariam_Badawi.jpeg`), subject at ~0.75 m on the
tablet:

```
match rate:  111/111 frames with a face (100%)
similarity:  min 0.393   median 0.536   max 0.676   (threshold 0.363)
```

Then the same person, same session, a few minutes later — **while smiling**:

```
match rate:  2/44 frames with a face (5%)
similarity:  min 0.094   median 0.295   max 0.373
```

Recognition collapsed. The reference photo is a neutral expression, and a smile
moves the SFace embedding far enough that the median similarity falls *below*
the 0.363 threshold. Nothing was wrong with the setup: this is what one
reference photo buys.

So the margin in the good run — a floor of 0.393 against a 0.363 threshold — was
not comfortable, it was luck about expression. **The fix is 3–4 reference photos
covering a neutral face, a smile, and normal lighting variation**, not a lower
threshold: lowering it would recover this smile by making a stranger's face
likelier to match too. Every photo becomes its own gallery entry and the best
match wins, so more photos raise the floor without touching the false-match
rate.

This is also a warning about how greet-by-name will behave in the building.
Someone walking up cheerfully is exactly the person the kiosk will fail to
recognise, and it will do so silently by greeting them as a stranger.

**Emotion is too noisy to use raw.** Five different labels in ten seconds from a
subject who was not doing anything dramatic — `Disgust`, `Neutral`, `Sad`,
`Surprised`, `Thinking`. Smooth it over a window (majority vote across ~2 s)
before it drives the mascot or reaches the agent, or it will read as a nervous
tic rather than an expression.

**Two tuning notes from the same run**

- OCR returned `['1', 'ape', 'toe']` off an ordinary room: noise read as words.
  Raise `OCR_MIN_CONF` above the 0.5 default before anything acts on OCR text.
- Distance read 0.65 m for someone holding a tablet, which is plausible but
  uncalibrated. Do the `CAMERA_HFOV_DEG` calibration before the 1.5 m wake
  threshold means anything.

**Also still to do**

- Calibrate `CAMERA_HFOV_DEG` (see §5) before trusting any distance, including
  the 1.5 m wake threshold.
- Set `features.camera = true` in `branding/branding.json` to turn any of this
  on; it ships off.
- Drop reference photos into `opencam/faces/` for greet-by-name.

**Running it**

```bash
cd /c/Users/USER/Desktop/opencam
docker compose -f docker-compose.yml -f docker-compose.windows.yml up -d
curl -s localhost:8080/api/config          # which stages loaded
```

Dashboard: <http://localhost:5273> (5173 belongs to the haici web container).

Headless pipeline test — no browser, no camera, nothing installed on the host.
Run it from PowerShell, not Git Bash, which mangles the container-side path:

```powershell
docker compose -f docker-compose.yml -f docker-compose.windows.yml run --rm --no-deps -v "C:\Users\USER\Desktop\opencam\tools:/tools:ro" --entrypoint python backend /tools/smoke_publish.py http://backend:8080
```

**Earlier build notes (kept — they explain the local diffs)**

- Repo reviewed; cloned to `C:\Users\USER\Desktop\opencam`.
- `docker-compose.windows.yml` written — bridge networking instead of upstream's
  Linux-only `network_mode: host`. `docker compose config` validates.
- Dashboard moved to `:5273` (the haici `web` container already owns `:5173`);
  backend on `:8080`.
- `backend/Dockerfile` made survivable on a slow link (pip cache mounts,
  conditional build toolchain, retries). Wheels-only resolution verified with
  `pip --only-binary=:all: --dry-run`.
- `opencam-frontend:1.0.0` image built.
- **The `useHardware` wss bug is fixed and tested** (§3 below) — independent of
  OpenCam, and it was blocking the whole tablet plan.

---

## 0b. Telling the agent who it is looking at

Recognising a face is not the same as the agent knowing you. Until this was
wired, the camera resolved an identity and nothing downstream could see it: the
name only ever appeared inside the greeting *text*, so "who am I" was answered
by an agent that had never been told.

**Frontend.** Every turn now carries `visitor: { name, emotion }`
(`lib/api.ts`), read at send time via a ref rather than captured when the hook
mounted — identity resolves seconds *after* a conversation starts, so a value
captured at mount is always stale. The key is omitted entirely when the camera
sees nobody, so its presence means "the kiosk can see someone right now".

**Workflow** (`Agent Workflow`, id `d8nftRI2zhutW98L`, backed up to
`agent_workflow_backup_pre_visitor_*.json` before any edit):

- `Set userText (Text)` / `(Audio)` carry `body.visitor.name` forward, both
  reading it from the Webhook node — on the voice path `$json` is the STT
  transcript by then, so reading `$json.body` there would silently yield
  nothing.
- `AI Agent` receives it as a marked `[kiosk camera: ...]` line, with a system
  rule saying that line is trusted camera output rather than user-typed text,
  and that **with no such line it cannot see anyone and must not guess a name**.
- `Normalize & Hash Question` keys the Redis cache per visitor whenever a
  visitor is known.

### The cache was the dangerous part

The cache key was the question text alone. Once the agent could say "you are
Mariam", that answer would be stored under `hash("who am i")` and replayed to
the next person who asked — the kiosk telling a stranger they are someone else.

The first fix keyed only *personal* questions per visitor, and testing killed
it immediately: asked "when was IUL established", the agent replied **"Hello
Mariam, the Islamic University of Lebanon was established in 1996"** — a
personalised answer to an impersonal question, cached under the shared key. The
agent greets people it recognises, so **any** answer produced while it knows a
name may contain that name.

So the rule is now: a visitor being known at all makes the entry per-visitor.
Unrecognised visitors — the common case at a public desk — still share one
entry per question, so hit rate is unaffected for them. The 54 cache entries
written before the fix were flushed.

Verified end to end against the live webhook:

| Case | Result |
| --- | --- |
| Mariam asks "who am I" | "Hello Mariam, you are Mariam Badawi." |
| Ali asks the same | "Hello, Ali Jaafar." — no leak |
| No camera, same question | "I do not recognize you." — no guess |
| Mariam asks an FAQ | answered, personalised |
| **Stranger asks that same FAQ** | **"IUL was established in 1996…" — no Mariam** |

### Two operational notes

- **`n8n import:workflow` deactivates the workflow.** It printed
  `Deactivating workflow "Agent Workflow"` and the webhook went dead until
  `POST /api/v1/workflows/{id}/activate`. Always reactivate and re-test after
  an import.
- **The public API cannot be used for this workflow.** `PUT /workflows/{id}`
  rejects `settings.binaryMode` (`must NOT have additional properties`), and
  that setting is real — n8n-core reads it in `binary-helper-functions` — so a
  PUT would silently drop it from a workflow that carries recorded audio. The
  CLI import preserves the whole object; use it.

### Still open here

`emotion` reaches the workflow but is not yet in the prompt. It was left out
deliberately: the classifier is noisy (§4), and an agent told "this person looks
sad" on weak evidence will say something strange. Wire it only with the
smoothed value and a soft instruction.

---

## 1. What the module actually is

`barmajino-official/opencam` is a **WebRTC computer-vision service**, not a camera
driver. The camera stays in the browser; the browser publishes its stream to a
Python backend over WebRTC, and the backend streams back JSON — one message per
inference pass, roughly 15–25 per second.

```
tablet browser ──── WebRTC video ────▶ FastAPI + aiortc
      │                                   ├─ YOLOv8n      → objects (80 classes)
      │                                   ├─ YuNet+SFace  → who it is
      ◀─── JSON over WebSocket ───────────┼─ MobileFaceNet→ emotion
                                          ├─ PP-OCRv3+CRNN→ text in frame
                                          └─ pinhole      → distance in metres
```

Two properties make it a good fit for us rather than a science project:

- **Nothing runs on the host.** Two containers, all five ONNX models baked into
  the image at build time. No pip, no model downloads at runtime.
- **It is a library, not just a dashboard.** `@opencam/client` is a TypeScript
  SDK with React bindings. The dashboard is one consumer of it; our kiosk app can
  be another, without adopting any of their UI.

The API surface we care about:

```ts
cam.get('people')    // [{ id, name, distance_m, emotion, box, has_face }]
cam.get('distance')  // metres to the nearest person, or null
cam.get('text')      // OCR lines as plain strings
cam.on('person:enter', p => …)   // stable tracking id appears
cam.on('person:leave', p => …)   // …and is retired after a miss budget
cam.on('face:known',   p => …)   // a face matched a photo in faces/
```

`person:enter` / `person:leave` are the events the wake logic is built on. They
come from a real tracker (IoU + centroid with a miss budget), so an id survives
the dropped frames the pipeline is designed to tolerate — a person does not
"re-enter" every time inference skips a frame.

---

## 2. Why it did not run here as-is

The upstream compose is written for a Linux host and says so. Two things had to
change; both are in **`docker-compose.windows.yml`** in the opencam clone, so the
upstream file is untouched and the friend's repo can still be pulled cleanly.

### `network_mode: host` does not mean what it means on Linux

Upstream puts both services on the host network deliberately: aiortc advertises
ICE candidates from the interfaces it can see, and inside a bridge network those
are unreachable `172.x` addresses.

On Docker Desktop the containers live in a Linux VM, so "the host network" is the
**VM's** network. A backend binding `127.0.0.1` would be listening on the VM's
loopback, which nothing on Windows can reach. The override puts both services
back on a bridge network with published ports.

Upstream's README says bridge mode needs a TURN relay. That is only half true,
and the other half is why this works without coturn: **ICE only needs one
direction to get through.** The browser's own host candidates are reachable from
inside the VM, so aiortc's connectivity checks land, the browser learns a
peer-reflexive candidate from them, and that pair gets nominated. The `172.x`
candidates the browser cannot reach simply fail and are discarded.

One caveat worth knowing: Chrome hides local IPs behind mDNS `.local` candidates
for pages that have *not* been granted camera permission. Once you click Allow,
real host candidates appear and the pair forms. A page that only watches and
never publishes can therefore be slower to connect than the publisher.

### Port 5173 was already ours

The haici `web` container publishes 5173. OpenCam's dashboard wants the same
port, so it now sits on **`http://localhost:5273`**, set in the opencam `.env`.
The backend is on **`127.0.0.1:8080`**, which was free.

### The build does not survive this internet connection unmodified

The backend image build failed twice, both times in the same way and neither time
because of anything in the code: DNS resolution inside the build sandbox dropped
partway through (`Could not resolve 'deb.debian.org'`, `Name or service not
known` for PyPI) during a stretch where the link was running at 130–230 kB/s. The
build needs to pull ~195 MB of CPU Torch, ~74 MB of Debian toolchain and a
~74 MB pandas wheel, and upstream uses `--no-cache-dir` throughout — so **every
failed attempt restarted every download from zero**, which on this link is an
hour thrown away each time.

Three changes to `backend/Dockerfile` in the clone (uncommitted, so
`git diff` in that repo shows exactly what differs from the friend's version —
worth sending back to him, since none of it is Windows-specific):

1. **BuildKit pip cache mounts** instead of `--no-cache-dir`, so a retry resumes
   from what already downloaded. Cache mounts are not part of the image, so the
   final image size is unchanged.
2. **The 74 MB build toolchain is now installed only if it is needed.** Upstream
   installs `build-essential` unconditionally so that pip *can* fall back to a
   source build of aiortc. The wheels-only install is now tried first, and the
   toolchain download happens on the failure path. Verified rather than assumed:
   `pip install --only-binary=:all: --dry-run -r requirements.txt` resolves the
   whole set on cp311 — aiortc, av, pylibsrtp and cryptography included — so on
   this machine that download was being paid for nothing, and it was the single
   most failure-prone step in the build.
3. `--retries 10 --timeout 120` on pip, `-o Acquire::Retries=10` on apt.

### Also worth knowing on Windows

`device:///dev/video0` server-side ingest — where the backend opens a camera
itself instead of receiving one over WebRTC — **cannot work here.** Docker
Desktop cannot pass a USB webcam through to the VM. This is not a limitation we
care about: in every design below the *browser* owns the camera and publishes it,
which is the path upstream recommends anyway.

---

## 3. The tablet kiosk

The goal: one iPad or Android tablet replaces the separate camera, microphone,
speaker and screen. The PC stays the server and runs everything.

```
        TABLET (kiosk)                    PC (server, Docker)
   ┌───────────────────────┐         ┌──────────────────────────────┐
   │ haici web app         │────────▶│ vite :5173 ── n8n ── whisper │
   │  • mic  → STT         │  HTTPS  │            └─ piper ─ ollama  │
   │  • speaker ← TTS      │         │                              │
   │  • screen: mascot     │         │ opencam backend :8080        │
   │  • camera → OpenCam   │◀───────▶│  (WebRTC + JSON)             │
   └───────────────────────┘  WebRTC └──────────────────────────────┘
              ▲
              │ ws — presence, buttons
   ┌──────────┴────────────┐
   │ ESP32: ultrasonic,    │
   │ buttons, status LEDs  │
   └───────────────────────┘
```

The ESP32 does **not** go away. It keeps the ultrasonic sensor, the buttons and
the status LEDs; the tablet takes over camera, mic, speaker and display.

### The three things that have to be true

**1. One origin, served over HTTPS.** `getUserMedia` — camera *and* microphone —
requires a secure context. `http://localhost` counts; `http://192.168.1.x` does
not. The moment the UI moves off the kiosk machine to a tablet, TLS stops being
optional *for the microphone we already use*, before the camera is even
considered.

The repo already anticipates this: `web/vite.config.ts` loads
`@vitejs/plugin-basic-ssl` when `VITE_HTTPS=1`. That gives a self-signed cert,
which the tablet must be told to trust once (an iPad needs the cert installed as
a profile *and* switched on under Settings → General → About → Certificate Trust
Settings; Android Chrome can instead be pointed at `chrome://flags` →
*Insecure origins treated as secure*).

**2. OpenCam must be behind the same origin.** An HTTPS page cannot call
`http://192.168.1.x:8080` — mixed content is blocked outright, and so is `ws://`.
Rather than give OpenCam its own certificate, proxy it through the Vite server we
are already serving, exactly as `/webhook` is proxied to n8n today:

```ts
// web/vite.config.ts
"/opencam": {
  target: "http://opencam-backend:8080",
  ws: true,
  rewrite: (p) => p.replace(/^\/opencam/, ""),
}
```

The SDK takes a base URL and appends `/api/…` and `/ws/…` to it, so
`new OpenCam({ url: location.origin + "/opencam" })` lands on the right routes
with no CORS, no second certificate, and no LAN exposure of an unauthenticated
camera API. The prefix also sidesteps a real collision: `/api` on the haici
origin already belongs to the Bun branding sidecar.

Note this proxies **signalling only**. The media itself is direct UDP from the
tablet to the backend — which is the one part of this that has to be proven on
real hardware rather than reasoned about.

**3. `useHardware` broke over HTTPS — fixed.** `web/src/hooks/useHardware.ts`
dialled the ESP32 relay directly at `ws://<host>:3001`, upgrading to `wss:` when
the page is HTTPS. The Bun relay serves plain WebSocket with no TLS, so on an
HTTPS tablet page that connection failed and **every hardware trigger — the
ultrasonic sensor and all three buttons — went dead**, with no visible symptom
beyond a reconnect loop. Pre-existing, and invisible until the UI leaves the
kiosk machine.

It now connects same-origin to `/hw-ws`, proxied to the relay by Vite with
`ws: true`, so the relay inherits the page's certificate and a tablet has
nothing extra to trust. The ESP32 is unaffected: it still dials
`ws://<pc>:3001/ws` over the LAN, where no TLS is required.

The old comment in that file justified dialling directly on the grounds that the
Vite proxy "does not reliably forward WS frames for a custom backend". That does
not hold on Vite 5.4.21 — verified three ways: the upgrade returns
`101 Switching Protocols`, a `presence_detected` frame sent by a hardware client
arrives at a browser client through the proxy, and the same test passes against
`wss://` with `VITE_HTTPS=1`, which is the case that was actually broken.

Deliberately no `rewrite` on the proxy entry: `ws-server.ts` upgrades any path
that is not an `/api/branding` route, so `/hw-ws` connects as-is. That avoids
depending on whether Vite applies path rewrites to upgrade requests, which is
the fragile part of proxying a websocket.

---

## 4. Two wake triggers, one wake

The camera is a **second** way to notice someone, not a replacement for the
ultrasonic sensor. The two disagree in useful ways:

| | Ultrasonic (HC-SR04) | Camera (OpenCam) |
|---|---|---|
| Answers | "something is within N cm" | "a *person* is at D metres, and it's Ali" |
| Latency | ~60 ms | ~200 ms |
| In the dark | works | fails |
| False positives | a chair, a cart, a passing bag | rare |
| False negatives | someone off to the side | someone backlit or side-on |
| Knows you left | no — only a timeout | yes, `person:leave` |
| Privacy | none | it is a camera |

Neither is a superset of the other, which is exactly why fusing them is worth
doing rather than picking one.

### Where the fusion lives

In the **browser**, not the firmware and not n8n. Both signals already arrive
there — the ultrasonic over the `:3001` relay, the camera metadata over the
OpenCam socket — and the browser is what owns the session. One hook,
`usePresence`, replaces the direct `presence_detected → onNewSession()` wire in
`useHardware.ts`.

### The rules

**Either sensor can arm; only one wake fires.** A single cooldown (the existing
`IDLE_TIMEOUT_S = 180` is the natural starting value) covers both sources, so a
person who trips the ultrasonic *and* is seen by the camera is greeted once.

**Camera confirms, ultrasonic doesn't wait.** If the ultrasonic fires and the
camera confirms a person within ~1.5 s, wake immediately and confidently. If the
ultrasonic fires and the camera is *running and sees nothing*, treat it as an
object and stay asleep — this is the single biggest win, because it kills the
cart-and-chair false positives that make a kiosk look broken. If the camera is
unavailable (dark room, tablet asleep, backend down), fall back to trusting the
ultrasonic alone. **Degrading to today's behaviour must be the failure mode.**

**The camera can wake on approach, earlier.** `distance_m` falling across
consecutive frames means someone is walking up, which is a better greeting moment
than the instant they cross a fixed ultrasonic threshold. Wake at ~1.5 m and
closing.

**Greet by name when we can, but never wait for it.** Hold the generic greeting
for a short grace window (~1.2 s) after wake; if `face:known` lands inside it,
greet by name instead. If not, greet generically and let recognition arrive late
— it can still personalise the *next* turn.

**`person:leave` ends the session.** Today a conversation dies on a 180-second
timeout, so the next person walks up to someone else's transcript on screen. When
the camera has seen the last person leave and stay gone for ~10 s, reset. This is
a genuinely new capability, not an optimisation.

### What the other capabilities feed

- **Emotion** → the mascot's `Emotion` prop (the renderer already takes one), and
  optionally a hint on the n8n turn so the agent can soften its tone. Worth being
  sceptical here: the model has seven classes and "Thinking" is a *derived*
  heuristic, flagged `derived: true` in the payload. Treat it as a nudge, never
  as fact about a person.
- **OCR** → "hold your paper up to the camera." `cam.get('text')` on demand,
  sent as the turn's text. This is the capability with the clearest standalone
  value for a university reception desk (a student holding up a form or an ID).
- **Distance** → besides waking, it tells us whether to speak at all. Nobody
  within 3 m means nobody to talk to.

### What this costs — measured on this machine

Three configurations, same synthetic 640×480 @ 30 fps publisher, 8 cores shared
with the running haici stack (n8n, Postgres, Redis, Qdrant, Whisper):

| Config | end-to-end | inference | fps | dropped |
| --- | --- | --- | --- | --- |
| Upstream defaults (`WORKERS=4 THREADS=2 OCR_N=6`) | 166 ms | 152 ms | 6.7 | 580/721 |
| `WORKERS=2 THREADS=3 OCR_N=12` | 216 ms | 204 ms | 5.1 | 567/712 |
| **`WORKERS=4 THREADS=2 OCR_N=12`, detector OFF** | **51 ms** | **45 ms** | **21.4** | 215/739 |

Two things fall out of this, and the first corrects an earlier guess in this
document.

**Trading workers for threads made it worse, not better.** The reasoning was
that `MAX_WORKERS × INFERENCE_THREADS` should stay under the core count, so
2 × 3 should beat 4 × 2. Measured, it is 30% slower on every axis. The pool is
shared between the fast path and OCR, so starving it of workers costs more than
the extra threads win — `ocr_ms` alone went from 325 ms to 503 ms. Upstream's
defaults are better than my arithmetic was.

**The object detector costs about 115 ms and two thirds of the frame rate.**
Turning it off takes the pipeline from 166 ms to 51 ms and from 6.7 to 21.4
inference passes per second — comfortably inside the 150 ms budget, with several
cores handed back to Whisper, which is on the critical path of every spoken turn.
This reproduces upstream's own claim rather than taking it on faith.

`DETECTOR_ENABLED=0` is therefore what the kiosk runs, and it is a supported
configuration: `build_people()` in `pipeline/people.py` explicitly handles a face
with no body box, so `people`, `person:enter/leave`, distance and emotion all
keep working.

**But it changes who gets seen.** With YOLO off, a person exists only if a face is
detected. Someone approaching side-on, looking down at their phone, or turned
away produces *no* person record at all. That is precisely the case the
ultrasonic sensor covers — which is the strongest argument for the two-sensor
design, and the reason the camera must never be allowed to veto a sensor pulse
when it is not actually live.

Turn the detector back on if the kiosk ever needs to notice people who are not
facing it, and accept ~166 ms.

---

## 5. Open items

- **Distance is uncalibrated.** Every estimate scales linearly with
  `CAMERA_HFOV_DEG` (default 60). Sit at a measured 1.00 m, read
  `cam.get('distance')`, and correct once. Until then distances are a ratio, not
  a measurement — and the wake threshold depends on them.
- **`faces/` is biometric data.** Plain image files on the PC, gitignored and
  mounted read-only, but that is a policy question for a university deployment
  before it is a technical one.
- **The backend is unauthenticated by default.** Fine while it is bound to
  loopback. The moment anything is widened, `OPENCAM_API_TOKEN` is not optional —
  the same endpoint that accepts a camera also accepts an ingest URL.
- **`INGEST_ENABLED=0` is the right setting for us.** We publish from the
  browser and never pull RTSP, so the SSRF surface upstream documents at length
  can simply be switched off.
