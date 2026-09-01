# Multi-Tenant SaaS Architecture

**Status:** design proposal — no code changes made
**Date:** 2026-08-30
**Companion to:** `docs/SYSTEM-CHANGES.md` (the engineering record this builds on)

Every claim about the current system in this document was verified against the running stack on 2026-08-30 and is cited to a file path or an API call. Where something is an estimate or needs checking before it is relied on, it is marked ⚠️.

---

## 1. Problem and commercial goal

The assistant is being sold to multiple businesses. The commercial requirement is that a client gets **the service, never the source**: they point a domain at our infrastructure, receive a branded assistant and a read-only analytics panel, and we retain control of branding, artifacts, and the code.

### Topology is not what protects the source

Worth saying at the outset, because it removes a false constraint from the architecture decision.

Whether we run one shared stack or one container per client, **the source code never leaves our infrastructure in either case**. The client receives HTTP responses. That is what protects the IP — not the container layout. This is exactly the model the brief compares against: an API and a web app, no repository.

So the architecture should be chosen on **operating cost and maintainability**, not on intellectual-property grounds. Those two criteria point clearly in one direction.

### The four questions this document answers

1. What is the right multi-tenant architecture for *this* stack?
2. How does a client's domain get connected, and what does onboarding look like?
3. Who pays for inference, how is it metered, and what do we charge?
4. Should registration be whitelist-only or open?

---

## 2. Where the stack is single-tenant today

The stack is single-tenant **everywhere except the browser**. The only tenant-awareness that exists is cosmetic: one branding document, and localStorage/IndexedDB key namespacing in `web/src/lib/branding/scope.ts`.

Everything below was confirmed live on 2026-08-30.

| State | Location | Current key / scope |
|---|---|---|
| Answer + audio cache | Redis | `faq:<djb2 hash>` — six nodes, no tenant prefix |
| Semantic cache vectors | Qdrant `faq_cache` | point id = `parseInt(questionHash, 16)` |
| Knowledge base | Qdrant `local_docs` | collection hardcoded, `options: {}` (no filter) |
| Conversation memory | n8n process RAM | client-supplied `sessionId`, fallback `default-session` |
| Analytics | Postgres `receptionist_session_logs` | no tenant column; 164 rows today |
| Admin passcode | Postgres `admin_settings` | one global row |
| Typo lexicon | Postgres `admin_settings` | one global row |
| Domain knowledge | `AI Agent` system message | inlined in the workflow |
| STT vocabulary | `Groq STT` node `prompt` param | inlined in the workflow |
| Timezone | `Asia/Beirut` | hardcoded in the overview SQL |
| Branding | `branding/branding.json`, bind-mounted | one file per container |
| Brand assets | `${ASSET_DIR}/<slot>.<ext>` | **fixed global filenames** (`web/ws-server.ts:161`) |
| Hardware WS relay | two process-global `Set`s | no rooms, broadcasts to all (`web/ws-server.ts:224-228`) |
| Credentials | n8n credential store | 6 shared, ids hardcoded in nodes |

The frontend, by contrast, is already tenant-ready. `TenantConfig.id` namespaces browser storage, and `scope.ts` applies it to chat sessions and the voice-retry IndexedDB. **The browser is done; nothing server-side has started.**

### ⚠️ A methodology note that changes how you read any workflow claim

`GET /api/v1/workflows/:id` returns **two different graphs**:

```python
w = json.load(open(path, encoding='utf-8'))
running = w['activeVersion']['nodes']   # the published version serving traffic
draft   = w['nodes']                    # the unpublished editor draft
```

On 2026-08-30 these differed by **17 nodes**. The draft had the entire Tier-2 semantic cache and all three typo-tolerance layers deleted; production was still running the full 47-node graph. Reading the top-level `nodes` array produces a convincing false alarm.

**Live hazard, unrelated to multi-tenancy but worth acting on now:** that destructive draft is still sitting in the editor (`versionId 802bfc1d…` vs `activeVersionId 41bcb7c4…`). Anyone who opens Agent Workflow and clicks Publish ships it, and the semantic cache plus all typo tolerance vanish from production with no error. Either restore the draft from the active version or discard it.

---

## 3. The architecture decision: pooled, not container-per-tenant

**Recommendation: one shared stack with `tenant_id` threaded through every layer, plus a dedicated-stack "Enterprise" tier that reuses the same image and the same `tenant_id` code path.**

### Why not a container stack per tenant

The brief proposed spinning up a container or image per client. The decisive argument against it is not RAM — it is **workflow maintenance**.

The Agent Workflow is 47 nodes carrying the two-tier cache, the LLM judge, the typo lexicon and the TTS chunking. `docs/SYSTEM-CHANGES.md` is a record of continuously improving it. Fork that per tenant and every future improvement becomes N manual edits across N n8n instances, applied by hand through a UI, with no diff and no rollout control. The forks drift, and the drift is invisible until a tenant reports a bug that exists only in their copy. **That is the failure mode that kills the product's ability to ship.**

