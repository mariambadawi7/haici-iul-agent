import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, UserX } from "lucide-react";
import ChatPanel from "./components/ChatPanel";
import MessageInput from "./components/MessageInput";
import LandingPage from "./components/LandingPage";
import BrandStrip, { BrandFooter } from "./components/BrandStrip";
import HealthBanner from "./components/HealthBanner";
import Avatar3D from "./components/Avatar3D";
import Mascot2D from "./components/Mascot2D";
import { useChat } from "./hooks/useChat";
import { useHardware } from "./hooks/useHardware";
import { usePresence } from "./hooks/usePresence";
import { useVision } from "./hooks/useVision";
import { useVisitor } from "./hooks/useVisitor";
import { useSTT } from "./hooks/useSTT";
import { useTTS } from "./hooks/useTTS";
import { checkHealth, type HealthState } from "./lib/health";
import { config, twoStage, type Visitor } from "./lib/api";
import { isGeneratedUid } from "./lib/visitorApi";
import { useTenant } from "./lib/branding/context";
import type { Emotion, FaceState } from "./types";

const STATE_LABEL: Record<FaceState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Reflecting",
  speaking: "Responding",
};

export default function App() {
  const tenant = useTenant();
  const { features, identity, avatar } = tenant;

  const tts = useTTS();
  const stt = useSTT();

  // Camera vision. Off unless the tenant enables it, and silently inert if the
  // vision backend is unreachable — the kiosk must not depend on it.
  //
  // Declared BEFORE useChat, unlike everything else here, because the chat
  // layer now depends on it: which conversation is on screen, and which memory
  // thread the workflow answers into, are both decided by who the camera says
  // is standing here.
  const vision = useVision({ enabled: features.camera });

  const visitor = useVisitor({
    enabled: features.camera,
    identity: vision.identity,
    captureFace: vision.captureFace,
  });

  // Written just below, once `vision` has a reading; read only when a turn is
  // sent, by which point it holds whatever the camera currently believes.
  const visitorRef = useRef<Visitor | null>(null);

  const chat = useChat({
    wantsAudio: features.voice && tts.enabled,
    getVisitor: () => visitorRef.current,
    // Face-keyed memory. n8n's Window Buffer Memory is keyed on the sessionId
    // the workflow receives, so this is the single line that makes the AGENT
    // remember a returning visitor rather than only the interface replaying
    // the transcript at it.
    getSessionKey: visitor.sessionKey,
    onMessagesChanged: visitor.saveMessages,
    onProfileDelta: visitor.applyProfileDelta,
    onAudio: (blob) => {
      tts.playBlob(blob).catch((e) =>
        console.error("[app] TTS playback failed", e),
      );
    },
  });

  // Fold the recognised visitor's stored transcript in above whatever the
  // conversation has already accumulated. This lands a beat after the wake —
  // identity takes a few frames to confirm, and enrolling a stranger takes
  // longer still — so the greeting is usually already on screen and their
  // history slots in above it, in the order it happened.
  const hydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    const history = visitor.history;
    const sessionId = chat.activeId;
    if (!visitor.uid || !history?.length || !sessionId) return;
    // Once per binding: prependMessages is id-deduplicated, but re-running it
    // on every render would still churn the whole message array.
    const token = `${visitor.uid}:${sessionId}`;
    if (hydratedForRef.current === token) return;
    hydratedForRef.current = token;
    chat.prependMessages(sessionId, history);
  }, [visitor.uid, visitor.history, chat]);

  const [view, setView] = useState<"landing" | "chat">("landing");
  const [health, setHealth] = useState<HealthState>({ status: "checking" });
  // Set when the tenant's GLB fails to load. `glb` is the one avatar kind
  // that depends on a fetched asset, so it is the one that can leave the
  // panel empty on a typo'd URL or an upload that never landed. Falling
  // back to the mascot keeps a face on screen; it ships in the repo and
  // needs nothing fetched (S-04 in docs/CODE-REVIEW-FINDINGS.md).
  const [glbFailed, setGlbFailed] = useState(false);

  useEffect(() => {
    console.info("[app] booted", {
      chatUrl: config.chatUrl,
      ttsUrl: config.ttsUrl || "(single-stage)",
      twoStage,
      tenant: tenant.id,
      title: identity.name,
    });
  }, [tenant.id, identity.name]);

  const runHealthCheck = useCallback(() => {
    setHealth({ status: "checking" });
    checkHealth().then(setHealth);
  }, []);
  
  useEffect(() => {
    runHealthCheck();
  }, [runHealthCheck]);

  // --- Text-based mouth animation (when TTS is off) ---
  const [textSpeaking, setTextSpeaking] = useState(false);
  const [synthAmplitude, setSynthAmplitude] = useState(0);
  const animFrameRef = useRef<number>(0);
  const prevPendingRef = useRef(false);
  const prevMsgCountRef = useRef(0);

  useEffect(() => {
    const wasPending = prevPendingRef.current;
    prevPendingRef.current = chat.pending;

    const msgs = chat.active?.messages ?? [];
    const msgCount = msgs.length;
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = msgCount;

    // Detect: pending just ended OR a new assistant message appeared
    const newMsg = msgCount > prevCount && msgs[msgs.length - 1]?.role === "assistant";
    const responseArrived = (wasPending && !chat.pending) || newMsg;

    if (!responseArrived) return;
    // Skip if TTS audio is already handling the mouth
    if (tts.speaking) return;

    const lastMsg = [...msgs].reverse().find(m => m.role === "assistant" && m.content);
    if (!lastMsg) return;

    // Duration scales with text length: ~35ms per character, clamped 1.5–10s
    const duration = Math.min(Math.max(lastMsg.content.length * 35, 1500), 10000);
    const startTime = performance.now();

    setTextSpeaking(true);

    const animate = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= duration) {
        setTextSpeaking(false);
        setSynthAmplitude(0);
        return;
      }

      // Fade envelope: ramp up quickly, sustain, then fade out
      const progress = elapsed / duration;
      const envelope = progress < 0.08
        ? progress / 0.08                          // quick ramp-up
        : progress > 0.85
          ? (1 - progress) / 0.15                   // fade-out
          : 1;                                      // sustain

      // Natural speech: overlapping sines at different frequencies + randomness
      const t = elapsed / 1000;
      const raw =
        0.30 +
        0.22 * Math.sin(t * 9.1) +
        0.18 * Math.sin(t * 14.7) +
        0.10 * Math.sin(t * 6.3) +
        0.08 * Math.sin(t * 21.0) +   // high-freq flicker
        0.12 * Math.random();           // organic jitter

      setSynthAmplitude(Math.max(0, Math.min(1, raw * envelope)));
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [chat.pending, chat.active?.messages, tts.speaking]);

  // Stop text-speaking if real TTS audio starts
  useEffect(() => {
    if (tts.speaking && textSpeaking) {
      setTextSpeaking(false);
      setSynthAmplitude(0);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    }
  }, [tts.speaking, textSpeaking]);

  const faceState: FaceState = useMemo(() => {
    if (tts.speaking) return "speaking";
    if (textSpeaking) return "speaking";
    if (chat.pending) return "thinking";
    if (stt.status === "recording") return "listening";
    return "idle";
  }, [tts.speaking, textSpeaking, chat.pending, stt.status]);

  // Effective amplitude: real TTS audio wins over synthetic
  const effectiveAmplitude = tts.speaking ? tts.amplitude : synthAmplitude;

  // Lightweight sentiment of the latest answer → drives the avatar's expression.
  const replyEmotion: Emotion = useMemo(() => {
    const msgs = chat.active?.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === "assistant" && m.content);
    const t = (last?.content ?? "").toLowerCase();
    if (!t) return "neutral";
    if (/(sorry|unfortunately|can(?:no|')t|could ?n[o']t|couldn't|not find|no information|unable|apolog|regret|عذر|آسف|لا يمكن|لم أجد)/.test(t))
      return "sad";
    if (/(welcome|glad|happy|great|congrat|wonderful|excellent|delighted|pleasure|thank|أهلا|مرحبا|سعيد|رائع|شكرا)/.test(t))
      return "happy";
    if (/(wow|amazing|incredible|fascinating)/.test(t)) return "surprised";
    return "neutral";
  }, [chat.active?.messages]);

  // A new model URL deserves a fresh attempt: an operator who fixes the URL
  // in #/admin should see the 3D head come back without reloading the kiosk.
  useEffect(() => {
    setGlbFailed(false);
  }, [avatar.glbUrl]);

  // The kind actually rendered, which is not always the kind configured.
  const avatarKind = avatar.kind === "glb" && glbFailed ? "mascot" : avatar.kind;

  // The mascot is the agent's own face, so what it should express depends on
  // whose turn it is. While the agent is thinking or speaking it wears the
  // sentiment of its own answer. While it is idle or listening it has nothing
  // of its own to express, so it mirrors the visitor — which is what makes a
  // receptionist look like it is paying attention rather than staring.
  //
  // vision.emotion is already smoothed over a 2 s window (see useVision); the
  // raw per-frame label would make this twitch several times a second.
  const attending = faceState === "idle" || faceState === "listening";
  const emotion: Emotion =
    attending && vision.emotion ? vision.emotion : replyEmotion;

  // Every turn carries who the camera thinks it is talking to. Null fields are
  // dropped in sendChat, so "no visitor key" means the kiosk cannot see anyone.
  // Sent whenever the camera can see someone OR the conversation is bound to
  // a person. The second half matters: the binding is locked for the whole
  // conversation, so a visitor who leans out of frame — or a camera that drops
  // a couple of seconds of inference — must not silently stop being
  // themselves halfway through, which would move the rest of their turns into
  // a different memory thread and a different cache namespace.
  visitorRef.current =
    vision.signal.live || visitor.uid
    ? {
        // The name is for the agent to SAY. Prefer what the person told the
        // kiosk they are called over the gallery label, and never fall back to
        // an auto-enrolled uid — "hello v7f3a9c1b2d" is worse than "hello".
        name:
          visitor.displayName ??
          (isGeneratedUid(vision.signal.identity) ? null : vision.signal.identity),
        emotion: vision.emotion,
        // The uid is for the workflow to KEY on. Separate field, separate job.
        uid: visitor.uid,
        profile: visitor.profile
          ? {
              displayName: visitor.profile.displayName,
              // Timestamps are bookkeeping for the store, not context for the
              // agent, and they would only dilute the prompt.
              facts: visitor.profile.facts.map((f) => ({ key: f.key, value: f.value })),
            }
          : null,
      }
    : null;

  /**
   * How long the opening greeting waits for the camera to say who this is.
   *
   * The greeting is the first turn, so it is the turn that decides which
   * memory thread the whole conversation lands in — sending it unbound means
   * the agent starts a thread under the local session id and the rest of the
   * visit continues somewhere else. Waiting is worth it.
   *
   * Sized for the slow path, not the fast one: a known face confirms in about
   * five frames (a quarter of a second), while a stranger needs the
   * confirmation window plus a crop and an upload. Past this the kiosk greets
   * anyway — a person standing in front of a silent screen has no idea it is
   * being careful, and only reads it as broken.
   */
  const BIND_GRACE_MS = 2_000;

  const startConversation = useCallback(
    async (name: string | null) => {
      // createSession returns the session it just made. The `chat` object
      // captured below is from the PREVIOUS render, so its ensureActive()
      // would resolve to the old session id — the greeting has to be
      // addressed to this id explicitly (F-05 in
      // docs/CODE-REVIEW-FINDINGS.md).
      const session = chat.createSession();
      setView("chat");

      const uid = await visitor.awaitBinding(BIND_GRACE_MS);
      // Prefer what the visitor actually told us they are called. A gallery
      // label is a usable name only when a person chose it -- an auto-enrolled
      // uid like `v7f3a9c1b2d` is not one, and greeting someone with it is far
      // worse than not greeting them by name at all.
      const known =
        visitor.displayName ?? (uid && !isGeneratedUid(uid) ? uid : null) ?? name;

      // The name comes from a face match, which can be wrong. It is phrased as
      // the visitor introducing themselves rather than as an assertion the
      // kiosk makes about them, so a mismatch reads as a misunderstanding the
      // person can correct, not as the machine insisting who they are.
      const greeting = known ? `Hello! I'm ${known}.` : "Hello!";
      chat.sendText(greeting, session.id);
    },
    [chat, visitor],
  );

  const presence = usePresence({
    vision: vision.signal,
    onWake: ({ name }) => void startConversation(name),
    onDepart: () => {
      // The visitor walked away. Flush their transcript to their own record,
      // unbind, clear the screen so the next person does not arrive at a
      // stranger's conversation, and stop any reply mid-speech.
      tts.stop();
      visitor.release();
      chat.createSession();
      if (features.landing) setView("landing");
    },
  });

  useHardware({
    faceState,
    // The button is an explicit request. Routed through the same wake so it
    // picks up a recognised name when the camera has been running long enough
    // to have one.
    onNewSession: () => presence.wake("button"),
    // The ultrasonic sensor is evidence, weighed against what the camera sees.
    onPresence: presence.pulse,
    onStartRecord: () => {
      if (stt.permission !== "granted") {
        stt.requestPermission();
      } else {
        stt.start();
      }
    },
    onStopRecord: async () => {
      const result = await stt.stop();
      if (result?.blob) {
        chat.sendAudio(result.blob);
      }
    },
    onStopSpeaking: () => {
      tts.stop();
    },
  });

  /**
   * The visitor says the kiosk has the wrong person.
   *
   * Everything on screen belongs to the identity being disowned, so it all
   * goes: the transcript is cleared and the conversation restarts unbound.
   * `disown` (rather than `release`) is what keeps it unbound — the camera can
   * still see the same face and would otherwise re-bind to it within a second.
   */
  const handleNotMe = useCallback(() => {
    tts.stop();
    chat.cancelInFlight();
    visitor.disown();
    hydratedForRef.current = null;
    chat.createSession();
  }, [chat, tts, visitor]);

  // The landing tap is also the gesture that lets the camera start, if the
  // tenant has vision on — getUserMedia refuses outside one. useVision picks
  // that up from the pointerdown itself, so nothing extra is needed here.
  const beginConversation = useCallback(() => {
    presence.wake("button");
  }, [presence]);

  // Tenants without the landing screen drop straight into the conversation;
  // `view` still exists so the home button can return there when they do.
  if (features.landing && view === "landing") {
    return <LandingPage onBegin={beginConversation} />;
  }

  return (
    <div className="app-shell h-screen w-screen flex flex-col overflow-hidden bg-slate-50">
      
      <BrandStrip
        className="z-10"
        actions={
          <>
            {/* The escape hatch for a wrong face match. With the conversation
                list gone this is the ONLY way a misrecognised visitor can get
                out of someone else's transcript, so it is on screen whenever
                the kiosk has bound to a person rather than tucked away in the
                admin console where the person standing here cannot reach it.
                Named, because "not you?" is meaningless unless it says who it
                thinks you are. */}
            {visitor.status === "bound" && (
              <button
                onClick={handleNotMe}
                className="flex items-center gap-2 px-3 h-10 rounded-full border border-slate-200/80 bg-surface shadow-sm text-xs text-slate-600 hover:text-warn-700 hover:border-warn-200 transition-colors"
                title="Start a fresh conversation that is not linked to this face"
              >
                <UserX className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">
                  Not {visitor.displayName ?? "you"}?
                </span>
              </button>
            )}
            {features.landing && (
              <button
                onClick={() => setView("landing")}
                className="btn-icon bg-surface shadow-sm hover:shadow-md hover:-translate-y-0.5 border-slate-200/80 text-slate-600 hover:text-teal-600"
                title="Return Home"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
              </button>
            )}
          </>
        }
      />

      <HealthBanner health={health} onRecheck={runHealthCheck} />

      {/* F-11: a camera that silently never starts is worse than one that
          visibly fails — nobody investigates a kiosk that looks fine. This is
          deliberately NOT folded into HealthBanner: that banner reports
          whether the n8n workflow is reachable, and a dead camera must not be
          able to claim the workflow is down, nor mask a real outage by
          occupying the same slot. Answering questions still works without a
          camera, so this informs rather than alarms. */}
      {features.camera && vision.error && (
        <div className="px-4 py-2 text-xs text-warn-700 bg-warn-50 border-b border-warn-200 flex items-center justify-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {/* Show the underlying reason, not just the symptom. The SDK
              distinguishes permission-denied, no-such-device and
              already-in-use, and "already in use by another application" is
              the difference between a five-second fix and an afternoon. */}
          <span className="leading-snug">
            The camera could not start, so the kiosk cannot recognise visitors.{" "}
            {vision.error.message} Tap anywhere to try again.
          </span>
        </div>
      )}

      {/* Main App Layout */}
      <div className="flex-1 flex min-h-0 p-4 md:p-6 gap-6">

        {/* The conversation list is gone. It was a list of everyone who had
            ever used this kiosk, readable by whoever was standing at it next;
            a transcript now belongs to the face it came from and is fetched
            when that face is recognised, not left on screen for the next
            person to scroll through. */}

        {/* MIDDLE & RIGHT: The new Split layout */}
        <main className="flex-1 flex flex-col lg:flex-row-reverse min-w-0 main-panel overflow-hidden border border-slate-200 shadow-sm rounded-2xl bg-surface">
          
          {/* RIGHT: Robot Command Center */}
          {features.avatar && avatarKind !== "none" && (
          <div className="relative shrink-0 lg:w-[22rem] flex flex-col items-center justify-center bg-slate-50/50 border-b lg:border-b-0 lg:border-l border-slate-200/80 p-6 transition-all">

             {/* The assistant — the rigged 2D mascot, an animated 3D head, or
                 a still image for tenants who supplied flat artwork. All three
                 read the same face state and speech amplitude. */}
             <div className="h-52 lg:h-80 w-full flex items-center justify-center">
                {avatarKind === "mascot" ? (
                  <Mascot2D
                    state={faceState}
                    amplitude={effectiveAmplitude}
                    emotion={emotion}
                    view={avatar.mascotView}
                    // The wide face crop is bounded by the column, the tall
                    // full-body crop by the panel's height.
                    className={`drop-shadow-xl ${
                      avatar.mascotView === "head" ? "w-full" : "h-full"
                    }`}
                  />
                ) : avatarKind === "glb" ? (
                  <Avatar3D
                    state={faceState}
                    amplitude={effectiveAmplitude}
                    emotion={emotion}
                    modelUrl={avatar.glbUrl}
                    onLoadError={() => setGlbFailed(true)}
                  />
                ) : (
                  avatar.imageUrl && (
                    <img
                      src={avatar.imageUrl}
                      alt={`${identity.name} avatar`}
                      className="max-h-full object-contain drop-shadow-xl"
                    />
                  )
                )}
             </div>
             
             {/* Beautiful Status Card */}
             <div className="mt-4 lg:mt-8 bg-surface border border-slate-200 shadow-sm rounded-2xl p-4 w-full text-center hidden lg:block">
               <h3 className="font-serif font-semibold text-slate-800 text-lg">{identity.name}</h3>
               <div className="mt-2 flex items-center justify-center gap-2">
                 <span className="relative flex h-2.5 w-2.5">
                   {faceState !== 'idle' && (
                     <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75"></span>
                   )}
                   <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${faceState === 'idle' ? 'bg-slate-300' : 'bg-teal-500'}`}></span>
                 </span>
                 <span className="badge-serif tracking-widest text-xs text-slate-500">
                   {STATE_LABEL[faceState]}
                 </span>
               </div>
             </div>
             
             {/* Tiny Mobile Status Pill */}
             <div className="mt-2 bg-surface border border-slate-200 shadow-sm rounded-full px-4 py-1.5 flex items-center justify-center gap-2 lg:hidden">
               <span className={`relative inline-flex rounded-full h-2 w-2 ${faceState === 'idle' ? 'bg-slate-300' : 'bg-teal-500'}`}></span>
               <span className="badge-serif tracking-widest text-[10px] text-slate-500">
                 {STATE_LABEL[faceState]}
               </span>
             </div>
          </div>
          )}

          {/* MIDDLE: Pure Chat and Input */}
          <div className="flex-1 flex flex-col min-w-0 relative">
            <ChatPanel
              messages={chat.active?.messages ?? []}
              retriable={chat.retriable}
              onRetry={chat.retry}
              onSuggestion={chat.sendText}
            />
            {chat.toast && (
              <div className="alert-bar alert-error">
                {chat.toast}
              </div>
            )}
            {stt.error && (
              <div className="alert-bar alert-warning">
                Microphone: {stt.error}
              </div>
            )}
            <MessageInput
              onSendText={chat.sendText}
              onSendAudio={chat.sendAudio}
              onAudioNotice={(msg) => chat.setToast(msg)}
              pending={chat.pending}
              ttsEnabled={tts.enabled}
              onToggleTTS={() => {
                if (tts.enabled) tts.stop();
                tts.setEnabled(!tts.enabled);
              }}
              sttStatus={stt.status}
              sttPermission={stt.permission}
              sttLevel={stt.level}
              onRequestMic={stt.requestPermission}
              onStartRecord={stt.start}
              onStopRecord={stt.stop}
              onCancelRecord={stt.cancel}
              isAssistantSpeaking={tts.speaking}
              onStopSpeaking={tts.stop}
            />
          </div>

        </main>
      </div>

      <BrandFooter />
    </div>
  );
}