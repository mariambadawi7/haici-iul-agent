"""Add retrieve-then-verify semantic caching to the Agent Workflow.

Embeddings only SHORTLIST candidates; a fast LLM decides whether the cached
answer is actually reusable. Measured on 18 adversarial IUL question pairs,
plain similarity had no safe threshold (near-misses scored higher than real
paraphrases); the LLM judge scored 17/18 with zero false positives.
"""
import json

wf = json.load(open("workflow_backup_pre_semantic.json", encoding="utf-8"))
nodes = {n["name"]: n for n in wf["nodes"]}
conns = wf["connections"]

GEMINI_CRED = {"googlePalmApi": {"id": "3NeEadTXR21DloX6",
                                 "name": "Google Gemini(PaLM) Api account"}}
REDIS_CRED = {"redis": {"id": "bDN9Hfgixc2fSuSq",
                        "name": "Redis account (authenticated)"}}
QDRANT = "http://qdrant:6333/collections/faq_cache"

# --- A. Embed the incoming question -------------------------------------
nodes["Embed Question"] = {
    "id": "d47d91a6-43c5-474c-8ec7-b3139b879be5",
    "name": "Embed Question",
    "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
    "position": [-300, 1250],
    "parameters": {
        "method": "POST",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googlePalmApi",
        "sendBody": True, "specifyBody": "json",
        "jsonBody": ("={{ JSON.stringify({ model: 'models/gemini-embedding-001', "
                     "taskType: 'SEMANTIC_SIMILARITY', content: { parts: [{ text: "
                     "$('Normalize & Hash Question').first().json.userText }] } }) }}"),
        "options": {"timeout": 30000},
    },
    "credentials": GEMINI_CRED,
    "onError": "continueRegularOutput",
}

# --- B. Shortlist nearest cached questions from Qdrant ------------------
nodes["Semantic Lookup"] = {
    "id": "cd38506e-c752-4cf1-b8bb-155fff143bf7",
    "name": "Semantic Lookup",
    "type": "n8n-nodes-base.code", "typeVersion": 2,
    "position": [-100, 1250],
    "parameters": {"jsCode": (
        "// Qdrant needs no auth, so call it straight from the Code node.\n"
        "// Any failure here must degrade to a normal cache miss, never break the turn.\n"
        "const vec = $json.embedding && $json.embedding.values;\n"
        "if (!vec || !vec.length) return [{ json: { candidateFound: false } }];\n"
        "try {\n"
        "  const res = await this.helpers.httpRequest({\n"
        "    method: 'POST',\n"
        "    url: '" + QDRANT + "/points/search',\n"
        "    body: { vector: vec, limit: 3, with_payload: true, score_threshold: 0.8 },\n"
        "    json: true,\n"
        "  });\n"
        "  const top = res && res.result && res.result[0];\n"
        "  if (!top || !top.payload || !top.payload.questionHash) {\n"
        "    return [{ json: { candidateFound: false } }];\n"
        "  }\n"
        "  return [{ json: {\n"
        "    candidateFound: true,\n"
        "    candidateHash: top.payload.questionHash,\n"
        "    candidateQuestion: top.payload.question,\n"
        "    candidateScore: top.score,\n"
        "  } }];\n"
        "} catch (e) {\n"
        "  return [{ json: { candidateFound: false, lookupError: String(e).slice(0, 200) } }];\n"
        "}"
    )},
}

def if_node(node_id, name, pos, cond):
    return {
        "id": node_id, "name": name, "type": "n8n-nodes-base.if",
        "typeVersion": 2.2, "position": pos,
        "parameters": {"conditions": {
            "options": {"caseSensitive": True, "leftValue": "",
                        "typeValidation": "strict", "version": 2},
            "conditions": [cond], "combinator": "and"}, "options": {}},
    }

nodes["IF (Candidate Found?)"] = if_node(
    "1b4dd751-5a49-4ff7-bd00-c0a3bde82537", "IF (Candidate Found?)", [100, 1250],
    {"id": "cond-candidate", "leftValue": "={{ $json.candidateFound }}", "rightValue": True,
     "operator": {"type": "boolean", "operation": "true", "singleValue": True}})

