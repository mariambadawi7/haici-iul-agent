export type Role = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** Set when a send failed and the user can retry. */
  failed?: boolean;
  /** Friendly error to display under the bubble. */
  errorMessage?: string;
  /** Cached original text — lets text retries survive a page reload. */
  originalText?: string;
  /** Hint that the audio for this message is in IndexedDB under the same id. */
  hasAudioBlob?: boolean;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type FaceState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Sentiment inferred from the assistant's latest answer. Drives the avatar's
 * expression, whichever avatar the tenant is running.
 */
export type Emotion = "neutral" | "happy" | "sad" | "surprised";
