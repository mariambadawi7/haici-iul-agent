/**
 * Client for the visitor store in the Bun sidecar (web/visitor-store.ts).
 *
 * Same arrangement as branding: the browser calls `/api/...` on its own origin
 * and Vite proxies it, so there is no CORS and no second certificate. Unlike
 * branding, the sidecar refuses these routes unless they arrive from that
 * proxy — see requireLoopback in ws-server.ts.
 *
 * Every function here fails soft. A visitor record is an enhancement to a
 * conversation that has to work regardless: if the sidecar is down, the kiosk
 * must still greet the person and answer their question, just without
 * recognising them. Nothing in this module throws.
 */

import type { ChatMessage } from "../types";

export interface VisitorFact {
  key: string;
  value: string;
  updatedAt: number;
}

export interface VisitorProfile {
  displayName: string | null;
  facts: VisitorFact[];
}

export interface VisitorRecord {
  uid: string;
  createdAt: number;
  updatedAt: number;
  lastSeen: number;
  visits: number;
  enrolled: boolean;
  profile: VisitorProfile;
  messages: ChatMessage[];
}

export interface VisitorSummary extends Omit<VisitorRecord, "messages"> {
  messageCount: number;
  samples: number;
}

const BASE = "/api/visitors";

/** Short: this runs while someone is standing at the kiosk waiting to be greeted. */
const TIMEOUT_MS = 6_000;

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: ctl.signal });
  } catch (err) {
    console.warn(`[visitors] ${init?.method ?? "GET"} ${path} failed`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enroll a face crop. Pass `uid` to add another reference photo to someone
 * already known; omit it to mint a new identity.
 *
 * Returns the uid, or null when the sidecar could not store the face — in
 * which case the conversation proceeds unbound, which is exactly what the
 * kiosk did before any of this existed.
 */
export async function enrollFace(
  blob: Blob,
  uid?: string,
): Promise<{ uid: string; samples: number; created: boolean } | null> {
  const form = new FormData();
  form.append("file", blob, "face.jpg");
  if (uid) form.append("uid", uid);

  const res = await call(`${BASE}/enroll`, { method: "POST", body: form });
  if (!res?.ok) return null;
  try {
    const data = await res.json();
    return typeof data.uid === "string"
      ? { uid: data.uid, samples: data.samples ?? 1, created: !!data.created }
      : null;
  } catch {
    return null;
  }
}

/**
 * Load a visitor. Returns null only when the store could not be reached — a
 * uid with no record yet comes back as an empty record, because a face a
 * member of staff added to the gallery by hand is a real identity that has
 * simply never spoken to the kiosk before.
 */
export async function loadVisitor(uid: string): Promise<VisitorRecord | null> {
  const res = await call(`${BASE}/${encodeURIComponent(uid)}`);
  if (!res?.ok) return null;
  try {
    const data = await res.json();
    return (data.record ?? null) as VisitorRecord | null;
  } catch {
    return null;
  }
}

export interface SaveVisitorInput {
  messages?: ChatMessage[];
  /**
   * A partial profile to merge. Facts carry no `updatedAt` on the way in — the
   * sidecar stamps its own, so a client clock (or a workflow's) can never
   * decide the ordering of what the store believes.
   */
  profile?: {
    displayName?: string | null;
    facts?: Array<{ key: string; value: string }>;
  };
  /** Set once per conversation, never per turn — see writeVisitor in ws-server.ts. */
  bumpVisit?: boolean;
}

export async function saveVisitor(uid: string, input: SaveVisitorInput): Promise<boolean> {
  const res = await call(`${BASE}/${encodeURIComponent(uid)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return !!res?.ok;
}

/** Operator only. Used by the admin console's Visitors tab. */
export async function listVisitors(passcode: string): Promise<VisitorSummary[] | null> {
  const res = await call(BASE, { headers: { "X-Admin-Passcode": passcode } });
  if (!res?.ok) return null;
  try {
    const data = await res.json();
    return Array.isArray(data.visitors) ? data.visitors : null;
  } catch {
    return null;
  }
}

/** Operator only. Deletes the transcript, the profile AND the enrolled face. */
export async function forgetVisitor(uid: string, passcode: string): Promise<boolean> {
  const res = await call(`${BASE}/${encodeURIComponent(uid)}`, {
    method: "DELETE",
    headers: { "X-Admin-Passcode": passcode },
  });
  return !!res?.ok;
}