# --- D. The judge. Prompt text is empirically validated - do not reword. --
JUDGE = (
    "A university receptionist caches answers. Decide whether the stored answer to "
    "Question A can be reused for Question B.\\n\\n"
    "Question A: ${$json.candidateQuestion}\\n"
    "Question B: ${$('Normalize & Hash Question').first().json.userText}\\n\\n"
    "Answer SAME if both questions request the same information. Differences in wording, "
    "formality, word order, spelling, or language (English vs Arabic) do NOT make them "
    "different.\\n\\n"
    "Answer DIFFERENT only if they ask about genuinely different things - a different "
    "semester, a different degree level, a different campus, a different department, or a "
    "different kind of detail (for example phone vs email, or president vs founder).\\n\\n"
    "Reply with exactly one word: SAME or DIFFERENT."
)
nodes["Judge Same Question"] = {
    "id": "58034b33-d3a5-40d5-9a54-76107c316ec4",
    "name": "Judge Same Question",
    "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
    "position": [300, 1250],
    "parameters": {
        "method": "POST",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googlePalmApi",
        "sendBody": True, "specifyBody": "json",
        "jsonBody": ("={{ JSON.stringify({ contents: [ { parts: [ { text: `" + JUDGE +
                     "` } ] } ], generationConfig: { temperature: 0, maxOutputTokens: 16, "
                     "thinkingConfig: { thinkingBudget: 0 } } }) }}"),
        "options": {"timeout": 30000},
    },
    "credentials": GEMINI_CRED,
    "onError": "continueRegularOutput",
}

nodes["Check Verdict"] = {
    "id": "d08f66f1-f4bb-4981-8e68-7a49d234b5bb",
    "name": "Check Verdict",
    "type": "n8n-nodes-base.code", "typeVersion": 2,
    "position": [500, 1250],
    "parameters": {"jsCode": (
        "const raw = $json.candidates?.[0]?.content?.parts?.[0]?.text || '';\n"
        "const verdict = raw.trim().toUpperCase();\n"
        "// A blank/failed judge reply must fall through to the agent, not serve a hit.\n"
        "const isSame = verdict.includes('SAME') && !verdict.includes('DIFFERENT');\n"
        "const lookup = $('Semantic Lookup').first().json;\n"
        "return [{ json: {\n"
        "  isSame,\n"
        "  verdict: verdict || '(empty)',\n"
        "  candidateHash: lookup.candidateHash || '',\n"
        "  candidateScore: lookup.candidateScore,\n"
        "} }];"
    )},
}

nodes["IF (Judge SAME?)"] = if_node(
    "806ac92c-f966-435e-8fed-d2c8669a60fc", "IF (Judge SAME?)", [700, 1250],
    {"id": "cond-judge", "leftValue": "={{ $json.isSame }}", "rightValue": True,
     "operator": {"type": "boolean", "operation": "true", "singleValue": True}})

# --- G. Fetch the cached payload. propertyName MUST stay 'cachedValue' so
#        the existing Parse Cached Response node works unchanged.
nodes["Fetch Semantic Hit"] = {
    "id": "b094ef35-3a13-4166-a384-439fc9963622",
    "name": "Fetch Semantic Hit",
    "type": "n8n-nodes-base.redis", "typeVersion": 1,
    "position": [900, 1250],
    "parameters": {"operation": "get", "key": "={{ 'faq:' + $json.candidateHash }}",
                   "propertyName": "cachedValue", "options": {}},
    "credentials": REDIS_CRED,
    "onError": "continueRegularOutput",
}

# --- H. A Qdrant vector can outlive its Redis entry (30-day TTL). If the
#        pointer is stale, fall through to the agent rather than serve empty.
nodes["IF (Semantic Value Present?)"] = if_node(
    "6815539e-f1da-4bf9-a34d-a86405cf7352", "IF (Semantic Value Present?)", [1100, 1250],
    {"id": "cond-sem-present", "leftValue": "={{ $json.cachedValue }}", "rightValue": "",
     "operator": {"type": "string", "operation": "notEmpty", "singleValue": True}})

