import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sendChat,
  sendChatAudio,
  transcribeAudio,
  fetchAudio,
  twoStage,
  type ChatReply,
} from "../lib/api";
import {
  deleteAudio,
  listAudioKeys,
  loadAudio,
  storeAudio,
} from "../lib/audioStore";
import {
  loadActive,
  loadSessions,
  saveActive,
  saveSessions,
  uid,
} from "../lib/storage";
import type { ChatMessage, Session } from "../types";

type Payload =
  | { kind: "text"; text: string }
  | { kind: "audio"; blob: Blob };

interface UseChatOpts {
  /** Whether to ask the workflow for audio. */
  wantsAudio: boolean;
  /** Called with the audio blob from a successful reply (for playback). */
  onAudio?: (blob: Blob) => void;
}

/**
 * Single source of truth for chat state. Owns:
 *   - session list + active session (persisted to localStorage)
 *   - in-flight request lifecycle (one at a time, with abort)
 *   - retry cache: text is replayed from `message.originalText`,
 *     audio is replayed from IndexedDB → both survive a page reload
 *   - toast / error surface
 */
export function useChat({ wantsAudio, onAudio }: UseChatOpts) {
  const [sessions, setSessions] = useState<Session[]>(() => loadSessions());
  const [activeId, setActiveIdState] = useState<string | null>(() =>
    loadActive(),
  );
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retriable, setRetriable] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);
  // Latest opts captured for use inside dispatch closures.
  const optsRef = useRef({ wantsAudio, onAudio });
  optsRef.current = { wantsAudio, onAudio };

  // ---- Persistence ----
  useEffect(() => saveSessions(sessions), [sessions]);
  useEffect(() => saveActive(activeId), [activeId]);

  // ---- Auto-dismiss toast ----
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- On mount: hydrate retriable Set from IndexedDB + message metadata ----
  useEffect(() => {
    let cancelled = false;
    listAudioKeys().then((keys) => {
      if (cancelled) return;
      setRetriable((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        // Also: any failed text message with originalText is retriable
        for (const s of sessions) {
          for (const m of s.messages) {
            if (m.failed && m.originalText) next.add(m.id);
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // We only want this on mount; sessions in the closure are fine because
    // we're snapshotting current state to compute retriability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Session CRUD ----
  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
  }, []);

  const createSession = useCallback((title = "New chat"): Session => {
    const now = Date.now();
    const s: Session = {
      id: uid(),
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    setSessions((prev) => [s, ...prev]);
    setActiveIdState(s.id);
    return s;
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const target = prev.find((s) => s.id === id);
        if (target) {
          for (const m of target.messages) {
            if (m.role === "user") void deleteAudio(m.id);
          }
        }
        const next = prev.filter((s) => s.id !== id);
        if (activeId === id) setActiveIdState(next[0]?.id ?? null);
        return next;
      });
    },
    [activeId],
  );

  // Ensure at least one session always exists.
  useEffect(() => {
    if (sessions.length === 0) {
      createSession();
      return;
    }
    if (!activeId || !sessions.find((s) => s.id === activeId)) {
      setActiveIdState(sessions[0].id);
    }
  }, [sessions, activeId, createSession]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  // ---- Message mutators ----
  const appendMessage = useCallback(
    (sessionId: string, msg: ChatMessage) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const title =
            s.title === "New chat" && msg.role === "user"
              ? msg.content.replace(/^🎙️\s*/, "").slice(0, 40) || s.title
              : s.title;
          return {
            ...s,
            messages: [...s.messages, msg],
            title,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  const updateMessage = useCallback(
    (sessionId: string, messageId: string, patch: Partial<ChatMessage>) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id !== sessionId
            ? s
            : {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch } : m,
                ),
                updatedAt: Date.now(),
              },
        ),
      );
    },
    [],
  );

  // ---- Retriability tracking ----
  const markRetriable = useCallback((id: string) => {
    setRetriable((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unmarkRetriable = useCallback((id: string) => {
    setRetriable((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // ---- Core dispatch ----
  const dispatch = useCallback(
    async (sessionId: string, userMessageId: string, payload: Payload) => {
      // Cancel any in-flight request so we never have two pending at once.
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;

      setToast(null);
      setPending(true);
      console.info("[chat] dispatch", {
        sessionId,
        userMessageId,
        kind: payload.kind,
      });

      try {
        const { wantsAudio: wa, onAudio: oa } = optsRef.current;
        const askMainForAudio = wa && !twoStage;
        
        let reply: ChatReply;
        if (payload.kind === "text") {
          reply = await sendChat(sessionId, payload.text, askMainForAudio, ctl.signal);
        } else {
          updateMessage(sessionId, userMessageId, {
            content: "🎙️ (Transcribing...)",
          });
          
          const transcript = await transcribeAudio(payload.blob, ctl.signal);
          
          if (!transcript.trim()) {
            throw new Error("Could not transcribe the audio. Please speak more clearly or try again.");
          }
          
          updateMessage(sessionId, userMessageId, {
            content: transcript,
            originalText: transcript,
            failed: false,
            errorMessage: undefined,
          });
          
          reply = await sendChat(sessionId, transcript, askMainForAudio, ctl.signal);
          reply.question = transcript;
        }

        console.info("[chat] reply", {
          chars: reply.answer.length,
          hasAudio: !!reply.audio,
          transcript: !!reply.question,
          error: reply.error,
        });

        // Ensure failure state is cleared for the user message
        updateMessage(sessionId, userMessageId, {
          failed: false,
          errorMessage: undefined,
        });

        // Workflow error responder fired — show as a red assistant bubble.
        const assistantFailed = !!reply.error;
        appendMessage(sessionId, {
          id: uid(),
          role: "assistant",
          content: reply.answer || "(empty response)",
          createdAt: Date.now(),
          failed: assistantFailed,
          errorMessage: assistantFailed
            ? `Workflow stage: ${reply.stage ?? "unknown"}${reply.error ? ` — ${reply.error}` : ""}`
            : undefined,
        });

        // Clean up retriability + IndexedDB only on TRUE success.
        if (!assistantFailed) {
          unmarkRetriable(userMessageId);
          if (payload.kind === "audio") void deleteAudio(userMessageId);
        }

        if (wa && reply.audio && oa) {
          oa(reply.audio);
        } else if (wa && twoStage && reply.answer && oa) {
          fetchAudio(reply.answer)
            .then((blob) => {
              if (blob) oa(blob);
            })
            .catch((e) => console.warn("[chat] tts stage failed", e));
        }
      } catch (e: any) {
        if (e?.name === "AbortError" || ctl.signal.aborted) {
          console.info("[chat] dispatch aborted");
          return;
        }
        const msg = e?.message ?? "Request failed";
        console.error("[chat] dispatch failed", e);
        updateMessage(sessionId, userMessageId, {
          failed: true,
          errorMessage: msg,
        });
        setToast(msg);
      } finally {
        if (abortRef.current === ctl) {
          abortRef.current = null;
          setPending(false);
        }
      }
    },
    [appendMessage, updateMessage, unmarkRetriable],
  );

  // ---- Public send helpers ----
  const ensureActive = useCallback((): string => {
    if (activeId && sessions.find((s) => s.id === activeId)) return activeId;
    if (sessions[0]) {
      setActiveIdState(sessions[0].id);
      return sessions[0].id;
    }
    return createSession().id;
  }, [activeId, sessions, createSession]);

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const sessionId = ensureActive();
      const id = uid();
      appendMessage(sessionId, {
        id,
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
        originalText: trimmed,
      });
      markRetriable(id);
      void dispatch(sessionId, id, { kind: "text", text: trimmed });
    },
    [ensureActive, appendMessage, markRetriable, dispatch],
  );

  const sendAudio = useCallback(
    (blob: Blob) => {
      if (!blob || blob.size === 0) {
        setToast("Recording was empty — please try again.");
        return;
      }
      const sessionId = ensureActive();
      const id = uid();
      appendMessage(sessionId, {
        id,
        role: "user",
        content: "🎙️ (voice message)",
        createdAt: Date.now(),
        hasAudioBlob: true,
      });
      // Persist to IndexedDB before dispatching so a mid-flight reload
      // can still retry.
      void storeAudio(id, blob);
      markRetriable(id);
      void dispatch(sessionId, id, { kind: "audio", blob });
    },
    [ensureActive, appendMessage, markRetriable, dispatch],
  );

  const retry = useCallback(
    async (messageId: string) => {
      const sessionId = ensureActive();
      const session = sessions.find((s) => s.id === sessionId);
      const msg = session?.messages.find((m) => m.id === messageId);
      if (!msg) {
        setToast("Couldn't find the message to retry.");
        return;
      }
      updateMessage(sessionId, messageId, {
        failed: false,
        errorMessage: undefined,
      });

      if (msg.originalText) {
        void dispatch(sessionId, messageId, {
          kind: "text",
          text: msg.originalText,
        });
        return;
      }
      if (msg.hasAudioBlob) {
        const blob = await loadAudio(messageId);
        if (!blob) {
          updateMessage(sessionId, messageId, {
            failed: true,
            errorMessage: "Audio data was lost — please record again.",
          });
          unmarkRetriable(messageId);
          return;
        }
        void dispatch(sessionId, messageId, { kind: "audio", blob });
        return;
      }
      setToast("This message can't be retried — please send a new one.");
    },
    [ensureActive, sessions, updateMessage, dispatch, unmarkRetriable],
  );

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    // session list
    sessions,
    active,
    activeId,
    setActiveId,
    createSession,
    deleteSession,
    // chat actions
    sendText,
    sendAudio,
    retry,
    cancelInFlight,
    // state surface
    pending,
    toast,
    setToast,
    retriable,
  };
}
