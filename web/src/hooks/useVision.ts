import { useCallback, useEffect, useRef, useState } from "react";
import { OpenCam } from "@opencam/client";
import type { VisionSignal } from "./usePresence";
import type { Emotion } from "../types";

/**
 * Owns the OpenCam connection and reduces its per-frame snapshots to the few
 * facts the kiosk actually acts on.
 *
 * Talks to `${origin}/opencam`, which Vite proxies to the vision backend — see
 * the note in vite.config.ts for why it is same-origin rather than a direct
 * call to :8080. Signalling goes through that proxy; the video itself is direct
 * UDP from this browser to the backend and never touches Vite.
 *
 * TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT:
 *
 * `enable()` must be called from a real user gesture. `getUserMedia` is gated
 * on one, strictly so on iOS Safari, so the camera cannot start on mount — the
 * kiosk needs a tap once per page load. That is a browser rule, not a choice.
 *
 * `live` is deliberately pessimistic: it requires an inference message within
 * the last STALE_MS, not merely a socket that opened. Everything downstream
 * uses `live` to decide whether the camera's silence means "no one is there"
 * or "the camera is not working", and getting that backwards makes the kiosk
 * ignore its ultrasonic sensor. When in doubt this reports not-live, which
 * degrades to the sensor-only behaviour the kiosk had before.
 */

const IDLE: VisionSignal = {
  live: false,
  peopleCount: 0,
  nearestDistanceM: null,
  identity: null,
  hasUnidentifiedFace: false,
};

/** Inference runs at 15-25 fps; 2 s of silence means something is wrong. */
const STALE_MS = 2_000;

/**
 * The backend labels an unmatched face with the STRING "Unknown", not null —
 * confirmed against live output, and the backend guards against the same
 * sentinel internally (pipeline/people.py). Taking `name` at face value would
 * greet a stranger as "Unknown" and, worse, make `hasUnidentifiedFace` always
 * false, so the wake would never wait for a real identity to resolve.
 */
const identityOf = (name: string | null | undefined): string | null =>
  !name || name === "Unknown" ? null : name;

/**
 * Emotion smoothing.
 *
 * Measured on a real face sitting still for ten seconds, the classifier
 * returned Disgust, Neutral, Sad, Surprised and Thinking — five labels for one
 * unchanging expression. Per-frame output is not a reading of how someone
 * feels, it is a sample from a noisy distribution, and anything that consumes
 * it directly (a mascot face, a hint to the agent) reads as a nervous tic.
 *
 * So: majority vote over a window, and only commit when the winner has a real
 * plurality. The window is short enough to follow a genuine change in
 * expression within about a second, long enough to swallow single-frame flips.
 */
const EMOTION_WINDOW_MS = 2_000;
/** Below this many samples the window is too young to be believed. */
const EMOTION_MIN_SAMPLES = 8;
/** The winner must hold at least this share of the window to take over. */
const EMOTION_MIN_SHARE = 0.5;

/**
 * The FER model has seven classes; the app's mascot has four. Angry, Disgust
 * and Fear are also the classes this model is least reliable on, so they map to
 * neutral rather than being forced into a sad/surprised bucket — an expression
 * the kiosk is unsure about is better shown as no expression than as a wrong
 * one. "Thinking" is the backend's derived weak-neutral, so neutral is exact.
 */
const EMOTION_MAP: Record<string, Emotion> = {
  happy: "happy",
  sad: "sad",
  surprised: "surprised",
  neutral: "neutral",
  thinking: "neutral",
  angry: "neutral",
  disgust: "neutral",
  fear: "neutral",
};

type Sample = { t: number; label: string };

/** Winner of the window, or `current` when nothing has earned the switch. */
function majority(window: Sample[], current: Emotion | null): Emotion | null {
  if (window.length < EMOTION_MIN_SAMPLES) return current;

  const counts = new Map<string, number>();
  for (const s of window) counts.set(s.label, (counts.get(s.label) ?? 0) + 1);

  let best: string | null = null;
  let bestCount = 0;
  for (const [label, n] of counts) {
    if (n > bestCount) [best, bestCount] = [label, n];
  }

  if (best === null || bestCount / window.length < EMOTION_MIN_SHARE) return current;
  return EMOTION_MAP[best.toLowerCase()] ?? "neutral";
}

