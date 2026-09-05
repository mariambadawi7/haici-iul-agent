import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sendChat,
  transcribeAudio,
  fetchAudio,
  twoStage,
  type ChatReply,
  type Visitor,
} from "../lib/api";
import {
  deleteAudio,
  listAudioKeys,
  loadAudio,
  storeAudio,
} from "../lib/audioStore";
import { loadDraft, saveDraft, uid } from "../lib/storage";
import type { ChatMessage, Session } from "../types";

type Payload =
  | { kind: "text"; text: string }
  | { kind: "audio"; blob: Blob };

interface UseChatOpts {
  /** Whether to ask the workflow for audio. */
  wantsAudio: boolean;
  /** Called with the audio blob from a successful reply (for playback). */
  onAudio?: (blob: Blob) => void;
  /**
   * Read what the camera currently sees, at send time rather than at hook
   * setup — identity resolves seconds after a conversation starts, so a value
   * captured when this hook mounted would always be stale.
   */
  getVisitor?: () => Visitor | null;
  /**
   * The id the WORKFLOW should see for this conversation, which is not the id
   * this hook uses locally.
   *
   * n8n's Window Buffer Memory is keyed on `body.sessionId`, so whatever goes
   * out here decides what the agent remembers. Returning `face:<uid>` is what
   * makes the agent itself carry a person's conversation across visits, rather
   * than only the interface replaying it. Returning null falls back to the
   * local session id, which is the old per-visit behaviour and the right
   * answer whenever the kiosk cannot see who it is talking to.
   *
   * Read at send time, not at setup: identity resolves a second or so into a
   * conversation, so a value captured when this hook mounted is always stale.
   */
  getSessionKey?: () => string | null;
  /**
   * Called whenever the visible transcript changes, so the visitor store can
   * persist it against the face it belongs to. Debouncing is the caller's job.
   */
  onMessagesChanged?: (messages: ChatMessage[]) => void;
  /**
   * Facts the workflow picked out of the turn that just completed, for the
   * visitor's stored profile. Fires on the rare turn where someone actually
   * says something about themselves.
   */
  onProfileDelta?: (delta: NonNullable<ChatReply["profileDelta"]>) => void;
}

/**
 * Single source of truth for chat state. Owns:
 *   - the current conversation (there is only ever one; see below)
 *   - in-flight request lifecycle (one at a time, with abort)
 *   - retry cache: text is replayed from `message.originalText`,
 *     audio is replayed from IndexedDB → both survive a page reload
 *   - toast / error surface
 *
 * ONE CONVERSATION, NOT A LIST. The kiosk used to keep every conversation this
 * browser had ever held and show them in a sidebar, which meant one visitor
 * could read the previous visitor's transcript by scrolling. Conversations are
 * now bound to a face and stored per person (lib/visitorApi.ts): starting a
 * new one REPLACES the old rather than pushing onto a list, so the previous
 * visitor's messages do not survive in memory either.
 *
 * The internal array is kept because every mutator below addresses a session
 * by id, and collapsing it to a bare object buys nothing.
 */
export function useChat({
  wantsAudio,
  onAudio,
  getVisitor,
  getSessionKey,
  onMessagesChanged,
  onProfileDelta,
}: UseChatOpts) {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const draft = loadDraft();
    return draft ? [draft] : [];
  });
  const [activeId, setActiveIdState] = useState<string | null>(
    () => loadDraft()?.id ?? null,
  );
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [retriable, setRetriable] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);
  // Latest opts captured for use inside dispatch closures.
  const optsRef = useRef({
    wantsAudio,
    onAudio,
    getVisitor,
    getSessionKey,
    onMessagesChanged,
    onProfileDelta,
  });
  optsRef.current = {
    wantsAudio,
    onAudio,
    getVisitor,
    getSessionKey,
    onMessagesChanged,
    onProfileDelta,
  };

  // ---- Persistence ----
  // The draft slot only ever holds the conversation on screen (see
  // lib/storage.ts); the durable copy is the visitor record, written by the
  // callback below.
  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  useEffect(() => {
    saveDraft(activeSession);
  }, [activeSession]);

  useEffect(() => {
    if (activeSession) optsRef.current.onMessagesChanged?.(activeSession.messages);
    // Only the messages matter here — a title or timestamp change is not worth
    // a write to the visitor store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.messages]);

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

  /**
   * Start a fresh conversation, REPLACING whatever was on screen.
   *
   * The replacement is the point. When one visitor leaves and the next walks
   * up, the previous transcript must be gone from this browser entirely — not
   * pushed down a list where it can be scrolled back to. The durable copy is
   * already safe in that visitor's own record.
   *
   * Any recorded audio still pending in IndexedDB for the outgoing
   * conversation goes with it, or a stranger's voice message accumulates on
   * the kiosk indefinitely with nothing left that could ever replay it.
   */
  const createSession = useCallback((title = "New chat"): Session => {
    const now = Date.now();
    const s: Session = {
      id: uid(),
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    setSessions((prev) => {
      for (const old of prev) {
        for (const m of old.messages) {
          if (m.role === "user" && m.hasAudioBlob) void deleteAudio(m.id);
        }
      }
      return [s];
    });
    setActiveIdState(s.id);
    return s;
  }, []);

  /**
   * Load a recognised visitor's transcript into the conversation.
   *
   * Prepends rather than replaces: by the time a face resolves, the kiosk has
   * usually already greeted the person and that exchange is on screen. Their
   * history belongs above it, in the order it happened, not instead of it.
   *
   * Messages already present are matched by id and skipped, so a late-arriving
   * record cannot duplicate the turns it overlaps with.
   */
  const prependMessages = useCallback(
    (sessionId: string, history: ChatMessage[]) => {
      if (history.length === 0) return;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const present = new Set(s.messages.map((m) => m.id));
          const missing = history.filter((m) => !present.has(m.id));
          if (missing.length === 0) return s;
          return { ...s, messages: [...missing, ...s.messages] };
        }),
      );
    },
    [],
  );

  // Ensure a conversation always exists.
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
        const {
          wantsAudio: wa,
          onAudio: oa,
          getVisitor: gv,
          getSessionKey: gk,
        } = optsRef.current;
        const askMainForAudio = wa && !twoStage;
        const visitor = gv?.() ?? null;
        // What the workflow sees. Local ids stay local; the agent's memory is
        // keyed on this, so a recognised visitor continues the same thread
        // they were on last visit.
        const wireSessionId = gk?.() ?? sessionId;

        let reply: ChatReply;
        if (payload.kind === "text") {
          reply = await sendChat(wireSessionId, payload.text, askMainForAudio, ctl.signal, visitor, "text");
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
          
          // Mark the turn as spoken: the workflow can no longer infer it, since
          // the transcript reaches it as ordinary text.
          reply = await sendChat(wireSessionId, transcript, askMainForAudio, ctl.signal, visitor, "audio");
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

        // Only on a turn that really worked: an error responder can carry a
        // half-built body, and a profile is not the place to find out.
        if (!assistantFailed && reply.profileDelta) {
          optsRef.current.onProfileDelta?.(reply.profileDelta);
        }

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
    (text: string, forceSessionId?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // An explicit id lets a caller target a session it just created, before
      // this hook's own state has caught up with that creation — see the
      // opening-greeting stale-closure bug this exists for (F-05 in
      // docs/CODE-REVIEW-FINDINGS.md).
      const sessionId = forceSessionId ?? ensureActive();
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
    // the current conversation
    active,
    activeId,
    setActiveId,
    createSession,
    prependMessages,
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
