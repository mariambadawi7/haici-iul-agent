import { useEffect, useRef } from "react";
import type { FaceState } from "../types";

export interface HardwareOpts {
  faceState: FaceState;
  onNewSession: () => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onStopSpeaking: () => void;
}

export function useHardware({
  faceState,
  onNewSession,
  onStartRecord,
  onStopRecord,
  onStopSpeaking,
}: HardwareOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const faceRef = useRef(faceState);
  faceRef.current = faceState;

  // Stable refs so the reconnect loop never needs callbacks in its dep array
  const cbRef = useRef({ onNewSession, onStartRecord, onStopRecord, onStopSpeaking });
  cbRef.current = { onNewSession, onStartRecord, onStopRecord, onStopSpeaking };

  useEffect(() => {
    // Connect DIRECTLY to the Bun.serve relay on port 3001 — not through the
    // Vite dev-server proxy, which does not reliably forward WS frames for a
    // custom backend. On the kiosk machine the page is served over
    // http://localhost:5173 (a secure context, so the mic still works), so a
    // plain ws:// connection to the relay has no mixed-content/cert friction.
    // Override with VITE_HW_WS_URL if the relay lives on another host.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url =
      import.meta.env.VITE_HW_WS_URL ||
      `${proto}//${location.hostname}:3001/ws?client=browser`;
    let alive = true;

    function connect() {
      if (!alive) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.info("[hw] relay connected");
        ws.send(JSON.stringify({ type: "status", state: faceRef.current }));
      };

      ws.onmessage = (e) => {
        let msg: { type: string };
        try {
          msg = JSON.parse(e.data as string);
        } catch {
          return;
        }
        const cb = cbRef.current;
        switch (msg.type) {
          case "new_session":
          case "presence_detected":
            cb.onNewSession();
            break;
          case "start_record":
            cb.onStartRecord();
            break;
          case "stop_record":
            cb.onStopRecord();
            break;
          case "stop_speaking":
            cb.onStopSpeaking();
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (alive) setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      alive = false;
      wsRef.current?.close();
    };
  }, []); // connect once on mount

  // Push face state to hardware whenever it changes
  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "status", state: faceState }));
    }
  }, [faceState]);
}
