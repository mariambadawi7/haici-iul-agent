import type { Session } from "../types";
import { scoped } from "./branding/scope";

// The conversation list is gone. Transcripts are keyed by the visitor's face
// and live in the sidecar's visitor store (lib/visitorApi.ts), which is what
// makes a returning person get their own conversation back rather than the
// browser's most recent one.
//
// What is left here is a single-slot DRAFT of the conversation currently on
// screen, and it exists for exactly one reason: a page reload must not wipe
// what the person standing at the kiosk is in the middle of saying. It is
// crash resilience, not history — there is one slot, it is overwritten
// constantly, and it is cleared the moment the visitor walks away.
//
// It also carries the whole burden for a tenant running with the camera off:
// no camera means no face, means no visitor record, so this is the only thing
// keeping a conversation alive across a refresh.
//
// The key is resolved per call rather than at module load: the tenant id is
// not known until the branding config has been fetched, which happens after
// this module is first imported. Scoping keeps two tenants served from the
// same origin out of each other's conversations.
const DRAFT_KEY = () => scoped("draft.v1");

export function loadDraft(): Session | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed as Session;
  } catch {
    return null;
  }
}

export function saveDraft(session: Session | null) {
  try {
    if (!session) {
      localStorage.removeItem(DRAFT_KEY());
      return;
    }
    localStorage.setItem(DRAFT_KEY(), JSON.stringify(session));
  } catch (err) {
    // Quota exhausted, or storage blocked entirely (Safari private mode throws
    // on every write). The draft is a convenience — the conversation is
    // already in React state — so degrade to in-memory rather than taking the
    // kiosk down through the ErrorBoundary, since this runs inside a useEffect
    // in useChat.ts where an uncaught throw unwinds the render.
    //
    // Unlike the old session list there is nothing to prune: one conversation
    // that does not fit is simply not persisted, and the durable copy is in
    // the visitor record anyway.
    console.warn("[storage] could not persist the conversation draft", err);
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
