# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A self-hosted local AI agent stack defined by `docker-compose.yml`, plus a React/TypeScript web UI in `web/`. The compose file orchestrates n8n (workflows), Qdrant (vectors), Ollama (LLM), Whisper (STT), Piper (TTS), and the `web` service (Vite + Bun). The `n8n_local_data/` directory holds n8n's SQLite DB and stored workflows/credentials; treat it as runtime state, not source. `shared_docs/` is curated input for workflows.

## JS/TS tooling: Bun, in Docker only

**Never run `npm`, `node`, `bun`, or `npx` on the host.** All JS/TS work goes through the `web` Docker service (built from `web/Dockerfile`, image `oven/bun:1-alpine`). To install a new dependency, edit `web/package.json` and rebuild: `docker compose build web`. To run one-off commands: `docker compose run --rm web bun <cmd>`.

## Common commands

```bash
docker compose up -d              # start the whole stack
docker compose down               # stop (data persists in ./*_data dirs)
docker compose logs -f n8n        # tail a specific service
docker compose restart n8n        # restart one service after env changes
docker compose pull && docker compose up -d   # upgrade images

# pull a model into the ollama container (must be done after first start)
docker exec -it ollama ollama pull <model-name>
```

Service endpoints (host ports):
- Web UI: http://localhost:5173
- n8n UI: http://localhost:5678
- Qdrant: http://localhost:6333
- Ollama: http://localhost:11435  (note: remapped from container's 11434)
- Whisper (OpenAI-compatible STT): http://localhost:8000
- Piper (TTS): http://localhost:5500

## Architecture

n8n is the orchestrator; the other four services are sidecars it calls by **container name** over Docker's default network (not via the host ports above). When wiring nodes inside n8n use these internal URLs:

- `http://ollama:11434` — LLM inference (also exposed to n8n as `OLLAMA_HOST` env var)
- `http://qdrant:6333` — vector store
- `http://whisper:8000` — speech-to-text, OpenAI-compatible `/v1/audio/transcriptions`
- `http://piper:5000` — text-to-speech, POST raw text → WAV

n8n's `depends_on` ensures sidecars start first, but Docker does **not** wait for them to be healthy — workflows that fire on container startup may need a retry.

### Filesystem sandbox

`N8N_RESTRICT_FILE_ACCESS_TO=/shared_docs` confines n8n's file nodes to that single path, which is bind-mounted from `./shared_docs/`. Drop documents the workflows need to ingest there; do not widen this restriction without a reason — it's the main containment boundary for workflow code that may come from imported templates.

### GPU

Ollama is configured to reserve one NVIDIA GPU (`deploy.resources.reservations.devices`). On a host without nvidia-container-toolkit this block makes `docker compose up` fail — comment it out for CPU-only machines.

### Persistence layout

Each service has a host-bind volume at `./<service>_data/`. `piper_data/` and `whisper_data/` are owned by root (created by their containers); needs `sudo` to clean up. Deleting `n8n_local_data/` wipes all workflows and credentials.

## Web UI (`web/`)

A Vite + React 18 + TypeScript + Tailwind app. Key shape:

- **`hooks/useChat.ts` is the single source of truth for chat state.** It owns sessions (persisted to `localStorage`), the active session id, pending state, the toast, and the retriability set. There is one in-flight `AbortController` — sending a new message cancels the previous one. The hook is the only place `dispatch()` lives.
- **Retry survives reloads.** Text messages cache `originalText` on the message itself; voice recordings get stored in IndexedDB keyed by message id (`lib/audioStore.ts`). On boot, `useChat` hydrates the `retriable` Set from both sources, so the Retry button on a failed message works even after a page refresh.
- **`ErrorBoundary` and `HealthBanner`.** `main.tsx` wraps `<App>` in `ErrorBoundary` so a render crash shows a recovery screen instead of a blank page. `App.tsx` runs `checkHealth()` on mount and shows an amber banner at the top whenever the n8n webhook is unreachable or the workflow is inactive.
- **State machine for the avatar** lives in `web/src/App.tsx` and resolves a single `FaceState` (`idle | listening | thinking | speaking`) from the union of TTS/STT/pending booleans. Whichever renderer is active (see § The avatar) reads that one prop plus an `amplitude` 0..1 driven by a WebAudio AnalyserNode tap on the playback element — that's where the lip-sync comes from. When TTS is off, `App.tsx` synthesises the envelope from the reply's length instead, so the mouth still moves on text-only turns.
- **The frontend ONLY talks to the n8n webhook.** It does not call Whisper or Piper directly — the workflow handles STT and TTS internally and returns audio as `audioBase64`. The only env var that matters is `VITE_N8N_WEBHOOK_URL` (default `/webhook/rag-agent` — relative).
- **CORS is sidestepped via a Vite reverse-proxy.** `web/vite.config.ts` proxies `/webhook/*` to `http://n8n:5678/webhook/*` over the Docker network. The browser only ever talks to `localhost:5173`, so the request is same-origin and CORS never gets a vote. If a turn fails with "Could not reach the workflow through the Vite proxy", the web container can't resolve `n8n:5678` — usually fixed by `docker compose up -d --force-recreate web`.
- **Two request shapes** to the same webhook:
  - **Text turn:** `POST application/json` with body `{ sessionId, text, wantsAudio }`. The workflow's `Set userText (Text)` node reads `body.text`.
  - **Voice turn:** `POST multipart/form-data` with `file` (the recorded blob), `sessionId`, and `wantsAudio` as form fields. n8n exposes the first binary file as `$binary.data0`, which the workflow's Switch routes through Whisper.