Secondary arguments: n8n idle RSS is roughly 700 MB–1 GB, so a handful of tenants exhausts a normal VPS; N Postgres instances means N backup and migration regimes; and `docker-compose.yml` hardcodes `container_name` on every service and uses host bind mounts throughout, so it **cannot be run twice on one host** without being rewritten anyway.

### Why pooled works here

The per-tenant surface is small and almost entirely *data*: a system prompt, a document corpus, a lexicon, a branding document, a timezone, a set of colours. None of that is code. The workflow graph is identical for every tenant. That is the textbook case for pooled multi-tenancy.

### The Enterprise tier keeps the option open

A client who contractually requires physical data isolation gets a dedicated stack — **the same image, the same `tenant_id` code path, with exactly one tenant in it**. Because isolation is expressed in the data model rather than the deployment, a silo is a *configuration* of the pooled design, not a fork of it. This tier is also the only place bring-your-own API keys can work (§9).

| | Pooled (default) | Enterprise silo |
|---|---|---|
| Stack | shared | dedicated |
| Workflow updates | once, everywhere | once per silo (few of them) |
| Data isolation | logical (`tenant_id`) | physical |
| BYO API keys | not possible | yes |
| Cost to serve | marginal | a full stack |

---

## 4. Request lifecycle

Where tenant identity is established is the most important detail in the design.

```
  Browser  (amba.client.com)
     |  HTTPS
     v
  +----------------------------------------------------------+
  | Caddy                                                    |
  |  - TLS: wildcard (DNS-01) for *.ourplatform.com          |
  |         on-demand for customer CNAMEs, gated by `ask`    |
  |  - strips any client-supplied X-Tenant-Id                |
  |  - forwards the validated Host                           |
  +----------------------------------------------------------+
     |
     v
  +----------------------------------------------------------+
  | Control plane  (Bun - today's ws-server.ts, promoted)    |
  |                                                          |
  |  == TENANT IDENTITY IS ESTABLISHED HERE ==               |
  |  Host -> tenant, in-memory map. Never from the request   |
  |  body, never from a client-supplied header.              |
  |                                                          |
  |  - serves the BUILT React bundle (no Vite in prod)       |
  |  - auth: users, argon2, cookie sessions                  |
  |  - branding by host                                      |
  |  - analytics SQL straight to Postgres                    |
  |  - injects resolved tenant config into the webhook body  |
  +----------------------------------------------------------+
     | internal network only
     v
  +----------------------------------------------------------+
  | n8n  (Postgres backend, queue mode, header-auth webhook) |
  |  one Agent Workflow, all tenants, config from the body   |
  +----------------------------------------------------------+
     |
     v
  Redis  t:<tenant>:faq:...   Qdrant  docs_<tenant>, faq_cache_<tenant>
  Postgres  ... WHERE tenant_id = $n
```

The rule that makes this safe: **tenant identity is derived once, server-side, from the validated Host, and is never accepted from anything the client controls.**

---

## 5. Tenant identity, domains, and TLS

### Two ways in, deliberately

- **`<tenant>.ourplatform.com`** — provisioned instantly, covered by one wildcard certificate obtained via DNS-01. Available the moment a tenant is created, which matters for sales demos.
- **A customer domain** (`amba.client.com`) — the client creates a CNAME to our ingress. Certificate issued automatically on first request via on-demand TLS.

Supporting both costs almost nothing extra. Subdomain-only would weaken the white-label story the branding work exists to serve; custom-only means nothing works until DNS propagates, so there is no instant demo URL.

### On-demand TLS and the `ask` endpoint

```
{
  on_demand_tls {
    ask http://control-plane:3001/internal/tls-check
  }
}
```

Caddy sends `GET /internal/tls-check?domain=amba.client.com` at handshake time for an unknown SNI. **Any 2xx means issue the certificate; anything else refuses.** The response body is ignored. Once a certificate is cached, no further asks until renewal.

Three rules for the handler, all load-bearing:

1. **Fail closed.** If the database is unreachable, return 5xx. A handler that returns 200 on error lets anyone pointing DNS at our IP mint certificates until we hit the Let's Encrypt rate limit and are locked out for a week. This is the standard way people blow up on-demand TLS.
2. **Exact match only** against `tenant_domains`. No wildcards, no suffix matching.
3. **Rate-limit the handler itself.**

Restricting on-demand TLS to customer CNAMEs — with platform subdomains on a wildcard cert — keeps the blast radius to the CNAME set and keeps subdomain provisioning instant.

### Tenant resolution happens in the app, not in Caddy

