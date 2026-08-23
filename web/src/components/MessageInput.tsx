import { Mic, MicOff, Send, Volume2, VolumeX, Square, ShieldAlert, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MicPermission, StopResult } from "../hooks/useSTT";
import { useTenant } from "../lib/branding/context";

interface Props {
  onSendText: (text: string) => void;
  onSendAudio: (blob: Blob) => void;
  /** Optional callback so the parent can show recording-failure toasts. */
  onAudioNotice?: (msg: string) => void;
  /** True while a chat request is in flight. */
  pending: boolean;
  ttsEnabled: boolean;
  onToggleTTS: () => void;
  sttStatus: "idle" | "permission" | "recording";
  sttPermission: MicPermission;
  sttLevel: number;
  onRequestMic: () => Promise<boolean>;
  onStartRecord: () => Promise<void>;
  onStopRecord: () => Promise<StopResult>;
  onCancelRecord: () => void;
  isAssistantSpeaking: boolean;
  onStopSpeaking: () => void;
}

export default function MessageInput({
  onSendText,
  onSendAudio,
  onAudioNotice,
  pending,
  ttsEnabled,
  onToggleTTS,
  sttStatus,
  sttPermission,
  sttLevel,
  onRequestMic,
  onStartRecord,
  onStopRecord,
  onCancelRecord,
  isAssistantSpeaking,
  onStopSpeaking,
}: Props) {
  // Voice controls (mic, TTS toggle, stop-speaking) are hidden wholesale for
  // tenants without the voice feature; the composer degrades to text-only.
  const { content, features } = useTenant();
  const voice = features.voice;

  const [text, setText] = useState("");
  const [recordSeconds, setRecordSeconds] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text]);

  // Recording timer
  useEffect(() => {
    if (sttStatus !== "recording") {
      setRecordSeconds(0);
      return;
    }
    setRecordSeconds(0);
    const id = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [sttStatus]);

  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    if (pending) {
      onAudioNotice?.("A request is already in flight — please wait.");
      return;
    }
    onSendText(t);
    setText("");
  };

  const onMicClick = async () => {
    if (sttPermission === "unsupported") {
      onAudioNotice?.("This browser does not support microphone input.");
      return;
    }
    if (sttStatus === "permission") return;
    if (sttStatus === "recording") {
      const result = await onStopRecord();
      if (result.blob) {
        onSendAudio(result.blob);
      } else if (result.reason) {
        onAudioNotice?.(result.reason);
      }
      return;
    }
    if (pending) {
      onAudioNotice?.("Please wait for the current reply before recording.");
      return;
    }
    if (sttPermission !== "granted") {
      const ok = await onRequestMic();
      if (!ok) return;
    }
    await onStartRecord();
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const recording = sttStatus === "recording";

  return (
    <div className="border-t border-bg-border bg-bg-panel/85 backdrop-blur-xl px-4 py-3">
      <div className="flex items-end gap-2 max-w-4xl mx-auto">
        {/* TTS toggle */}
        {voice && (
        <button
          onClick={onToggleTTS}
          className="btn-icon"
          title={ttsEnabled ? "Mute voice replies" : "Enable voice replies"}
          type="button"
        >
          {ttsEnabled ? (
            <Volume2 className="w-5 h-5 text-accent" />
          ) : (
            <VolumeX className="w-5 h-5" />
          )}
        </button>
        )}

        {voice && isAssistantSpeaking && (
          <button
            onClick={onStopSpeaking}
            className="btn-icon text-accent-pink"
            title="Stop voice"
            type="button"
          >
            <Square className="w-4 h-4 fill-current" />
          </button>
        )}

        {/* Mic */}
        {voice && (
        <button
          onClick={onMicClick}
          className={`btn-icon relative ${
            recording
              ? "bg-red-500/15 text-red-300 ring-2 ring-red-400/50"
              : sttPermission === "denied"
                ? "text-amber-400"
                : ""
          }`}
          title={
            sttPermission === "unsupported"
              ? "Microphone not supported"
              : sttPermission === "denied"
                ? "Permission denied — click to retry"
                : recording
                  ? "Stop & send"
                  : sttPermission === "granted"
                    ? "Tap to record — tap again to send"
                    : "Click to allow microphone"
          }
          type="button"
        >
          {sttPermission === "denied" ? (
            <ShieldAlert className="w-5 h-5" />
          ) : sttStatus === "permission" ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : recording ? (
            <MicOff className="w-5 h-5" />
          ) : (
            <Mic className="w-5 h-5" />
          )}
          {recording && (
            <span
              className="absolute inset-0 rounded-md border border-red-400/40 pointer-events-none"
              style={{
                transform: `scale(${1 + sttLevel * 0.35})`,
                transition: "transform 80ms linear",
              }}
            />
          )}
        </button>
        )}

        {/* Center: recording panel OR textarea */}
        {voice && recording ? (
          <div className="flex-1 flex items-center gap-3 h-11 px-4 rounded-md border border-red-500/30 bg-red-500/5">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse-soft" />
            <span className="text-sm font-medium text-red-200">
              Recording · {fmtTime(recordSeconds)}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-accent to-accent-pink"
                style={{ width: `${Math.min(100, sttLevel * 100)}%` }}
              />
            </div>
            <button
              onClick={onCancelRecord}
              className="text-xs text-ink-500 hover:text-ink-100"
              type="button"
            >
              cancel
            </button>
          </div>
        ) : (
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
            placeholder={
              pending
                ? "Waiting for reply…"
                : voice && sttPermission === "denied"
                  ? "Mic blocked — type instead, or unblock the mic in your browser"
                  : content.inputPlaceholder
            }
            className="input resize-none flex-1 max-h-[180px]"
          />
        )}

        {/* Send */}
        <button
          onClick={submitText}
          disabled={!text.trim() || recording || pending}
          className="btn-primary h-11 px-4"
          title="Send (Enter)"
          type="button"
        >
          {pending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
      <div className="text-[10px] text-ink-500 text-center mt-2 tracking-wide">
        <kbd className="px-1 py-0.5 bg-white/5 rounded border border-bg-border">
          Enter
        </kbd>{" "}
        send ·{" "}
        <kbd className="px-1 py-0.5 bg-white/5 rounded border border-bg-border">
          Shift+Enter
        </kbd>{" "}
        newline{voice && " · voice is transcribed directly by the UI"}
      </div>
    </div>
  );
}
