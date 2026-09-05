import type { Session } from "../types";
import { scoped } from "./branding/scope";

// Keys are resolved per call rather than at module load: the tenant id is not
// known until the branding config has been fetched, which happens after this
// module is first imported. Scoping them keeps two tenants served from the
// same origin from reading each other's conversations.
const KEY = () => scoped("sessions.v1");
const ACTIVE_KEY = () => scoped("active.v1");

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: Session[]) {
  try {
    localStorage.setItem(KEY(), JSON.stringify(sessions));
  } catch (err) {
    // Quota exhausted, or storage is blocked entirely (Safari private mode
    // throws on every write). Persistence is a convenience here — the session
    // list is already in React state — so degrade to in-memory rather than
    // taking the whole kiosk down through the ErrorBoundary (saveSessions
    // runs inside a useEffect in useChat.ts, and an uncaught throw there
    // unwinds the render).
    console.warn("[storage] could not persist sessions", err);
    // A full quota is usually a long transcript history. Drop the oldest
    // half and try once more so the CURRENT conversation still survives a
    // reload. createSession in useChat.ts prepends (`[s, ...prev]`), so
    // sessions[0] is the newest — keep the front slice, not the back.
    if (sessions.length > 1) {
      try {
        const trimmed = sessions.slice(0, Math.ceil(sessions.length / 2));
        localStorage.setItem(KEY(), JSON.stringify(trimmed));
        console.warn(`[storage] pruned session history to ${trimmed.length} entries`);
      } catch {
        /* still failing — give up on persistence for this run */
      }
    }
  }
}

export function loadActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY());
  } catch {
    return null;
  }
}

export function saveActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY(), id);
    else localStorage.removeItem(ACTIVE_KEY());
  } catch (err) {
    console.warn("[storage] could not persist the active session id", err);
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
