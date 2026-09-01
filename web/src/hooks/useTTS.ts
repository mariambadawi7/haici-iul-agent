import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays audio returned by the n8n workflow. Tapping a WebAudio AnalyserNode
 * on the playback graph exposes an RMS `amplitude` value (0..1) for lip-sync.
 *
 * We never call Piper from the browser — the workflow synthesises and ships
 * the WAV back as `audioBase64`, decoded into a Blob upstream.
 *
 * iOS/iPadOS caveat, and the reason this file is shaped the way it is:
 * `createMediaElementSource` REROUTES the element away from the speakers and
 * into the graph. If that graph's AudioContext is suspended, playback is
 * silent while every success signal still fires — `play()` resolves, `onplay`
 * and `onended` run, the avatar animates. Safari only lets an AudioContext
 * start (or resume) inside a user gesture, and `playBlob` runs after the await
 * on the network reply, so the context it used to create there was born
 * suspended and stayed that way for the life of the page. Hence two rules
 * below: unlock the context from a real gesture, and never hand the element to
 * a context that is not actually running.
 */

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext ??
    null
  );
}

export function useTTS() {
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      ctxRef.current = new Ctor();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  // Unlock the audio graph on the first real user gesture, which is the only
  // moment Safari will grant it. Listeners stay attached for the life of the
  // hook rather than detaching once running: iOS re-suspends the context when
  // the page is backgrounded, and leaving these in place lets the next tap
  // heal it instead of stranding us on the fallback path forever.
  useEffect(() => {
    const EVENTS = ["pointerdown", "touchend", "keydown"] as const;

    const unlock = () => {
      const ctx = getCtx();
      if (!ctx || ctx.state === "running") return;
      // Deliberately not awaited: on iOS a resume() that will not be granted
      // can leave its promise unsettled, and this runs on every tap.
      void ctx.resume().catch(() => {
        /* ignored — the next gesture tries again */
      });
      // Some WebKit builds only honour the resume once the graph has actually
      // produced a sample, so push one silent buffer through inside this same
      // gesture.
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* ignored */
      }
    };

    EVENTS.forEach((e) => document.addEventListener(e, unlock, { passive: true }));
    return () =>
      EVENTS.forEach((e) => document.removeEventListener(e, unlock));
  }, [getCtx]);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onplay = null;
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
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          URL.revokeObjectURL(url);
        }
        cleanup();
      };

      try {
        // No crossOrigin here: the source is a same-origin blob: URL, where the
        // attribute buys nothing and has historically made Safari fail the load.
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = release;
        audio.onerror = release;

        const ctx = getCtx();
        if (ctx && ctx.state === "suspended") {
          // Same reasoning as in `unlock` — kick it, but never block on it.
          void ctx.resume().catch(() => {
            /* ignored */
          });
        }

        // The decisive check. Only route the element through the analyser if
        // the context is genuinely running; otherwise let the element play
        // straight to the speakers, which needs no unlocked context.
        if (ctx && ctx.state === "running") {
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
        } else {
          // Fallback: audible, but there is no graph to measure, so drive the
          // mouth from a synthetic envelope the way App.tsx does when TTS is
          // off. Sound matters more than an accurate lip-sync.
          const synthTick = () => {
            const t = performance.now() / 1000;
            const v =
              0.35 + 0.3 * Math.sin(t * 11) + 0.2 * Math.sin(t * 17.3);
            setAmplitude(Math.max(0, Math.min(1, v)));
            rafRef.current = requestAnimationFrame(synthTick);
          };

          audio.onplay = () => {
            setSpeaking(true);
            synthTick();
          };
          console.info(
            "[tts] AudioContext unavailable or suspended — playing without the analyser tap",
          );
        }

        await audio.play();
      } catch (e) {
        console.error("TTS playback failed", e);
        release();
      }
    },
    [enabled, cleanup, getCtx],
  );

  const stop = useCallback(() => cleanup(), [cleanup]);

  return { enabled, setEnabled, speaking, amplitude, playBlob, stop };
}
