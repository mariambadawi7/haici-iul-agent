import { useCallback, useEffect, useRef, useState } from "react";
import { OpenCam } from "@opencam/client";
import type { Box, FrameSize } from "@opencam/client";
import { cropFace, faceSizeInVideoPixels, MIN_FACE_PX } from "../lib/faceCrop";
import {
  freshDiagWindow,
  noteCropRejection,
  noteFacePx,
  reportBindingDiagnostic,
  MIN_FRAMES_TO_REPORT,
  REPORT_INTERVAL_MS,
} from "../lib/bindingDiag";
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

/**
 * Identity confidence.
 *
 * The backend calls a face matched at cosine >= 0.363 (`match_threshold` in
 * face_matcher.py). That is the right threshold for its job — labelling a box
 * on a dashboard, where a wrong name is a cosmetic error you can see and
 * ignore. It is the wrong threshold for ours: this identity keys a stored
 * transcript, so a false match does not mislabel a box, it opens a stranger's
 * conversation and shows it to the wrong person.
 *
 * The failure modes are not symmetric, so the gate is not centred:
 *
 *   too strict -> a returning visitor gets a blank chat. Mildly annoying, and
 *                 self-correcting, because they are about to be re-enrolled or
 *                 recognised on the next frame.
 *   too loose  -> one person reads another person's conversation. Not
 *                 recoverable, and not even noticed by the kiosk.
 *
 * So: a higher similarity than the backend requires, AND the same name on
 * consecutive frames. The second condition is what a single unlucky frame
 * cannot satisfy, and at 15-25 fps it costs a fraction of a second.
 */
const IDENTITY_MIN_SIMILARITY = 0.5;
const IDENTITY_MIN_FRAMES = 5;

/**
 * Frames of a face with no identity before we accept that it is genuinely a
 * stranger rather than a match that has not resolved yet. Longer than the
 * confirmation above, deliberately: enrolling is a write to the gallery, and
 * enrolling someone who was about to be recognised creates a duplicate
 * identity that splits their history in two forever.
 */
const STRANGER_MIN_FRAMES = 25;

/**
 * A `<video>` that exists only so a still can be grabbed from the camera.
 *
 * The kiosk never shows the camera feed, but `canvas.drawImage` needs an
 * element with decoded frames in it, and the SDK hands back a MediaStream
 * rather than anything drawable.
 *
 * It is attached to the document and sized 1x1 rather than hidden with
 * `display:none` or left detached. Browsers are entitled to stop decoding a
 * video they are not painting, and both of those routes hit that path on at
 * least one engine — the symptom is not an error but a permanently black crop,
 * which enrolls successfully and then matches nobody. One transparent pixel in
 * the corner is the price of the frames being real.
 */
function createCaptureVideo(stream: MediaStream): HTMLVideoElement {
  const el = document.createElement("video");
  el.srcObject = stream;
  el.muted = true;
  // iOS Safari refuses inline playback without this and opens the fullscreen
  // player instead, which on a kiosk would cover the entire interface.
  el.playsInline = true;
  el.autoplay = true;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(el);
  // Autoplay of a muted stream is allowed, but the promise still rejects if
  // the element is torn down mid-start. Nothing to do about it either way.
  void el.play().catch(() => undefined);
  return el;
}

function destroyCaptureVideo(el: HTMLVideoElement | null): void {
  if (!el) return;
  el.pause();
  // Drop the reference to the stream without stopping its tracks — the tracks
  // belong to the OpenCam publisher, which is still sending them.
  el.srcObject = null;
  el.remove();
}

/**
 * `null` while the camera has not made up its mind, a gallery label once it
 * has, or the `"stranger"` sentinel for a face it is confident it has never
 * seen. The three are genuinely different and the caller acts differently on
 * each: wait, bind, enroll.
 */
export type ConfirmedIdentity = string | { stranger: true } | null;

export const isStranger = (id: ConfirmedIdentity): id is { stranger: true } =>
  typeof id === "object" && id !== null;

export interface UseVisionOptions {
  enabled: boolean;
  sessionId?: string;
}

