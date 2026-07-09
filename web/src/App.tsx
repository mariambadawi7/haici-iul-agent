import { useCallback, useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import MessageInput from "./components/MessageInput";
import LandingPage from "./components/LandingPage";
import HealthBanner from "./components/HealthBanner";
import Avatar3D from "./components/Avatar3D";
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

  const faceState: FaceState = useMemo(() => {
    if (tts.speaking) return "speaking";
    if (chat.pending) return "thinking";
    if (stt.status === "recording") return "listening";
    return "idle";
  }, [tts.speaking, chat.pending, stt.status]);

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
          <div className="relative shrink-0 lg:w-80 flex flex-col items-center justify-center bg-slate-50/50 border-b lg:border-b-0 lg:border-l border-slate-200/80 p-6 transition-all">
             
             {/* The Robot - Large on desktop, short on mobile */}
             <div className="h-40 lg:h-64 w-full flex items-center justify-center">
                <Avatar3D state={faceState} amplitude={tts.amplitude} />
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