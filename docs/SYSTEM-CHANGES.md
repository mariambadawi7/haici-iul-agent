# HAICI / IUL Agent — Engineering Record

Reference notes for the written report. Covers everything built on top of the
original "n8n + Qdrant + Ollama + Whisper + Piper" stack: the two-tier answer
cache, the Postgres analytics database, the admin dashboard, the white-label
(re-branding) system, and the typo-tolerance layer.

Snapshot date: 2026-08-29. Branch: `admin-dashboard-and-white-labeling`.

> **Source of truth.** The *live* n8n instance is authoritative. The
> `*.json` exports in the repo root were synced from it on **2026-09-01** and
> match it as of that date, but they are a snapshot, not the system: an edit
> made in the n8n editor changes behaviour without touching them. Verify
> against the live copy through the REST API
> (`GET /api/v1/workflows/<id>` with `X-N8N-API-KEY`) before trusting a file.
>
> When re-syncing, take `nodes`/`connections` from **`activeVersion`** (what
> serves traffic) but `name` and `settings` from the **top-level** object —
> `activeVersion.name` is `null`, and exporting the top-level `nodes` gives you
> the unpublished editor draft instead. Check `versionId == activeVersionId`
> first; if they differ an unpublished draft exists and the two disagree.

| Workflow | id | Nodes | Active | Export |
|---|---|---|---|---|
| Agent Workflow | `d8nftRI2zhutW98L` | 45 | yes | `Agent Workflow.json` |
| Admin Dashboard API | `9UwU0payk3rht1ms` | 25 | yes | `admin_dashboard_workflow.json` |
| RAG workflow | `btAR6oU4MThHIYy9` | 7 | yes | `RAG workflow.json` |
| STT Webhook | `KNUv1TRbHWl3v6oS` | 5 | yes | `STT Webhook.json` |

`agent_workflow_fixed.json` was deleted on 2026-09-01. It was an abandoned
27-node snapshot of the Agent Workflow, kept under a name that invited
mistaking it for the good copy — and it carried the **real workflow id**
`d8nftRI2zhutW98L`, so importing or `PUT`-ing it would have overwritten the live
43-node workflow with a version whose only distinguishing nodes were the audio
branch removed in §7. Recoverable from commit `69f19ac` if ever needed.

Note the instance carries duplicate names — three "STT Webhook", two "Agent
Workflow". Match on **id**, not name, and check `active`.

---

## 1. Infrastructure added

Two services were added to `docker-compose.yml` beside the original five:

- **Redis 7-alpine** — answer cache. AOF persistence on, `maxmemory 3gb`,
  `allkeys-lru`, password-protected via `REDIS_PASSWORD`.
  Sizing rationale (recorded in the compose comment): a cached TTS answer
  averages ~0.55 MB, so 3 GB is roughly 5,500 spoken answers — enough to hold one
  full 30-day TTL period even at admission-season traffic (~180 new entries/day),
  so entries expire on TTL rather than being evicted early. Headroom was left
  under the Docker VM's ~6 GB free for allocator fragmentation and the AOF
  rewrite fork.
- **Postgres 16-alpine** — analytics + settings store. Schema auto-applied from
  `postgres_init/init.sql` on first volume init.

Hardening done at the same time (`docker-compose.yml.bak-prehardening` is the
before-state): n8n, Redis and Postgres ports are now bound to `127.0.0.1` only,
so nothing but the host can reach them; secrets moved to `.env`
(`REDIS_PASSWORD`, `POSTGRES_*`, `ADMIN_PASSCODE`, `N8N_API_KEY`) and `.env` is
gitignored. Execution timeouts capped (`EXECUTIONS_TIMEOUT=300`).

STT also moved to **Groq** (`Groq STT` node) on the voice path, replacing the
in-workflow Whisper call.

---

## 2. Answer caching — two tiers, retrieve-then-verify

The pipeline tries three ways to answer before it ever pays for a full RAG turn.

### Tier 1 — exact cache (Redis)

`Normalize & Hash Question` lowercases, trims, strips punctuation (keeping the
Arabic range so Arabic survives), collapses whitespace, and hashes with djb2
into a hex key. `Check Redis Cache` does `GET faq:<hash>`; `IF (Cache Hit?)`
branches. The stored value is a JSON blob
`{ answer, audioBase64, audioMime, question, rawQuestion, corrections }`
with TTL **2,592,000 s = 30 days**.

A *dual-write* pattern handles the typo layer: when the question was corrected,
the answer is written under both the raw hash and the corrected hash
(`IF (Dual Write Needed - Audio)` / `IF (Dual Write Needed - NoAudio)` →
`Save … (Corrected)`), so the next person who mispronounces it the same way
still gets a tier-1 hit.

### Tier 2 — semantic cache (Qdrant + LLM judge)

Built by `build_semantic_cache.py`. Flow on a tier-1 miss:

