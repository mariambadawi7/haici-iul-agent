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
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?client=browser`;
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