export function useVision({ enabled, sessionId = "kiosk" }: UseVisionOptions) {
  const [signal, setSignal] = useState<VisionSignal>(IDLE);
  const [emotion, setEmotion] = useState<Emotion | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  /**
   * The identity the kiosk is willing to act on: a gallery label confirmed by
   * IDENTITY_MIN_FRAMES agreeing frames above IDENTITY_MIN_SIMILARITY, or
   * `"stranger"` once a face has gone that long without resolving to one.
   *
   * State rather than a ref because binding a conversation to a person is a
   * render-visible event; it changes a handful of times per visit, not per
   * frame, which is the whole point of confirming it here rather than letting
   * every consumer re-derive it from the raw stream.
   */
  const [identity, setIdentity] = useState<ConfirmedIdentity>(null);

  const camRef = useRef<OpenCam | null>(null);
  const lastUpdateRef = useRef(0);
  // Mirrors `publishing` for the gesture-listener effect below, whose closure
  // is created once per effect run and would otherwise see a stale value.
  const publishingRef = useRef(publishing);
  publishingRef.current = publishing;
  const emotionWindowRef = useRef<Sample[]>([]);
  // Mirrors the committed emotion so the update handler can compare without
  // depending on state — at 20 fps this runs far more often than React renders.
  const emotionRef = useRef<Emotion | null>(null);
  /** Latest unsmoothed label, for diagnostics. Read through a function so it
   *  cannot cause a render on every frame. */
  const rawEmotionRef = useRef<string | null>(null);

  // --- Identity confirmation and face capture ---
  //
  // All refs, all written from the `update` handler. That handler runs 15-25
  // times a second; anything it puts in React state re-renders the whole app
  // at that rate. Only the confirmed identity graduates to state, and only
  // when it actually changes.

  /** Consecutive frames agreeing on the same above-threshold name. */
  const identityRunRef = useRef<{ name: string | null; frames: number }>({
    name: null,
    frames: 0,
  });
  /** Consecutive frames showing a face that resolved to nobody. */
  const strangerRunRef = useRef(0);
  /**
   * Counters explaining why the two runs above are not completing.
   *
   * Written every frame and read only by the reporting timer, so it is a ref:
   * a re-render per frame to display nothing would cost more than the
   * diagnostic is worth.
   */
  const diagRef = useRef(freshDiagWindow());
  const identityRef = useRef<ConfirmedIdentity>(null);
  /** Nearest face geometry from the last frame, for cropping. */
  const faceRef = useRef<{ box: Box; frame: FrameSize } | null>(null);
  /** The published camera stream, kept so a still can be grabbed from it. */
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
      // Geometry for cropping a reference photo. `frame` travels with the box
      // because the two are one unit — a box means nothing without the frame
      // it was measured in (see lib/faceCrop.ts).
      faceRef.current =
        nearest?.face_box && snapshot.frame
          ? { box: nearest.face_box as Box, frame: snapshot.frame }
          : null;

      // Identity confirmation. `matched` is a name this frame is confident
      // enough about to count; anything weaker is treated as no match at all,
      // not as a weak vote, because the run below must mean "N frames of
      // real evidence" rather than "N frames of maybe".
      const named = identityOf(nearest?.name);
      const matched =
        named && (nearest?.similarity ?? 0) >= IDENTITY_MIN_SIMILARITY ? named : null;

      const run = identityRunRef.current;
      // A different name restarts the count rather than continuing it: two
      // frames of Ali and three of Sara are not five frames of anything.
      run.frames = matched && matched === run.name ? run.frames + 1 : 1;
      run.name = matched;

      const seesFace = people.some((p) => p.has_face);
      const strangerRunBefore = strangerRunRef.current;
      strangerRunRef.current = seesFace && !matched ? strangerRunRef.current + 1 : 0;

      let confirmed: ConfirmedIdentity = identityRef.current;
      if (matched && run.frames >= IDENTITY_MIN_FRAMES) {
        confirmed = matched;
      } else if (strangerRunRef.current >= STRANGER_MIN_FRAMES) {
        confirmed = { stranger: true };
      } else if (!seesFace && people.length === 0) {
        // Nobody in frame at all: drop back to undecided so the next person to
        // walk up is evaluated from scratch rather than inheriting a verdict.
        confirmed = null;
      }

      // Compare by identity for the sentinel too — a fresh `{ stranger: true }`
      // every frame would be a new object and would re-render forever.
      const changed = isStranger(confirmed)
        ? !isStranger(identityRef.current)
        : confirmed !== identityRef.current;
      if (changed) {
        identityRef.current = confirmed;
        setIdentity(confirmed);
      }

      // Evidence for why an unresolved face stays unresolved. A handful of
      // counter updates per frame, and none at all once a name is confirmed —
      // see lib/bindingDiag.ts for what the shapes of this mean.
      if (typeof confirmed === "string") {
        // Recognised. Nothing to explain, so the window starts over rather
        // than surviving to report a success as a failure later.
        diagRef.current = freshDiagWindow();
      } else {
        const diag = diagRef.current;
        diag.frames += 1;
        if (seesFace) diag.framesWithFace += 1;
        diag.bestStrangerRun = Math.max(diag.bestStrangerRun, strangerRunRef.current);
        if (strangerRunBefore > 0 && strangerRunRef.current === 0) {
          // Which of the two things broke the run is the whole question: a
          // match means the gallery is half-recognising this person, no match
          // means the detector lost their face between frames.
          if (matched) diag.resetsMatched += 1;
          else diag.resetsNoFace += 1;
        }
        const similarity = nearest?.similarity ?? 0;
        if (named && !matched && similarity > (diag.weakMatch?.similarity ?? 0)) {
          diag.weakMatch = { name: named, similarity };
        }
        const facePx = faceSizeInVideoPixels(
          videoRef.current,
          nearest?.face_box as Box | undefined,
          snapshot.frame,
        );
        if (facePx !== null) noteFacePx(diag, facePx);
      }

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
      destroyCaptureVideo(videoRef.current);
      videoRef.current = null;
      streamRef.current = null;
      setPublishing(false);
      setSignal(IDLE);
      emotionWindowRef.current = [];
      emotionRef.current = null;
      setEmotion(null);
      identityRunRef.current = { name: null, frames: 0 };
      strangerRunRef.current = 0;
      diagRef.current = freshDiagWindow();
      faceRef.current = null;
      identityRef.current = null;
      setIdentity(null);
    };
  }, [enabled, sessionId]);

  // Demote to not-live when inference stops arriving, whatever the socket says.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (Date.now() - lastUpdateRef.current > STALE_MS) {
        setSignal((s) => (s.live ? IDLE : s));
        // A verdict outlives the evidence for it otherwise: with inference
        // stopped, the last confirmed identity would stay latched and the next
        // person to walk up would be bound to whoever was here when the
        // camera died.
        if (identityRef.current !== null) {
          identityRef.current = null;
          identityRunRef.current = { name: null, frames: 0 };
          strangerRunRef.current = 0;
          faceRef.current = null;
          setIdentity(null);
        }
      }

      // Report on the same tick. Nothing downstream ever asks for this — a
      // conversation that never binds simply proceeds — so the timer is the
      // only thing that can raise it.
      //
      // Two situations qualify, and the second is why this is not simply "no
      // identity yet": a confirmed stranger whose every crop is refused has an
      // identity as far as this hook is concerned, and is exactly the case
      // worth hearing about. A stranger who enrolls normally satisfies
      // neither — the backend rebuilds its gallery within about five seconds
      // and starts returning the new uid, which resolves the verdict to a
      // name and clears the window — so a working kiosk stays silent.
      const diag = diagRef.current;
      const undecided = identityRef.current === null;
      const enrollmentRefused = Object.keys(diag.cropRejections).length > 0;
      if (
        Date.now() - diag.startedAt >= REPORT_INTERVAL_MS &&
        ((undecided && diag.framesWithFace >= MIN_FRAMES_TO_REPORT) || enrollmentRefused)
      ) {
        const { startedAt, ...counters } = diag;
        reportBindingDiagnostic({
          ...counters,
          unresolvedMs: Date.now() - startedAt,
          needStrangerFrames: STRANGER_MIN_FRAMES,
          needSimilarity: IDENTITY_MIN_SIMILARITY,
          minFacePx: MIN_FACE_PX,
        });
        diagRef.current = freshDiagWindow();
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [enabled]);

  /** Start publishing this device's camera. MUST be called from a user gesture. */
  const enable = useCallback(async () => {
    const cam = camRef.current;
    if (!cam) return;
    try {
      // Video ONLY. Two reasons, and the second is a real bug that looked like
      // a broken camera:
      //
      // 1. The vision pipeline needs pixels. The kiosk's microphone belongs to
      //    the STT path (useSTT), which opens it per recording; holding it open
      //    here as well is pointless and leaves the browser's mic indicator lit
      //    the whole time the kiosk is running.
      //
      // 2. The SDK defaults a camera source to `audio: true`, and getUserMedia
      //    is ALL-OR-NOTHING: one call for video+audio rejects entirely if
      //    either device is unavailable. So any app holding the microphone —
      //    Discord during a call or a stream is the case we hit — made this
      //    request fail with NotReadableError, and the symptom was "the camera
      //    does not work" even though the camera itself was free.
      const stream = await cam.start({ type: "camera", audio: false });
      streamRef.current = stream;
      if (stream) {
        destroyCaptureVideo(videoRef.current);
        videoRef.current = createCaptureVideo(stream);
      }
      setPublishing(true);
      setError(null);
    } catch (err: unknown) {
      setPublishing(false);
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  // Satisfy the browser's gesture requirement without asking the kiosk for a
  // ritual tap: a touch anywhere on the page starts the camera. `once` is
  // deliberately NOT used — a start can fail for transient reasons (signalling
  // still in flight, a permission prompt dismissed by accident), and consuming
  // the listener on a failure would disable the camera for the whole page load.
  useEffect(() => {
    if (!enabled || publishing) return;
    let cancelled = false;
    const onGesture = async () => {
      if (cancelled) return;
      document.removeEventListener("pointerdown", onGesture);
      await enable();
      // enable() swallows its own errors; if it did not start, listen again so
      // the next tap gets another chance.
      if (!cancelled && !publishingRef.current) {
        document.addEventListener("pointerdown", onGesture);
      }
    };
    document.addEventListener("pointerdown", onGesture);
    return () => {
      cancelled = true;
      document.removeEventListener("pointerdown", onGesture);
    };
  }, [enabled, publishing, enable]);

  const disable = useCallback(async () => {
    await camRef.current?.stop().catch(() => undefined);
    destroyCaptureVideo(videoRef.current);
    videoRef.current = null;
    streamRef.current = null;
    setPublishing(false);
    setSignal(IDLE);
  }, []);

  /**
   * A JPEG of the face currently nearest the camera, for enrollment.
   *
   * Null whenever this moment cannot produce a usable reference photo — no
   * camera, no face in the last frame, or a face too small or too close to the
   * edge (see lib/faceCrop.ts). The caller is sampling a live stream, so null
   * means "not this frame", never "broken".
   */
  const captureFace = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    const face = faceRef.current;
    if (!video || !face) {
      // Never reaches cropFace, and it is a distinct failure: the capture
      // element or the last frame's geometry is missing, not the face.
      noteCropRejection(diagRef.current, "no-frame-geometry", null);
      return null;
    }
    try {
      return await cropFace({
        video,
        box: face.box,
        frame: face.frame,
        onReject: ({ reason, facePx }) =>
          noteCropRejection(diagRef.current, reason, facePx),
      });
    } catch (err) {
      console.warn("[vision] face capture failed", err);
      noteCropRejection(diagRef.current, "threw", null);
      return null;
    }
  }, []);

  /** The unsmoothed label, for debugging why the smoothed one settled where it did. */
  const readRawEmotion = useCallback(() => rawEmotionRef.current, []);

  /** OCR lines currently in frame — for "hold your paper up to the camera". */
  const readText = useCallback((): string[] => camRef.current?.get("text") ?? [], []);

  return {
    signal,
    emotion,
    identity,
    publishing,
    error,
    enable,
    disable,
    captureFace,
    readText,
    readRawEmotion,
  };
}
