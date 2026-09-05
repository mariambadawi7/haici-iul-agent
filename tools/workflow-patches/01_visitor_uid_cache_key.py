"""Patch `Normalize & Hash Question` on the live Agent Workflow.

Two changes, both inside one Code node -- no topology change at all:

  1. The private cache key is built from the visitor's UID rather than their
     name. A name is the wrong key: an auto-enrolled visitor has none, and two
     people who share one would share a cache namespace. Falls back to the name
     so a turn arriving before the face has bound behaves exactly as today.

  2. `visitorContext` carries the stored profile as well as the name, behind
     the SAME fence -- identity questions only. That fence is the thing that
     stops personal context reaching a shared cache entry, so it is preserved
     exactly rather than widened.

Follows the rules in the live-workflow memory note: read activeVersion (not the
draft), take name/settings from the parent, whitelist settings keys, and scan
every expression for balanced braces before the PUT.
"""

import io
import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

WF_ID = "d8nftRI2zhutW98L"
NODE = "Normalize & Hash Question"
BASE = os.environ["N8N_API_URL"].rstrip("/")
KEY = os.environ["N8N_API_KEY"]

ALLOWED_SETTINGS = {
    "executionOrder", "saveDataErrorExecution", "saveDataSuccessExecution",
    "saveManualExecutions", "saveExecutionProgress", "executionTimeout",
    "errorWorkflow", "timezone", "callerPolicy", "callerIds",
}


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"X-N8N-API-KEY": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


# ---- the replacements, applied to the LIVE body so nothing else drifts ------

OLD_KEY = """  const visitorName = String(item.json.visitorName || '').trim();
  const personal = PERSONAL.test(normalized);"""

NEW_KEY = """  const visitorName = String(item.json.visitorName || '').trim();

  // The face-bound identifier, when the kiosk has one. Read straight off the
  // webhook body rather than threaded through `Set userText (Text)`: that Set
  // node exists to shape the AGENT's input, and a value only the cache key and
  // this node's own context line use has no business travelling through it.
  // Guarded because a turn can legitimately arrive with no visitor object at
  // all -- camera off, nobody in frame, or a face that never resolved.
  let visitorUid = '';
  try {
    visitorUid = String($('Webhook').first().json.body?.visitor?.uid || '').trim();
  } catch (e) {
    visitorUid = '';
  }

  // Facts the kiosk has been told about this person, if any. Same guard, same
  // reason. Kept as a formatted line here so the fence below decides ONE thing
  // -- whether personal context is shown at all -- rather than two.
  let profileLine = '';
  try {
    const facts = $('Webhook').first().json.body?.visitor?.profile?.facts;
    if (Array.isArray(facts) && facts.length) {
      profileLine = '\\n[what the kiosk has been told about them: ' +
        facts.slice(0, 20)
          .map(f => String(f && f.key || '') + ': ' + String(f && f.value || ''))
          .filter(s => s.length > 2)
          .join('; ') + ']';
    }
  } catch (e) {
    profileLine = '';
  }

  const personal = PERSONAL.test(normalized);"""

OLD_BASE = """  const couldCarryName = personal || GREET.test(normalized);
  const keyBase = (couldCarryName && visitorName
    ? normalized + '|visitor:' + visitorName.toLowerCase()
    : normalized) + '|lang:' + lang;"""

NEW_BASE = """  const couldCarryName = personal || GREET.test(normalized);
  // The UID is the identity; the name is only what we call it. Keying on a
  // name is wrong twice over -- an auto-enrolled visitor has no name at all,
  // and two people who share one would share a private cache namespace, which
  // is the exact leak this suffix exists to prevent. The name stays as the
  // fallback for a turn that arrives before the face has finished binding.
  //
  // For a staff-enrolled face the two are the same string (the uid IS the
  // gallery label), so those keys are unchanged and their cache entries
  // survive this edit.
  //
  // Lowercased even though a minted uid is already lowercase hex, because a
  // gallery label is not: "Mariam Badawi" and "mariam badawi" must not open
  // two namespaces for one person.
  const visitorKey = (visitorUid || visitorName).toLowerCase();
  const keyBase = (couldCarryName && visitorKey
    ? normalized + '|visitor:' + visitorKey
    : normalized) + '|lang:' + lang;"""

