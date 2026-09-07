import { useCallback, useEffect, useRef, useState } from "react";
import {
  enrollFace,
  isGeneratedUid,
  loadVisitor,
  saveVisitor,
  undoEnrollment,
  type VisitorRecord,
} from "../lib/visitorApi";
import type { ProfileDelta } from "../lib/api";
import { isStranger, type ConfirmedIdentity } from "./useVision";
import type { ChatMessage } from "../types";

/**
 * Binds the conversation on screen to the person in front of the camera.
 *
 * This is the hook that turns "the camera is fairly sure this is Ali" into
 * "this conversation belongs to Ali, and here is what he said last time".
 * Three rules do most of the work:
 *
 * ONE BINDING PER CONVERSATION. Once bound, the identity is LOCKED until
 * `release()`. The camera reports the nearest person every frame and the
 * nearest person changes — a colleague leaning in over the visitor's shoulder
 * is enough — so a conversation that followed the live signal would swap
 * whose transcript is on screen mid-sentence. Whoever the kiosk decided it was
 * talking to at the start is who it is talking to until they leave.
 *
 * ENROLLING IS THE SAME ACT AS ISSUING A UID. A stranger has no identifier
 * until their face is in the gallery, so `useVision` reporting a confident
 * stranger is what triggers a capture, an upload, and a brand-new uid.
 *
 * NOTHING HERE MAY BLOCK THE KIOSK. Every failure path — no camera, sidecar
 * down, face too small to crop, enrollment refused — ends in an unbound
 * conversation, which is exactly how the kiosk behaved before any of this
 * existed. A visitor is standing there; being unrecognised is a far better
 * outcome than being made to wait.
 */

export type VisitorStatus =
  /** No camera, or nothing seen yet. */
  | "idle"
  /** A face is in frame and the camera has not committed to a verdict. */
  | "resolving"
  /** Confirmed stranger; a reference photo is being captured and uploaded. */
  | "enrolling"
  /** Bound to a uid. `record` is populated. */
  | "bound"
  /** Deliberately unbound — the camera failed, or the visitor said "not me". */
  | "anonymous";

export interface UseVisitorOptions {
  /** The tenant's camera feature flag. False disables everything here. */
  enabled: boolean;
  /** `useVision().identity` — already confirmed, not a raw per-frame guess. */
  identity: ConfirmedIdentity;
  /** `useVision().captureFace`. */
  captureFace: () => Promise<Blob | null>;
}

/** How long after the last change before the transcript is written. */
const SAVE_DEBOUNCE_MS = 1_500;

/**
 * Gap between opportunistic extra reference photos.
 *
 * The crop taken at the instant someone walks up is one angle in one lighting
 * condition, and it is the only thing standing between them and being treated
 * as a stranger on every future visit. Adding a few more during the
 * conversation — different pose, different expression — is what turns a
 * fragile match into a reliable one. Spaced out on purpose: four frames from
 * the same second are four copies of the same photo.
 */
const EXTRA_SAMPLE_INTERVAL_MS = 9_000;

/** Matches MAX_SAMPLES in web/visitor-store.ts; the server enforces it too. */
const MAX_SAMPLES = 5;

/**
 * What became of the face data when the visitor declined recognition.
 *
 * The panel that offers the control stays open afterwards as a receipt, so it
 * has to be able to say which of these actually happened rather than assert
 * the happy one. `kept` is the honest awkward case: someone the kiosk knew
 * from an earlier visit, whose stored record is not a tap away from deletion.
 */
export type UndoStatus = "none" | "pending" | "removed" | "failed" | "kept";

