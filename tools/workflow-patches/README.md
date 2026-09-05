# Workflow patches

The live n8n instance is the source of truth for the Agent Workflow — the JSON
files in the repo root are stale exports. That is fine for running the system
and terrible for reviewing it: a change to a 48-node workflow otherwise leaves
no diff, no reasoning and no test anywhere a person can read.

So every edit to the live workflow is written as a script here. Each one:

- reads `activeVersion` (what is actually serving traffic), never the top-level
  `nodes`, which is the **unpublished editor draft** and has differed by as much
  as 17 nodes;
- takes `name` and `settings` from the parent object — `activeVersion.name` is
  `null`, and a PUT built from it silently blanks the workflow's name;
- whitelists settings keys, because the live `settings` can hold keys the public
  API rejects (`binaryMode`);
- matches each replacement **exactly once** and refuses to run otherwise, so a
  node that has drifted since the patch was written fails loudly instead of
  being half-edited;
- scans every `={{ … }}` expression for balanced braces before the PUT. A
  truncated expression on a node with `onError: continueRegularOutput` reports
  success and silently stops doing its job — that is how the entire answer cache
  was once disabled with every node showing green.

All three support `--dry-run`.

```bash
set -a; . ./.env; set +a
python tools/workflow-patches/01_visitor_uid_cache_key.py --dry-run
```

They are **not** idempotent migrations to re-run on a whim; they are the record
of what was changed and why. Patch 3 is the exception and updates in place.

## The patches

| # | Node(s) | What and why |
|---|---|---|
| 01 | `Normalize & Hash Question` | Key the private cache namespace on the visitor UID rather than their name, and let the stored profile reach the prompt on identity questions. |
| 02 | `Normalize & Hash Question`, `Correct Domain Terms` | Give the visitor key suffix exactly one author. The dual write recomputed the rule and drifted from it — twice. |
| 03 | `Keep Answer Text` | Refuse to cache an answer whose *text* contains the visitor's name or a stored fact, regardless of how the question was worded. |

Patch 03 is the important one. The original fence predicts from the question
(`PERSONAL` matches, so the key goes private). Face-bound memory broke that
assumption: the agent now carries what it knows about someone across visits and
will use it to answer a question the regex does not match. Observed live —
`"remind me what you know about me please"` (the regex wants "what **do** you
know about me") returned a fully personalised answer and wrote it to the
**shared** key. No regex fixes that, because the leak depends on what the model
chose to say, not on how the question was phrased.

## Tests

Both suites run the real code — patch 01/02 extract the live `jsCode`, patch 03
emits the live expression body — against mocked n8n globals (`$input`, `$json`,
`$('Webhook')`). No n8n, no network, no LLM.

```bash
set -a; . ./.env; set +a
SP=$(mktemp -d)

# Node-body suite: cache-key scoping and the profile fence.
python tools/workflow-patches/01_visitor_uid_cache_key.py --dry-run --out $SP/n.js
cp $SP/n.js web/.n.js && cp tools/workflow-patches/tests/normalize_node_test.mjs web/.t.mjs
MSYS_NO_PATHCONV=1 docker compose exec web bun //app/.t.mjs //app/.n.js
rm -f web/.n.js web/.t.mjs

# Expression suite: the answer-content cache fence.
python tools/workflow-patches/03_answer_content_cache_fence.py --emit-expression $SP/f.js
cp $SP/f.js web/.f.js && cp tools/workflow-patches/tests/answer_fence_test.mjs web/.tf.mjs
MSYS_NO_PATHCONV=1 docker compose exec web bun //app/.tf.mjs //app/.f.js
rm -f web/.f.js web/.tf.mjs
```

They run through the `web` container because that is where a JS runtime lives —
`bun` is never run on the host (see CLAUDE.md). Note `docker compose run --rm
web` gets an **empty** `/app/node_modules` anonymous volume; use `exec` against
the running container.

## Verifying against the live system afterwards

Node status is not evidence — `onError: continueRegularOutput` makes a failed
node report success. Assert the side effect:

```bash
set -a; . ./.env; set +a
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  EXISTS faq:<hash> </dev/null
```

`</dev/null` is not optional inside a `while read` loop — `docker compose exec
-T` otherwise eats the rest of the loop's input and every check after the first
silently reports `exists=0`. Strip `\r` from anything Python printed on Windows
before using it as a key, for the same class of reason.

Test with a question that was **not** already cached: a pre-existing key makes a
broken cache look healthy.
