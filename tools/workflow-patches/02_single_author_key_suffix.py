"""Make the cache's visitor suffix have exactly ONE author.

`Correct Domain Terms` recomputes the private-key rule so the dual write lands
under the same namespace as the primary write. Its own comment says it mirrors
`Normalize & Hash Question` "exactly", and keeping two copies of a rule in sync
by hand worked exactly as well as that always does:

  * the previous patch moved the primary key onto the visitor UID and left this
    copy on the name, so one turn wrote the same personalised answer under both
    -- observed live, faq:9c673791 (uid) and faq:335c9f65 (name), four seconds
    apart;
  * they had ALREADY drifted before that, independently: the primary fences on
    `personal || GREET`, this copy only on `isPersonalQuestion`, so a greeting
    took a private primary key and a shared corrected one.

So this stops copying the rule. `Normalize & Hash Question` now publishes the
finished suffix as `visitorKeySuffix` and uses it for its own key; the corrected
hash appends the same string. One author, no drift possible.

The fallback in the consumer is deliberate: mid-deploy, an execution can reach
it with a payload from the previous version of the upstream node, and a missing
field must degrade to today's behaviour rather than silently dropping the
suffix and writing a personal answer to a shared key.
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


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"X-N8N-API-KEY": KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode("utf-8"))


# ---- 1. Normalize & Hash Question: publish the suffix, and use it ----------

NH_OLD = """  const visitorKey = (visitorUid || visitorName).toLowerCase();
  const keyBase = (couldCarryName && visitorKey
    ? normalized + '|visitor:' + visitorKey
    : normalized) + '|lang:' + lang;"""

NH_NEW = """  const visitorKey = (visitorUid || visitorName).toLowerCase();
  // The finished suffix, published so the dual write can APPEND it rather than
  // re-derive it. `Correct Domain Terms` used to own a second copy of this
  // rule; the two drifted twice (once on the personal-vs-greeting fence, once
  // when this key moved to the uid), and each time the effect was a personal
  // answer written to a key someone else could hit. A rule with one author
  // cannot drift from itself.
  const visitorKeySuffix = (couldCarryName && visitorKey)
    ? '|visitor:' + visitorKey
    : '';
  const keyBase = normalized + visitorKeySuffix + '|lang:' + lang;"""

NH_TAIL_OLD = """  item.json.visitorName = visitorName;"""
NH_TAIL_NEW = """  item.json.visitorName = visitorName;
  item.json.visitorKeySuffix = visitorKeySuffix;"""

# ---- 2. Correct Domain Terms: consume it ----------------------------------

CD_OLD = """  let correctedKeyBase = correctedNormalized;
  // Take the language from the primary hasher rather than re-deriving it, so a
  // correction that strips or adds Arabic characters can never move the two
  // hashes into different language buckets. Fall back to the same script test
  // only if that node is unreachable.
  let corrLang = /[\\u0600-\\u06FF]/.test(String(result.userText || '')) ? 'ar' : 'en';
  try {
    const nh = $('Normalize & Hash Question').first().json;
    if (nh.questionLanguage) corrLang = nh.questionLanguage;
    if (nh.isPersonalQuestion && nh.visitorName) {
      correctedKeyBase = correctedNormalized + '|visitor:' + String(nh.visitorName).toLowerCase();
    }
  } catch (e) { correctedKeyBase = correctedNormalized; }"""

CD_NEW = """  let correctedKeyBase = correctedNormalized;
  // Take the language from the primary hasher rather than re-deriving it, so a
  // correction that strips or adds Arabic characters can never move the two
  // hashes into different language buckets. Fall back to the same script test
  // only if that node is unreachable.
  let corrLang = /[\\u0600-\\u06FF]/.test(String(result.userText || '')) ? 'ar' : 'en';
  try {
    const nh = $('Normalize & Hash Question').first().json;
    if (nh.questionLanguage) corrLang = nh.questionLanguage;
    // APPEND the suffix that node already built. This used to re-derive the
    // rule from `isPersonalQuestion` and `visitorName`, and the copy drifted
    // from the original twice -- both times writing a personalised answer to a
    // key another visitor could hit, which is the exact leak the suffix exists
    // to prevent. Reading the finished string removes the possibility.
    if (typeof nh.visitorKeySuffix === 'string') {
      correctedKeyBase = correctedNormalized + nh.visitorKeySuffix;
    } else if (nh.isPersonalQuestion && nh.visitorName) {
      // Only reachable mid-deploy, when an execution picks up the previous
      // version of the upstream node. Degrading to the old rule keeps the
      // answer private; dropping the suffix would publish it.
      correctedKeyBase = correctedNormalized + '|visitor:' + String(nh.visitorName).toLowerCase();
    }
  } catch (e) { correctedKeyBase = correctedNormalized; }"""


def replace_once(body, old, new, label):
    if body.count(old) != 1:
        raise SystemExit("refusing: %r matched %d times, expected 1" % (label, body.count(old)))
    return body.replace(old, new)


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


wf = api("GET", "/api/v1/workflows/%s" % WF_ID)
active = wf["activeVersion"]
nodes = json.loads(json.dumps(active["nodes"]))
by = {n["name"]: n for n in nodes}

nh = by["Normalize & Hash Question"]["parameters"]
nh["jsCode"] = replace_once(nh["jsCode"], NH_OLD, NH_NEW, "keyBase")
nh["jsCode"] = replace_once(nh["jsCode"], NH_TAIL_OLD, NH_TAIL_NEW, "visitorName export")

cd = by["Correct Domain Terms"]["parameters"]
cd["jsCode"] = replace_once(cd["jsCode"], CD_OLD, CD_NEW, "correctedKeyBase")

bad = brace_check(nodes)
if bad:
    for p, s in bad:
        print("  UNBALANCED", p, s)
    raise SystemExit("refusing to PUT: unbalanced expression braces")
print("brace check: clean across %d nodes" % len(nodes))

if "--dry-run" in sys.argv:
    if "--out" in sys.argv:
        base = sys.argv[sys.argv.index("--out") + 1]
        open(base + ".normalize.js", "w", encoding="utf-8").write(nh["jsCode"])
        open(base + ".correct.js", "w", encoding="utf-8").write(cd["jsCode"])
    print("DRY RUN -- nothing sent")
    raise SystemExit(0)

settings = {k: v for k, v in (wf.get("settings") or {}).items() if k in ALLOWED_SETTINGS}
payload = {"name": wf["name"], "nodes": nodes,
           "connections": active["connections"], "settings": settings}
assert isinstance(payload["name"], str) and payload["name"]
api("PUT", "/api/v1/workflows/%s" % WF_ID, payload)

after = api("GET", "/api/v1/workflows/%s" % WF_ID)
live = {n["name"]: n for n in after["activeVersion"]["nodes"]}
print("after PUT: name=%r active=%s published=%s"
      % (after["name"], after.get("active"),
         after.get("versionId") == after.get("activeVersionId")))
print("  suffix published:", "visitorKeySuffix" in live["Normalize & Hash Question"]["parameters"]["jsCode"])
print("  suffix consumed :", "nh.visitorKeySuffix" in live["Correct Domain Terms"]["parameters"]["jsCode"])
