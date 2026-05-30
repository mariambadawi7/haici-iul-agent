import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ChatMessage } from "../types";
import Message from "./Message";

interface Props {
  messages: ChatMessage[];
  retriable?: Set<string>;
  onRetry?: (messageId: string) => void;
  onSuggestion?: (prompt: string) => void;
}

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
  retriable,
  onRetry,
  onSuggestion,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-6 bg-white">
      <div className="max-w-3xl mx-auto space-y-4 pt-6">
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
  );
}

function EmptyState({
  onSuggestion,
}: {
  onSuggestion?: (prompt: string) => void;
}) {
  return (
    <div className="text-center py-10">
      <h2 className="font-serif text-2xl text-slate-800">
        How may I help you today?
      </h2>
      <p className="font-serif italic text-slate-500 mt-2 text-sm">
        Ask a question by voice or text — or tap one of the prompts below.
      </p>
      <div className="mt-8 flex flex-wrap gap-2 justify-center max-w-2xl mx-auto">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion?.(s)}
            className="chip group inline-flex items-center gap-1.5"
          >
            <Sparkles className="w-3 h-3 opacity-50 group-hover:opacity-100 group-hover:text-teal-600 transition" />
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}