# -*- coding: utf-8 -*-
"""Structural audit: prove no SHARED cache key holds a visitor's name.

    set -a; . ./.env; set +a
    python tools/visitor-privacy-test/cache_key_audit.py

leak_suite.py only proves the questions it happens to ask do not leak. This
recomputes the cache keys independently — same djb2 and normalisation as
`Normalize & Hash Question` — and classifies every name-bearing entry as either
a private per-visitor key (fine) or a shared one (a leak).

Anything it cannot positively classify is reported as UNVERIFIED rather than
assumed safe: a corrected question is cached under a hash of the corrected text,
so its stored `question` will not always reproduce the key.
"""
import json, os, re, subprocess, sys

VISITORS = ["Mariam Badawi", "Omar Khalil"]

def djb2(s):
    h = 5381
    for ch in s:
        h = ((h << 5) + h) + ord(ch)
        h &= 0xFFFFFFFF
    return format(h, "x")

def normalise(raw):
    s = raw.lower().strip()
    s = re.sub(r"[^\w\s\u0600-\u06FF]", "", s, flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()

def redis(*args):
    pw = os.environ.get("REDIS_PASSWORD", "")
    out = subprocess.run(["docker", "exec", "redis", "redis-cli", "-a", pw,
                          "--no-auth-warning"] + list(args),
                         capture_output=True, text=True, encoding="utf-8")
    return out.stdout.strip()

NAME_FORMS = {"Mariam Badawi": ["mariam", "مريم"], "Omar Khalil": ["omar", "عمر"]}

keys = [k for k in redis("KEYS", "faq:*").splitlines() if k.strip()]
print("cache entries: %d" % len(keys))
leaks, private, unverified = [], [], []
for k in keys:
    raw = redis("GET", k)
    if not raw:
        continue
    try:
        entry = json.loads(raw)
    except Exception:
        entry = {}
    q = entry.get("question") or ""
    # Scan the TEXT fields only, never the whole record. Cached entries carry a
    # base64 WAV of ~450KB, and a blob that size contains a 4-letter string like
    # "omar" by pure chance — measured: 2 hits in one entry whose answer holds no
    # name at all. Scanning `raw` therefore flags clean entries as name-bearing,
    # and could just as easily manufacture a false LEAK and fail the suite.
    low = " ".join([q, entry.get("answer") or "", entry.get("rawQuestion") or ""]).lower()
    who = [v for v in VISITORS if any(f in low for f in NAME_FORMS[v])]
    if not who:
        continue
    n = normalise(q)
    if k == "faq:" + djb2(n):
        leaks.append((k, q))
    elif any(k == "faq:" + djb2(n + "|visitor:" + v.lower()) for v in VISITORS):
        private.append((k, q))
    else:
        unverified.append((k, q))

for k, q in private:    print("  PRIVATE     %-16s %s" % (k, q[:46]))
for k, q in unverified: print("  UNVERIFIED  %-16s %s" % (k, q[:46]))
for k, q in leaks:      print("  LEAK        %-16s %s" % (k, q[:46]))
print()
print("named entries: %d private, %d unverified, %d LEAKED"
      % (len(private), len(unverified), len(leaks)))
sys.exit(1 if leaks else 0)
