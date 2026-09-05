"""Create the `Profile Extract` workflow.

The kiosk stores what a visitor volunteers about themselves. Something has to
turn "I'm Ali, I'm in third year engineering" into structured facts, and the
obvious place is the Agent Workflow -- it already has the turn, the model and
the credential.

It is the wrong place. That workflow is 48 nodes, and the whole answer path is
delicate: three branches fan into the TTS/response chain, two dual-write IFs
guard the cache, and a node inserted between them that fails in an unexpected
way takes the kiosk down for every visitor, not just the one talking about
themselves. Extraction is also not on the critical path -- nobody is waiting
for it -- so paying for it with a Gemini call inside the turn buys latency on
every question in exchange for a fact captured on roughly one.

So it lives here instead: its own webhook, called fire-and-forget by the client
after a turn has already been answered and rendered. The blast radius of a
failure is one missing fact. It can be deactivated without touching the agent.

Shape:

    Webhook  ->  Gate (Code)  ->  IF worth asking?
                                    true  -> Gemini -> Parse -> Respond
                                    false -> Respond nothing

The Gate is the cost control. Most kiosk turns are questions about the
university and say nothing about who is asking, so a cheap regex decides
whether a model call is justified at all. It is deliberately generous in the
other direction -- a false positive costs one small Gemini call, a false
negative loses the one thing the visitor told the kiosk about themselves.
"""

import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ["N8N_API_URL"].rstrip("/")
KEY = os.environ["N8N_API_KEY"]
WF_NAME = "Profile Extract"
WEBHOOK_PATH = "profile-extract"

# Same credential the Agent Workflow's Gemini nodes use.
GEMINI_CRED = {"googlePalmApi": {"id": "3NeEadTXR21DloX6",
                                 "name": "Google Gemini(PaLM) Api account"}}


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"X-N8N-API-KEY": KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit("%s %s -> %s\n%s" % (method, path, e.code, e.read().decode("utf-8")[:600]))


GATE_CODE = r"""
// Decide whether this turn is worth a model call, and normalise the payload.
//
// Most turns at a university kiosk are questions ABOUT the university and say
// nothing about who is asking. Calling Gemini on every one of them would pay
// for extraction thousands of times to capture a handful of facts, so a regex
// filters first.
//
// Deliberately generous: a false positive costs one small call, a false
// negative loses the only thing a visitor ever said about themselves. When in
// doubt, ask.
const DISCLOSES = new RegExp([
  // English: naming, studying, working, belonging, wanting.
  "\\bi(?:'| a)?m\\b", "\\bmy name\\b", "\\bcall me\\b", "\\bi am\\b",
  "\\bi study\\b", "\\bi'?m studying\\b", "\\bi major\\b", "\\bmy major\\b",
  "\\bi work\\b", "\\bi teach\\b", "\\bi graduated\\b", "\\bi applied\\b",
  "\\bmy (?:faculty|department|year|major|degree|programme|program|course|email|phone|id)\\b",
  "\\bi(?:'| a)?m in\\b", "\\bi live\\b", "\\bi come from\\b", "\\bi want to\\b",
  "\\bi need\\b", "\\bi have\\b", "\\bfirst year\\b", "\\bsecond year\\b",
  "\\bthird year\\b", "\\bfourth year\\b", "\\bmy son\\b", "\\bmy daughter\\b",
  // Arabic: my name / I am / I study / I work / my faculty / my specialisation.
  "اسمي", "انا", "أنا", "ادرس", "أدرس", "بدرس", "اعمل", "أعمل", "بشتغل",
  "كليتي", "تخصصي", "سنتي", "ابني", "ابنتي", "اريد", "أريد", "بدي",
].join("|"), "i");

const items = $input.all();
return items.map(item => {
  const body = item.json.body || item.json || {};
  const text = String(body.text || "").trim();
  const answer = String(body.answer || "").trim();
  const uid = String(body.uid || "").trim();

  // No identity means nowhere to file the result, so there is nothing to do
  // however revealing the sentence was.
  const known = Array.isArray(body.knownFacts) ? body.knownFacts : [];
  const worthAsking = !!uid && text.length >= 4 && text.length <= 2000
    && DISCLOSES.test(text);

  return {
    json: {
      uid,
      text,
      answer: answer.slice(0, 1200),
      knownFacts: known
        .filter(f => f && f.key)
        .slice(0, 40)
        .map(f => String(f.key) + ": " + String(f.value || "")),
      worthAsking,
    },
  };
});
""".strip()

