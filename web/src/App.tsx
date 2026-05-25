import { useCallback, useEffect, useMemo, useState } from "react";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import ChatPanel from "./components/ChatPanel";
import MessageInput from "./components/MessageInput";
import LandingPage from "./components/LandingPage";
import HealthBanner from "./components/HealthBanner";
import { useChat } from "./hooks/useChat";
import { useSTT } from "./hooks/useSTT";
import { useTTS } from "./hooks/useTTS";
import { checkHealth, type HealthState } from "./lib/health";
import { config, twoStage } from "./lib/api";
import type { FaceState } from "./types";

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

  // Boot log once.
  useEffect(() => {
    console.info("[app] booted", {
      chatUrl: config.chatUrl,
      ttsUrl: config.ttsUrl || "(single-stage)",
      twoStage,
      title: config.title,
    });
  }, []);

  // Connectivity probe on mount and on demand.
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

  const beginConversation = useCallback(() => {
    chat.createSession();
    setView("chat");
    // Brief delay so the view-mount finishes before we dispatch.
    setTimeout(() => {
      // The agent's system prompt tells it to introduce itself on hello.
      chat.sendText("Hello!");
    }, 120);
  }, [chat]);

  if (view === "landing") {
    return <LandingPage onBegin={beginConversation} />;
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      <Header onHome={() => setView("landing")} health={health} />
      <HealthBanner health={health} onRecheck={runHealthCheck} />
      <div className="flex-1 flex min-h-0">
        <Sidebar
          sessions={chat.sessions}
          activeId={chat.activeId}
          onSelect={chat.setActiveId}
          onCreate={() => chat.createSession()}
          onDelete={chat.deleteSession}
        />
        <main className="flex-1 flex flex-col min-w-0">
          <ChatPanel
            messages={chat.active?.messages ?? []}
            faceState={faceState}
            amplitude={tts.amplitude}
            retriable={chat.retriable}
            onRetry={chat.retry}
            onSuggestion={chat.sendText}
          />
          {chat.toast && (
            <div className="px-4 py-2 text-xs text-red-300 bg-red-500/10 border-t border-red-500/20 text-center">
              {chat.toast}
            </div>
          )}
          {stt.error && (
            <div className="px-4 py-2 text-xs text-amber-300 bg-amber-500/10 border-t border-amber-500/20 text-center">
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
        </main>
      </div>
    </div>
  );
}
