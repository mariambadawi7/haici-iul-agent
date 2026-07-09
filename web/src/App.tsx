import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import MessageInput from "./components/MessageInput";
import LandingPage from "./components/LandingPage";
import HealthBanner from "./components/HealthBanner";
import Avatar3D, { type Emotion } from "./components/Avatar3D";
import { useChat } from "./hooks/useChat";
import { useHardware } from "./hooks/useHardware";
import { useSTT } from "./hooks/useSTT";
import { useTTS } from "./hooks/useTTS";
import { checkHealth, type HealthState } from "./lib/health";
import { config, twoStage } from "./lib/api";
import type { FaceState } from "./types";

const STATE_LABEL: Record<FaceState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Reflecting",
  speaking: "Responding",
};

export default function App() {
  const tts = useTTS();
  const stt = useSTT();
  const chat = useChat({
    wantsAudio: tts.enabled,
    onAudio: (blob) => {
      tts.playBlob(blob).catch((e) =>
        console.error("[app] TTS playback failed", e),
      );
    },
  });

  const [view, setView] = useState<"landing" | "chat">("landing");
  const [health, setHealth] = useState<HealthState>({ status: "checking" });

  useEffect(() => {
    console.info("[app] booted", {
      chatUrl: config.chatUrl,
      ttsUrl: config.ttsUrl || "(single-stage)",
      twoStage,
      title: config.title,
    });
  }, []);

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
  const emotion: Emotion = useMemo(() => {
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

  useHardware({
    faceState,
    onNewSession: () => {
      chat.createSession();
      setView("chat");
      setTimeout(() => chat.sendText("Hello!"), 120);
    },
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

  const beginConversation = useCallback(() => {
    chat.createSession();
    setView("chat");
    setTimeout(() => {
      chat.sendText("Hello!");
    }, 120);
  }, [chat]);

  if (view === "landing") {
    return <LandingPage onBegin={beginConversation} />;
  }

  return (
    <div className="app-shell h-screen w-screen flex flex-col overflow-hidden bg-slate-50">
      
      {/* Top Header */}
      <section className="brand-strip panel-elevated border-b border-bg-border z-10 shrink-0">
        <div className="brand-row">
          <div className="brand-icon-wrap">
            <img src="/iul_logo.png" alt="IUL Logo" className="brand-icon" />
          </div>
          <div className="brand-copy">
            <div className="brand-label">IUL • HAICI</div>
            <h2 className="brand-heading">IUL Agent</h2>
            <p className="brand-subtitle">
              Premium robot assistant design for intelligent campus guidance.
            </p>
          </div>
          <div className="brand-right-actions flex items-center gap-3 md:gap-5">
            <div className="brand-icon-wrap hidden sm:block">
              <img src="/haici_logo.png" alt="HAICI Logo" className="brand-icon" />
            </div>
            <button 
              onClick={() => setView("landing")} 
              className="btn-icon bg-white shadow-sm hover:shadow-md hover:-translate-y-0.5 border-slate-200/80 text-slate-600 hover:text-teal-600"
              title="Return Home"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
            </button>
          </div>
        </div>
      </section>

      <HealthBanner health={health} onRecheck={runHealthCheck} />

      {/* Main App Layout */}
      <div className="flex-1 flex min-h-0 dashboard-grid p-4 md:p-6 gap-6">
        
        {/* LEFT: Sidebar History */}
        <Sidebar
          sessions={chat.sessions}
          activeId={chat.activeId}
          onSelect={chat.setActiveId}
          onCreate={() => chat.createSession()}
          onDelete={chat.deleteSession}
        />

        {/* MIDDLE & RIGHT: The new Split layout */}
        <main className="flex-1 flex flex-col lg:flex-row-reverse min-w-0 main-panel overflow-hidden border border-slate-200 shadow-sm rounded-2xl bg-white">
          
          {/* RIGHT: Robot Command Center */}
          <div className="relative shrink-0 lg:w-[22rem] flex flex-col items-center justify-center bg-slate-50/50 border-b lg:border-b-0 lg:border-l border-slate-200/80 p-6 transition-all">
             
             {/* The Robot - Large on desktop, short on mobile */}
             <div className="h-52 lg:h-80 w-full flex items-center justify-center">
                <Avatar3D state={faceState} amplitude={effectiveAmplitude} emotion={emotion} />
             </div>
             
             {/* Beautiful Status Card */}
             <div className="mt-4 lg:mt-8 bg-white border border-slate-200 shadow-sm rounded-2xl p-4 w-full text-center hidden lg:block">
               <h3 className="font-serif font-semibold text-slate-800 text-lg">IUL Agent</h3>
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
             <div className="mt-2 bg-white border border-slate-200 shadow-sm rounded-full px-4 py-1.5 flex items-center justify-center gap-2 lg:hidden">
               <span className={`relative inline-flex rounded-full h-2 w-2 ${faceState === 'idle' ? 'bg-slate-300' : 'bg-teal-500'}`}></span>
               <span className="badge-serif tracking-widest text-[10px] text-slate-500">
                 {STATE_LABEL[faceState]}
               </span>
             </div>
          </div>

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
    </div>
  );
}