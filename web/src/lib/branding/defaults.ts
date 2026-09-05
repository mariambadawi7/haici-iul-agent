/**
 * Neutral out-of-the-box branding.
 *
 * Deliberately generic: a fresh install shows an unbranded product rather than
 * the previous client's. Every tenant config is merged on top of this, so a
 * missing, partial or malformed `branding.json` still renders a usable app.
 */

import type { PartialTenantConfig, TenantConfig } from "./types";

export const DEFAULT_CONFIG: TenantConfig = {
  id: "default",
  identity: {
    name: "AI Assistant",
    kicker: "",
    tagline: "Ask a question by voice or text.",
    logoPrimary: "",
    logoSecondary: "",
    favicon: "/favicon.svg",
    footerCredit: "",
    metaDescription:
      "A multimodal assistant. Ask questions by voice or text.",
  },
  theme: {
    brand: "#0d9488",
    neutral: "#475569",
    warn: "#d97706",
    surface: "#ffffff",
    mode: "light",
    fontSans: "Inter",
    fontSerif: "Cormorant Garamond",
    radius: "1rem",
  },
  avatar: {
    kind: "glb",
    glbUrl: "/avatar/facecap.glb",
    imageUrl: "",
    mascotView: "full",
  },
  features: {
    voice: true,
    avatar: true,
    landing: true,
    admin: true,
    sidebar: true,
    camera: false,
  },
  content: {
    inputPlaceholder: "Ask anything — or tap the mic to speak",
    suggestions: [],
  },
};

/**
 * Merge a partial config over the defaults, one level deep (the config tree is
 * exactly two levels, so a deep merge would buy nothing). Arrays and scalars
 * replace wholesale; `undefined` and `null` fall through to the default so a
 * cleared field in the admin form does not blank the UI.
 */
export function withDefaults(partial?: PartialTenantConfig | null): TenantConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
  const out = structuredClone(DEFAULT_CONFIG);

  for (const key of Object.keys(out) as (keyof TenantConfig)[]) {
    const incoming = partial[key];
    if (incoming === undefined || incoming === null) continue;

    // Branch on the shape of the DEFAULT slot, not the type of the incoming
    // value. Branching on the incoming type alone (the previous bug) let a
    // scalar supplied for an object key — e.g. `{ theme: "dark" }` — replace
    // the entire defaulted sub-object with that scalar. Every consumer reads
    // `config.theme.brand`, `config.features.admin`, etc. synchronously with
    // no guard, so that silently poisoned the whole config (see F-06/F-07).
    const slot = out[key];
    const slotIsObject = typeof slot === "object" && slot !== null && !Array.isArray(slot);

    if (!slotIsObject) {
      // A scalar slot (currently only `id`) takes a scalar. Reject an object.
      if (typeof incoming !== "object") {
        (out as unknown as Record<string, unknown>)[key] = incoming;
      } else {
        console.warn(`[branding] ignoring object supplied for scalar field "${key}"`);
      }
      continue;
    }

    // An object slot takes only an object. A scalar here would replace an
    // entire defaulted branch (theme, features, …) and every consumer reads
    // those synchronously with no guard, so it must be dropped, not merged.
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      console.warn(`[branding] ignoring ${typeof incoming} supplied for object field "${key}"`);
      continue;
    }

    const target = slot as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue;
      target[field] = value;
    }
  }

  return out;
}
