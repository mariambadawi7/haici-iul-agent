# -*- coding: utf-8 -*-
import json, base64, urllib.request, os, sys
OUT = os.path.dirname(os.path.abspath(__file__))
URL = "http://localhost:5678/webhook/tmp-claude-tts"

CLIPS = [
  ("ar1", "\u0623\u064a\u0646 \u064a\u0642\u0639 \u062d\u0631\u0645 \u0627\u0644\u062c\u0627\u0645\u0639\u0629 \u0627\u0644\u0625\u0633\u0644\u0627\u0645\u064a\u0629 \u0641\u064a \u0644\u0628\u0646\u0627\u0646 \u0641\u064a \u062e\u0644\u062f\u0629\u061f"),
  ("ar2", "\u0645\u0627 \u0647\u064a \u0645\u0648\u0627\u0639\u064a\u062f \u0627\u0644\u062a\u0633\u062c\u064a\u0644 \u0641\u064a \u0643\u0644\u064a\u0629 \u0627\u0644\u0647\u0646\u062f\u0633\u0629\u061f"),
  ("ar3", "\u0647\u0644 \u064a\u0648\u062c\u062f \u0641\u0631\u0639 \u0644\u0644\u062c\u0627\u0645\u0639\u0629 \u0641\u064a \u0627\u0644\u0648\u0631\u062f\u0627\u0646\u064a\u0629 \u0648\u0628\u0639\u0644\u0628\u0643\u061f"),
  ("armix", "\u0623\u064a\u0646 \u064a\u0642\u0639 \u062d\u0631\u0645 IUL \u0641\u064a \u062e\u0644\u062f\u0629\u061f"),
  ("en1", "Where is the IUL campus in Khaldeh?"),
  ("en2", "Tell me about HAICI at the Islamic University of Lebanon."),
]

for name, text in CLIPS:
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"{name}: REQUEST FAILED {e}"); continue
    b64 = d.get("b64")
    if not b64:
        print(f"{name}: NO AUDIO -> {json.dumps(d)[:300]}"); continue
    raw = base64.b64decode(b64)
    p = os.path.join(OUT, name + ".pcm")
    with open(p, "wb") as f:
        f.write(raw)
    print(f"{name}: mime={d.get('mime')} pcm_bytes={len(raw)} dur~{len(raw)/2/24000:.2f}s  text={text}")
