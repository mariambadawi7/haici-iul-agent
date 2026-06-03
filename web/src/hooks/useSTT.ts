import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "permission" | "recording";
export type MicPermission = "prompt" | "granted" | "denied" | "unsupported";

export interface StopResult {
  blob: Blob | null;
  /** Friendly reason when blob is null (empty recording, premature stop). */
  reason?: string;
}

export function useSTT() {
  const [status, setStatus] = useState<Status>("idle");
  const [permission, setPermission] = useState<MicPermission>("prompt");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission("unsupported");
      return;
    }
    const anyNav = navigator as any;
    if (anyNav.permissions?.query) {
      anyNav.permissions
        .query({ name: "microphone" as PermissionName })
        .then((p: PermissionStatus) => {
          setPermission(p.state as MicPermission);
          p.onchange = () => setPermission(p.state as MicPermission);
        })
        .catch(() => {
          /* leave as 'prompt' */
        });
    }
  }, []);

  const cleanupAnalyser = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setLevel(0);
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission("unsupported");
      setError("This browser does not expose a microphone API.");
      return false;
    }
    try {
      setStatus("permission");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission("granted");
      setStatus("idle");
      return true;
    } catch (e: any) {
      setPermission("denied");
      setStatus("idle");
      setError(
        e?.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow access from the browser address bar."
          : (e?.message ?? "Microphone access failed"),
      );
      return false;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermission("granted");

      // VU meter
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      // Emit a chunk every second so a hard stop still has data.
      rec.start(1000);
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setStatus("recording");
      console.info("[stt] recording started", { mime });
    } catch (e: any) {
      setPermission(e?.name === "NotAllowedError" ? "denied" : "prompt");
      setError(e?.message ?? "Microphone access failed");
      setStatus("idle");
      console.error("[stt] start failed", e);
    }
  }, []);

  const stop = useCallback(async (): Promise<StopResult> => {
    const rec = recorderRef.current;
    if (!rec) {
      return { blob: null, reason: "Recorder was not running." };
    }
    const tooShort = Date.now() - startedAtRef.current < 350;
    const result = await new Promise<StopResult>((resolve) => {
      rec.onstop = () => {
        const mime = rec.mimeType || "audio/webm";
        if (chunksRef.current.length === 0) {
          resolve({
            blob: null,
            reason: tooShort
              ? "Recording was too short — hold the mic for at least half a second."
              : "Microphone produced no audio data.",
          });
          return;
        }
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size < 200) {
          resolve({
            blob: null,
            reason: "Recording was empty — please try again.",
          });
          return;
        }
        resolve({ blob });
      };
      try {
        rec.requestData(); // flush any in-progress buffer before stopping
      } catch {
        /* not all browsers support; safe to ignore */
      }
      rec.stop();
    });
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    cleanupAnalyser();
    setStatus("idle");
    if (result.blob) {
      console.info("[stt] recording stopped", {
        bytes: result.blob.size,
        type: result.blob.type,
      });
    } else {
      console.warn("[stt] recording stopped without usable audio", result.reason);
    }
    return result;
  }, [cleanupAnalyser, releaseStream]);

  const cancel = useCallback(() => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignored */
    }
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
    cleanupAnalyser();
    setStatus("idle");
  }, [cleanupAnalyser, releaseStream]);

  useEffect(() => () => cancel(), [cancel]);

  return {
    status,
    permission,
    error,
    level,
    requestPermission,
    start,
    stop,
    cancel,
  };
}
