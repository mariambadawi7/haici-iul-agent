import { motion } from "framer-motion";
import { AlertCircle, RotateCw, User } from "lucide-react";
import type { ChatMessage } from "../types";

interface Props {
  message: ChatMessage;
  canRetry?: boolean;
  onRetry?: (messageId: string) => void;
}

export default function Message({ message, canRetry, onRetry }: Props) {
  const isUser = message.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}
    >
      <div
        className={`shrink-0 w-9 h-9 rounded-sm grid place-items-center border ${
          isUser
            ? "bg-white/5 border-bg-border text-ink-300"
            : "bg-gradient-to-br from-accent/30 to-accent-deep/40 border-accent/40 text-accent-glow"
        }`}
      >
        {isUser ? (
          <User className="w-4 h-4" />
        ) : (
          <span className="font-serif italic text-sm">A</span>
        )}
      </div>
      <div
        className={`max-w-[78%] flex flex-col ${
          isUser ? "items-end" : "items-start"
        }`}
      >
        <div
          className={`px-4 py-2.5 rounded-md text-[15px] leading-relaxed whitespace-pre-wrap ${
            message.failed
              ? "bg-red-500/10 border border-red-500/30 text-ink-100"
              : isUser
                ? "bg-accent/10 border border-accent/25 text-ink-100"
                : "bg-bg-elevated/85 border border-bg-border text-ink-100"
          }`}
        >
          {message.content}
        </div>
        {message.failed && (
          <div className="mt-1.5 flex items-start gap-2 text-xs text-red-300 max-w-full">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="leading-snug flex-1">
              {message.errorMessage ?? "Failed to send"}
              {!canRetry && onRetry && (
                <span className="block text-ink-500 italic mt-0.5">
                  This message can't be retried after a reload — please send it
                  again.
                </span>
              )}
            </span>
            {canRetry && onRetry && (
              <button
                onClick={() => onRetry(message.id)}
                className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-400/40 text-red-200 hover:bg-red-500/15 transition shrink-0"
              >
                <RotateCw className="w-3 h-3" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
