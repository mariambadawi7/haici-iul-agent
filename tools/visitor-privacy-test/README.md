# Visitor privacy regression tests

The answer cache is shared across visitors, except for questions whose answer is
about the person asking ("who am I"). See `docs/SYSTEM-CHANGES.md`.

That is safe **only because ordinary answers contain no name**, which is enforced
structurally: `Normalize & Hash Question` supplies the camera line
(`visitorContext`) to the agent *only* for identity questions, so the model
cannot use a name it was never given.

If that gate is ever removed — or the agent prompt is loosened to let it address
people by name — ordinary answers start carrying names, get cached for 30 days,
and are served to strangers. Silently: no error, no log entry. These two tests
are the guard.

```bash
set -a; . ./.env; set +a
python tools/visitor-privacy-test/leak_suite.py        # behavioural, 18 cases
python tools/visitor-privacy-test/cache_key_audit.py   # structural, whole cache
```

Both exit non-zero on failure.

- **`leak_suite.py`** — sharing across visitors, identity recognition in English
  and Arabic, strangers, and cross-visitor confusion. Proves the questions it
  asks do not leak.
- **`cache_key_audit.py`** — recomputes cache keys independently and classifies
  every name-bearing entry as private or shared. Proves *no* shared key holds a
  name, which the behavioural suite cannot.

## Two traps worth knowing

**Check both scripts.** The agent transliterates when answering in Arabic, so a
Latin-only assertion mis-grades the bilingual half — an early version reported
two Arabic passes as failures because the answer said `مريم` and not "Mariam".

**A warm cache hides bugs.** A cached answer is returned before most of the
pipeline runs, so re-testing a question you already asked proves little. Clear
the relevant entries first:

```bash
docker exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning KEYS 'faq:*'
```
