/**
 * Applies a tenant config to the live document.
 *
 * Colours are written as CSS variables on <html>; `tailwind.config.js` points
 * the `teal` (brand), `slate` (neutral) and `amber` (warn) scales at those
 * variables, so every colour utility already written in a component retargets
 * itself the moment these are set. Nothing re-renders, nothing rebuilds.
 */

import { buildRamp, invertRamp, readableOn, STOPS, type Ramp } from "./color";
import type { TenantConfig } from "./types";

const FONT_LINK_ID = "tenant-fonts";

function emitRamp(root: HTMLElement, name: string, ramp: Ramp) {
  for (const stop of STOPS) {
    root.style.setProperty(`--${name}-${stop}`, ramp[stop]);
  }
}

/** Scale an "R G B" triplet toward black. Used to sink the dark-mode surface
 *  slightly below the darkest neutral so panels stay distinguishable. */
function darken(triplet: string, factor: number): string {
  return triplet
    .split(" ")
    .map((n) => Math.round(Number(n) * factor))
    .join(" ");
}

function hexTriplet(hex: string): string {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return "255 255 255";
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ].join(" ");
}

/**
 * Repaint without animating, and without leaving elements stranded.
 *
 * Chrome does not re-resolve a transitioning property when the custom property
 * feeding it changes: an element carrying `transition: all` keeps rendering the
 * PREVIOUS colour indefinitely while a freshly created one picks up the new
 * value. Killing transitions across the swap sidesteps that, and it is what we
 * want visually anyway — a rebrand should snap into place rather than crossfade
 * every surface on screen at once.
 */
function withoutTransitions(mutate: () => void) {
  const freeze = document.createElement("style");
  freeze.textContent =
    "*,*::before,*::after{transition:none !important;animation-duration:0s !important}";
  document.head.appendChild(freeze);

  mutate();

  // Force a synchronous style flush so the new values are committed while
  // transitions are still disabled, then restore them on the next frame.
  void document.body?.offsetHeight;
  requestAnimationFrame(() => freeze.remove());
}

export function applyTheme(config: TenantConfig) {
  withoutTransitions(() => paintTheme(config));
}

function paintTheme(config: TenantConfig) {
  const { theme } = config;
  const root = document.documentElement;
  const dark = theme.mode === "dark";

  const brand = buildRamp(theme.brand);
  const warn = buildRamp(theme.warn);
  const neutralLight = buildRamp(theme.neutral);
  const neutral = dark ? invertRamp(neutralLight) : neutralLight;

  emitRamp(root, "brand", brand);
  emitRamp(root, "warn", warn);
  emitRamp(root, "neutral", neutral);

  // Surfaces. In light mode the configured surface is used verbatim; in dark
  // mode it is derived from the neutral so the two always agree in hue.
  root.style.setProperty(
    "--surface",
    dark ? darken(neutralLight[950], 0.55) : hexTriplet(theme.surface),
  );
  root.style.setProperty(
    "--surface-raised",
    dark ? darken(neutralLight[950], 0.8) : hexTriplet(theme.surface),
  );
  root.style.setProperty("--on-brand", readableOn(theme.brand));
  root.style.setProperty("--radius", theme.radius);
  root.style.setProperty("--font-sans", `'${theme.fontSans}'`);
  root.style.setProperty("--font-serif", `'${theme.fontSerif}'`);

  root.style.colorScheme = theme.mode;
  root.dataset.themeMode = theme.mode;

  loadFonts(theme.fontSans, theme.fontSerif);
}

/**
 * Swap the Google Fonts stylesheet to whatever families the tenant chose.
 * Replacing the tag (rather than appending) keeps a rebrand from stacking up
 * stylesheets across repeated saves in the admin UI.
 */
function loadFonts(sans: string, serif: string) {
  const families = Array.from(new Set([sans, serif].filter(Boolean)))
    .map((f) => `family=${f.trim().replace(/\s+/g, "+")}:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400`)
    .join("&");
  if (!families) return;

  const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
  if (existing) {
    if (existing.href !== href) existing.href = href;
    return;
  }
  const link = document.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/** Document-level identity: tab title, favicon, meta description. */
export function applyIdentity(config: TenantConfig) {
  const { identity } = config;
  document.title = identity.name;

  const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (desc) desc.content = identity.metaDescription;

  if (identity.favicon) {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    if (icon.href !== identity.favicon) icon.href = identity.favicon;
  }
}

export function applyBranding(config: TenantConfig) {
  applyTheme(config);
  applyIdentity(config);
}

/**
 * Resolve a theme variable to a concrete colour string.
 *
 * Recharts writes its colours out as SVG presentation attributes, where a
 * `var(...)` reference is never resolved. Charts therefore have to read the
 * computed value instead of referencing the variable — this is the one place
 * in the app that needs a literal colour.
 */
export function cssColor(token: string, alpha = 1): string {
  if (typeof window === "undefined") return "#000000";
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${token}`)
    .trim();
  if (!raw) return "#000000";
  return alpha >= 1 ? `rgb(${raw})` : `rgb(${raw} / ${alpha})`;
}