This corrects the obvious first design. **Caddy cannot look up a tenant id in a database.** `{host}` gives the hostname, and a `map` directive gives only a static translation table that needs a config reload on every new tenant — which defeats the purpose.

So Caddy does what it is good at: TLS termination, certificate gating, and stripping spoofed headers.

```
reverse_proxy control-plane:3001 {
  header_up -X-Tenant-Id
  header_up X-Forwarded-Host {host}
}
```

The control plane holds the Host→tenant map in memory and resolves in nanoseconds. One less moving part, and one less place for the mapping to go stale.

*(A `forward_auth` + `copy_headers` variant can put the tenant id on the wire before the app sees it, but it adds a synchronous internal round-trip to every request including static assets, for a lookup the app was going to do anyway. Not worth it now.)*

---

## 6. The control plane

`web/ws-server.ts` is already a real HTTP server handling `/api/*`. Promote it into its own service and give it the jobs that currently have no home.

### What it takes on

| Job | Today | After |
|---|---|---|
| Serving the app | Vite **dev server** in production | the built bundle from `web/dist` |
| Tenant resolution | does not exist | Host → tenant, in memory |
| Auth | shared passcode, two different mechanisms | users table, argon2, cookie sessions |
| Branding | one JSON file | per-tenant record, resolved by host |
| Analytics | `/webhook/admin-stats` in n8n | SQL directly against Postgres |
| Webhook access | Vite proxy | authenticated proxy to an internal-only n8n |

### Why kill Vite in production

`web/vite.config.ts` runs the **dev server** with `host: "0.0.0.0"` and no `allowedHosts`, and `web/Dockerfile:15` starts it with `bun run dev`. A dev server is not designed to face the internet — the Vite 5.4.x line has had arbitrary-file-read CVEs — and putting one behind a proxy that accepts arbitrary Host headers per tenant is not a posture worth defending.

The replacement is easy. `bun run build` already exists (`tsc -b && vite build`) and `web/dist` is already produced. **Routing is hash-based** (`main.tsx:29-31` matches `#/admin`), so the only real path the browser requests is `/` — no SPA-fallback complexity. The three Vite proxy rules become a few lines of `Bun.serve` URL rewriting; Bun streams request and response bodies, so the multipart audio upload and the base64 audio response both work unchanged.

### Auth model

Replace all three of today's mechanisms — the Postgres passcode hash, the plaintext `ADMIN_PASSCODE` env var, and the passcode in `sessionStorage` — with one.

- `users` table: `tenant_id`, email, argon2id password hash, role.
- Roles: `operator` (us, global), `tenant_admin`, `tenant_viewer`.
- Cookie sessions: HTTP-only, Secure, SameSite=Lax, scoped to the tenant's domain.
- Entitlements as **per-tenant capability flags** — `can_edit_branding`, `can_edit_lexicon` — rather than hardcoded restrictions. Analytics-only is the default; flipping a flag for one client later then costs nothing.

⚠️ **Migration ordering.** The passcode is the only working auth in the system. Keep it functioning in parallel until the session path has been exercised, then remove it in a separate change. Do not do both at once.

### The two panels

| | Client panel | Operator console |
|---|---|---|
| Where | their own domain, `#/admin` | `console.ourplatform.com` |
| Analytics | their tenant only | any tenant |
| Usage / spend | their tenant only (§9) | all tenants, plus cost |
| Question log + CSV | yes | yes |
| Branding, theme, avatar, features | **no** | yes |
| Documents, system prompt, lexicon | **no** | yes |
| Tenant CRUD, domains, invites | no | yes |
| View-as-tenant | no | yes |

The existing `web/src/components/admin/` tree needs **no changes** to serve the client panel. `web/src/lib/adminApi.ts` is already a clean `AdminClient` interface with a swappable implementation (there is a mock client behind `#/admin?mock=1`). If the new control-plane endpoints return the existing typed shapes (`OverviewResponse` and friends) byte-identically, swapping `/webhook/admin-stats` for `/api/admin/*` is a **single-file change**.

The Branding tab moves to the operator console essentially as-is.

---

## 7. Data-layer isolation

Two of these are not cosmetic namespacing — they are the difference between a mixup and a cross-tenant data leak.

### Postgres — genuinely cheap

All three analytics queries funnel through a **single leading CTE** holding the only reference to the base table. Verified on the published Admin Dashboard API:

| Query | Size | Base-table refs |
|---|---|---|
| Overview Query | 6,741 chars, 17 CTEs | **1** (`scoped`) |
| Log Query | 1,170 chars | **1** (`filtered`) |
| Corrections Query | 1,222 chars | **1** (`scoped`) |

So the tenant predicate is **one line per query, three lines total**:

```sql
WITH scoped AS (
  SELECT * FROM receptionist_session_logs
  WHERE timestamp >= $1::timestamptz AND timestamp <= $2::timestamptz
    AND tenant_id = $3                      -- the entire change
),
```

