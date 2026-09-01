import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fuses the two ways the kiosk can notice a person into a single wake.
 *
 * The ultrasonic sensor on the ESP32 answers "something is within N cm": fast,
 * works in the dark, and fires just as happily for a cleaning cart. The camera
 * answers "a person is at D metres, and it is Ali": slower, useless in the
 * dark, but it knows a human from a chair and it knows when they leave.
 *
 * Neither is a superset of the other, so this hook uses each to cover the
 * other's blind spot:
 *
 *   - The camera VETOES the sensor. A pulse with the camera live and no person
 *     in frame is an object, and is dropped. This is the rule that stops the
 *     kiosk greeting furniture.
 *   - The sensor COVERS the camera. If the camera is not live — dark room,
 *     tablet asleep, backend down — a pulse wakes immediately, exactly as it
 *     did before this hook existed. Degrading to the old behaviour is the
 *     required failure mode, not a fallback we hope never runs.
 *   - The camera can wake ON ITS OWN when someone walks up close enough,
 *     which catches the person who approaches from outside the sensor's cone.
 *   - The camera ENDS the session on `person:leave`, so the next person does
 *     not walk up to a stranger's transcript. Departing also clears the
 *     cooldown, so the following visitor is greeted immediately rather than
 *     waiting out a timer sized for "the same person is still standing here".
 *
 * This hook takes plain signals rather than the OpenCam SDK so the rules stay
 * testable without a camera, and so a different vision backend could feed it.
 */

export type WakeSource = "ultrasonic" | "camera" | "both" | "button";

export interface WakeEvent {
  source: WakeSource;
  /** Recognised identity, when one resolved in time. Never blocks the wake. */
  name: string | null;
}

/** Everything the fusion needs to know about what the camera currently sees. */
export interface VisionSignal {
  /** The pipeline is connected AND receiving inference. False = no camera. */
  live: boolean;
  peopleCount: number;
  /** Metres to the nearest person. Null when no face gives an IPD estimate. */
  nearestDistanceM: number | null;
  /** Name of the nearest person, if a reference photo matched. */
  identity: string | null;
  /** A face is being tracked but has not resolved to a name (yet, or ever). */
  hasUnidentifiedFace: boolean;
}

export interface UsePresenceOptions {
  vision: VisionSignal;
  onWake: (event: WakeEvent) => void;
  /** Everyone has left and stayed gone. Only ever fires when the camera is live. */
  onDepart?: () => void;

  /** Minimum gap between wakes. Cleared early by a departure. */
  cooldownMs?: number;
  /** How long a sensor pulse waits for the camera to confirm a person. */
  vetoMs?: number;
  /** Wake on the camera alone at or inside this range. */
  nearMetres?: number;
  /** How long a wake may wait for a name, when a face is visible but unnamed. */
  nameGraceMs?: number;
  /** Continuous emptiness before a departure is declared. */
  departMs?: number;
}

export interface PresenceState {
  lastSource: WakeSource | null;
  lastName: string | null;
  /** Pulses dropped because the camera saw no person. Useful in the admin UI. */
  vetoed: number;
  awake: boolean;
}

const DEFAULTS = {
  // Long enough that one visitor standing at the desk is not re-greeted mid
  // conversation. A departure clears it, so this is not the gap between two
  // different people — it is the gap for the same person.
  cooldownMs: 180_000,
  // Two or three inference passes at 15-25 fps: enough for a person who is
  // really there to appear, short enough that a real wake is not delayed.
  vetoMs: 1_500,
  nearMetres: 1.5,
  nameGraceMs: 700,
  departMs: 10_000,
};

