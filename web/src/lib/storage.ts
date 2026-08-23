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
  localStorage.setItem(KEY(), JSON.stringify(sessions));
}

export function loadActive(): string | null {
  return localStorage.getItem(ACTIVE_KEY());
}

export function saveActive(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY(), id);
  else localStorage.removeItem(ACTIVE_KEY());
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
