/**
 * Where tenant branding is read from and written to.
 *
 * Source of truth is `GET/PUT /api/branding`, served by the Bun process that
 * already runs beside Vite in the web container (see `web/ws-server.ts`) and
 * backed by a JSON file on a mounted volume. The request is relative, so it
 * rides the Vite proxy and stays same-origin — same arrangement as `/webhook`.
 *
 * A localStorage copy is kept as a fallback so the kiosk still comes up
 * branded if the config endpoint is unreachable (or absent entirely, e.g. a
 * static `vite build` deployed without the Bun server).
 */

import { withDefaults } from "./defaults";
import type { PartialTenantConfig, TenantConfig } from "./types";

const ENDPOINT = "/api/branding";
const CACHE_KEY = "tenant.branding.v1";

function readCache(): PartialTenantConfig | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as PartialTenantConfig) : null;
  } catch {
    return null;
  }
}

function writeCache(config: PartialTenantConfig) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch {
    // Private-mode or quota failure — the server copy is still authoritative.
  }
}

/**
 * Resolve the active tenant config. Never throws and never returns null: a
 * failure at every layer still yields the neutral defaults, because a kiosk
 * that renders unbranded is far better than one that renders nothing.
 */
export async function loadBranding(): Promise<TenantConfig> {
  try {
    const res = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as PartialTenantConfig;
      writeCache(body);
      return withDefaults(body);
    }
    console.warn(`[branding] ${ENDPOINT} returned ${res.status}; using cached config`);
  } catch (err) {
    console.warn("[branding] config endpoint unreachable; using cached config", err);
  }
  return withDefaults(readCache());
}

export interface SaveResult {
  ok: boolean;
  /** Present when the write failed — surfaced in the admin UI. */
  error?: string;
}

/**
 * Persist a full config. The admin UI always sends the complete document, so a
 * cleared field is an explicit choice rather than an absent key.
 *
 * `passcode` is the same one the operator typed at the dashboard gate; the Bun
 * sidecar compares it against its ADMIN_PASSCODE env var. Deployments that
 * leave that unset accept the write regardless.
 */
export async function saveBranding(
  config: TenantConfig,
  passcode?: string | null,
): Promise<SaveResult> {
  writeCache(config);
  try {
    const res = await fetch(ENDPOINT, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(passcode ? { "X-Admin-Passcode": passcode } : {}),
      },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error:
          res.status === 404
            ? "The config endpoint is not available in this deployment. Changes were saved to this browser only."
            : res.status === 401
              ? "The passcode was rejected by the config service."
              : `Server refused the save (${res.status}). ${detail}`.trim(),
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "Could not reach the config endpoint. Changes were saved to this browser only.",
    };
  }
}

/** Namespaced browser-storage key, so two tenants on one origin never collide. */
export function scopedKey(tenantId: string, key: string): string {
  return `${tenantId}.${key}`;
}

/** Named upload destinations the config service accepts. */
export type AssetSlot =
  | "logo-primary"
  | "logo-secondary"
  | "favicon"
  | "avatar-image"
  | "avatar-model";

export interface UploadResult {
  ok: boolean;
  /** Path to reference from the config, e.g. "/api/branding/asset/logo-primary.png". */
  url?: string;
  error?: string;
}

/**
 * Send one file to a fixed slot and get back the URL to store in the config.
 * Slots are named server-side, so re-uploading a logo replaces it rather than
 * leaving the previous file orphaned on disk.
 */
export async function uploadAsset(
  slot: AssetSlot,
  file: File,
  passcode?: string | null,
): Promise<UploadResult> {
  const body = new FormData();
  body.append("file", file);
  try {
    const res = await fetch(`${ENDPOINT}/asset/${slot}`, {
      method: "POST",
      headers: passcode ? { "X-Admin-Passcode": passcode } : undefined,
      body,
    });
    const payload = await res.json().catch(() => ({}) as { error?: string; url?: string });
    if (!res.ok) {
      return { ok: false, error: payload.error || `Upload failed (${res.status}).` };
    }
    return { ok: true, url: payload.url };
  } catch {
    return { ok: false, error: "Could not reach the config service." };
  }
}
