"""Fence the cache on what the ANSWER contains, not only on what the question asked.

The existing fence is a prediction: PERSONAL matches the question, and the
private cache suffix follows. Everything else is assumed shareable.

Face-bound memory breaks that assumption. The workflow's Window Buffer Memory
is keyed on the sessionId, which is now `face:<uid>`, so the agent carries what
it learned about a person from one visit into the next -- and it will use that
knowledge to answer a question the regex does not classify as personal.

Observed live, after the uid change:

    "remind me what you know about me please"
      -> "You are Mariam Badawi, a third-year student in the Faculty of
          Engineering."
      -> written to faq:740536b8, the SHARED key.

PERSONAL contains "what do you know about me"; the sentence says "what you know
about me". One missing word, and a fully personalised answer is queued up for
the next stranger who phrases it the same way. No regex fixes this: the leak
does not depend on how the question was worded, it depends on what the model
chose to say.

So this stops predicting and starts checking. `Keep Answer Text` is where a
fresh answer first exists, and it now sets `noCache` when EITHER side of the
turn -- the answer text or the question that produced it -- contains the
visitor's name or any fact the kiosk holds on them. Both sides, because a
cached record stores both: "i am Mariam Badawi" answered with "Thank you."
carries the name purely on the question side. Both
cacheable IFs already honour that flag, and both audio-path nodes carry it
through faithfully (`source.noCache === true`), so one assignment covers every
route to a cache write.

Deliberately asymmetric, the same way the node it protects already argues:
over-matching costs a cache miss, under-matching costs someone else's private
answer. It therefore fails CLOSED -- if the visitor cannot be read at all, the
answer is not cached.
"""

import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

WF_ID = "d8nftRI2zhutW98L"
BASE = os.environ["N8N_API_URL"].rstrip("/")
KEY = os.environ["N8N_API_KEY"]

ALLOWED_SETTINGS = {
    "executionOrder", "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveManualExecutions", "saveExecutionProgress", "executionTimeout",
    "errorWorkflow", "timezone", "callerPolicy", "callerIds",
}

# Kept in one place so the unit test can import the exact string that ships.
FENCE_EXPRESSION = """={{
(() => {
  try {
    const v = $('Webhook').first().json.body?.visitor;
    // BOTH sides of the turn. A cached record stores the question as well as
    // the answer, and a self-disclosure turn -- "i am Mariam Badawi", answered
    // with a bare "Thank you." -- puts the name entirely on the question side,
    // where an answer-only fence never sees it. Found by
    // tools/visitor-privacy-test/cache_key_audit.py, which flagged exactly that
    // entry sitting on a shared key.
    const asked = $('Correct Domain Terms').isExecuted
      ? String($('Correct Domain Terms').first().json.userText || '')
      : '';
    const haystack = (String($json.output || '') + ' ' + asked).toLowerCase();
    if (!v || !haystack.trim()) return false;

    const needles = [];
    if (v.name) needles.push(String(v.name));
    if (v.profile && v.profile.displayName) needles.push(String(v.profile.displayName));
    const facts = (v.profile && Array.isArray(v.profile.facts)) ? v.profile.facts : [];
    for (const f of facts) { if (f && f.value) needles.push(String(f.value)); }

    return needles
      .map(s => s.toLowerCase().trim())
      .filter(s => s.length >= 3)
      .some(s => haystack.includes(s));
  } catch (e) {
    return true;
  }
})()
}}"""


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"X-N8N-API-KEY": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


def brace_check(nodes):
    bad = []
    def walk(v, path):
        if isinstance(v, str):
            if v.startswith("={{") and v[1:].count("{") != v[1:].count("}"):
                bad.append((path, v[:120]))
        elif isinstance(v, dict):
            for k, sub in v.items():
                walk(sub, path + "." + str(k))
        elif isinstance(v, list):
            for i, sub in enumerate(v):
                walk(sub, path + "[%d]" % i)
    for n in nodes:
        walk(n.get("parameters", {}), n["name"])
    return bad


if "--emit-expression" in sys.argv:
    # For the unit test: write just the JS body, without the ={{ }} wrapper.
    open(sys.argv[sys.argv.index("--emit-expression") + 1], "w", encoding="utf-8").write(
        FENCE_EXPRESSION[len("={{"):-len("}}")]
    )
    raise SystemExit(0)

wf = api("GET", "/api/v1/workflows/%s" % WF_ID)
active = wf["activeVersion"]
nodes = json.loads(json.dumps(active["nodes"]))
node = {n["name"]: n for n in nodes}["Keep Answer Text"]

assigns = node["parameters"]["assignments"]["assignments"]
existing = [a for a in assigns if a["name"] == "noCache"]
if existing:
    print("noCache assignment already present; updating it in place")
    existing[0]["value"] = FENCE_EXPRESSION
    existing[0]["type"] = "boolean"
else:
    assigns.append({
        "id": "keep-nocache-personal",
        "name": "noCache",
        "value": FENCE_EXPRESSION,
        "type": "boolean",
    })
print("Keep Answer Text now assigns:", [a["name"] for a in assigns])

bad = brace_check(nodes)
if bad:
    for p, s in bad:
        print("  UNBALANCED", p, s)
    raise SystemExit("refusing to PUT: unbalanced expression braces")
print("brace check: clean across %d nodes" % len(nodes))

if "--dry-run" in sys.argv:
    print("DRY RUN -- nothing sent")
    raise SystemExit(0)

settings = {k: v for k, v in (wf.get("settings") or {}).items() if k in ALLOWED_SETTINGS}
payload = {"name": wf["name"], "nodes": nodes,
           "connections": active["connections"], "settings": settings}
assert isinstance(payload["name"], str) and payload["name"]
api("PUT", "/api/v1/workflows/%s" % WF_ID, payload)

after = api("GET", "/api/v1/workflows/%s" % WF_ID)
live = {n["name"]: n for n in after["activeVersion"]["nodes"]}["Keep Answer Text"]
names = [a["name"] for a in live["parameters"]["assignments"]["assignments"]]
print("after PUT: name=%r active=%s published=%s"
      % (after["name"], after.get("active"),
         after.get("versionId") == after.get("activeVersionId")))
print("  live assignments:", names)
