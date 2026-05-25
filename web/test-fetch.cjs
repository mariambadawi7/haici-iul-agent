fetch("http://localhost:5173/webhook/rag-agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "test", text: "Who is the founder?", wantsAudio: true })
}).then(async r => {
  console.log("Status:", r.status);
  console.log("Body:", await r.text());
}).catch(e => {
  console.error("Fetch failed:", e);
});