OLD_CTX = """  item.json.visitorContext = (personal && visitorName)
    ? '\\n\\n[kiosk camera: the person at the kiosk is ' + visitorName + ']'
    : '';"""

NEW_CTX = """  // Fence unchanged: personal questions only. Widening it to every turn is
  // what would break the cache, because an answer shaped by one person's
  // profile must never be replayed to the next.
  //
  // The name and the profile are fenced together rather than separately -- a
  // list of facts about someone is no less identifying than their name, and a
  // second fence is a second thing to get wrong.
  const hasPersonalContext = !!(visitorName || profileLine);
  item.json.visitorContext = (personal && hasPersonalContext)
    ? '\\n\\n[kiosk camera: the person at the kiosk is ' +
      (visitorName || 'someone this kiosk has spoken with before, whose name it does not know') +
      ']' + profileLine
    : '';"""


def replace_once(body, old, new, label):
    if body.count(old) != 1:
        raise SystemExit(
            "refusing to patch: %r matched %d times, expected exactly 1.\n"
            "The live node has drifted from what this patch was written against."
            % (label, body.count(old))
        )
    return body.replace(old, new)


def brace_check(nodes):
    """Cheap detector for the truncated-expression failure mode: a malformed
    `={{ ... }` silently disables a node whose onError continues."""
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


wf = api("GET", "/api/v1/workflows/%s" % WF_ID)
active = wf["activeVersion"]
nodes = json.loads(json.dumps(active["nodes"]))  # deep copy

target = [n for n in nodes if n["name"] == NODE]
if len(target) != 1:
    raise SystemExit("expected exactly one %r node, found %d" % (NODE, len(target)))
node = target[0]

body = node["parameters"]["jsCode"]
before = len(body)
body = replace_once(body, OLD_KEY, NEW_KEY, "visitorName declaration")
body = replace_once(body, OLD_BASE, NEW_BASE, "keyBase construction")
body = replace_once(body, OLD_CTX, NEW_CTX, "visitorContext assignment")
node["parameters"]["jsCode"] = body
print("jsCode: %d -> %d chars" % (before, len(body)))

bad = brace_check(nodes)
if bad:
    for p, s in bad:
        print("  UNBALANCED", p, s)
    raise SystemExit("refusing to PUT: unbalanced expression braces")
print("brace check: clean across %d nodes" % len(nodes))

settings = {k: v for k, v in (wf.get("settings") or {}).items() if k in ALLOWED_SETTINGS}
payload = {
    "name": wf["name"],                 # parent, NOT activeVersion (which is null)
    "nodes": nodes,
    "connections": active["connections"],
    "settings": settings,
}
assert isinstance(payload["name"], str) and payload["name"], "name must be non-empty"
print("payload: name=%r nodes=%d settings=%s"
      % (payload["name"], len(payload["nodes"]), sorted(settings)))

if "--dry-run" in sys.argv:
    io.open(sys.argv[sys.argv.index("--out") + 1], "w", encoding="utf-8").write(body) \
        if "--out" in sys.argv else None
    print("DRY RUN -- nothing sent")
    raise SystemExit(0)

api("PUT", "/api/v1/workflows/%s" % WF_ID, payload)
after = api("GET", "/api/v1/workflows/%s" % WF_ID)
print("after PUT: name=%r active=%s versionId==activeVersionId: %s"
      % (after["name"], after.get("active"),
         after.get("versionId") == after.get("activeVersionId")))
live = [n for n in after["activeVersion"]["nodes"] if n["name"] == NODE][0]
print("live node now has the patch:", "visitorKey" in live["parameters"]["jsCode"])