# --- I. Index the question vector after a fresh answer -------------------
nodes["Index Question Vector"] = {
    "id": "0e2aa09d-069d-48a4-a763-93c18d265576",
    "name": "Index Question Vector",
    "type": "n8n-nodes-base.code", "typeVersion": 2,
    "position": [900, 1450],
    "parameters": {"jsCode": (
        "// Deterministic point id from the question hash, so re-asking the same\n"
        "// question overwrites its vector instead of duplicating it.\n"
        "const items = $input.all();\n"
        "try {\n"
        "  if (!$('Embed Question').isExecuted) return items;\n"
        "  const vec = $('Embed Question').first().json.embedding?.values;\n"
        "  if (!vec || !vec.length) return items;\n"
        "  const nh = $('Normalize & Hash Question').first().json;\n"
        "  const id = parseInt(nh.questionHash, 16);\n"
        "  if (!Number.isFinite(id)) return items;\n"
        "  await this.helpers.httpRequest({\n"
        "    method: 'PUT',\n"
        "    url: '" + QDRANT + "/points',\n"
        "    body: { points: [{ id, vector: vec, payload: {\n"
        "      questionHash: nh.questionHash, question: nh.userText } }] },\n"
        "    json: true,\n"
        "  });\n"
        "} catch (e) {\n"
        "  // Indexing is best-effort; never break the response over it.\n"
        "}\n"
        "return items;"
    )},
}

# --- Step 4: distinguish semantic hits in the Postgres log ---------------
pc = nodes["Parse Cached Response"]["parameters"]
old = pc["jsCode"]
assert "matchType: 'cache_hit'" in old, "matchType marker not found"
pc["jsCode"] = old.replace(
    "matchType: 'cache_hit'",
    "matchType: ($('Fetch Semantic Hit').isExecuted ? 'semantic_hit' : 'cache_hit')")

# --- Step 3: rewiring ----------------------------------------------------
def drop(src, tgt):
    for branch in conns.get(src, {}).get("main", []):
        for c in list(branch):
            if c["node"] == tgt:
                branch.remove(c)

def add(src, tgt, idx=0):
    m = conns.setdefault(src, {}).setdefault("main", [])
    while len(m) <= idx:
        m.append([])
    if not any(c["node"] == tgt for c in m[idx]):
        m[idx].append({"node": tgt, "type": "main", "index": 0})

# cache miss now goes through the semantic path instead of straight to the agent
drop("IF (Cache Hit?)", "AI Agent")
add("IF (Cache Hit?)", "Embed Question", 1)

add("Embed Question", "Semantic Lookup")
add("Semantic Lookup", "IF (Candidate Found?)")
add("IF (Candidate Found?)", "Judge Same Question", 0)
add("IF (Candidate Found?)", "AI Agent", 1)
add("Judge Same Question", "Check Verdict")
add("Check Verdict", "IF (Judge SAME?)")
add("IF (Judge SAME?)", "Fetch Semantic Hit", 0)
add("IF (Judge SAME?)", "AI Agent", 1)
add("Fetch Semantic Hit", "IF (Semantic Value Present?)")
add("IF (Semantic Value Present?)", "Parse Cached Response", 0)
add("IF (Semantic Value Present?)", "AI Agent", 1)
add("Keep Answer Text", "Index Question Vector")

wf["nodes"] = list(nodes.values())
wf["connections"] = conns
json.dump({"name": wf["name"], "nodes": wf["nodes"], "connections": conns,
           "settings": {"executionOrder": "v1"}},
          open("semantic_payload.json", "w", encoding="utf-8"))

print("nodes:", len(wf["nodes"]))
for s in ("IF (Cache Hit?)", "Embed Question", "Semantic Lookup", "IF (Candidate Found?)",
          "Judge Same Question", "Check Verdict", "IF (Judge SAME?)", "Fetch Semantic Hit",
          "IF (Semantic Value Present?)", "Keep Answer Text"):
    print("  %-28s -> %s" % (s, [[c["node"] for c in b]
                                 for b in conns.get(s, {}).get("main", [])]))