PARSE_CODE = r"""
// Turn Gemini's reply into a profileDelta the kiosk can merge, or nothing.
//
// Every failure mode here ends in an empty delta rather than a thrown error.
// The caller is a fire-and-forget request whose only job is to enrich a
// profile; a turn that produced no facts and a turn whose extraction broke
// should look identical from outside, because in both cases the right thing
// to do is carry on.
function emptyDelta() {
  return [{ json: { profileDelta: {} } }];
}

let raw = '';
try {
  const parts = $json?.candidates?.[0]?.content?.parts;
  raw = Array.isArray(parts) ? String(parts[0]?.text || '') : '';
} catch (e) {
  return emptyDelta();
}
if (!raw.trim()) return emptyDelta();

// The model is asked for bare JSON but will sometimes fence it anyway.
const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
const body = (fenced ? fenced[1] : raw).trim();

let parsed;
try {
  parsed = JSON.parse(body);
} catch (e) {
  return emptyDelta();
}
if (!parsed || typeof parsed !== 'object') return emptyDelta();

const delta = {};

// A name is only taken when the visitor stated it. The model is told to return
// null otherwise, and anything that does not look like a name is dropped here
// too -- a wrong displayName is worse than none, because the kiosk greets
// people by it out loud on their next visit.
const name = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
if (name && name.length <= 80 && !/^(unknown|null|n\/a|none|visitor)$/i.test(name)) {
  delta.displayName = name;
}

if (Array.isArray(parsed.facts)) {
  const facts = [];
  for (const f of parsed.facts.slice(0, 12)) {
    if (!f || typeof f !== 'object') continue;
    const key = String(f.key || '').trim().toLowerCase().slice(0, 60);
    const value = String(f.value || '').trim().slice(0, 300);
    // Keys are a small vocabulary on purpose. Left free, the model invents a
    // new one for every phrasing ("year", "study year", "academic year") and
    // the profile fills with near-duplicates that never overwrite each other.
    if (!key || !value) continue;
    if (/^(unknown|null|n\/a|none)$/i.test(value)) continue;
    facts.push({ key, value });
  }
  if (facts.length) delta.facts = facts;
}

return [{ json: { profileDelta: delta } }];
""".strip()

PROMPT = (
    "You extract durable facts a visitor states about THEMSELVES at a university "
    "reception kiosk.\\n\\n"
    "Visitor said: ${$json.text}\\n"
    "Kiosk replied: ${$json.answer}\\n"
    "Already on file: ${$json.knownFacts.join('; ') || '(nothing)'}\\n\\n"
    "Return ONLY minified JSON of this shape:\\n"
    '{\\"displayName\\": string|null, \\"facts\\": [{\\"key\\": string, \\"value\\": string}]}\\n\\n'
    "Rules:\\n"
    "- displayName ONLY if the visitor stated their own name in this message. Otherwise null.\\n"
    "- Facts must be about the VISITOR, not about the university. "
    "\\\"When does the library close\\\" contains no facts.\\n"
    "- Use these keys where they fit: name, role, faculty, department, year, major, "
    "degree, interest, contact, language, relation. Invent a key only if nothing fits.\\n"
    "- Record only what is DURABLE and worth remembering next visit. A question they "
    "asked today is not a fact about them.\\n"
    "- Do NOT repeat a fact already on file with the same value.\\n"
    "- Do NOT infer, guess or embellish. If they stated nothing about themselves, "
    'return {\\"displayName\\":null,\\"facts\\":[]}.\\n'
    "- Never include health, religion, politics, or anything about a third party.\\n"
    "- Keep values under 12 words, in the language the visitor used."
)

