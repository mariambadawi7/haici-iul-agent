import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ChatMessage, FaceState } from "../types";
import AnimatedFace from "./AnimatedFace";
import Message from "./Message";

interface Props {
  messages: ChatMessage[];
  faceState: FaceState;
  amplitude: number;
  retriable?: Set<string>;
  onRetry?: (messageId: string) => void;
  onSuggestion?: (prompt: string) => void;
}

const STATE_LABEL: Record<FaceState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Reflecting",
  speaking: "Responding",
};

const SUGGESTIONS = [
  "Tell me about the faculties of IUL",
  "Where are IUL's campuses located?",
  "What is IUL's history and founding vision?",
  "Which accreditations does IUL hold?",
  "What languages are programs taught in?",
  "How do I apply to IUL?",
];

export default function ChatPanel({
  messages,
  faceState,
  amplitude,
  retriable,
  onRetry,
  onSuggestion,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="relative shrink-0 flex flex-col items-center justify-center py-6 border-b border-bg-border bg-bg-panel/40">
        <AnimatedFace state={faceState} amplitude={amplitude} />
        <div className="mt-3 flex items-center gap-3 text-ink-500">
          <span className="badge-serif">{STATE_LABEL[faceState]}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <div className="max-w-3xl mx-auto space-y-4 pt-4">
          {messages.length === 0 ? (
            <EmptyState onSuggestion={onSuggestion} />
          ) : (
            messages.map((m) => (
              <Message
                key={m.id}
                message={m}
                canRetry={!!retriable?.has(m.id)}
                onRetry={onRetry}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  onSuggestion,
}: {
  onSuggestion?: (prompt: string) => void;
}) {
  return (
    <div className="text-center py-10">
      <h2 className="font-serif text-2xl text-ink-100">
        How may I help you today?
      </h2>
      <p className="font-serif italic text-ink-500 mt-2 text-sm">
        Ask a question by voice or text — or tap one of the prompts below.
      </p>
      <div className="mt-6 flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion?.(s)}
            className="chip group inline-flex items-center gap-1.5"
          >
            <Sparkles className="w-3 h-3 opacity-50 group-hover:opacity-100 group-hover:text-accent transition" />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
