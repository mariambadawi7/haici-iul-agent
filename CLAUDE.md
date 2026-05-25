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
- **State machine for the animated face** lives in `web/src/App.tsx` and resolves a single `FaceState` (`idle | listening | thinking | speaking`) from the union of TTS/STT/pending booleans. The face (`web/src/components/AnimatedFace.tsx`) reads that one prop plus an `amplitude` 0..1 driven by a WebAudio AnalyserNode tap on the playback element — that's where the lip-sync comes from.
- **The frontend ONLY talks to the n8n webhook.** It does not call Whisper or Piper directly — the workflow handles STT and TTS internally and returns audio as `audioBase64`. The only env var that matters is `VITE_N8N_WEBHOOK_URL` (default `/webhook/rag-agent` — relative).
- **CORS is sidestepped via a Vite reverse-proxy.** `web/vite.config.ts` proxies `/webhook/*` to `http://n8n:5678/webhook/*` over the Docker network. The browser only ever talks to `localhost:5173`, so the request is same-origin and CORS never gets a vote. If a turn fails with "Could not reach the workflow through the Vite proxy", the web container can't resolve `n8n:5678` — usually fixed by `docker compose up -d --force-recreate web`.
- **Two request shapes** to the same webhook:
  - **Text turn:** `POST application/json` with body `{ sessionId, text, wantsAudio }`. The workflow's `Set userText (Text)` node reads `body.text`.
  - **Voice turn:** `POST multipart/form-data` with `file` (the recorded blob), `sessionId`, and `wantsAudio` as form fields. n8n exposes the first binary file as `$binary.data0`, which the workflow's Switch routes through Whisper.
- **Response shape** (JSON): `{ answer, question?, audioBase64?, audioMime? }`. `question` is the Whisper transcript on voice turns and replaces the placeholder bubble in the UI. When `wantsAudio:true`, the workflow's Piper node fills `audioBase64`.
- **The workflow must be Active.** `/webhook-test/rag-agent` only listens for one call per Listen click; subsequent calls succeed in n8n's execution history but the HTTP response never reaches the browser (it surfaces as `NetworkError when attempting to fetch resource`). Toggle the workflow Active in n8n and use `/webhook/rag-agent`.
- **Sessions** are stored in `localStorage` only (see `web/src/lib/storage.ts`). No server-side persistence — clearing site data wipes them. The voice retry cache is in-memory only; reloading the page disables Retry on already-failed voice messages.
- **Logos:** drop `logo-center.svg` and `logo-iul.svg` into `web/public/` and they'll be picked up via `VITE_LOGO_LEFT` / `VITE_LOGO_RIGHT`. Without them the header renders serif-monogram placeholders.

## Domain context

`iul.txt` and `shared_docs/` contain reference material about the **Islamic University of Lebanon (IUL)** — this stack appears to be a university-project assistant whose workflows answer questions grounded in those documents. Preserve the content of `shared_docs/` unless explicitly told otherwise; it is workflow input, not scratch space.
