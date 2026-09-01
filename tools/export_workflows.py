# -*- coding: utf-8 -*-
"""Re-sync the repo's workflow JSON exports from the live n8n instance.

    set -a; . ./.env; set +a
    python tools/export_workflows.py

The live instance is the source of truth; these files are a snapshot of it.

Two traps this script exists to avoid:

  * `GET /api/v1/workflows/<id>` returns TWO graphs. Top-level `nodes` /
    `connections` are the unpublished editor DRAFT; `activeVersion.nodes` /
    `activeVersion.connections` are what actually serves traffic. Exporting the
    former silently captures work nobody published.
  * `activeVersion.name` is null and it carries no `settings`, so those two
    fields must come from the top-level object.

Volatile bookkeeping (createdAt/updatedAt/triggerCount/shared/...) is dropped so
a file only changes when the workflow actually changes.
"""
import io, json, os, sys, urllib.request

WORKFLOWS = {
    "d8nftRI2zhutW98L": "Agent Workflow.json",
    "9UwU0payk3rht1ms": "admin_dashboard_workflow.json",
    "btAR6oU4MThHIYy9": "RAG workflow.json",
    "KNUv1TRbHWl3v6oS": "STT Webhook.json",
}

def fetch(base, key, wf_id):
    req = urllib.request.Request("%s/api/v1/workflows/%s" % (base.rstrip("/"), wf_id),
                                 headers={"X-N8N-API-KEY": key})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

def build(w):
    av = w.get("activeVersion")
    if not av:
        raise SystemExit("%s: no activeVersion -- refusing to export the draft" % w.get("id"))
    if w.get("versionId") != w.get("activeVersionId"):
        raise SystemExit("%s: an unpublished draft exists (versionId != activeVersionId); "
                         "publish or discard it before exporting" % w.get("id"))
    nodes, conns = av["nodes"], av["connections"]

    # credential references must never carry secret material
    for n in nodes:
        for typ, cred in (n.get("credentials") or {}).items():
            extra = set(cred) - {"id", "name"}
            if extra:
                raise SystemExit("%s: credential on %r has unexpected keys %s"
                                 % (w["id"], n["name"], extra))

    names = {n["name"] for n in nodes}
    for src, spec in conns.items():
        if src not in names:
            raise SystemExit("%s: connection from unknown node %r" % (w["id"], src))
        for kind, groups in spec.items():
            for g in groups:
                for t in g:
                    if t["node"] not in names:
                        raise SystemExit("%s: connection to unknown node %r" % (w["id"], t["node"]))

    out = {
        "name": w["name"],                      # top-level, NOT activeVersion
        "nodes": nodes,
        "connections": conns,
        "settings": w.get("settings") or {},    # top-level, NOT activeVersion
        "pinData": w.get("pinData") or {},
        "meta": w.get("meta") or {},
        "id": w["id"],
        "versionId": w.get("activeVersionId"),
    }
    if w.get("staticData"):
        out["staticData"] = w["staticData"]
    if not isinstance(out["name"], str) or not out["name"]:
        raise SystemExit("%s: empty name" % w["id"])
    return out, len(nodes)

def main():
    base, key = os.environ.get("N8N_API_URL"), os.environ.get("N8N_API_KEY")
    if not base or not key:
        raise SystemExit("set N8N_API_URL and N8N_API_KEY (set -a; . ./.env; set +a)")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    changed = 0
    for wf_id, fname in sorted(WORKFLOWS.items(), key=lambda kv: kv[1]):
        export, n = build(fetch(base, key, wf_id))
        path = os.path.join(root, fname)
        txt = json.dumps(export, indent=2, ensure_ascii=False) + "\n"
        before = io.open(path, encoding="utf-8").read() if os.path.exists(path) else None
        io.open(path, "w", encoding="utf-8", newline="\n").write(txt)
        state = "unchanged" if before == txt else "UPDATED"
        changed += state == "UPDATED"
        print("  %-32s %-20s %2d nodes  %s" % (fname, wf_id, n, state))
    print("%d file(s) updated" % changed)

if __name__ == "__main__":
    main()