- **Response shape** (JSON): `{ answer, question?, audioBase64?, audioMime? }`. `question` is the Whisper transcript on voice turns and replaces the placeholder bubble in the UI. When `wantsAudio:true`, the workflow's Piper node fills `audioBase64`.
- **The workflow must be Active.** `/webhook-test/rag-agent` only listens for one call per Listen click; subsequent calls succeed in n8n's execution history but the HTTP response never reaches the browser (it surfaces as `NetworkError when attempting to fetch resource`). Toggle the workflow Active in n8n and use `/webhook/rag-agent`.
- **Sessions** are stored in `localStorage` only (see `web/src/lib/storage.ts`). No server-side persistence — clearing site data wipes them. The voice retry cache is in-memory only; reloading the page disables Retry on already-failed voice messages.
- **Branding is runtime config, not code.** Nothing in `web/src` names a client. See § White-labelling below.

## White-labelling

The frontend is sold to different businesses, so every visual detail is data rather than source. There is one tenant document — `branding/branding.json`, bind-mounted to `/app/branding` in the `web` container — covering identity (name, kicker, tagline, logos, favicon, footer credit), theme (brand/neutral/warn/surface colours, light or dark, fonts, corner radius), avatar (2D mascot, 3D model, still image, or none), feature switches (voice, avatar, landing, admin, sidebar) and the brand-bound copy (input placeholder, starter prompts).

- **Edited from the UI.** `#/admin` → Branding tab. Changes preview live against the running app and only hit disk on Save. Non-technical staff never touch a file or trigger a rebuild.
- **Served by the Bun sidecar.** `web/ws-server.ts` handles `GET/PUT /api/branding` plus asset upload at `/api/branding/asset/<slot>`; Vite proxies `/api/*` to it so the browser stays same-origin, exactly as it does for `/webhook`. Set `ADMIN_PASSCODE` in `docker-compose.yml` — without it, branding writes are unauthenticated.
- **Theming works by redefining Tailwind's scales.** `tailwind.config.js` points `teal`→brand, `slate`→neutral and `amber`→warn at CSS variables, and `src/lib/branding/theme.ts` writes those variables from the config. An existing `bg-teal-600` therefore retargets itself with no rebuild and no edit — which is why ~140 colour utilities did not have to be rewritten. Full tint/shade ramps are generated from a single hex (`branding/color.ts`), and dark mode is the neutral ramp inverted, so no `dark:` variants exist anywhere.
- **Prefer the semantic names in new code:** `bg-brand-600`, `text-neutral-500`, `bg-surface`, `text-on-brand`, `text-warn-700`. Never write a raw hex or `bg-white` in a component — it will not follow the tenant's theme. Charts are the one exception: Recharts emits colours as SVG attributes where `var()` never resolves, so they read computed values via `chartColors()` in `components/admin/ui.tsx`.
- **Do not add `transition: all`.** Chrome will not re-resolve a transitioning property when the custom property behind it changes, leaving elements stuck on the previous tenant's colours. Enumerate the properties instead; `theme.ts` also freezes transitions across a theme swap.
- Config resolves before the first React render (`main.tsx`), so components read it synchronously via `useTenant()` — there is no loading state. A missing or malformed file degrades to neutral defaults rather than a blank screen.
- Browser storage keys are tenant-scoped through `lib/branding/scope.ts`, so two tenants can share an origin without reading each other's conversations.

## The avatar

`avatar.kind` picks one of four renderers, all driven by the same
`(state, amplitude, emotion)` triple so the app shell is agnostic:

- **`mascot`** — `components/Mascot2D.tsx`, the supplied HAICI character. This is what the IUL tenant runs.
- **`glb`** — `components/Avatar3D.tsx`, any GLB with ARKit/Oculus blendshapes.
- **`image`** — a still from `avatar.imageUrl`.
- **`none`** — the panel is dropped.

`FaceState` and `Emotion` both live in `web/src/types.ts`; a new avatar renderer should import from there, never from a sibling renderer.

### Mascot assets are generated, not hand-made

`web/public/mascot/` and `web/src/lib/mascotRig.ts` are **build output** from `tools/build_mascot_assets.py`, which flattens the vendor "HAICI Mascot Animation Asset Pack" (unzip it anywhere and pass `--pack`). Do not hand-edit either — change the script and rerun:

```bash
python tools/build_mascot_assets.py --pack /path/to/HAICI_Mascot_Animation_Asset_Pack
```

Things worth knowing before touching it:

- The pack mixes three canvas registrations. Only `source/PSD_Layers/SVG/` is on the 2000x3200 master; the isolated parts under `assets/svg/head/` are anchor-centred and **cannot** be composited by position. Face overlays (eyes/brows/mouths/marks) are a clean 1024x1024 drop-in at master `(488, 290)`.
- Every pack SVG carries a byte-identical `<defs>`. That is the only reason layer bodies can be concatenated without id collisions — check it still holds if a new pack arrives.
- Registration and pivots are read from the pack's rig JSON and emitted to `mascotRig.ts`. Never retype those numbers into the TSX.
- `Mascot2D` animates through one `requestAnimationFrame` loop writing styles directly, reading props via a ref. Do not convert it to React state — it runs at 60fps.
- The mascot keeps its own palette on purpose. It is supplied artwork like a logo, so it is the one component exempt from "never write a raw colour"; retinting it would break the brand it belongs to.
- The root element carries `aspect-ratio`, so callers must constrain exactly one axis (`h-full` for the `full` crop, `w-full` for `head`). Pinning both stretches the artwork.

## Domain context

`iul.txt` and `shared_docs/` contain reference material about the **Islamic University of Lebanon (IUL)** — this stack appears to be a university-project assistant whose workflows answer questions grounded in those documents. Preserve the content of `shared_docs/` unless explicitly told otherwise; it is workflow input, not scratch space.