Whoever wrote those queries left a perfect seam. Migration:

```sql
ALTER TABLE receptionist_session_logs ADD COLUMN tenant_id TEXT;
UPDATE receptionist_session_logs SET tenant_id = 'iul' WHERE tenant_id IS NULL;
ALTER TABLE receptionist_session_logs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE receptionist_session_logs ADD COLUMN execution_id TEXT;   -- for metering, §9

-- every index gains tenant_id as the leading column
DROP INDEX idx_rsl_timestamp;
CREATE INDEX idx_rsl_tenant_ts ON receptionist_session_logs (tenant_id, timestamp DESC);
-- ... same for qhash, session, and the partial unknown index

ALTER TABLE admin_settings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'iul';
ALTER TABLE admin_settings DROP CONSTRAINT admin_settings_pkey;
ALTER TABLE admin_settings ADD PRIMARY KEY (tenant_id, key);
```

`'iul'` is the correct backfill value — it is the `id` in `branding/branding.json` already flowing into `setTenantScope()` at `web/src/main.tsx:41`. Only 164 rows exist, so the backfill is instant.

⚠️ **Two ordering traps.** `postgres_init/init.sql:45` seeds the lexicon with `ON CONFLICT (key) DO NOTHING`, and the live `Lexicon Save` node does `ON CONFLICT (key) DO UPDATE`. Both must become `ON CONFLICT (tenant_id, key)` or they break the moment the primary key changes.

New tables: `tenants`, `tenant_domains`, `users`, `usage_events`.

### Redis — a prefix, six places

`t:<tenant>:faq:<hash>`. Six nodes build these keys today (`Check Redis Cache`, `Save to Redis Cache`, `Save Audio to Cache`, `Fetch Semantic Hit`, and the two `(Corrected)` dual-write nodes), all as expressions like `={{ 'faq:' + $json.questionHash }}`. Mechanically simple; just do all six.

### Qdrant — two real problems

**Problem 1: a mandatory payload filter fails *open*.**

The intuitive design — one shared collection with a `tenant_id` payload field and a filter on every search — has the wrong failure mode. If `tenantId` ever resolves empty (a config load returning no rows, a missing body field, an expression silently evaluating to nothing), the filter becomes `{}` or vanishes, and the retriever returns **every tenant's documents** into the agent's context, which is then read aloud to a stranger. No error, no alert, and the log row looks completely normal.

**Use per-tenant collections instead** (`docs_<tenant>`, `faq_cache_<tenant>`). The same failure produces a nonexistent collection name and a hard 404. It **fails closed**.

This is cheap to do: the Qdrant Vector Store node's `qdrantCollection` is a resource locator in `mode: "id"`, which accepts an expression. Revisit the shared-collection plus `is_tenant` index scheme only past a few hundred collections — and budget it properly when you do, because `is_tenant: true` needs a keyword payload index and per-tenant HNSW subgraphs need `hnsw_config: { m: 0, payload_m: 16 }`, which cannot be set in place. That is a collection recreate plus a full re-embed at 3072 dimensions.

**Problem 2: the semantic cache will serve one tenant's answer to another, and a Redis prefix does not fix it.**

From the published `Index Question Vector` node:

```js
const id = parseInt(nh.questionHash, 16);
url: 'http://qdrant:6333/collections/faq_cache/points',
body: { points: [{ id, vector: vec, payload: {
  questionHash: nh.questionHash, question: correctedQuestion } }] },
```

The point id is a number derived from the **normalized question text alone**. Two tenants both asking *"what are the tuition fees"* produce the **same point id**; the second PUT overwrites the first. `Semantic Lookup` then matches it — with `score_threshold: 0.8` and **no filter** — the judge correctly answers SAME because the questions genuinely are identical, and tenant A receives **tenant B's cached answer verbatim, with audio.**

Qdrant point ids must be an unsigned integer or a UUID, so a string prefix is not available. Two fixes:

- **UUIDv5 over `tenant_id + questionHash`** — deterministic, collision-free, no id-space arithmetic; or
- **per-tenant cache collections**, consistent with the fail-closed argument above.

Both call sites are our own Code nodes, so this is a URL-template and id change.

⚠️ One principle needs splitting here. Both nodes swallow all errors by design ("indexing is best-effort; never break the response over it"). That is right for availability and **wrong for an isolation control** — a tenancy filter that silently no-ops is worse than a hard failure. Isolation failures should throw; everything else keeps degrading gracefully.

### Conversation memory

`sessionKey` is currently `={{ $('Webhook').item.json.body?.sessionId || 'default-session' }}` — client-supplied, unauthenticated, with a shared fallback bucket that pools every anonymous turn across all tenants.

