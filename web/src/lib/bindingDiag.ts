/**
 * Why a conversation ended up unbound.
 *
 * A visitor who is never recognised and never enrolled leaves no trace at all:
 * no uid, so no record, so nothing in the Visitors tab — and nothing in the
 * sidecar log either, which only speaks when an enrollment actually happens.
 * That silence is correct behaviour (nothing in the binding path may block the
 * kiosk, so every failure is soft) but it makes the failure undiagnosable
 * afterwards. On 2026-09-10 a visitor held a six-minute conversation with a
 * live camera and a healthy vision backend, and there was no way to tell from
 * any log whether his face had never been confirmed a stranger or had been
 * confirmed and every crop refused.
 *
 * This is that missing evidence. It is deliberately a report of the WHOLE
 * window rather than a line per frame — at 15-25 fps the interesting fact is
 * never one frame, it is that a counter kept restarting.
 *
 * WHAT EACH SHAPE MEANS
 *
 *   bestStrangerRun well below needStrangerFrames, resetsNoFace high
 *       The detector is losing the face between frames, so the run restarts
 *       from zero and never completes. Framing, distance or light.
 *
 *   bestStrangerRun at the threshold, cropRejections mostly "face-too-small"
 *       He IS confirmed a stranger and enrollment is what is failing. Compare
 *       largestFacePx against minFacePx: the gap is how much closer he had to
 *       stand, and it is the number to argue about before touching the
 *       threshold, because a small face enrolls badly and then matches anyone.
 *
 *   weakMatch just under needSimilarity
 *       The limbo band. The backend keeps half-matching him to someone already
 *       in the gallery, which is not enough to bind and (correctly) not enough
 *       to stop him counting as a stranger either — but a name here says the
 *       gallery, not the camera, is what needs attention.
 *
 * Raised at most once every REPORT_INTERVAL_MS, and only when the kiosk is
 * genuinely stuck: a face in frame that has resolved to nobody, or crops being
 * refused. An empty lobby has nothing to explain, and neither does a stranger
 * who enrolls normally — the backend rebuilds its gallery within about five
 * seconds and starts returning the new uid as a name, which clears the window.
 */

/** Counters for one reporting window. Reset, never mutated in place, on flush. */
export interface BindingDiagWindow {
  startedAt: number;
  frames: number;
  framesWithFace: number;
  bestStrangerRun: number;
  resetsNoFace: number;
  resetsMatched: number;
  weakMatch: { name: string; similarity: number } | null;
  /** Keyed by CropRejection; a plain record so a new reason needs no change here. */
  cropRejections: Record<string, number>;
  smallestFacePx: number | null;
  largestFacePx: number | null;
}

export const freshDiagWindow = (): BindingDiagWindow => ({
  startedAt: Date.now(),
  frames: 0,
  framesWithFace: 0,
  bestStrangerRun: 0,
  resetsNoFace: 0,
  resetsMatched: 0,
  weakMatch: null,
  cropRejections: {},
  smallestFacePx: null,
  largestFacePx: null,
});

/** The window plus the thresholds it was measured against. */
export interface BindingDiagnostic extends Omit<BindingDiagWindow, "startedAt"> {
  unresolvedMs: number;
  needStrangerFrames: number;
  needSimilarity: number;
  minFacePx: number;
}

/** Track the range of face sizes seen, for comparison against minFacePx. */
export function noteFacePx(w: BindingDiagWindow, px: number): void {
  w.smallestFacePx = Math.min(w.smallestFacePx ?? px, px);
  w.largestFacePx = Math.max(w.largestFacePx ?? px, px);
}

/**
 * Count one refused crop. `reason` is a plain string rather than the
 * CropRejection union because the caller adds one of its own for the case that
 * never reaches cropFace at all — no face in the last frame to crop from.
 */
export function noteCropRejection(
  w: BindingDiagWindow,
  reason: string,
  facePx: number | null,
): void {
  w.cropRejections[reason] = (w.cropRejections[reason] ?? 0) + 1;
  if (facePx !== null) noteFacePx(w, facePx);
}

/**
 * How long a window runs before it is reported.
 *
 * Long enough that a visitor who is simply walking up — a second or two of
 * unresolved frames on the way to being recognised — never produces a line at
 * all, and short enough that a six-minute conversation produces a couple of
 * dozen rather than one summary averaged into meaninglessness.
 */
export const REPORT_INTERVAL_MS = 15_000;

/**
 * Frames with a face below which a window is not worth reporting.
 *
 * Guards the case where inference stops mid-window: the stale timer clears the
 * verdict, the window flushes on its next tick, and three frames of evidence
 * would read as a binding failure when the camera simply went away.
 */
export const MIN_FRAMES_TO_REPORT = 10;

/**
 * Send one report to the sidecar, so it lands in `docker compose logs web`.
 *
 * Fire-and-forget in the strongest sense: no await, no timeout, no retry, and
 * every failure swallowed. This is a diagnostic about a visitor who is
 * standing at the kiosk right now, and it may not cost them so much as a
 * dropped frame. `keepalive` so a report started as the page unloads still
 * goes out.
 */
export function reportBindingDiagnostic(diag: BindingDiagnostic): void {
  // Also to the console: with devtools open on the kiosk this is immediate,
  // and it survives the sidecar being unreachable, which is itself one of the
  // reasons a conversation runs unbound.
  console.info("[vision] unresolved face", diag);
  try {
    void fetch("/api/visitors/diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(diag),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Serialisation or a blocked fetch. Nothing here is worth a second try.
  }
}
