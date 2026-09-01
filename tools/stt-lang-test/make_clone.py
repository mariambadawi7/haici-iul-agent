# -*- coding: utf-8 -*-
import json, sys, copy, os
HERE=os.path.dirname(os.path.abspath(__file__))
live=json.load(open(os.path.join(HERE,"stt_live_fetch.json"),encoding="utf-8"))
av=live["activeVersion"]

PROMPT_EN = ("Islamic University of Lebanon, IUL, HAICI, Khaldeh, Wardanieh, Tyre, Sour, Baalbek, "
             "Bourj El Barajneh, Majdal Balhiss, Sahmar, Moussa El-Sader, Shams Al-Din, "
             "Abdul Amir Qablan, Hassan Al-Laqis, Rodayna Hmede, HCERES, ECTS, Baccalaureate, "
             "Order of Engineers, IUL")

variant = sys.argv[1]          # 'en' or 'bi'
path    = sys.argv[2]          # webhook path
name    = sys.argv[3]

if variant=="en":
    prompt = PROMPT_EN
else:
    prompt = (PROMPT_EN + ", \u0627\u0644\u062c\u0627\u0645\u0639\u0629 \u0627\u0644\u0625\u0633\u0644\u0627\u0645\u064a\u0629 \u0641\u064a \u0644\u0628\u0646\u0627\u0646, "
              "\u062e\u0644\u062f\u0629, \u0627\u0644\u0648\u0631\u062f\u0627\u0646\u064a\u0629, \u0635\u0648\u0631, \u0628\u0639\u0644\u0628\u0643, \u0628\u0631\u062c \u0627\u0644\u0628\u0631\u0627\u062c\u0646\u0629")

nodes=copy.deepcopy(av["nodes"])
for n in nodes:
    if n["name"]=="STT Webhook":
        n["parameters"]["path"]=path
        n.pop("webhookId",None)
    if n["name"]=="Groq STT":
        ps=n["parameters"]["bodyParameters"]["parameters"]
        ps=[p for p in ps if p.get("name")!="prompt"]
        # insert prompt before temperature to mirror the Agent Workflow ordering
        ps.append({"name":"prompt","value":prompt})
        n["parameters"]["bodyParameters"]["parameters"]=ps

payload={"name":name,"nodes":nodes,"connections":copy.deepcopy(av["connections"]),
         "settings":{"executionOrder":"v1"}}
out=os.path.join(HERE,f"clone_{variant}.json")
json.dump(payload,open(out,"w",encoding="utf-8"),ensure_ascii=False)
print("wrote",out)
g=[n for n in nodes if n["name"]=="Groq STT"][0]
print("groq params:",[p.get("name") for p in g["parameters"]["bodyParameters"]["parameters"]])
print("has creds:", "credentials" in g, g.get("credentials"))
print("prompt len:",len(prompt))