- Prefix it: `t:<tenant>:chat:<sessionId>`.
- **Mint the session id server-side** (signed, tenant-bound) rather than trusting a browser value generated by `Math.random()`. The control plane is issuing cookies anyway.
- Make a missing `sessionId` a hard 400 rather than falling back to a shared bucket.
- ⚠️ **And move off `memoryBufferWindow` entirely.** It is in-process RAM. The moment n8n runs in queue mode with multiple workers (§8), consecutive turns from the same user land on different workers and the buffer is empty half the time — conversation memory silently degrades to none, with no error. Prefixing the key does not fix this. Use Redis chat memory; Redis is already in the stack.

---

## 8. n8n as a shared execution plane

**One n8n instance in its current configuration is not safe to share between tenants.** This is the largest piece of prerequisite work in the whole plan, and it is cheaper to do before there are paying tenants than after.

### Four compounding problems

- **SQLite.** `docker-compose.yml` sets no `DB_TYPE`, so n8n runs on SQLite. `n8n_local_data/database.sqlite` is **240 MB with an 11.5 MB WAL** from a single tenant's pilot traffic. SQLite is single-writer, and every execution writes execution data synchronously. This becomes latency on the user path, not a clean error.
- **No pruning.** There is no `EXECUTIONS_DATA_PRUNE*` anywhere (verified: zero matches). That is why the file is 240 MB after a pilot.
- **Single process, unbounded concurrency.** n8n in main mode runs executions on one Node event loop, with no `N8N_CONCURRENCY_PRODUCTION_LIMIT`. And look at what runs on that loop: `Build JSON (Text + Audio)` does `Buffer.concat` over raw PCM and hand-builds a WAV header in-process, for every audio turn, for every tenant. **One tenant's demo day is every tenant's outage.**
- **No isolation primitive.** n8n has no tenant concept, every credential is global, and there is no `networks:` block in `docker-compose.yml`, so any Code node can reach `http://qdrant:6333` unauthenticated — as `Semantic Lookup` already does.

### Prerequisites before tenant #2

```yaml
DB_TYPE=postgresdb                    # off SQLite
EXECUTIONS_MODE=queue                 # + Redis, 2+ workers
N8N_CONCURRENCY_PRODUCTION_LIMIT=...  # bound the blast radius
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=168           # hours; must exceed the metering drain window (§9)
```

Queue mode also provides the natural lever for tier isolation: a dedicated worker pool per Enterprise tenant, same image, same code path.

### Inject tenant config; do not query for it

Trace the graph: `Webhook → Switch → … → Normalize & Hash Question → Check Redis Cache`. **The Redis lookup is nearly the first thing that happens**, and it needs the tenant id to build its key. So tenant config must be resolved before the fastest path in the system — the cache hit that `docs/SYSTEM-CHANGES.md` measures at 290–340 ms.

Loading it with a Postgres query inside the workflow adds a synchronous round-trip to **every** turn, including cache hits, on one event loop. That taxes the cheapest, highest-volume path to serve the rarest one.

**Instead, the control plane merges the resolved tenant config into the request body before forwarding.** n8n does zero extra I/O, the config cache and its invalidation live where they can be reasoned about, and tenant identity is established by a trusted party before a single node runs.

⚠️ **The security corollary is not optional.** The webhook has **no authentication at all** today. Once tenant config arrives in the request body, anyone who can reach `n8n:5678` can impersonate any tenant, override the system prompt, and point the vector store at another tenant's collection. n8n must be on an internal-only network, and the webhook node needs a Header Auth credential holding a secret only the control plane knows.

### What is expression-driven (so one workflow really can serve everyone)

Confirmed against the published workflow — these already use expressions elsewhere, so the pattern is proven in production:

| Per-tenant field | Node | Mechanism |
|---|---|---|
| System prompt | `AI Agent` | `options.systemMessage` — plain string parameter |
| Knowledge collection | `Qdrant Vector Store` | `qdrantCollection` resource locator, `mode: "id"` |
| STT vocabulary | `Groq STT` | multipart body parameter `prompt` |
| Memory key | `Window Buffer Memory` | `sessionKey` (already an expression) |
| Cache keys | six Redis nodes | already expressions |
| Cache collection | two raw-HTTP Code nodes | our own request bodies |

⚠️ **The curly-brace footgun.** The Tools Agent composes a LangChain prompt template from the system message using f-string interpolation. A tenant prompt containing `{` or `}` — a JSON example, or `Hi {name}` — produces `Missing value for input variable` and the agent **hard-fails on every turn**. The control plane must reject or escape braces at write time, and a smoke test should run one real turn against a tenant's prompt before it goes live.

### Blast radius

With one workflow for all tenants, a bad edit takes down every tenant simultaneously. There is no canary and no per-tenant pin. Minimum mitigations: server-side prompt validation, a synthetic turn against the tenant's config before publish, and a workflow-version pin per tenant so a change can be rolled to a subset first. The `activeVersion` versioning described in §2 is the mechanism this would build on.