`Embed Question` (Gemini `gemini-embedding-001`, `taskType: SEMANTIC_SIMILARITY`)
→ `Semantic Lookup` (Qdrant `faq_cache` collection, `limit 3`,
`score_threshold 0.8`) → `IF (Candidate Found?)` → `Judge Same Question`
→ `Check Verdict` → `IF (Judge SAME?)` → `Fetch Semantic Hit` (Redis GET on the
candidate's hash) → `IF (Semantic Value Present?)` → `Parse Cached Response`.
Every failure edge falls through to `AI Agent`, i.e. a normal cache miss.
`Index Question Vector` writes the vector back to Qdrant after a fresh answer.

**The key design decision — and the strongest single result for the report.**
Embedding similarity alone had *no safe threshold*: on 18 adversarial IUL
question pairs, near-miss pairs (different semester, different degree level,
different campus, phone-vs-email) scored *higher* than genuine paraphrases, so
any cut-off either served wrong answers or rejected valid reuse. Replacing the
threshold with a cheap LLM adjudicator — Gemini 2.5 Flash, `temperature 0`,
`maxOutputTokens 16`, `thinkingBudget 0`, answering exactly `SAME` or
`DIFFERENT` — scored **17/18 with zero false positives**. Embeddings were demoted
to a *shortlist* mechanism; the judge decides. This is the "retrieve-then-verify"
pattern.

The judge prompt explicitly states that wording, formality, word order, spelling
and **language (English vs Arabic)** differences do not make two questions
different — which is what lets an Arabic paraphrase hit an answer cached from
the English question.

Three outcomes are recorded distinctly in the log as `match_type`:
`cache_hit` (tier 1), `semantic_hit` (tier 2), `fresh` (full RAG turn).

---

## 3. Database — `receptionist_session_logs`

`postgres_init/init.sql` defines one wide log table plus a settings table.

Columns: `id, timestamp, input_type, question, answer, responded_with_audio,
match_type, answer_hash, session_id, question_hash, normalized_question,
latency_ms, is_unknown, intent, language, raw_question, corrections (JSONB),
semantic_skipped`.

Indexes: `timestamp DESC`, `question_hash`, `session_id`, and a *partial* index
on `is_unknown WHERE is_unknown` — the unknown-questions view is the most-run
query and only ever wants the true rows.

`admin_settings (key, value)` is a generic KV store holding two things: the
admin passcode as `admin_passcode_sha256` (hash only — plaintext is never stored
or committed) and the `typo_lexicon` JSON document, seeded by the init script
with `ON CONFLICT DO NOTHING` so re-running is safe.

The write happens in `Anonymize Log Entry` → `Log Session (Postgres)`. That Code
node is deliberately *defensive*: every field lookup is wrapped in try/catch and
falls back to a default, because a logging failure must never break a user's
turn. It derives:

- `intent` — greeting/small-talk detection against an EN+AR phrase list, matched
  on padded word boundaries so `hi` does not match inside `history`.
- `is_unknown` — substring match against an EN+AR list of non-answer phrasings
  ("i don't have", "no information", "outside my scope", and their Arabic
  equivalents). The list had to be extended after real traffic showed the model
  has no fixed fallback sentence and improvises scope refusals.
- `latency_ms` — measured from `startedAt`, stamped in
  `Normalize & Hash Question`. It no longer includes STT time: transcription
  moved to the separate `STT Webhook` workflow (§7), whose latency is currently
  not logged anywhere.
- `raw_question` / `corrections` — read from `Correct Domain Terms` when it ran,
  and from the cached blob when it didn't (the cache-hit path skips that node).

**Known trap:** an `id: 0` mapping bug in the Postgres node silently killed
logging once — rows stopped being written with no visible error. Worth a line in
the report as a real debugging incident.

---

## 4. Admin dashboard

Front end lives in `web/src/components/admin/`, reached at `#/admin`, gated by
`PasscodeGate`. Three tabs: **Analytics**, **Lexicon**, **Branding**.

Back end is the separate **Admin Dashboard API** n8n workflow: one webhook
(`POST /webhook/admin-stats`) that authenticates every call by comparing the
posted passcode against the SHA-256 in `admin_settings`, then routes on a
`view` field — `overview | log | lexicon | lexiconSave | corrections`.
Client wrapper: `web/src/lib/adminApi.ts` (typed, with `AdminApiError` /
`AdminAuthError` / `AdminValidationError`).

The **overview** is a single 6.7 KB SQL statement — 17 CTEs (`scoped`,
`kpi_base`, `by_hour`, `weekday_series`, `heatmap`, `by_day`, `top_questions`,
`unk_groups`, `by_language`, `by_input_type`, `by_match_type`, …) returning the
whole dashboard in one round trip rather than a dozen queries. Generated date
series are used so empty hours/days appear as zeros instead of gaps.

KPIs surfaced: total & unique questions, sessions, unknown count and rate,
**cache hit rate**, avg and **p95 latency**, voice share, audio-reply share,
avg questions per session, active days, busiest hour, busiest day, first/last
seen. Charts: volume over time, peak hours, weekday/hour heatmap, top questions,
unknown questions, breakdowns by language / input type / match type. The log tab
is searchable, filterable and paginated server-side.

The **corrections** view (CTEs `pairs`, `pair_counts`, `clarify_rows`) mines the
`corrections` JSONB to show which misheard forms actually occur and how often —
this is the feedback loop that tells staff what to add to the lexicon.

`lexiconSave` runs a server-side `Validate Lexicon` node before writing; a 400
returns the offending term by name and the client raises `AdminValidationError`.

---

## 5. White-labelling / re-branding

Goal: the same frontend is sold to different businesses, so **no client name
appears anywhere in `web/src`**. One tenant document,
`branding/branding.json`, bind-mounted to `/app/branding`, covers identity
(name, kicker, tagline, logos, favicon, footer credit, meta description), theme
(brand/neutral/warn/surface colours, light-or-dark mode, sans+serif fonts,
corner radius), avatar (2D mascot / `glb` 3D model / still image / none), feature switches
(voice, avatar, landing, admin, sidebar) and brand-bound copy (input
placeholder, starter prompts).

Mechanism, in the order that matters:

1. **Served by the existing Bun sidecar.** `web/ws-server.ts` gained
   `GET/PUT /api/branding` and asset upload at `/api/branding/asset/<slot>`.
   Vite proxies `/api/*` to it, so the browser stays same-origin — the same
   trick already used for `/webhook`. Writes require `X-Admin-Passcode`; if
   `ADMIN_PASSCODE` is unset the server logs a loud warning that branding writes
   are unauthenticated.
2. **Theming by redefining Tailwind's scales, not by rewriting components.**
   `tailwind.config.js` re-points `teal`→brand, `slate`→neutral, `amber`→warn at
   CSS custom properties, and `lib/branding/theme.ts` writes those variables at
   runtime. An existing `bg-teal-600` therefore re-targets itself with no
   rebuild — which is why roughly **140 colour utilities did not have to be
   touched**. Full tint/shade ramps are generated from a single hex
   (`lib/branding/color.ts`), and dark mode is the neutral ramp inverted, so
   there is not one `dark:` variant in the codebase.
3. **Resolved before first render.** `main.tsx` resolves branding before mounting
   React, so components read config synchronously via `useTenant()` and there is
   no loading state. `store.ts` degrades in layers: server → localStorage cache →
   neutral defaults. A missing or malformed file yields an unbranded kiosk, never
   a blank screen.
4. **Tenant-scoped storage.** `lib/branding/scope.ts` namespaces browser storage
   keys by tenant, so two tenants sharing an origin cannot read each other's
   conversations.
5. **Edited from the UI.** `#/admin` → Branding tab (`BrandingTab.tsx`) previews
   changes live and only writes to disk on Save. Non-technical staff never touch
   a file or trigger a rebuild.

### The 2D mascot avatar

Management supplied a rigged 2D character (the "HAICI Mascot Animation Asset
Pack": ~300 isolated SVG/PNG parts, a layered master, viseme mouths, and a rig
JSON). It is wired in as a fourth avatar kind, `mascot`, alongside `glb`,
`image` and `none` — the tenant document picks one, so the choice is data, not
code.

Two problems had to be solved to use it.

**Three canvas registrations, one stage.** The pack draws parts on three
different canvases: a 2000x3200 master, a 1600x1600 head canvas offset to
master `(200, 0)`, and 1024x1024 face overlays offset to master `(488, 290)`.
Worse, the isolated head parts under `assets/svg/head/` are *anchor-centred*
rather than head-registered, so they cannot be composited by position at all.
`tools/build_mascot_assets.py` sidesteps this by building from the pack's
`source/PSD_Layers/SVG/` layers, which are already on the master canvas: it
concatenates them into three static composites (`body`, `head`, `antenna`) and
copies the face overlays through untouched. Every SVG in the pack ships a
byte-identical `<defs>`, which is what makes concatenation safe — one hoisted
copy, no id collisions. 306 files and 45 MB reduce to 54 files and 237 KB.

**The rig numbers must not be retyped.** The registration offset and the neck
and antenna pivots are the whole contract between the artwork and the
component. The script re-reads them from the pack's rig JSON and emits
`web/src/lib/mascotRig.ts`, so a repacked character with different geometry
still lands correctly instead of silently drifting. It is a generated module
rather than a JSON file in `public/` because the component must paint on its
first frame and cannot afford a fetch.

`components/Mascot2D.tsx` then stacks the layers as `<img>` elements over the
master box and animates them:

- **Same contract as the 3D head.** It reads the identical
  `(state, amplitude, emotion)` triple `Avatar3D` reads, so the app shell does
  not know or care which avatar a tenant runs. `Emotion` moved from
  `Avatar3D.tsx` to `types.ts` to stop the 2D component importing the 3D one.
- **Lip-sync by switched drawings.** The pack's 12 visemes are banded by
  speech amplitude, two drawings per band so a sustained vowel alternates
  instead of freezing, with a 75 ms floor on each shape — below roughly 70 ms
  the switch reads as a flicker rather than speech. Each swap cross-dissolves
  between two stacked `<img>`s.
- **Pose from the rig's bones.** The head group rotates about the `neck` bone
  and the antenna about the `antenna` bone, both expressed as
  `transform-origin` percentages of the master box, so the pivots survive any
  scale. The antenna ball doubles as a status light: it breathes while idle and
  flares with the voice.
- **One rAF loop, no React state.** Every moving value is a direct style write
  inside a single `requestAnimationFrame` loop that mounts once and reads props
  through a ref. Re-rendering React at 60 fps to move a head would be waste.
- **Colours stay the character's own.** This is the one place the "never write
  a raw colour in a component" rule is deliberately not extended: the mascot is
  supplied artwork like a logo, and retinting it to the tenant theme would
  break the brand it belongs to.

A framing switch (`avatar.mascotView`) chooses between the whole character and
a crop to the head. The head crop keeps a wide horizontal margin because the
head swings on the neck bone, which sits *below* the crop, so a few degrees of
sway travels a long way sideways; a tight frame clipped the shell corners.

Two bugs worth reporting as findings:

- **`transition: all` breaks theme swaps.** Chrome does not re-resolve a
  transitioning property when the custom property behind it changes, so elements
  stayed stuck on the previous tenant's colours. Fix: enumerate transitioned
  properties explicitly, and `theme.ts` freezes transitions across a swap.
- **Recharts ignores `var()`.** It emits colours as SVG attributes, where CSS
  custom properties never resolve. Charts therefore read *computed* values via
  `chartColors()` in `components/admin/ui.tsx` — the one sanctioned exception to
  "never read a raw colour in a component".

---

## 6. Typo tolerance — three layers

The problem: speech-to-text mangles domain vocabulary — "IUL" comes back as
"IOM", "Khaldeh" as "cald day", "HAICI" as "HiSci" — and RAG retrieval then
fails on a question the system actually knows the answer to. The failure is
worse than an ordinary typo because a mishearing produces a *confident wrong
word*: "IOM" is a real organisation, so the agent answers about the wrong thing
or refuses, rather than shrugging off a garbled token the way an LLM does with
"faclties".

One layer is not enough, so there are three, each catching what the previous
one missed:

| Layer | Where | Mechanism |
|---|---|---|
| 1. Prevention | `Groq STT` params, **STT Webhook** wf | bilingual domain vocabulary sent as Whisper's `prompt`, `temperature: 0` |
| 2. Correction | `Correct Domain Terms` (Code) | deterministic lexicon repair, alias + fuzzy |
| 3. Tolerance | `AI Agent` system message | near-miss acronyms read as IUL rather than refused |

Correction applies to **both spoken and typed turns** — the two input branches
merge before it — though the two are treated differently where it matters (see
the decision rule below).

### Layer 1 — prevention at the STT boundary

The `Groq STT` node of the **STT Webhook** workflow (`KNUv1TRbHWl3v6oS`) — the
one the microphone actually reaches — sends a comma-separated domain vocabulary
as Whisper's `prompt` field, plus `temperature: 0`. Whisper treats the prompt as
a vocabulary prior, so the decoder is biased toward these spellings before it
can err. The prompt is kept short deliberately — Whisper only honours roughly
the last 224 tokens.

**The prompt must stay bilingual.** It carries the English domain vocabulary
(IUL, HAICI, Wardanieh, Khaldeh, Al-Laqis, HCERES, ECTS …) *and* the Arabic
canonical forms from the `typo_lexicon` (الجامعة الإسلامية في لبنان, خلدة,
الوردانية, صور, بعلبك, برج البراجنة). This is not cosmetic. An all-English
prompt makes Whisper **romanise short Arabic utterances** — "أين خلدة؟" comes
back as `"Eyni halda?"` — and `Guard Language` (§7) then rejects the turn on its
script-vs-label check, because Groq still labels the clip `Arabic` while the
text is pure Latin. Measured against the live webhook: **6/6 short Arabic clips
rejected with the English-only prompt, 0/6 with the bilingual prompt, 0/6 with
no prompt at all.** Arabic clips of ≥ 3 s were unaffected either way, which is
why the defect hides until someone asks something short.

Layer 1's own yield is modest — it moved "Haysi" to "HACI" for *HAICI* and
sharpened a short "خلدة", but did not rescue "Khaldeh" from "Calder". It is a
cheap prior, not a fix; Layer 2 is what actually repairs these.

### Layer 2 — deterministic correction

`IF (Cache Hit?)` → `Load Typo Lexicon` (Postgres) → `Correct Domain Terms`
(Code) → `IF (Needs Clarification?)` → either the agent or
`Build Clarification Reply`.

The lexicon is the `typo_lexicon` row in `admin_settings`: `thresholds`,
`stoplist`, and ~25 `terms`, each with a canonical form, an alias list, and a
`fuzzy` flag. Coverage is bilingual: IUL and its Arabic name, HAICI, campus
towns (Khaldeh, Wardanieh, Tyre, Baalbek, Bourj El Barajneh, Majdal Balhiss,
Sahmar — each with its Arabic form), people (Moussa El-Sader, Shams Al-Din,
Abdul Amir Qablan, Hassan Al-Laqis, Rodayna Hmede) and academic terms (HCERES,
ECTS, Baccalaureate, Order of Engineers).

Matcher design:

- **Arabic normalisation** — strips tashkeel and tatweel and folds hamza-alef
  forms, ta-marbuta and alef-maksura to their bare equivalents, so orthographic
  variants collapse before comparison.
- **Offset-preserving tokenisation** — tokens carry `[start,end)` offsets into
  the original string, so a correction is spliced back in without disturbing
  surrounding punctuation or spacing.
- **Similarity** = normalised Levenshtein, plus a small **+0.05 phonetic
  bonus** when a coarse consonant-skeleton key matches (first char + consonants,
  vowels dropped). The phonetic key is deliberately only a booster, never a
  primary key — it is far too lossy to match on alone.
- **Short acronyms cannot be fuzzy-matched, by design.** Levenshtein("iom",
  "iul") is 2 edits out of 3 characters; any threshold loose enough to catch it
  would rewrite half the dictionary. `IUL`, `HCERES` and `ECTS` are therefore
  `fuzzy: false` and rely entirely on their hand-written alias lists, and
  `minFuzzyLen 5` keeps short tokens out of fuzzy matching generally. This is
  why the editable alias list — not the fuzzy matcher — is the load-bearing
  part of the feature.
- **Ambiguity is measured between terms, not between spellings.** Candidates
  are scored per canonical term, taking each term's best-matching alias, and
  only then ranked. Ranking raw aliases instead (the original implementation)
  made three spellings of one term — `wardania` / `wardaniyeh` / `wardaniya` —
  look like an ambiguous tie, which silently blocked every fuzzy correction for
  any term carrying more than one alias.
- **The decision is input-type aware.** A typed near-miss is almost always a
  slip of the fingers; a spoken one can be a genuinely different word. So typed
  turns auto-apply the uncertain band (`clarify 0.72` … `autoApply 0.86`) and
  are recorded as tier `B-typed`, while voice turns ask. A genuine tie between
  two *different* terms — inside the `gap 0.08` margin — still asks on either
  input type. A 36-word stoplist keeps question words ("where", "when", "what")
  from being "corrected" into domain terms.
- **Clarification is bilingual** and length-capped at 250 chars:
  *I heard "X". Did you mean Y or Z? Please ask again.* and its Arabic
  equivalent. It asks the user to repeat rather than to confirm, because the
  clarification branch bypasses the agent and therefore never enters the
  conversation buffer — a plain "yes" would have nothing to refer back to.

Observed behaviour on typed input:

| typed | corrected to | score | tier |
|---|---|---|---|
| `where is iom` | `where is IUL` | 1.0 | A |
| `which faculties are taught at iull` | `… at IUL` | 1.0 | A |
| `how do i reach the wardaneih campus` | `… the Wardanieh campus` | 0.778 | B-typed |
| `does sourr campus offer law` | `does Tyre campus offer law` | 0.8 | B-typed |
| `what documents do I need for the law faculty` | *unchanged* | — | — |

### Layer 3 — tolerance in the agent prompt

A short TRANSCRIPTION NOISE clause tells the agent that voice input may contain
transcription errors and that near-miss acronyms should be read as IUL rather
than refused. This is the last resort, and it demonstrably earns its place: in
end-to-end voice testing Groq transcribed "HAICI" as **"HiSci"**, an alias the
lexicon did not have, so layer 2 passed it through unchanged — and the agent
still answered correctly about the HAICI centre. The observed alias was
afterwards added to the lexicon, which is exactly the intended loop.

### Placement — why it sits on the cache-miss branch

Correction originally ran *before* the Redis cache check, so every cache hit
paid to repair text whose answer was already known. Measured per-node on a
cache-hit execution:

| node | duration |
|---|---|
| `Load Typo Lexicon` | 18 ms |
| `Correct Domain Terms` | 76 ms |
| `IF (Needs Clarification?)` | 2 ms |

96 ms added to a turn that otherwise took ~550 ms wall clock — a ~25 %
regression on the hot path. Worth noting the shape of the cost: the Postgres
read was *not* the problem, and roughly 25 ms of every n8n Code node is
irreducible sandbox overhead (`Normalize & Hash Question` does near-trivial
work in 26 ms), so node *count* on the hot path is itself a tax.

The fix was structural rather than algorithmic — the three nodes moved onto the
cache-*miss* branch, where their cost is invisible beside an LLM call measured
in seconds. Cache-hit wall clock went from ~550 ms to **~290–340 ms**, i.e.
faster than before the feature existed, because `Normalize & Hash Question`
also moved ahead of the cache check. Node execution time on a hit fell from
377 ms to ~142 ms, and `Load Typo Lexicon` / `Correct Domain Terms` no longer
appear in a cache-hit execution at all.

### Cache interaction

Because correction now happens after the lookup, the cache key is the hash of
the *raw* text. Three consequences were handled explicitly:

- The cached JSON blob carries `question` (corrected), `rawQuestion` and
  `corrections`, so a cache hit still displays "where is IUL" even though the
  corrector never ran on that turn.
- Entries are **dual-written** under both the raw hash and the corrected-text
  hash, so a typed "where is IUL" hits the entry created by a spoken "iom".
  The second write is skipped when nothing was corrected.
- A cached clarification outlives a lexicon change for up to the 30-day TTL.
  It is self-healing for aliases (a newly aliased term hashes differently, so
  the stale entry becomes unreachable) but not for threshold changes, which
  need the affected keys cleared.

### Observability

`raw_question` keeps what was actually heard, `corrections` (JSONB) keeps each
applied substitution with its score and tier. That feeds the admin
**Corrections** view, and the loop closes in the **Lexicon** tab, where staff
add the new alias — with server-side validation — without a deploy.

`latency_ms` was also repaired here. Its start mark sat in
`Normalize & Hash Question`, downstream of the added nodes, so the metric
structurally could not observe the regression it was supposed to catch — the
log read 183 ms for turns users experienced as 550 ms. The mark moved to the
first node on each branch (`Normalize Binary` for audio, `Set userText (Text)`
for text), adding no nodes; logged values track wall clock within ~200–300 ms of
webhook overhead. Note that since the audio branch was removed (§7) only the
`Set userText (Text)` mark remains, and the figure therefore no longer includes
STT time — transcription happens in the separate `STT Webhook` workflow, and its
latency is not currently logged anywhere.

### Two silent failures worth recording

Both were introduced while building this layer, and neither surfaced as an
error in n8n's execution log:

1. **A fan-in node that knew only two of its three inputs.** Three branches
   feed the response path — a fresh answer, a cache hit, and a clarification —
   but `Build JSON (Text + Audio)` probed only the first two. Referencing a node
   that did not execute throws, so clarification turns *with audio* failed. It
   escaped testing because every clarification test until then had used
   `wantsAudio: false`. n8n compounded it by mangling the message into
   `Cannot assign to read only property 'name'`, hiding the real cause.
2. **A truncated expression behind `onError: continueRegularOutput`.** Both
   Redis cache-write nodes ended `…}) }` instead of `…}) }}`. The nodes reported
   `executionStatus: success` and wrote nothing, so the answer cache was
   entirely dead — every turn hitting the LLM at ~6 s — while the execution log
   showed all-green. It was invisible in testing because the test questions had
   been cached *before* the patch, so pre-existing keys made a dead cache look
   healthy.

The practical lessons: assert side effects directly (`redis-cli EXISTS`, row
counts) rather than trusting node status; scan every `={{ … }}` expression for
balanced braces before deploying; and re-test cache behaviour with a key that
did not exist before the change.

---

## 7. Speech input — container fidelity and language fencing

Reported symptom: dictating from an **iPad** produced a transcript in an
apparently random language. It never reproduced on the kiosk PC. Two independent
defects, both on the path `useSTT` → `/webhook/stt` → `STT Webhook` workflow.

### The path that actually serves the microphone

Worth stating plainly, because it used not to be the obvious one. `useChat`
calls `transcribeAudio()`, which posts to **`/webhook/stt`** (the `STT Webhook`
workflow) and only then sends the resulting *text* to the agent.

The Agent Workflow used to carry a second, unreachable audio branch —
`Switch (Audio or Text)` → `Normalize Binary` → `Groq STT` — fed only by an
uncalled `sendChatAudio()`. Both were removed (see *One way in for audio*
below), so there is now exactly one route for speech and the ambiguity that
produced the §6 Layer 1 mix-up is gone.

### Defect 1 — the container was mislabelled, and only Safari noticed

`useSTT` probed exactly two MIME types:

```
audio/webm;codecs=opus  →  audio/webm  →  ""   (fall through, browser default)
```

Safari (iPadOS/iOS/macOS) supports neither, so it fell to the default recorder
and produced **AAC in an MP4 container**. Two places then asserted otherwise:

- `api.ts` named the part `speech.wav` (`blob.type.includes("webm") ? … : "wav"`)
- the workflow's first Code node overwrote the metadata unconditionally:
  `mimeType = 'audio/webm'`, `fileName = 'speech.webm'`

Groq was therefore handed AAC bytes declared as Opus. The decode produced noise,
and Whisper's language detector dutifully assigned that noise a language — which
is the "unknown language" that was actually being observed. Chrome and Firefox
genuinely *do* record WebM, so the false label was harmless there; the bug was
invisible on every machine except the one Safari was running on.

Fix: probe a candidate list that includes `audio/mp4`, derive the filename
extension from the real blob type (`audioFileName()` in `api.ts`), and have the
workflow node **map** the incoming MIME onto an extension Groq accepts instead
of overwriting it. The server-side half fixes iPads that have not reloaded the
client yet.

### Defect 2 — nothing constrained the detected language

The live `Groq STT` node sent only `file` and `model`. No `language`, no
`prompt`, no `temperature` — Whisper's language detector ran unconstrained on
every clip and its answer was accepted without inspection.

Whisper's `language` parameter takes exactly one value, so pinning it is not
available to a bilingual deployment: forcing `en` returns Arabic speech as
English gibberish. Instead the node now requests `response_format:
verbose_json`, which exposes the detected language, and a new **`Guard
Language`** Code node validates it:

| Check | Rejects |
|---|---|
| transcript has a letter or digit | empty clips, punctuation-only hallucinations |
| detected label ∈ {English, Arabic} | the reported symptom — Vietnamese, Welsh, Nepali … |
| ≥60% of letters are Arabic or ASCII-Latin | Cyrillic, CJK, Thai, Devanagari, *even when the label looks fine* |
| label agrees with the script, when the script is unambiguous (≥90% one script, ≥4 letters) | Latin text labelled Arabic, and the reverse |

The last check is deliberately conditional: a question that genuinely mixes the
two — `أين يقع حرم IUL في صور؟` — must pass, so the label is only overruled when
one script clearly dominates. A rejection returns `{ text: "", error: … }` and
the UI shows the message rather than forwarding a foreign-language sentence to
the agent as if it were a real question.

Groq returns the language as a capitalised English **name** (`"English"`), not
an ISO code — the lookup accepts both spellings.

### What could not be gated server-side

Silence is a separate failure with the same shape: two seconds of digital
silence returns the classic Whisper hallucination `" Thank you."`. Measured on
`whisper-large-v3-turbo` (2026-09-01), the confidence fields cannot catch it:

| Clip | `no_speech_prob` | `avg_logprob` | `compression_ratio` |
|---|---|---|---|
| real speech | 0 | −0.160 | 1.105 |
| 2 s of pure silence | **0** | −0.293 | 0.579 |

`no_speech_prob` is 0 for both, and the `avg_logprob` gap is far too small to
threshold safely. So the gate moved to the browser, where the signal exists:
`useSTT` already computes an RMS level for the level meter, so it now tracks the
peak across the recording and refuses to upload a clip that never rose above the
noise floor. This is the cheaper place anyway — no network round trip.

### Verification

Test clips were built by synthesising English speech with Windows SAPI and
transcoding to AAC/MP4 (`ffmpeg` inside the `whisper` container) to reproduce
exactly what Safari records. Against the live webhook:

| Input | Result |
|---|---|
| AAC/MP4 named `speech.wav` (old client on iPad) | correct English, `language: "en"` |
| AAC/MP4 named `speech.m4a` (new client) | correct English, `language: "en"` |
| WAV, `audio/wav` | correct English — desktop path unaffected |
| `application/octet-stream` (no usable type) | correct English — fallback path works |
| 5 s pink noise | rejected: *"I didn't catch that"* |

The guard's classification logic was unit-tested separately against 16 cases —
real Arabic, mixed-script questions, Cyrillic/CJK/Vietnamese, mislabelled
scripts — run with Bun inside the `web` container. All pass. The Arabic
end-to-end path was originally covered by those unit cases only, since no Arabic
TTS voice is installed on this machine; it has since been exercised for real
against the live webhook with Gemini-synthesised Arabic audio (see *Layer 1
applied to the real voice path* below). Those clips are studio-clean synthetic
speech, so they probe the language/script logic rather than microphone realism —
accented, noisy human Arabic is still worth a pass before launch.

### Layer 1 applied to the real voice path

Layer 1 (§6) previously sat only on the **Agent Workflow's** `Groq STT` node,
which voice traffic never reaches, so the microphone path ran with no vocabulary
prior at all. The prompt now sits on the **STT Webhook's** `Groq STT` node,
where it takes effect — but in a **bilingual** form, not the English original.

Getting there needed Arabic audio, and no Arabic TTS voice is installed on this
host. The clips were synthesised instead with the Gemini TTS model the stack
already uses (`gemini-2.5-flash-preview-tts`, driven through a temporary n8n
workflow so the existing Google credential never had to be exported), decoded
from L16 PCM and encoded to WebM/Opus with `ffmpeg` in the `whisper` container —
the same container the browser produces. Nine Arabic clips: full questions,
short questions (~1.2 s), Arabic domain names, a mixed-script question, plus
quiet/band-limited/noisy degradations. Three arms were compared by cloning the
live workflow onto throwaway webhook paths, leaving production untouched:

| Arm | Short Arabic rejected | Long Arabic rejected | *HAICI* heard as |
|---|---|---|---|
| no prompt (previous behaviour) | 0/6 | 0 | "Haysi" |
| English-only prompt | **6/6** | 0 | "HACI" |
| bilingual prompt (**shipped**) | 0/6 | 0 | "HACI" |

The English-only arm fails by romanisation, not by misdetection: Groq still
returns `language: "Arabic"`, but the text comes back Latin ("Eyni halda?",
"Ina halda?"), and `Guard Language` rejects on script-vs-label disagreement.
The user-visible result is the *"did not come through as English or Arabic"*
message on a perfectly good Arabic question — so copying the English prompt
across verbatim, as originally proposed, would have shipped a regression.

Determinism was confirmed by re-running each arm: at `temperature: 0` the same
clip yields the same transcript every time, so the differences above are caused
by the prompt and nothing else. After applying, all 11 clips pass the live
`/webhook/stt` (0 rejections), and draft and `activeVersion` were verified
identical afterwards (`versionId == activeVersionId`).

Backup before the change:
`.workflow-backups/KNUv1TRbHWl3v6oS_pre_stt_prompt_20260831T224623Z.json`.

### One way in for audio — the Agent Workflow's audio branch removed

The Agent Workflow carried a second, parallel speech path: `Switch (Audio or
Text)` → `Normalize Binary` → `Groq STT` → `Set userText (Audio)`, reachable
only from a `sendChatAudio()` helper in `web/src/lib/api.ts` that had no callers
anywhere in `web/src`. Both are now deleted (Agent Workflow 30 → 26 nodes;
`Webhook` wires straight to `Set userText (Text)`).

Deleting it rather than keeping it as a "fallback" was deliberate. That branch
had **no `Guard Language` node at all**, and — per the note below — had already
lost its Whisper prompt. Re-enabling it would have silently bypassed both the
language fencing of §7 and Layer 1 of §6. A fallback that skips your safety
checks is a trap, not a fallback.

Two live references had to be repaired first, and one of them would have taken
production down:

- `Keep Answer Text` built its `question` field from
  `$('Set userText (Audio)').isExecuted ? … : …` — **not** inside a try/catch.
  In n8n, `$('Node')` on a deleted node throws, and this node sits on the
  cache-miss path, so every *fresh* answer would have failed while cached ones
  kept working. Rewritten to read `Set userText (Text)` only.
- `Anonymize Log Entry` derived `inputType` from the same node, but inside
  try/catch, so it would have degraded silently to `'text'` — which happens to
  be the now-correct answer. Simplified to a constant anyway, so the log field
  states a fact rather than depending on a caught exception.

Verified after the change: fresh and cached text turns both answer; Arabic and
English speech both complete the full `/webhook/stt` → `/webhook/rag-agent`
round trip; `receptionist_session_logs` still writes rows with populated
`latency_ms`, `intent` and `language`; `tsc -b --force` clean. Backup:
`.workflow-backups/d8nftRI2zhutW98L_pre_audio_branch_removal_20260901T120401Z.json`.

### Still open

- **The Agent Workflow had already lost Layer 1 before the branch was removed.**
  As of the `agent_workflow_backup_pre_visitor_20260831T223844Z` snapshot its
  *draft* had dropped `prompt` and `temperature` while its `activeVersion` still
  had them; a later publish promoted that draft. Moot now that the branch is
  gone, but it is the draft/active divergence trap of §9 actually firing and
  destroying config with no error — worth one slide.
- **Two speech mishearings added to the lexicon** (`typo_lexicon`, `version`
  1 → 3), both found by listening to what the STT actually returns rather than
  by guessing:
  `calder` → `Khaldeh` (spoken "Khaldeh" comes back as *"the IUL campus in
  Calder"*) and `haci` → `HAICI` (spoken "HAICI" comes back as *"HACI"*).

  Both needed an **exact alias**, and for the same structural reason: fuzzy
  matching only applies at or above `thresholds.minFuzzyLen` (5 characters), so
  a 4-character token like `haci` can never be reached by it no matter how close
  the score would be. Short acronyms are therefore invisible to Layer 2 unless
  listed explicitly — worth knowing before adding more.

  Verified from real audio, not typed text — the `haci` case end-to-end through
  the microphone path:

  ```
  raw_question | Tell me about HACI at the Islamic University of Lebanon.
  question     | Tell me about HAICI at the Islamic University of Lebanon.
  corrections  | [{"to": "HAICI", "from": "HACI", "tier": "A", "score": 1}]
  ```

  Before this, both were caught only by Layer 3 (the agent's transcription-noise
  tolerance) — the answer was right but the repair happened a layer later and at
  the cost of a full model call. Backups:
  `.workflow-backups/typo_lexicon_pre_calder_20260901T121405Z.json` and
  `..._pre_haci_20260901T171723Z.json`.
- **The typed/spoken distinction is restored, via an explicit client flag.**
  Removing the audio branch left nothing server-side able to tell a spoken turn
  from a typed one, since speech now arrives already transcribed — which
  flattened §6's input-type-aware rule into "everything is typed". The client now
  says so outright: `sendChat()` takes an `InputType` (`"text" | "audio"`) and
  puts it in the request body; `useChat.ts` passes `"audio"` on the
  `transcribeAudio()` path and `"text"` otherwise. `Set userText (Text)` captures
  it as `{{ $json.body?.inputType === 'audio' ? 'audio' : 'text' }}` —
  whitelisted, so an absent or unexpected value reads as `text` — and both
  `Correct Domain Terms` and `Anonymize Log Entry` read it from there instead of
  hardcoding. This also makes the `input_type` log column truthful again.

  Verified live on one near-miss, *"how do i reach the wardaneih campus"*:

  | flag | behaviour | latency |
  |---|---|---|
  | `text` | auto-applied, `B-typed`, score 0.778, answered | 6.6 s |
  | `audio` | *"I heard "wardaneih". Did you mean Wardanieh or Khaldeh?"* | 0.19 s |

  An exact alias hit still auto-applies regardless of origin — spoken "Calder"
  corrects to Khaldeh at tier `A`, score 1, without asking.

### Latency regression: the retry I added made things worse

Reported symptom: greetings taking ~20 s, and the cache appearing to have been
wiped. Three separate causes, one of them self-inflicted.

**1. The `Embed Question` retry turned a free failure into a 12-second stall.**
The Gemini embedding quota fails on roughly **28%** of calls, and that was always
true — what changed was the price of failing. Measured on the same error:

| | embedding fails | cost |
|---|---|---|
| before the retry | exec 1095 | **0.6 s**, fell straight through |
| with `maxTries 3 / 5000 ms` | exec 1104, 1128, 1133 | **11.4 – 14.8 s** |

7 of 18 embed calls were costing over 5 s, and the waits applied to calls that
eventually *succeeded* too. This is exactly the trade flagged when the retry went
in — "good for transient bursts, bad under sustained exhaustion" — and the quota
turned out to be sustained, not bursty. **Reduced to `maxTries 2 /
waitBetweenTries 1000`**: still absorbs a one-off network blip, but a quota error
now costs ~1 s. Retrying harder cannot beat a per-minute quota, so there is no
version of this that both retries hard and stays fast. Measured after:
`Embed Question` back to **0.6–1.1 s**.

**2. Greetings ran the entire pipeline.** "Hello!" went through semantic lookup,
RAG and TTS — 21–23 s when the embedding stalled, for a reply that never
depended on any of it. `Correct Domain Terms` → **`Detect Greeting`** →
**`IF (Greeting?)`** now answers a pure greeting inline and routes everything
else down the existing path untouched.

The detector is deliberately stricter than the greeting test in
`Anonymize Log Entry`: that one only labels a row after the fact, while a false
positive *here* would answer a real question with "how can I help you?". So it
requires the whole utterance to be a greeting — no question mark, ≤ 8 words, no
request-shaped words — which is why *"Hello, what are the admission deadlines?"*
still reaches the agent and gets a real answer. The reply carries no institution
name, because the deployment is white-labelled at runtime and a hard-coded one
would be wrong for every other tenant.

Measured: greeting **21 s → 0.16–0.34 s**; a greeting-plus-question and an
ordinary question both unchanged. Greeting turns log as `match_type: 'greeting'`
so they stop inflating the `fresh` count (a new value alongside `clarify`; the
dashboard's Fresh/Cache filters do not match it, "All" does).

`Build JSON (Text + Audio)` had to learn the new branch — it probes upstream
sources by name and would otherwise have returned an empty answer whenever a
greeting was spoken with audio on. That is the §6 fan-in rule biting again.

**3. The camera split the cache per visitor** — resolved below. Nothing was
deleted: `evicted_keys: 0`, `expired_keys: 0`, entries growing.

### Per-visitor cache keys narrowed to identity questions

Every question from a recognised visitor used to get its own private key, so the
camera recognising someone handed them a completely cold cache — the reported
"all the cached questions got deleted". The key is now private **only when the
answer is inherently about that person** ("who am I", "what is my name");
everything else shares one entry, as it did before the camera existed.

That was not a one-line change, because the narrow rule had already failed once
and the comment in `Normalize & Hash Question` said so: the agent opened ordinary
answers with "Hello Mariam, ..." and those must never reach the next visitor.
Measured before changing anything — **18 of 321** logged answers contained a
visitor name, including *"How do I apply to IUL?"* → *"Hello Mariam. To
apply..."*. So three things had to move together:

1. **The agent no longer greets.** Its prompt permits the name only for identity
   questions. That became safe only because greetings are now answered before the
   agent runs (`Detect Greeting`), so the personal touch survives while the name
   leaves ordinary answers.
2. **`correctedHash` follows the same rule.** The typo dual-write stores the
   answer under a second key which ignored the visitor entirely — a personal
   answer would have leaked through that back door on the next ask.
3. **The semantic tier had to stop bypassing the key** — below.

### The semantic tier walked straight past the per-visitor key

Caught by the acceptance test, not by reasoning. A stranger asked *"Who am I?"*
and was told *"You are Mariam Badawi."*

Tier 1 behaved correctly — the stranger's shared key missed. The semantic tier
then embedded the question, matched the recognised visitor's vector at
**0.99999964**, the judge said `SAME`, and `Fetch Semantic Hit` did a Redis `GET`
on **the candidate's** hash: the private one. That tier fetches by the stored
hash, which carries no notion of who is asking, so per-visitor keying cannot
defend itself one layer up.

**Pre-existing, not introduced by the narrowing** — the same path would have
served the same answer under the old rule. It had simply never been tested.

Closed at both ends: `Semantic Lookup` declines an identity question before the
Qdrant call (`semanticBypass: 'personal_question'`; `semanticSkipped` stays
`false`, so this does not pollute the outage metric), and `Index Question Vector`
never puts one into the shared collection. One stale identity vector, and the
cache entries poisoned while the test was failing, were purged.

Acceptance test, run twice, all passing:

| case | result |
|---|---|
| recognised visitor asks an ordinary question | no name in the answer |
| **stranger** asks the same question | 2.1 s cache hit, no name |
| **different** visitor asks it | 2.2 s cache hit, no name |
| recognised visitor asks "Who am I?" | "You are Mariam Badawi." |
| **stranger** asks "Who am I?" | "I'm sorry, I don't recognize you." |

A name-bearing answer does still sit under the recognised visitor's *private*
key. That is the design working, and the stranger case proves it is unreachable.

**Hardened: the agent is no longer told the name unless it needs it.**
Sharing was safe only *because* ordinary answers carried no name — and that
rested on the model obeying a prompt instruction. `visitorContext` was appended
to every agent call, so a future prompt edit or a model drift would have put
names back into shared answers silently, cached for 30 days, served to
strangers. No error, no log line.

The camera line is now supplied **only for identity questions**. The agent
cannot leak a name it was never given, which turns an instruction into a
structural guarantee. The prompt was rewritten to match the new contract —
previously it said an absent camera line meant "you cannot see anyone", which
would now be a lie on every ordinary turn.

Because that same `PERSONAL` regex now gates the agent's access to the name, its
failure modes became asymmetric and it was widened accordingly:

| | consequence |
|---|---|
| over-matching | a shareable answer gets a private key — costs one cache hit |
| under-matching | the kiosk tells someone it can plainly see "I don't recognise you" — costs trust |

So it now also covers "remember me", "have we met", "who do you think I am",
"what do you know about me" and the Arabic equivalents (`تتذكرني`, `تعرف عني` …).

Verified across phrasings, both languages, both directions:

| asked by | question | result |
|---|---|---|
| recognised visitor | "Who am I?" / "Do you know me?" / "Do you remember me?" / "What's my name?" / "Have we met before?" | named correctly |
| recognised visitor | `من أنا؟` / `هل تتذكرني؟` / `ما اسمي؟` | named correctly (the agent transliterates, `مريم بدوي`) |
| recognised visitor | ordinary questions | no name, answer shareable |
| **stranger** | the same ordinary question | 2.1 s cache hit, no name |
| **stranger** | every identity phrasing above, EN and AR | "I don't recognise you" |

Worth noting for the report: the first run of this test reported two Arabic
failures that were not failures. The assertion looked for the Latin string
"mariam" while the agent had answered `أنت مريم بدوي` — the test was wrong, not
the system. A checker that only understands one script will quietly mis-grade a
bilingual deployment.

### Arabic punctuation was inside the tokeniser's "word" class

Wiring the flag above immediately exposed a latent bug, because it was the first
time an Arabic voice turn could reach the clarification branch at all. A
correctly spoken *"أين يقع حرم الجامعة الإسلامية في لبنان في خلدة؟"* came back as
*"سمعت "خلدة؟". هل تقصد خلدة أو الوردانية؟"* — the system asking the user to
clarify a word they had pronounced perfectly.

`tokenize()` matched `/[A-Za-z؀-ۿ']+/`. That Arabic range is the entire
U+0600–U+06FF block, which **contains the punctuation**: `؟` U+061F, `،` U+060C,
`؛` U+061B, `۔` U+06D4. So `خلدة؟` tokenised as one token, missed the exact alias
`خلدة`, scored 0.8 into the clarify band (0.72–0.86) and asked. `normToken`'s
comment asserted the opposite — *"No punctuation stripping needed here because
tokens are already extracted via the word-char regex"* — which is exactly the
false assumption. English never showed it, because `?` is outside `[A-Za-z']`.

The class now names letters and combining marks only, excluding U+0600–U+060F,
U+061B–U+061F, U+066A–U+066D and U+06D4. Confirmed after the fix: the same
Arabic clip answers normally with no correction recorded, while *"wardaneih"*
still clarifies on voice and still auto-applies when typed.

Worth recording as a bug that was **invisible while it was harmless**: before the
flag existed every turn counted as typed, so this misfire silently auto-applied a
no-op correction (`الوردانية؟ → الوردانية`, logged at score 0.8) rather than
surfacing. Restoring a feature is what made the latent defect observable.

### ⚠ Regression (recovered): 17 nodes were missing from the live Agent Workflow

Layer 2 was **not running in production**. `Load Typo Lexicon`,
`Correct Domain Terms`, `IF (Needs Clarification?)` and
`Build Clarification Reply` had gone from the live `activeVersion`, along with
the entire Tier-2 semantic cache (`Embed Question`, `Semantic Lookup`,
`Fetch Semantic Hit`, `Judge Same Question`, `Check Verdict`, `Index Question
Vector`, the `IF (Candidate Found?)` / `IF (Judge SAME?)` /
`IF (Semantic Value Present?)` / `IF (Dual Write Needed …)` gates and the
`… (Corrected)` cache writers) — 17 nodes in total.

The cache-miss branch, which used to read

```
IF (Cache Hit?) → Load Typo Lexicon → Correct Domain Terms → IF (Needs Clarification?) → AI Agent
```

now reads simply `IF (Cache Hit?) → AI Agent`. Every question goes straight to
the model with no term correction, no clarification path, and no semantic
lookup. §2's Tier 2 and §6's Layer 2 both describe behaviour the system does not
currently have.

This was **not** caused by the audio-branch removal. The snapshot taken
immediately before that change
(`d8nftRI2zhutW98L_pre_audio_branch_removal_20260901T120401Z.json`) already
shows `activeVersion` at 30 nodes with all 17 absent; the audio removal took it
30 → 26. The loss happened between the `pre_visitor` snapshot
(2026-08-31T22:38Z, `activeVersion` = 47 nodes, all present) and 2026-09-01T12:04Z.

The cause is the draft/active divergence trap of §9 firing: the *draft* had been
sitting at 30 nodes with these deleted while `activeVersion` still ran all 47,
and a publish promoted that draft over production. The same event took Layer 1's
Whisper `prompt` with it. Nothing errored — the workflow simply does less.

**Recovered.** The 17 nodes and their connections were merged back from
`agent_workflow_backup_pre_visitor_20260831T223844Z.json` (live workflow now 43
nodes: 26 + 17, with the audio branch still gone). It had to be a *merge*, not a
rollback — the backup predates the visitor feature, so a straight revert would
have destroyed it.

What the bad publish had also silently reverted, beyond deleting the 17 nodes:

| Node | Damage | Resolution |
|---|---|---|
| `AI Agent` | lost the **TRANSCRIPTION NOISE** block — i.e. §6 **Layer 3** | prompts merged: both TRANSCRIPTION NOISE and VISITOR RECOGNITION now present |
| `Parse Cached Response` | lost `rawQuestion`/`corrections` and semantic `matchType` | restored from backup |
| `Save to Redis Cache`, `Save Audio to Cache` | lost cached `question`/`rawQuestion`/`corrections`; **TTL cut 30 d → 3 d** | restored, TTL back to 2,592,000 s |
| `Anonymize Log Entry`, `Log Session (Postgres)` | lost the `raw_question` and `corrections` columns | restored (both columns still existed in Postgres) |
| `Build JSON (Text + Audio)` | lost the three-branch `pickSource` fan-in probe | restored |
| `Normalize & Hash Question`, `Set userText (Text)` | — (newer visitor work) | **kept current**, not reverted |

Verified live: `raw_question` *"Where is the IUL campus in Calder?"* → `question`
*"Where is the IUL campus in Khaldeh?"* with
`corrections: [{"from":"Calder","to":"Khaldeh","tier":"A","score":1}]`. Layer 2
is running again and the new alias works. Backup:
`.workflow-backups/d8nftRI2zhutW98L_pre_layer2_restore_20260901T121845Z.json`.

### The answer cache was dead for ~17 rows of traffic — a deleted credential

Tracing an execution after the restore showed every Redis node failing with
`Credential with ID "Pk9dL1I9ykAW6ha3" does not exist for type "redis"`. That
credential was deleted when Redis auth was introduced (§1); the surviving one is
`bDN9Hfgixc2fSuSq`, *"Redis account (authenticated)"*. The bad publish reverted
`Check Redis Cache`, `Save to Redis Cache` and `Save Audio to Cache` to the
deleted credential, so **the answer cache has been silently dead** — the nodes
run, fail, and pass through because they continue on error, and n8n reports the
execution green.

The evidence is in the logs: `match_type = cache_hit` appears 146 times up to row
250 and **never again**; every row since is `fresh`, including identical repeated
questions. This is §8's "degrade, never break" working exactly as designed and
therefore costing money quietly — every repeat question pays a full LLM call.

The three restored `(Corrected)` / `Fetch Semantic Hit` nodes came back on the
*correct* credential, so the workflow is currently split: corrected-hash writes
succeed, but `Check Redis Cache` still reads with the dead one, so nothing ever
hits.

**Fixed.** All six Redis nodes now reference `bDN9Hfgixc2fSuSq`. Verified by
asking one question three ways:

| turn | `match_type` | latency |
|---|---|---|
| first ask | `fresh` | 9,943 ms |
| same question again | `cache_hit` | **123 ms** |
| English paraphrase | `semantic_hit` | 1,993 ms |

That is the first `cache_hit` since row 250, and it makes the two-tier design of
§2 measurable at last: ~80x on an exact repeat, ~5x on a paraphrase that has to
go through the embedding shortlist and the LLM judge.

### Cross-language reuse re-tested — it works, and the first read was wrong

An initial single sample suggested Arabic could not reuse an English-cached
answer, and that the embedding shortlist was gating it before the judge ever
ran. Re-testing with n8n execution data (shortlist score and judge verdict per
turn, rather than just the logged `match_type`) showed that reading was wrong on
both points.

| Query | vs cached question | shortlist | judge | outcome |
|---|---|---|---|---|
| EN paraphrase | EN | 0.9721 | `SAME` | `semantic_hit` |
| **AR** | **EN** | **0.9444** | **`SAME`** | **`semantic_hit`** |
| AR | AR | 0.9382 | `SAME` | `semantic_hit` |
| AR | EN | 0.8989 | `DIFFERENT` | fresh |
| EN | EN, different topic | 0.9060 | `DIFFERENT` | fresh |
| EN | EN, general vs faculty | 0.8687 | `DIFFERENT` | fresh |

**Cross-language reuse is real**: *"ما هي شروط القبول في كلية الحقوق؟"* served the
answer cached for *"What are the admission requirements for the Faculty of
Law?"*. Cross-language pairs clear the 0.8 shortlist comfortably (0.899, 0.944),
so the shortlist is not the bottleneck the first read assumed.

The one cross-language `DIFFERENT` was the judge working, not failing: *"does
the university offer scholarships to engineering students"* (yes/no) against a
cached *"what scholarships does IUL offer to engineering students"*
(enumeration). The prompt lists "a different kind of detail" as grounds for
`DIFFERENT`, so that verdict is defensible — the original test pair was a sloppy
paraphrase, not a faithful translation. Both `DIFFERENT` verdicts on same-language
pairs were also correct rejections of genuine near-misses, which is the §2
retrieve-then-verify result holding up.

### `Embed Question` silently drops the semantic tier under burst load

The apparent cross-language failure was neither similarity nor the judge: the
embedding call had returned

```
Quota exceeded for aiplatform.googleapis.com/global_embed_content_requests_per_minute_per_base_model
```

`Semantic Lookup` opens with `if (!vec || !vec.length) return [{ json:
{ candidateFound: false } }]`, so a failed embedding is indistinguishable from
"nothing similar found": the turn degrades to a full RAG answer, the execution
is green, and the log records a perfectly ordinary `fresh`.

**3 of 15** embedding calls (20%) failed this way during rapid testing. That is
§8's "degrade, never break" behaving exactly as designed, and it is the right
trade — but it means the Tier-2 hit rate falls off precisely when traffic is
heaviest, and nothing surfaces it. One consequence for the report: benchmark
numbers taken from a burst **understate** the semantic-hit rate.

**Mitigated:** `Embed Question` now carries `retryOnFail: true`, `maxTries: 3`,
`waitBetweenTries: 5000`. `onError` deliberately stays
`continueRegularOutput`, so if all three tries fail the turn still degrades to a
normal cache miss rather than erroring — the retry is an extra chance, not a new
hard dependency.

Two honest limits on this fix:

- **n8n's retry is a fixed delay, not exponential backoff.**
  `waitBetweenTries` is a constant (5000 ms is n8n's maximum). Three tries span
  roughly ten seconds, which is enough to cross into a fresh per-minute quota
  window for the bursty collisions actually observed, but it is not true backoff
  and will not out-wait a genuinely exhausted quota.
- **It costs latency exactly on the turns already degrading.** A turn whose
  embedding is going to fail now waits ~10 s before falling through to the agent
  instead of failing immediately. That is a good trade for transient bursts and
  a bad one under sustained quota exhaustion — if that is ever observed in real
  traffic, drop `maxTries` to 2 or accept the degradation.

**The condition is now visible: `semantic_skipped`.** A failed embedding used to
be recorded as an ordinary `fresh`, indistinguishable from "the semantic tier
ran and found nothing similar". `Semantic Lookup` now reports which of the two
happened, `Anonymize Log Entry` forwards it, and it is stored on the log row as
a **nullable** boolean — the three states are genuinely different and collapsing
them would defeat the point:

| value | meaning |
|---|---|
| `false` | the semantic tier ran; nothing cleared the bar, or the judge said `DIFFERENT` |
| `true` | the tier could not finish — `semanticSkipReason` is `embedding_unavailable`, `lookup_failed` or `judge_unavailable` |
| `NULL` | never reached: a tier-1 cache hit answered first |

Verified across all three on live traffic — and the very first test run caught a
real one:

| row | `match_type` | `semantic_skipped` | latency |
|---|---|---|---|
| fresh, tier ran | `fresh` | `f` | 6,873 ms |
| tier-1 hit | `cache_hit` | `NULL` | 54 ms |
| **quota error** | `fresh` | **`t`** | 29,813 ms |

The last row is the failure this whole thread was about, now legible instead of
hiding inside `fresh`: `semanticSkipReason: 'embedding_unavailable'`, and the
~30 s reflects the new retry waiting ~10 s before giving up and falling through.

The schema change is additive and nullable, so it cannot break existing rows.

**Surfaced in the dashboard.** `Log Query` uses `SELECT *` only inside its CTEs;
the rows it actually returns come from an explicit `json_build_object`, so a new
column reaches the client only when named there — adding it to the table was not
enough. The projection now carries `semanticSkipped`, `LogRow` types it as
`boolean | null`, and `QuestionLog` marks a degraded turn with a red **degraded**
badge beside the match type, explained on hover. It is deliberately shown only
when the value is exactly `true`: a plain `fresh` is a genuine miss and gets no
marker, which keeps the badge rare enough to mean something. The flag is also
added to the page CSV export so it survives into offline analysis.

**`Judge Same Question` now gets the same treatment.** It calls the same Gemini
API behind the same `continueRegularOutput` fallback, so it had the identical
blind spot one stage later: the judge going down and the judge answering
`DIFFERENT` both end the turn as a cache miss, while meaning opposite things —
one is a degraded turn that *should* have been reusable, the other is the design
working. It now carries `retryOnFail: true, maxTries: 3, waitBetweenTries: 5000`,
and `Check Verdict` sets `semanticSkipped` with reason `judge_unavailable` when
the judge returns an error or an empty verdict.

The failure is folded into the **same** `semantic_skipped` column rather than a
second boolean: from the log's point of view `embedding_unavailable`,
`lookup_failed` and `judge_unavailable` are one question — "did this `fresh`
turn happen because nothing matched, or because the tier could not finish?" —
and `semanticSkipReason` separates them when that matters.

`Check Verdict` deliberately **takes precedence** over `Semantic Lookup` in the
logger, because the two can legitimately disagree: the lookup succeeds (it found
a candidate) and the judge fails afterwards. Verified on a throwaway clone whose
judge URL pointed at a non-existent model, so production was never broken to
test it:

```
Semantic Lookup : candidateFound=true, score=0.963, semanticSkipped=false
Judge           : error "The resource you are requesting could not be found"
Check Verdict   : semanticSkipped=true, semanticSkipReason='judge_unavailable'
logged          : semantic_skipped=t, match_type='fresh'
```

Had the logger kept reading `Semantic Lookup`, that degraded turn would have
been recorded as a genuine miss — the precedence is the whole point, not a
detail. Both genuine `DIFFERENT` verdicts tested alongside it logged `false`,
so the flag does not simply mark every cache miss.

---

## 8. Cross-cutting design principles worth naming in the report

1. **Degrade, never break.** Every added subsystem — semantic lookup, Qdrant
   indexing, logging, branding load, typo correction — is wrapped so its failure
   produces a normal turn rather than an error. The user-facing path gained no
   new hard dependencies.
2. **Cheap verification beats threshold tuning.** The semantic-cache result is
   the clearest instance: a small deterministic LLM call solved what no
   similarity cut-off could.
3. **Config over code.** Branding, the typo lexicon and the admin passcode all
   live in data (a mounted JSON file, a Postgres row) and are edited from the UI.
   Nothing about a client requires a rebuild.
4. **Observability was built with the feature, not after it.** `match_type`,
   `latency_ms`, `is_unknown`, `raw_question` and `corrections` exist so each
   subsystem can be *measured* — the dashboard reports cache hit rate, p95
   latency, unknown rate and correction frequency directly.

---

## 9. Repo landmarks

| Path | What |
|---|---|
| `docker-compose.yml` | Redis + Postgres services, port hardening, branding mount |
| `postgres_init/init.sql` | log table, indexes, `admin_settings`, lexicon seed |
| `build_semantic_cache.py` | script that patched the semantic-cache nodes into the workflow |
| `branding/branding.json` | the IUL tenant document |
| `tools/build_mascot_assets.py` | flattens the vendor mascot pack into runtime assets |
| `web/public/mascot/` | generated mascot artwork: 3 composites + face overlays |
| `web/src/components/Mascot2D.tsx` | the rigged 2D avatar |
| `web/src/lib/mascotRig.ts` | generated registration/pivot constants |
| `web/ws-server.ts` | Bun sidecar: `/api/branding`, asset upload |
| `web/src/lib/branding/` | `types` `defaults` `color` `theme` `store` `context` `scope` |
| `web/src/hooks/useSTT.ts` | recording, container selection, silence gate |
| `web/src/lib/api.ts` | webhook client + `audioFileName()` container mapping |
| `web/src/lib/adminApi.ts` | typed admin client + error classes |
| `web/src/components/admin/` | dashboard, lexicon editor, branding tab, charts |
| `web/tailwind.config.js` | scale re-pointing that makes retheming free |
| `*_backup*.json` | pre-edit workflow snapshots (gitignored, local scratch) |
