import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays audio returned by the n8n workflow. Tapping a WebAudio AnalyserNode
 * on the playback graph exposes an RMS `amplitude` value (0..1) for lip-sync.
 *
 * We never call Piper from the browser — the workflow synthesises and ships
 * the WAV back as `audioBase64`, decoded into a Blob upstream.
 *
 * Two iOS/iPadOS constraints shape this file, and both bite because playback
 * begins after the await on the network reply, where no user activation is
 * left:
 *
 *  1. An AudioContext only starts (or resumes) inside a user gesture, and
 *     `createMediaElementSource` REROUTES the element away from the speakers
 *     into the graph. Handing the element to a suspended context is therefore
 *     silence — with every success signal still firing: play() resolves,
 *     onplay and onended run, the avatar animates.
 *  2. A media element needs its own activation. A freshly constructed
 *     `new Audio()` has none, so `play()` on it can be refused outright.
 *
 * So one element is created up front and unlocked on the first gesture, then
 * reused for every utterance by swapping `src` — an element that has played
 * once may be played again from script indefinitely. The graph is attached
 * lazily and only once the context is confirmed running, because
 * `createMediaElementSource` is irreversible for an element: route it into a
 * context that never starts and it is mute forever.
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

/** 8 frames of silence — just enough to count as a played media element. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function useTTS() {
  const [enabled, setEnabled] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [amplitude, setAmplitude] = useState(0);

  const ctxRef = useRef<AudioContext | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const routedRef = useRef(false);
  const unlockedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

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

  const getEl = useCallback((): HTMLAudioElement => {
    if (elRef.current) return elRef.current;
    const el = document.createElement("audio");
    el.preload = "auto";
    // Never appended to the DOM; playsinline only matters to stop iOS from
    // treating it as a fullscreen-capable player.
    el.setAttribute("playsinline", "");
    elRef.current = el;
    return el;
  }, []);

  // Unlock both the context and the element on the first real gesture, the
  // only moment Safari grants either. Listeners stay attached for the life of
  // the hook rather than detaching once satisfied: iOS re-suspends the context
  // when the page is backgrounded, and leaving these in place lets the next
  // tap heal it instead of stranding playback.
  useEffect(() => {
    const EVENTS = ["pointerdown", "touchend", "keydown"] as const;

    const unlock = () => {
      const ctx = getCtx();
      if (ctx && ctx.state !== "running") {
        // Deliberately not awaited: on iOS a resume that will not be granted
        // can leave its promise unsettled, and this runs on every tap.
        void ctx.resume().catch(() => {
          /* the next gesture retries */
        });
        // Some WebKit builds only honour the resume once the graph has
        // produced a sample, so push one silent buffer through in this gesture.
        try {
          const src = ctx.createBufferSource();
          src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          src.connect(ctx.destination);
          src.start(0);
        } catch {
          /* ignored */
        }
      }

      if (!unlockedRef.current) {
        const el = getEl();
        el.src = SILENT_WAV;
        const p = el.play();
        if (p && typeof p.then === "function") {
          p.then(() => {
            el.pause();
            unlockedRef.current = true;
          }).catch(() => {
            /* the next gesture retries */
          });
        } else {
          unlockedRef.current = true;
        }
      }
    };

    EVENTS.forEach((e) =>
      document.addEventListener(e, unlock, { passive: true }),
    );
    return () =>
      EVENTS.forEach((e) => document.removeEventListener(e, unlock));
  }, [getCtx, getEl]);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    const el = elRef.current;
    if (el) {
      el.onplay = null;
      el.onended = null;
      el.onerror = null;
      el.pause();
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setSpeaking(false);
    setAmplitude(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // iOS can suspend a running context mid-utterance — another app taking the
  // audio session, the tab going to the background. Once the element is routed
  // into the graph it cannot be un-routed, so the only repair is to bring the
  // context back.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !speaking) return;
    const onStateChange = () => {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {
          /* the next gesture will retry */
        });
      }
    };
    ctx.addEventListener("statechange", onStateChange);
    return () => ctx.removeEventListener("statechange", onStateChange);
  }, [speaking]);

  const playBlob = useCallback(
    async (blob: Blob) => {
      if (!enabled) return;
      cleanup();

      const el = getEl();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;

      try {
        const ctx = getCtx();
        if (ctx && ctx.state === "suspended") {
          void ctx.resume().catch(() => {
            /* ignored */
          });
        }

        // Attach the analyser the first time — and only ever when the context
        // is genuinely running, since this is a one-way door for the element.
        if (ctx && ctx.state === "running" && !routedRef.current) {
          try {
            const source = ctx.createMediaElementSource(el);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(ctx.destination);
            analyserRef.current = analyser;
            routedRef.current = true;
          } catch (e) {
            console.warn("[tts] could not attach the analyser", e);
            analyserRef.current = null;
          }
        }

        const analyser = analyserRef.current;
        const data = analyser
          ? new Uint8Array(analyser.frequencyBinCount)
          : null;

        const tick = () => {
          if (analyser && data) {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            setAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 3));
          } else {
            // No graph to measure, so drive the mouth from a synthetic
            // envelope the way App.tsx does when TTS is off. Sound matters
            // more than an accurate lip-sync.
            const t = performance.now() / 1000;
            const v = 0.35 + 0.3 * Math.sin(t * 11) + 0.2 * Math.sin(t * 17.3);
            setAmplitude(Math.max(0, Math.min(1, v)));
          }
          rafRef.current = requestAnimationFrame(tick);
        };

        el.onplay = () => {
          setSpeaking(true);
          tick();
        };
        el.onended = cleanup;
        el.onerror = cleanup;

        el.src = url;
        await el.play();
      } catch (e) {
        console.error("TTS playback failed", e);
        cleanup();
      }
    },
    [enabled, cleanup, getCtx, getEl],
  );

  const stop = useCallback(() => cleanup(), [cleanup]);

  return { enabled, setEnabled, speaking, amplitude, playBlob, stop };
}
