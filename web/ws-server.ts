// WebSocket relay: bridges ESP32 hardware client <-> browser clients.
// Hardware connects with ?client=hardware, browsers with ?client=browser.
// Every message from one group is forwarded verbatim to all members of the other group.

type ClientType = "hardware" | "browser";

interface WsData {
  type: ClientType;
}

const hardware = new Set<import("bun").ServerWebSocket<WsData>>();
const browsers = new Set<import("bun").ServerWebSocket<WsData>>();

const server = Bun.serve<WsData>({
  port: 3001,
  fetch(req, server) {
    const url = new URL(req.url);
    const clientType = (url.searchParams.get("client") ?? "browser") as ClientType;
    const upgraded = server.upgrade(req, { data: { type: clientType } });
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      if (ws.data.type === "hardware") {
        hardware.add(ws);
        console.log(`[ws] hardware connected (${hardware.size} total)`);
      } else {
        browsers.add(ws);
        console.log(`[ws] browser connected (${browsers.size} total)`);
      }
    },
    message(ws, msg) {
      const targets = ws.data.type === "hardware" ? browsers : hardware;
      for (const t of targets) {
        t.send(msg);
      }
    },
    close(ws) {
      hardware.delete(ws as import("bun").ServerWebSocket<WsData>);
      browsers.delete(ws as import("bun").ServerWebSocket<WsData>);
      console.log(`[ws] disconnected (hw:${hardware.size} br:${browsers.size})`);
    },
  },
});

console.log(`[ws] relay listening on :${server.port}`);
