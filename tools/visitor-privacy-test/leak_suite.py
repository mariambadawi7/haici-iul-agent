# -*- coding: utf-8 -*-
"""Behavioural regression suite for the visitor cache split.

    python tools/visitor-privacy-test/leak_suite.py

Ordinary answers are shared across every visitor; identity answers are private.
That is only safe because the agent is never given the visitor's name unless the
question is about identity (see `visitorContext` in Normalize & Hash Question).
If someone re-adds the camera line to every agent call, section A starts failing
here before it starts leaking in production.

Exit code 1 on any failure, so it can gate a deploy.
"""
import json, sys, time, urllib.request

URL = "http://localhost:5678/webhook/rag-agent"

# The agent transliterates when answering in Arabic, so a Latin-only check
# silently mis-grades the bilingual half. This bit us once: a passing Arabic
# answer was reported as a failure because it said مريم rather than "Mariam".
FORMS = {"Mariam Badawi": ["mariam", "مريم"], "Omar Khalil": ["omar", "عمر"]}

def ask(q, visitor=None):
    body = {"sessionId": "leak-%d" % (time.time() * 1e6 % 1e9),
            "text": q, "wantsAudio": False, "inputType": "text"}
    if visitor:
        body["visitor"] = {"name": visitor, "emotion": "neutral"}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        return time.time() - t, str(json.loads(r.read().decode()).get("answer") or "")

def names(answer, who):
    return any(f in answer.lower() for f in FORMS[who])

PASS = FAIL = 0
def check(label, ok, detail=""):
    global PASS, FAIL
    if ok: PASS += 1; print("  PASS  %-50s %s" % (label, detail))
    else:  FAIL += 1; print("  FAIL  %-50s %s" % (label, detail))

ORDINARY = "What are the graduation requirements at IUL?"
EN_ID = ["Who am I?", "Do you know me?", "Do you remember me?",
         "What's my name?", "Have we met before?"]
AR_ID = ["من أنا؟", "هل تتذكرني؟", "ما اسمي؟"]

print("A. an ordinary answer is shared, and carries no name")
for who, label in ((("Mariam Badawi"), "recognised visitor"), (None, "stranger"),
                   ("Omar Khalil", "a different visitor")):
    t, a = ask(ORDINARY, who)
    check("%s gets no name" % label, not names(a, "Mariam Badawi"), "%.1fs" % t)

print("\nB. identity questions WITH the camera name the right person")
for q in EN_ID + AR_ID:
    _, a = ask(q, "Mariam Badawi")
    check(q, names(a, "Mariam Badawi"), a[:44])

print("\nC. the same questions from a stranger name nobody")
for q in EN_ID + AR_ID:
    _, a = ask(q)
    check("stranger: %s" % q, not names(a, "Mariam Badawi"), a[:44])

print("\nD. one visitor never inherits another's identity")
_, a = ask("Who am I?", "Omar Khalil")
check("Omar is not told he is Mariam", not names(a, "Mariam Badawi"), a[:46])
check("Omar is identified as Omar", names(a, "Omar Khalil"), a[:46])

print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
