# -*- coding: utf-8 -*-
"""Behavioural regression suite for the visitor cache split.

    python tools/visitor-privacy-test/leak_suite.py

Ordinary answers are shared across every visitor; identity answers are private.
That is only safe because the agent is never given the visitor's name unless the
question is about identity (see `visitorContext` in Normalize & Hash Question).
If someone re-adds the camera line to every agent call, section A starts failing
here before it starts leaking in production.

Section E covers the greeting path, which is answered inline by `Detect Greeting`
rather than by the agent, and so is fenced by a `noCache` flag rather than by the
cache key. It runs last on purpose: when it passes it writes nothing to the
cache, but if the fence ever regresses it poisons the shared key for "hello",
and every section before it should have run against a clean one.

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

print("\nE. a greeting is personalised but never cached under the shared key")
# The suite used to send only ORDINARY and identity questions, so this whole
# path went untested -- which is how F-01 survived it. `Detect Greeting` answers
# greetings inline and puts the camera name straight into the reply, but
# "hello" does not match the PERSONAL regex that decides the cache key, so the
# named reply was stored under the SHARED key and replayed -- in text, and in
# synthesised speech -- to the next person who said hello.
#
# ORDER MATTERS: the named greeting has to go first. Asking anonymously first
# would populate the shared key with a clean answer and hide the bug.
for greeting in ("hello", "\u0645\u0631\u062d\u0628\u0627"):
    _, a = ask(greeting, "Mariam Badawi")
    check("%r greets Mariam by name" % greeting, names(a, "Mariam Badawi"), a[:44])

    _, a = ask(greeting)
    check("%r from a stranger names nobody" % greeting,
          not names(a, "Mariam Badawi"), a[:44])

    _, a = ask(greeting, "Omar Khalil")
    check("%r does not replay Mariam to Omar" % greeting,
          not names(a, "Mariam Badawi"), a[:44])

print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
