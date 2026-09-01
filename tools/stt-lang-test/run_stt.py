# -*- coding: utf-8 -*-
import json, os, sys, uuid, urllib.request, mimetypes
HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS = ["ar1","ar2","ar3","armix","en1","en2"]

def post(url, path, mime="audio/webm", fname="speech.webm"):
    b = uuid.uuid4().hex
    body = b"".join([
        f"--{b}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        open(path,"rb").read(), b"\r\n",
        f"--{b}--\r\n".encode(),
    ])
    req = urllib.request.Request(url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"_httperror": str(e)}

url = sys.argv[1]
label = sys.argv[2] if len(sys.argv)>2 else url
ext = sys.argv[3] if len(sys.argv)>3 else "webm"
mime = {"webm":"audio/webm","wav":"audio/wav"}[ext]
results={}
print(f"### {label}   ({ext})")
for c in CLIPS:
    p = os.path.join(HERE, f"{c}.{ext}")
    d = post(url, p, mime, f"speech.{ext}")
    results[c]=d
    print(f"  {c:6s} lang={str(d.get('language')):8s} detected={str(d.get('detectedLanguage')):10s} "
          f"inScript={d.get('inScript')} err={'YES' if d.get('error') else 'no'}")
    print(f"         text={d.get('text')!r}")
    if d.get("_httperror"): print(f"         HTTPERR {d['_httperror']}")
json.dump(results, open(os.path.join(HERE,f"res_{label}.json"),"w",encoding="utf-8"), ensure_ascii=False, indent=1)