---

## 9. Metering and cost

### Token counts are already being recorded

Verified on execution 743 (a full fresh turn) via `GET /api/v1/executions/:id?includeData=true`:

```
Gemini (Agent LLM):  {promptTokens: 1200, completionTokens: 25}
Gemini (Agent LLM):  {promptTokens: 0,    completionTokens: 20}
Gemini (Tool LLM):   {promptTokens: 201,  completionTokens: 62}
Judge Same Question: {promptTokenCount: 135, candidatesTokenCount: 3}
Gemini TTS:          {promptTokenCount: 40,  candidatesTokenCount: 380,
                      candidatesTokensDetails: [{modality: "AUDIO", tokenCount: 380}]}
```

Two things this settles:

- **The LangChain Agent node hides token usage from its output** (downstream nodes see only `{output: string}`), but n8n's tracing callback records it in **execution data**. It is retrievable.
- **One turn is 4–5 LLM calls, not one.** The agent loop re-sends the growing context each step. Billing a turn as one call under-bills by roughly 4–5×.
- The TTS node reports `modality: "AUDIO"` separately, which is exactly what is needed to price it at audio rates.

### How to read it

1. Add `execution_id TEXT` to `receptionist_session_logs`, set from `$execution.id` in `Anonymize Log Entry` (that node already runs on every path).
2. A worker in the control plane drains rows where `metered_at IS NULL`, calls the executions API, walks `data.resultData.runData`, sums `tokenUsage` across every `ai_languageModel` sub-run plus `usageMetadata` from the HTTP nodes, and writes one `usage_events` row per turn.
3. Cheap belt-and-braces: capture `usageMetadata` from the three HTTP nodes synchronously into the log row as well. TTS is the dominant cost and is **already fully observable** without any of the above.

⚠️ This creates a hard dependency on execution retention. The metering worker must drain faster than the prune window (§8), and its failure must be loud.

⚠️ **Do not estimate tokens from character counts.** Traffic is bilingual; Gemini's tokenizer runs roughly 1 token per 1–2 characters for Arabic versus ~4 for English, so a single estimator misprices tenants by around 3× depending on language mix — and it cannot see retrieved RAG documents or the accumulating tool-loop context, which is where most of the tokens are.

### What a turn actually costs

Using execution 743's real counts. ⚠️ Provider rates are indicative and must be re-checked before any price is published; the arithmetic is the point, not the constants.

| Component | Measured | Indicative rate | Cost |
|---|---|---|---|
| Text input | 1,576 tok | $0.30 / 1M | $0.00047 |
| Text output | 110 tok | $2.50 / 1M | $0.00028 |
| **TTS audio output** | **380 tok** | **~$10 / 1M** | **$0.0038** |
| STT (voice turns) | ~10 s audio | ~$0.04 / hr | $0.0001 |
| Embedding | 1 call | — | negligible |
| **Fresh voice turn** | | | **≈ $0.0046** |
| **Cache hit** | Redis GET only | | **≈ $0** |

**TTS is ~82% of the marginal cost of a turn.** And a cache hit is essentially free, because Redis stores the audio too — which is why cache entries average ~0.55 MB.

### The finding that should shape pricing

At a 60% cache-hit rate the blended cost is about **$0.0018 per conversation**. A tenant doing 5,000 conversations a month therefore costs roughly **$9 in inference**.

That is far below the cost of the infrastructure they sit on. **Marginal cost per tenant is dominated by fixed infrastructure, not by usage.**

Three consequences:

1. **Do not build metering to recover inference cost** — there is barely any to recover. Build it for **abuse protection** (a runaway loop or a scraper, not normal usage) and for **tier definition**.
2. **Flat-rate pricing with generous limits is correct.** Usage-based billing would add billing complexity, procurement friction, and customer anxiety to recover single-digit dollars.
3. **The cache is a margin engine, not just a latency feature.** A cache hit costs nothing and earns full price. The two-tier cache and typo-tolerance work in `docs/SYSTEM-CHANGES.md` raise gross margin directly — which is a much better argument for that work than "it feels faster."

⚠️ With 164 log rows the system is still a pilot, so all volume figures are projections. Re-derive them from `usage_events` once real traffic exists.

### The BYO-API-key answer

**Per-tenant API keys cannot work on the pooled tier.** n8n binds credentials at design time and offers **no expression-driven credential selection** — the `lmChatGoogleGemini` nodes are pinned to credential `3NeEadTXR21DloX6`, and the same is true of the Qdrant, Postgres, Redis and Groq credentials. There is no supported way for one shared workflow to select a tenant's own key at runtime.

This is a good outcome commercially:

- **Pooled tiers run on our keys.** Given the cost analysis above, that is the right default anyway — the client is buying an assistant, not tokens, and $9 of inference is not worth pushing onto their procurement process.
- **BYO keys become an Enterprise/dedicated-tier feature.** That tier has its own stack and therefore its own n8n credentials, and it is the tier whose buyers actually ask for it.

⚠️ There is one path that would unlock BYO keys on the pooled tier: **replace the LangChain Agent node with a hand-rolled tool loop of HTTP Request nodes**, where the API key is an ordinary expression. That would also yield synchronous token counts and remove the execution-data dependency. It is a real option, but it means owning the agent loop — treat it as a costed future project, not a quick change.

*(The credential's `base_url` is genuinely plumbed through, so an LLM gateway is technically possible. But it cannot attribute a call to a tenant — there is no way to inject a per-execution header — so it is useful for rate limiting and key rotation, not for billing.)*

### The client's usage panel

Read-only, sitting beside analytics, showing **conversations** — not tokens:

- conversations used vs. included this period
- cache-hit rate (framed as "answered instantly")
- projected overage, if any

For a BYO-key Enterprise tenant, the same panel shows **estimated provider cost** computed from our own token counts at published list rates, clearly labelled an estimate. We cannot read their Google billing account, and pretending otherwise would be wrong.

---

## 10. Commercial model

**Bill conversations, not tokens.** A turn is 4–5 agent calls plus an embedding, a judge, STT and TTS — tokens are not comparable across those, raw-token pricing exposes us to provider price changes, and "your plan includes 5,000 conversations a month" is far easier to sell than a token meter. Track tokens internally for cost truth; expose conversations to the customer.

⚠️ Indicative packaging. The tier boundaries are a starting point for a pricing conversation, not a recommendation to publish these numbers.

| | Starter | Growth | Enterprise |
|---|---|---|---|
| Conversations / month | 2,000 | 10,000 | negotiated |
| Domain | `<tenant>.ourplatform.com` | + custom domain | + custom domain |
| Documents | limited corpus | larger corpus | unlimited |
| Isolation | pooled | pooled | **dedicated stack** |
| BYO API keys | — | — | yes |
| Support / SLA | email | priority | SLA |
| Overage | per conversation | per conversation | negotiated |

Given §9, gross margin on the pooled tiers is very high, and the binding constraint is **fixed infrastructure per pooled cluster**, not per-tenant usage. Price on delivered value — a branded, document-grounded, voice-capable assistant with an analytics dashboard — rather than on cost-plus.

---

## 11. Registration and onboarding

### Whitelist. Not open self-serve.

**Recommendation: operator-provisioned, invite-only, with a public "request access" form for lead capture.** Four reasons, all specific to this product:

1. **Every tenant needs a DNS change on their side.** That is already a human step that self-serve signup cannot complete.
2. **Every tenant needs a document corpus ingested and a system prompt written.** That is service delivery, not a signup form. Today it is also a workflow edit (§2), and even after §8 it remains a curated step.
3. **Every turn has real marginal cost.** Open signup without a card means paying for strangers' traffic, and there is no quota system yet.
4. **There is no billing system**, and B2B at dozens of accounts does not need self-serve — that is for thousands of small accounts.

The public site should capture demand, not provision it: a "request a demo" form that creates a lead, not a tenant.

### Onboarding flow

```
1. Lead        public "request access" form -> lead record
2. Provision   operator creates tenant in the console:
               slug, plan, timezone, subdomain
               -> docs_<tenant> + faq_cache_<tenant> created
               -> <tenant>.ourplatform.com live immediately
3. Content     operator uploads documents, writes the system prompt
               and STT vocabulary, seeds the typo lexicon
               (brace validation runs here - see section 8)
4. Invite      signed single-use link, 72h expiry, emailed to the client
5. Setup       client sets admin email + password
               -> first tenant_admin user created
6. Domain      client adds a CNAME; we verify ownership;
               on-demand TLS issues the certificate on first request
7. Live        client panel shows analytics and usage from turn one
```

The "configure it at startup" idea from the brief lands as **step 5 — the invite wizard**. The client never touches a config file, and never needs an API key.

⚠️ Steps 3 and 6 are the ones that will actually consume operator time. Worth measuring on the first two tenants before promising an onboarding SLA.

### Why the analytics-only boundary should still be a flag

The client panel is analytics-only by decision. Implement that as a per-tenant capability flag (`can_edit_branding`, default off) rather than a hardcoded restriction — identical behaviour today, and flipping it for one client later costs nothing.

Worth flagging as a commercial tradeoff to revisit: withholding branding edits keeps visual consistency and creates a service touchpoint, but every tagline tweak becomes a support ticket. The flag makes that a per-account decision rather than an architectural one.

---

## 12. Migration path

### Fix now — independent of multi-tenancy

| Issue | Evidence |
|---|---|
| **Branding writes are unauthenticated in production.** `docker-compose.yml:102` interpolates `${ADMIN_PASSCODE}` but `.env:13` defines `ADMIN_DASHBOARD_PASSCODE`. Confirmed empty in the running container. The guard is `if (ADMIN_PASSCODE && …)` (`ws-server.ts:98,135`), so an empty value **disables the check**. Anyone who can reach port 3001 can rewrite branding and upload assets. | verified live |
| **The destructive workflow draft** — one Publish click from removing the semantic cache and all typo tolerance (§2). | verified live |
| **No execution pruning.** 240 MB SQLite + 11.5 MB WAL. | verified live |
| **`ws-server.ts` is not type-checked** — `web/tsconfig.json:21` includes only `["src", "vite.config.ts"]`. It is about to become a production API service. | verified |
| **`CLAUDE.md` and `README.md` are stale** — both describe Ollama, Piper and Whisper as live. Inference is Gemini + Groq; those containers are vestigial or bypassed. | verified |

### Phase 1 — must land before tenant #2

Nothing here is optional; the first three are correctness, not scaling.

1. n8n onto Postgres, queue mode, pruning, concurrency limit.
2. Qdrant per-tenant collections + UUIDv5 (or per-tenant) cache point ids — closes the cross-tenant answer leak.
3. Redis key prefixes (six nodes); Redis-backed chat memory with a server-minted, tenant-scoped session id.
4. Postgres migration: `tenant_id`, `execution_id`, index rewrites, composite `admin_settings` key, the two `ON CONFLICT` fixes.
5. Control plane split out: built bundle, Host→tenant resolution, config injection into the webhook body.
6. n8n on an internal-only network; Header Auth on the webhook.
7. Per-tenant config out of the workflow (system prompt, STT vocabulary, timezone, lexicon) with brace validation.

### Phase 2 — before selling

8. Caddy, wildcard cert, on-demand TLS with a fail-closed `ask` handler.
9. Real auth: users, argon2, cookie sessions, roles, capability flags. Passcode retired *after* the new path is exercised.
10. Analytics moved off `/webhook/admin-stats` into the control plane (three one-line predicate changes, then reimplement ~11 nodes — see the caution below).
11. Operator console: tenant CRUD, domains, invites, branding editor, view-as-tenant.
12. Metering worker and `usage_events`; per-tenant rate limits and quotas.
13. Client usage panel.

### Phase 3 — as demand appears

14. Enterprise silo tier (same image, one tenant), with BYO keys.
15. Tenant-scoped WS rooms and authenticated hardware clients; same-origin WS URL.
16. Per-tenant document upload, if the analytics-only boundary is ever relaxed.

⚠️ **On item 10.** The tracked `admin_dashboard_workflow.json` has 13 nodes; the live workflow has **24**. The export is missing the entire lexicon path (`Validate Lexicon`, `Lexicon Valid?`, `Lexicon Save`) and the corrections path. `Lexicon Save` is a **write** to `admin_settings` with validation logic behind it. Reimplementing from the repo file would silently drop features — work from a fresh `activeVersion` export.

---

## 13. Open questions and risks

| # | Question / risk | Why it matters |
|---|---|---|
| 1 | Do we own a platform domain yet, and where is DNS hosted? | Wildcard cert via DNS-01 needs API access to the DNS provider. Blocks §5. |
| 2 | What is the realistic tenant count in 12 months — 5, 50, or 500? | Under ~10, a simpler design might suffice. Past a few hundred Qdrant collections, per-tenant collections need revisiting. |
| 3 | Who operates this at 3am? | Pooled means one incident affects everyone. Queue mode and pruning reduce but do not remove that. |
| 4 | Is the per-tenant knowledge corpus curated by us indefinitely? | It is the main recurring operator cost and the main argument for eventually giving clients document upload. |
| 5 | Verify provider rates before publishing any price. | Every cost figure in §9 is indicative; the token counts are real, the rates are not verified. |
| 6 | Data residency / retention commitments? | `receptionist_session_logs` stores questions and answers. Multi-tenant means a per-tenant retention policy and an export/delete path. Nothing exists today. |
| 7 | Which tenant is the pilot for phase 1? | Migrating `iul` in place is lower risk than onboarding a new client onto an untested path. |

### The three risks most likely to bite

1. **The n8n shared execution plane (§8).** The largest, least visible piece of work. Doing it after there are paying tenants is far more expensive than doing it now.
2. **The Qdrant fail-open trap (§7).** A tenancy control that silently returns another tenant's documents is the worst failure mode in the design. Per-tenant collections are the mitigation, and the "best-effort, never throw" principle must not be applied to isolation checks.
3. **Auth migration (§6).** The passcode is the only working auth in the system. Replacing it means a window where new, untested auth code guards the operator console. Run both in parallel, then remove.
