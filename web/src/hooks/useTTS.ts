import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays audio returned by the n8n workflow. Tapping a WebAudio AnalyserNode
 * on the playback graph exposes an RMS `amplitude` value (0..1) for lip-sync.
 *
 * We never call Piper from the browser — the workflow synthesises and ships
 * the WAV back as `audioBase64`, decoded into a Blob upstream.
 */
export function useTTS() {
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(false);
    setAmplitude(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const playBlob = useCallback(
    async (blob: Blob) => {
      if (!enabled) return;
      cleanup();
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        audio.crossOrigin = "anonymous";
        audioRef.current = audio;

        const ctx = ctxRef.current ?? new AudioContext();
        ctxRef.current = ctx;
        if (ctx.state === "suspended") {
          try {
            await ctx.resume();
          } catch {
            /* ignored */
          }
        }
        const source = ctx.createMediaElementSource(audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          setAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 3));
          rafRef.current = requestAnimationFrame(tick);
        };

        audio.onplay = () => {
          setSpeaking(true);
          tick();
        };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          cleanup();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          cleanup();
        };
        await audio.play();
      } catch (e) {
        URL.revokeObjectURL(url);
        console.error("TTS playback failed", e);
        cleanup();
      }
    },
    [enabled, cleanup],
  );

  const stop = useCallback(() => cleanup(), [cleanup]);

  return { enabled, setEnabled, speaking, amplitude, playBlob, stop };
}