export interface UseVisionOptions {
  enabled: boolean;
  sessionId?: string;
}

export function useVision({ enabled, sessionId = "kiosk" }: UseVisionOptions) {
  const [signal, setSignal] = useState<VisionSignal>(IDLE);
  const [emotion, setEmotion] = useState<Emotion | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const camRef = useRef<OpenCam | null>(null);
  const lastUpdateRef = useRef(0);
  const emotionWindowRef = useRef<Sample[]>([]);
  // Mirrors the committed emotion so the update handler can compare without
  // depending on state — at 20 fps this runs far more often than React renders.
  const emotionRef = useRef<Emotion | null>(null);
  /** Latest unsmoothed label, for diagnostics. Read through a function so it
   *  cannot cause a render on every frame. */
  const rawEmotionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSignal(IDLE);
      return;
    }

    const cam = new OpenCam({ url: `${location.origin}/opencam`, sessionId });
    camRef.current = cam;

    cam.on("update", (snapshot) => {
      lastUpdateRef.current = Date.now();
      const people = snapshot.people;
      // The backend sorts people nearest-first, so [0] is who we are talking to.
      const nearest = people[0] ?? null;
      setSignal({
        live: true,
        peopleCount: people.length,
        nearestDistanceM: nearest?.distance_m ?? null,
        identity: identityOf(nearest?.name),
        hasUnidentifiedFace: people.some((p) => p.has_face && !identityOf(p.name)),
      });
      // Smoothed, not raw: see EMOTION_WINDOW_MS above for why.
      const label = nearest?.emotion?.label ?? null;
      rawEmotionRef.current = label;

      const now = Date.now();
      const window = emotionWindowRef.current;
      if (label) window.push({ t: now, label });
      while (window.length && now - window[0].t > EMOTION_WINDOW_MS) window.shift();

      const next = window.length === 0 ? null : majority(window, emotionRef.current);
      if (next !== emotionRef.current) {
        emotionRef.current = next;
        setEmotion(next);
      }
    });

    cam.on("error", (err) => setError(err instanceof Error ? err : new Error(String(err))));

    // A failure here is not fatal: the vision backend being down must leave the
    // kiosk working exactly as it did without a camera.
    cam.init().catch((err: unknown) => {
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      camRef.current = null;
      void cam.destroy().catch(() => undefined);
      setPublishing(false);
      setSignal(IDLE);
      emotionWindowRef.current = [];
      emotionRef.current = null;
      setEmotion(null);
    };
  }, [enabled, sessionId]);

  // Demote to not-live when inference stops arriving, whatever the socket says.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (Date.now() - lastUpdateRef.current > STALE_MS) {
        setSignal((s) => (s.live ? IDLE : s));
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [enabled]);

  /** Start publishing this device's camera. MUST be called from a user gesture. */
  const enable = useCallback(async () => {
    const cam = camRef.current;
    if (!cam) return;
    try {
      await cam.start({ type: "camera" });
      setPublishing(true);
      setError(null);
    } catch (err: unknown) {
      setPublishing(false);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  // Satisfy the gesture requirement without asking the kiosk for a ritual tap:
  // the first touch anywhere on the page starts the camera. On a kiosk that is
  // the visitor tapping "Begin", or the staff waking the tablet in the morning.
  // `once` plus the publishing guard means it runs exactly one time.
  useEffect(() => {
    if (!enabled || publishing) return;
    const onGesture = () => void enable();
    document.addEventListener("pointerdown", onGesture, { once: true });
    return () => document.removeEventListener("pointerdown", onGesture);
  }, [enabled, publishing, enable]);

  const disable = useCallback(async () => {
    await camRef.current?.stop().catch(() => undefined);
    setPublishing(false);
    setSignal(IDLE);
  }, []);

  /** The unsmoothed label, for debugging why the smoothed one settled where it did. */
  const readRawEmotion = useCallback(() => rawEmotionRef.current, []);

  /** OCR lines currently in frame — for "hold your paper up to the camera". */
  const readText = useCallback((): string[] => camRef.current?.get("text") ?? [], []);

  return { signal, emotion, publishing, error, enable, disable, readText, readRawEmotion };
}
