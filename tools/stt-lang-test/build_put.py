# -*- coding: utf-8 -*-
import json, os, copy
HERE=os.path.dirname(os.path.abspath(__file__))
live=json.load(open(os.path.join(HERE,"stt_live_fetch.json"),encoding="utf-8"))
av=live["activeVersion"]
bi=json.load(open(os.path.join(HERE,"clone_bi.json"),encoding="utf-8"))
PROMPT=[p for n in bi["nodes"] if n["name"]=="Groq STT"
        for p in n["parameters"]["bodyParameters"]["parameters"] if p["name"]=="prompt"][0]["value"]

nodes=copy.deepcopy(av["nodes"])                 # active version = what serves traffic
for n in nodes:
    if n["name"]=="Groq STT":
        ps=[p for p in n["parameters"]["bodyParameters"]["parameters"] if p.get("name")!="prompt"]
        ps.append({"name":"prompt","value":PROMPT})
        n["parameters"]["bodyParameters"]["parameters"]=ps

ALLOWED={"executionOrder","saveDataErrorExecution","saveDataSuccessExecution","saveManualExecutions",
         "saveExecutionProgress","executionTimeout","errorWorkflow","timezone","callerPolicy",
         "callerIds"}
settings={k:v for k,v in (live.get("settings") or {}).items() if k in ALLOWED}   # drops binaryMode

payload={"name":live["name"],                    # name + settings from TOP-LEVEL
         "nodes":nodes,
         "connections":copy.deepcopy(av["connections"]),
         "settings":settings}
out=os.path.join(HERE,"put_stt_bi.json")
json.dump(payload,open(out,"w",encoding="utf-8"),ensure_ascii=False)
print("name:",payload["name"])
print("settings:",json.dumps(settings))
print("dropped settings keys:",sorted(set((live.get('settings') or {}))-set(settings)))
print("nodes:",[n["name"] for n in nodes])
g=[n for n in nodes if n["name"]=="Groq STT"][0]
print("groq body params:",[p["name"] for p in g["parameters"]["bodyParameters"]["parameters"]])
print("prompt:",PROMPT)
print("wrote",out,os.path.getsize(out),"bytes")
