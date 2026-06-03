// WebSocket relay (Bun native) bridging the ESP32 hardware client and browser
// clients. Hardware connects with ?client=hardware, browsers with ?client=browser.
// Every message from one group is forwarded verbatim to the other group.
//
// Bun's native WebSocket server is used deliberately: the `ws` npm package does
// not handshake reliably under Bun and the ESP32 (Arduino WebSocketsClient)
// drops immediately against it. Bun.serve is solid with both the ESP and browsers.

type ClientType = "hardware" | "browser";

interface WsData {
  type: ClientType;
}

const hardware = new Set<import("bun").ServerWebSocket<WsData>>();
const browsers = new Set<import("bun").ServerWebSocket<WsData>>();

const server = Bun.serve<WsData>({
  port: 3001,
  hostname: "0.0.0.0",
  fetch(req, server) {
    const url = new URL(req.url);
    const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;
    const upgraded = server.upgrade(req, { data: { type: clientType } });
    if (upgraded) return undefined;
    return new Response("WebSocket relay — upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "hardware") hardware.add(ws);
      else browsers.add(ws);
      console.log(`[ws] ${ws.data.type} connected (hw:${hardware.size} br:${browsers.size})`);
    },
    message(ws, msg) {
      const targets = ws.data.type === "hardware" ? browsers : hardware;
      for (const t of targets) t.send(msg);
    },
    close(ws) {
      hardware.delete(ws as import("bun").ServerWebSocket<WsData>);
      browsers.delete(ws as import("bun").ServerWebSocket<WsData>);
      console.log(`[ws] ${ws.data.type} disconnected (hw:${hardware.size} br:${browsers.size})`);
    },
  },
});

console.log(`[ws] relay listening on :${server.port}`);
