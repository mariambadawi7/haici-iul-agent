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
so its stored `question` will not always reproduce the key. Entries written
before the language suffix was added to the key format are UNVERIFIED for the
same reason -- they are unreachable by the running workflow and age out on TTL.
"""
import json, os, re, subprocess, sys

# Windows consoles default to cp1252, and half of these questions are Arabic.
# Printing one raised UnicodeEncodeError *after* the classification had already
# run, so the audit died with a traceback and a non-zero exit that looked like a
# tool crash rather than a verdict. Force UTF-8 on the way out.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

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
    """Run one redis-cli command, or die.

    redis-cli reports an auth failure on stdout and still exits 0, so a missing
    REDIS_PASSWORD used to come back as an empty key list -- and this script
    then cheerfully reported "0 LEAKED" having read nothing at all. That is the
    same vacuous pass the language-fence drift caused, and it is the worst
    failure mode a safety tool can have: it is indistinguishable from success.
    Run it as `set -a; . ./.env; set +a` first.
    """
    pw = os.environ.get("REDIS_PASSWORD", "")
    out = subprocess.run(["docker", "exec", "redis", "redis-cli", "-a", pw,
                          "--no-auth-warning"] + list(args),
                         capture_output=True, text=True, encoding="utf-8")
    blob = (out.stdout or "") + (out.stderr or "")
    if out.returncode != 0 or re.search(r"NOAUTH|WRONGPASS|AUTH failed|ERR ", blob):
        sys.exit("redis-cli failed (%s): %s\n"
                 "Load the environment first: set -a; . ./.env; set +a"
                 % (" ".join(args), blob.strip()[:200]))
    return out.stdout.strip()

NAME_FORMS = {"Mariam Badawi": ["mariam", "مريم"], "Omar Khalil": ["omar", "عمر"]}
LANGS = ("en", "ar")

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
    # Key format mirrors `Normalize & Hash Question`: the visitor suffix (identity
    # questions only) then the language suffix, in that fixed order. The language
    # is tried both ways rather than re-derived, because the stored `question` may
    # be the CORRECTED text and a correction can add or drop Arabic characters.
    shared = ["faq:" + djb2(n + "|lang:" + lg) for lg in LANGS]
    priv = ["faq:" + djb2(n + "|visitor:" + v.lower() + "|lang:" + lg)
            for v in VISITORS for lg in LANGS]
    if k in shared:
        leaks.append((k, q))
    elif k in priv:
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