export function useVisitor({ enabled, identity, captureFace }: UseVisitorOptions) {
  const [status, setStatus] = useState<VisitorStatus>("idle");
  const [undoStatus, setUndoStatus] = useState<UndoStatus>("none");
  const [record, setRecord] = useState<VisitorRecord | null>(null);

  /** The bound uid. A ref as well as state: send-time reads must not lag. */
  const uidRef = useRef<string | null>(null);
  /** True from the moment binding starts, so two frames cannot both enroll. */
  const bindingRef = useRef(false);
  const samplesRef = useRef(0);
  const lastSampleAtRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMessagesRef = useRef<ChatMessage[] | null>(null);
  /** Set once per conversation, so `visits` counts conversations not turns. */
  const visitCountedRef = useRef(false);
  /**
   * True when THIS conversation is what put the bound face in the gallery.
   *
   * The difference between undoing something the kiosk did unasked and
   * deleting a returning visitor's history, which is a staff decision.
   */
  const enrolledHereRef = useRef(false);

  /**
   * Callers waiting on `awaitBinding`. Resolved with the uid the moment one
   * exists, so the first turn of a conversation can go out already addressed
   * to the right person rather than being re-addressed a second later.
   */
  const waitersRef = useRef<Array<(uid: string | null) => void>>([]);
  const settleWaiters = useCallback((value: string | null) => {
    const waiters = waitersRef.current;
    waitersRef.current = [];
    for (const resolve of waiters) resolve(value);
  }, []);

  const bindTo = useCallback(
    async (uid: string, enrolledNow: boolean, samples: number) => {
      uidRef.current = uid;
      samplesRef.current = samples;
      lastSampleAtRef.current = Date.now();
      enrolledHereRef.current = enrolledNow;

      const loaded = await loadVisitor(uid);
      // A record that will not load is not a reason to refuse the binding: the
      // uid is real, the agent's memory is keyed on it, and the person is
      // better served by a kiosk that knows who they are with no transcript
      // than by one that has forgotten them entirely.
      setRecord(loaded);
      setStatus("bound");
      console.info(
        `[visitor] bound to ${uid}`,
        enrolledNow
          ? "(newly enrolled)"
          : `(${loaded?.messages.length ?? 0} stored messages, ${loaded?.visits ?? 0} previous visits)`,
      );
      settleWaiters(uid);
    },
    [settleWaiters],
  );

  const enroll = useCallback(async () => {
    setStatus("enrolling");
    const crop = await captureFace();
    if (!crop) {
      // No usable frame yet — too small, too close to the edge, not decoded.
      // Drop back so the next confirmed-stranger frame tries again.
      bindingRef.current = false;
      setStatus("resolving");
      return;
    }
    const result = await enrollFace(crop);
    if (!result) {
      // The sidecar refused or is unreachable. Do NOT retry in a loop against
      // a store that is down: give up on identity for this conversation and
      // let it run anonymously.
      console.warn("[visitor] enrollment failed; continuing without an identity");
      setStatus("anonymous");
      settleWaiters(null);
      return;
    }
    await bindTo(result.uid, true, result.samples);
  }, [captureFace, bindTo, settleWaiters]);

  // The binder. Runs on every change to the confirmed identity, and does
  // nothing at all once something is bound — that is the lock.
  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    if (bindingRef.current) return;
    if (identity === null) {
      setStatus((s) => (s === "idle" || s === "resolving" ? "resolving" : s));
      return;
    }

    bindingRef.current = true;
    if (isStranger(identity)) {
      void enroll();
    } else {
      // A gallery label. Includes faces a member of staff added by hand, which
      // have a real name for a uid and are handled identically.
      void bindTo(identity, false, 0);
    }
  }, [enabled, identity, enroll, bindTo]);

  /**
   * Extra reference photos, while the conversation runs.
   *
   * Only for visitors this kiosk enrolled itself. A face a member of staff
   * added deliberately already has a proper reference photo, and quietly
   * padding it with kiosk-angle crops is not ours to do.
   */
  useEffect(() => {
    if (status !== "bound" || !record?.enrolled) return;
    if (samplesRef.current >= MAX_SAMPLES) return;

    const timer = setInterval(async () => {
      const uid = uidRef.current;
      if (!uid || samplesRef.current >= MAX_SAMPLES) return;
      if (Date.now() - lastSampleAtRef.current < EXTRA_SAMPLE_INTERVAL_MS) return;
      const crop = await captureFace();
      if (!crop) return;
      lastSampleAtRef.current = Date.now();
      const result = await enrollFace(crop, uid);
      if (result) {
        samplesRef.current = result.samples;
        console.info(`[visitor] ${uid} now has ${result.samples} reference photo(s)`);
      }
    }, EXTRA_SAMPLE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [status, record?.enrolled, captureFace]);

  /**
   * The uid to send as the workflow's sessionId, namespaced.
   *
   * The prefix keeps a face-bound thread from ever colliding with a local
   * session id in n8n's memory table, and makes it obvious in the execution
   * log which turns belong to a recognised person.
   */
  const sessionKey = useCallback(
    () => (uidRef.current ? `face:${uidRef.current}` : null),
    [],
  );

  /**
   * Wait for binding, up to `timeoutMs`. Resolves with the uid, or null if the
   * camera has not made up its mind in time.
   *
   * Used once per conversation, before the opening greeting: a greeting sent
   * before binding lands in the wrong memory thread and has to be re-homed.
   * The timeout matters more than the wait — a person standing at a kiosk
   * notices a second of silence, so this gives up rather than stalling.
   */
  const awaitBinding = useCallback(
    (timeoutMs: number): Promise<string | null> => {
      if (uidRef.current) return Promise.resolve(uidRef.current);
      if (!enabled || status === "anonymous") return Promise.resolve(null);
      return new Promise((resolve) => {
        let settled = false;
        const done = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        waitersRef.current.push(done);
        setTimeout(() => done(uidRef.current), timeoutMs);
      });
    },
    [enabled, status],
  );

  /** Persist the transcript. Debounced: a turn writes several times as it lands. */
  const saveMessages = useCallback((messages: ChatMessage[]) => {
    pendingMessagesRef.current = messages;
    if (!uidRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const uid = uidRef.current;
      const pending = pendingMessagesRef.current;
      if (!uid || !pending) return;
      const bumpVisit = !visitCountedRef.current;
      visitCountedRef.current = true;
      void saveVisitor(uid, { messages: pending, bumpVisit });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  /**
   * Merge facts the agent extracted from this turn into the visitor's profile.
   *
   * Written through immediately rather than debounced: a delta is small, it
   * arrives at most once per turn, and losing one to a walk-away means losing
   * the one thing the visitor actually told the kiosk about themselves.
   */
  const applyProfileDelta = useCallback(async (delta: ProfileDelta) => {
    const uid = uidRef.current;
    if (!uid || !delta) return;
    if (!delta.displayName && !delta.facts?.length) return;
    const ok = await saveVisitor(uid, { profile: delta });
    if (!ok) return;
    setRecord((prev) =>
      prev
        ? {
            ...prev,
            profile: {
              displayName: delta.displayName ?? prev.profile.displayName,
              // Optimistic local merge so the UI reflects the change at once.
              // The server has already applied the authoritative one.
              facts: [
                ...prev.profile.facts.filter(
                  (f) => !delta.facts?.some((d) => d.key.toLowerCase() === f.key),
                ),
                ...(delta.facts ?? []).map((f) => ({
                  ...f,
                  key: f.key.toLowerCase(),
                  updatedAt: Date.now(),
                })),
              ],
            },
          }
        : prev,
    );
  }, []);

  /**
   * Unbind. Called when the visitor walks away, and when someone presses
   * "Not you?" because the camera matched the wrong person.
   *
   * Flushes a pending transcript write first. Departure is exactly when an
   * unflushed debounce would be lost, and it is the last turn — the one the
   * person actually cared about — that would go.
   */
  const release = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const uid = uidRef.current;
    const pending = pendingMessagesRef.current;
    if (uid && pending) {
      const bumpVisit = !visitCountedRef.current;
      void saveVisitor(uid, { messages: pending, bumpVisit });
    }

    uidRef.current = null;
    bindingRef.current = false;
    samplesRef.current = 0;
    visitCountedRef.current = false;
    enrolledHereRef.current = false;
    pendingMessagesRef.current = null;
    setRecord(null);
    setStatus(enabled ? "resolving" : "idle");
    setUndoStatus("none");
    // Anyone still waiting gets null rather than hanging until their timeout.
    settleWaiters(null);
  }, [enabled, settleWaiters]);

  // `disown` is defined below `refuseRecognition`, which it delegates to.

  /**
   * "Don't recognise me" — the visitor declines being identified at all.
   *
   * Three things separate this from `disown()`, which answers a different
   * question ("you have the wrong person"):
   *
   * NOTHING IS WRITTEN. `release()` flushes the pending transcript on its way
   * out, which is right for a walk-away and exactly wrong here: the request is
   * to not be on file, so the debounced write is dropped rather than flushed.
   *
   * THE ENROLLMENT IS UNDONE. If this conversation is what put the face in the
   * gallery, that photo and record go. Otherwise the kiosk would keep a
   * reference photo of someone who just said no, and recognise them on sight
   * next week — the button would have meant nothing beyond this session.
   * A face this kiosk did NOT enroll is left alone; deleting a record with
   * history behind it stays a staff decision, which is what the notice says.
   *
   * IT STAYS OFF. Like `disown`, `anonymous` holds for the rest of the
   * conversation; the camera still sees the same face and would re-bind within
   * a second of being let go.
   */
  const refuseRecognition = useCallback(() => {
    const uid = uidRef.current;
    const undoable = enrolledHereRef.current && isGeneratedUid(uid);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingMessagesRef.current = null;

    uidRef.current = null;
    samplesRef.current = 0;
    visitCountedRef.current = false;
    enrolledHereRef.current = false;
    setRecord(null);
    // Set before the await, and `bindingRef` with it: the binder effect runs on
    // the very next confirmed frame, and a request not to be recognised that
    // takes a network round-trip to take effect is not one.
    bindingRef.current = true;
    setStatus("anonymous");
    settleWaiters(null);

    if (undoable && uid) {
      setUndoStatus("pending");
      void undoEnrollment(uid).then((ok) => {
        setUndoStatus(ok ? "removed" : "failed");
        console.info(
          ok
            ? `[visitor] ${uid} declined recognition; enrollment removed`
            : `[visitor] ${uid} declined recognition, but the enrollment could not be removed`,
        );
      });
    } else {
      // Bound to a face this kiosk did not enroll just now — a returning
      // visitor, or one a member of staff added. Recognition stops, but their
      // stored record is not this button's to delete.
      setUndoStatus(uid ? "kept" : "none");
      console.info("[visitor] recognition declined; running anonymously");
    }
  }, [settleWaiters]);

  /**
   * "Not you?" — the visitor says the kiosk has matched the wrong person.
   *
   * A different question from `refuseRecognition` ("do not recognise me at
   * all") with identical mechanics, so it delegates rather than keeping a
   * second copy. Two implementations of this would drift, and both of them
   * handle the case where the kiosk being wrong is a privacy event — the same
   * argument that collapsed the cache key's two authors into one.
   *
   * What must NOT happen is the flush `release()` performs on its way out.
   * That is correct for a walk-away and exactly backwards here: the transcript
   * on screen is the misidentified person's stored history PLUS this visitor's
   * turns, so writing it back files a stranger's conversation under someone
   * else's face and bumps their visit count. The only people who ever press
   * this button are the ones that would happen to.
   *
   * Delegating also covers the case this used to miss. A face the kiosk
   * enrolled during THIS conversation is one it created unasked, so "not me"
   * has to remove it; leaving it behind means the person is silently on file
   * and recognised on sight next week, having explicitly said no. A face the
   * kiosk did not enroll is left alone — deleting a returning visitor's record
   * is a staff decision, not this button's.
   */
  const disown = useCallback(() => {
    refuseRecognition();
    console.info("[visitor] identity disowned by the visitor; running anonymously");
  }, [refuseRecognition]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const profile = record?.profile ?? null;

  return {
    status,
    undoStatus,
    uid: uidRef.current,
    record,
    profile,
    /** What the visitor is called, when they have told the kiosk. */
    displayName: profile?.displayName ?? null,
    /** Stored transcript to fold into the conversation, once bound. */
    history: record?.messages ?? null,
    /** Visits BEFORE this one. */
    previousVisits: record?.visits ?? 0,
    sessionKey,
    awaitBinding,
    saveMessages,
    applyProfileDelta,
    release,
    disown,
    refuseRecognition,
  };
}
