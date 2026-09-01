# -*- coding: utf-8 -*-
import json, os, uuid, urllib.request
HERE=os.path.dirname(os.path.abspath(__file__))
ARMS=[("control","http://localhost:5678/webhook/stt"),
      ("EN","http://localhost:5678/webhook/tmp-claude-stt-en"),
      ("BI","http://localhost:5678/webhook/tmp-claude-stt-bi")]
CLIPS=["arshort","arshort_deg"]
N=3
def post(url,path):
    b=uuid.uuid4().hex
    body=b"".join([f"--{b}\r\n".encode(),
      b'Content-Disposition: form-data; name="file"; filename="speech.webm"\r\n',
      b"Content-Type: audio/webm\r\n\r\n", open(path,"rb").read(), b"\r\n", f"--{b}--\r\n".encode()])
    req=urllib.request.Request(url,data=body,headers={"Content-Type":f"multipart/form-data; boundary={b}"})
    try:
        with urllib.request.urlopen(req,timeout=120) as r: return json.loads(r.read().decode())
    except Exception as e: return {"_err":str(e)}
tally={}
for c in CLIPS:
    for label,url in ARMS:
        rej=0; texts=[]
        for i in range(N):
            d=post(url,os.path.join(HERE,c+".webm"))
            if d.get("error"): rej+=1
            texts.append(d.get("text") or "<REJECTED>")
        tally[(c,label)]=(rej,N,texts)
        print(f"{c:12s} {label:8s} rejected {rej}/{N}   sample={texts[0]!r}")
    print("-"*60)
print("\n### REJECTION RATE SUMMARY (Arabic audio only)")
for label,_ in ARMS:
    r=sum(tally[(c,label)][0] for c in CLIPS); t=sum(tally[(c,label)][1] for c in CLIPS)
    print(f"  {label:8s}: {r}/{t}")