nodes = [
    {
        "id": "pe-webhook", "name": "Webhook",
        "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 0],
        "parameters": {
            "httpMethod": "POST", "path": WEBHOOK_PATH,
            "responseMode": "responseNode", "options": {},
        },
    },
    {
        "id": "pe-gate", "name": "Gate",
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [220, 0],
        "parameters": {"mode": "runOnceForAllItems", "jsCode": GATE_CODE},
    },
    {
        "id": "pe-if", "name": "IF (Worth Asking?)",
        "type": "n8n-nodes-base.if", "typeVersion": 2.2, "position": [440, 0],
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "",
                            "typeValidation": "strict", "version": 2},
                "conditions": [{
                    "id": "pe-cond-worth",
                    "leftValue": "={{ $json.worthAsking }}",
                    "rightValue": True,
                    "operator": {"type": "boolean", "operation": "true",
                                 "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        },
    },
    {
        "id": "pe-gemini", "name": "Extract Facts",
        "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
        "position": [680, -100],
        "parameters": {
            "method": "POST",
            "url": "https://generativelanguage.googleapis.com/v1beta/models/"
                   "gemini-2.5-flash:generateContent",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "googlePalmApi",
            "sendBody": True, "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ contents: [ { parts: [ { text: `"
                        + PROMPT +
                        "` } ] } ], generationConfig: { temperature: 0, "
                        "maxOutputTokens: 400, responseMimeType: 'application/json', "
                        "thinkingConfig: { thinkingBudget: 0 } } }) }}",
            "options": {"timeout": 20000},
        },
        "credentials": GEMINI_CRED,
        # A failed extraction must still answer the caller. Without this the
        # webhook hangs until its own timeout and the kiosk logs a scary error
        # for something entirely optional.
        "onError": "continueRegularOutput",
        "retryOnFail": True, "maxTries": 2, "waitBetweenTries": 1000,
    },
    {
        "id": "pe-parse", "name": "Parse Delta",
        "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [900, -100],
        "parameters": {"mode": "runOnceForAllItems", "jsCode": PARSE_CODE},
    },
    {
        "id": "pe-respond", "name": "Respond",
        "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1,
        "position": [1120, -100],
        "parameters": {"respondWith": "json",
                       "responseBody": "={{ JSON.stringify($json) }}",
                       "options": {}},
    },
    {
        "id": "pe-respond-empty", "name": "Respond (Nothing)",
        "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1,
        "position": [680, 120],
        "parameters": {"respondWith": "json",
                       "responseBody": "={{ JSON.stringify({ profileDelta: {} }) }}",
                       "options": {}},
    },
]

connections = {
    "Webhook": {"main": [[{"node": "Gate", "type": "main", "index": 0}]]},
    "Gate": {"main": [[{"node": "IF (Worth Asking?)", "type": "main", "index": 0}]]},
    "IF (Worth Asking?)": {"main": [
        [{"node": "Extract Facts", "type": "main", "index": 0}],
        [{"node": "Respond (Nothing)", "type": "main", "index": 0}],
    ]},
    "Extract Facts": {"main": [[{"node": "Parse Delta", "type": "main", "index": 0}]]},
    "Parse Delta": {"main": [[{"node": "Respond", "type": "main", "index": 0}]]},
}

if "--dry-run" in sys.argv:
    print(json.dumps({"nodes": [n["name"] for n in nodes],
                      "connections": connections}, indent=1))
    raise SystemExit(0)

existing = [w for w in api("GET", "/api/v1/workflows?limit=100")["data"]
            if w["name"] == WF_NAME]
if existing:
    print("already exists:", [(w["id"], w.get("active")) for w in existing])
    print("Delete it first if you mean to recreate it; refusing to make a duplicate.")
    raise SystemExit(1)

created = api("POST", "/api/v1/workflows", {
    "name": WF_NAME, "nodes": nodes, "connections": connections,
    "settings": {"executionOrder": "v1"},
})
wid = created["id"]
print("created:", wid)
api("POST", "/api/v1/workflows/%s/activate" % wid)
after = api("GET", "/api/v1/workflows/%s" % wid)
print("active:", after.get("active"), "| nodes:", len(after["activeVersion"]["nodes"]))
print("webhook: POST /webhook/%s" % WEBHOOK_PATH)
