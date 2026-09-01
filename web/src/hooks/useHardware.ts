import { useEffect, useRef } from "react";
import type { FaceState } from "../types";

export interface HardwareOpts {
  faceState: FaceState;
  onNewSession: () => void;
  /**
   * The ultrasonic sensor saw something. Deliberately separate from
   * `onNewSession`: the red button is a person deciding to start, and is
   * obeyed immediately, whereas a sensor pulse is evidence to be weighed
   * against the camera (see usePresence). Falls back to onNewSession when no
   * handler is supplied, which is the pre-fusion behaviour.
   */
  onPresence?: () => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onStopSpeaking: () => void;
}

export function useHardware({
  faceState,
  onNewSession,
  onPresence,
  onStartRecord,
  onStopRecord,
  onStopSpeaking,
}: HardwareOpts) {
  const wsRef = useRef<WebSocket | null>(null);
  const faceRef = useRef(faceState);
  faceRef.current = faceState;

  // Stable refs so the reconnect loop never needs callbacks in its dep array
  const cbRef = useRef({ onNewSession, onPresence, onStartRecord, onStopRecord, onStopSpeaking });
  cbRef.current = { onNewSession, onPresence, onStartRecord, onStopRecord, onStopSpeaking };

  useEffect(() => {
    // Same-origin, through the Vite proxy (see the /hw-ws entry in
    // vite.config.ts). This used to dial the relay directly on port 3001, which
    // works only while the page is plain http on the kiosk machine itself: on
    // an HTTPS page — which a tablet requires, or getUserMedia refuses the mic —
    // the protocol below becomes wss: and the relay, which serves no TLS,
    // refuses it. Every hardware trigger (ultrasonic presence and all three
    // buttons) went silent with no visible error but the reconnect loop.
    //
    // Going through the page's own origin means the relay inherits the page's
    // certificate and there is nothing separate for a tablet to trust.
    // Override with VITE_HW_WS_URL if the relay lives on another host.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url =
      import.meta.env.VITE_HW_WS_URL ||
      `${proto}//${location.host}/hw-ws?client=browser`;
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
            // A person pressed the button. No sensor fusion applies to an
            // explicit request — obey it immediately.
            cb.onNewSession();
            break;
          case "presence_detected":
            (cb.onPresence ?? cb.onNewSession)();
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