export function usePresence({
  vision,
  onWake,
  onDepart,
  cooldownMs = DEFAULTS.cooldownMs,
  vetoMs = DEFAULTS.vetoMs,
  nearMetres = DEFAULTS.nearMetres,
  nameGraceMs = DEFAULTS.nameGraceMs,
  departMs = DEFAULTS.departMs,
}: UsePresenceOptions) {
  const [state, setState] = useState<PresenceState>({
    lastSource: null,
    lastName: null,
    vetoed: 0,
    awake: false,
  });

  // Timers and callbacks live in refs so the effects below never need them in a
  // dependency array — re-subscribing on every render would restart the veto
  // and departure windows constantly and neither would ever elapse.
  const visionRef = useRef(vision);
  visionRef.current = vision;
  const cbRef = useRef({ onWake, onDepart });
  cbRef.current = { onWake, onDepart };

  const lastWakeRef = useRef(0);
  const awakeRef = useRef(false);
  const vetoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptySinceRef = useRef<number | null>(null);

  const clearVeto = () => {
    if (vetoTimerRef.current) clearTimeout(vetoTimerRef.current);
    vetoTimerRef.current = null;
  };
  const clearGrace = () => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = null;
  };

  const coolingDown = () => Date.now() - lastWakeRef.current < cooldownMs;

  /**
   * Fire the wake. The only thing allowed to delay it is a short wait for a
   * name, and only when a face is actually on camera without one — an
   * identity typically resolves within a pass or two of the face appearing,
   * and greeting someone by name is worth a few hundred milliseconds.
   *
   * The cooldown is stamped at the START of the grace window, not the end, so
   * a second trigger arriving during the wait cannot queue a second wake.
   */
  const commitWake = useCallback(
    (source: WakeSource) => {
      clearVeto();
      lastWakeRef.current = Date.now();
      awakeRef.current = true;
      emptySinceRef.current = null;

      const fire = (name: string | null) => {
        clearGrace();
        setState((s) => ({ ...s, lastSource: source, lastName: name, awake: true }));
        cbRef.current.onWake({ source, name });
      };

      const now = visionRef.current;
      if (now.identity) return fire(now.identity);
      if (!now.live || !now.hasUnidentifiedFace || nameGraceMs <= 0) return fire(null);

      // A face is there but unnamed: give recognition a moment, then go anyway.
      graceTimerRef.current = setTimeout(() => fire(visionRef.current.identity), nameGraceMs);
    },
    [nameGraceMs],
  );

  /** Call on every `presence_detected` from the ESP32 relay. */
  const pulse = useCallback(() => {
    if (coolingDown() || graceTimerRef.current) return;

    const now = visionRef.current;
    // No camera to consult: behave exactly as the kiosk did before.
    if (!now.live) return commitWake("ultrasonic");
    if (now.peopleCount > 0) return commitWake("both");

    // The camera is watching and sees nobody. Do not wake yet: wait one veto
    // window in case inference simply has not caught up with a fast walker,
    // then treat it as an object.
    if (vetoTimerRef.current) return;
    vetoTimerRef.current = setTimeout(() => {
      vetoTimerRef.current = null;
      if (visionRef.current.peopleCount > 0 && !coolingDown()) commitWake("both");
      else setState((s) => ({ ...s, vetoed: s.vetoed + 1 }));
    }, vetoMs);
  }, [commitWake, cooldownMs, vetoMs]);

  // A person appearing during a veto window retroactively confirms the pulse.
  useEffect(() => {
    if (vision.peopleCount > 0 && vetoTimerRef.current && !coolingDown()) {
      commitWake("both");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vision.peopleCount, commitWake]);

  // The camera waking on its own: someone close enough, no sensor involved.
  // A null distance still counts — with the object detector disabled there is
  // no body box to measure, and "a tracked person with no range" is far more
  // likely to be someone at the desk than a false positive.
  useEffect(() => {
    if (!vision.live || vision.peopleCount === 0) return;
    if (coolingDown() || graceTimerRef.current) return;
    const near = vision.nearestDistanceM === null || vision.nearestDistanceM <= nearMetres;
    if (near) commitWake("camera");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vision.live, vision.peopleCount, vision.nearestDistanceM, nearMetres, commitWake]);

  // Departure. Only the camera can observe this; the sensor cannot tell an
  // empty lobby from a person standing still.
  useEffect(() => {
    if (!vision.live || !awakeRef.current) return;

    if (vision.peopleCount > 0) {
      emptySinceRef.current = null;
      return;
    }
    if (emptySinceRef.current === null) emptySinceRef.current = Date.now();

    const elapsed = Date.now() - emptySinceRef.current;
    const timer = setTimeout(
      () => {
        if (visionRef.current.peopleCount > 0 || !awakeRef.current) return;
        awakeRef.current = false;
        emptySinceRef.current = null;
        // Clearing the cooldown is the point: the NEXT person is a new
        // visitor and should be greeted at once, not made to wait out a
        // window sized for the person who just walked away.
        lastWakeRef.current = 0;
        setState((s) => ({ ...s, awake: false }));
        cbRef.current.onDepart?.();
      },
      Math.max(0, departMs - elapsed),
    );
    return () => clearTimeout(timer);
  }, [vision.live, vision.peopleCount, departMs]);

  useEffect(() => () => {
    clearVeto();
    clearGrace();
  }, []);

  /**
   * Start a conversation because a person explicitly asked to — the red button
   * or the on-screen one. No veto and no cooldown check: an explicit request is
   * obeyed. It still goes through commitWake, so the button gets the same short
   * wait for a name that the sensors do, and so it stamps the cooldown that
   * stops a sensor pulse from greeting the same person a second time.
   *
   * On the very first tap of a page load this will be unnamed no matter what:
   * that tap is also what starts the camera, so no frame has been seen yet.
   */
  const wake = useCallback(
    (source: WakeSource = "button") => commitWake(source),
    [commitWake],
  );

  return { pulse, wake, state };
}
