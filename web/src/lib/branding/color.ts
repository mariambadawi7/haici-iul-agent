/**
 * Palette generation for runtime theming.
 *
 * The whole theming system rests on one idea: Tailwind's `teal`, `slate` and
 * `amber` scales are redefined in `tailwind.config.js` to read CSS variables
 * (`rgb(var(--brand-600) / <alpha-value>)`). That means every `bg-teal-600`
 * already written in a component becomes runtime-swappable without touching
 * the component. This module turns a single brand hex into the 11-stop ramp
 * those variables need.
 */

export type Stop = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

export const STOPS: Stop[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** RGB triplet in the "R G B" form CSS variables need for `rgb(var(--x) / a)`. */
export type Triplet = string;

export type Ramp = Record<Stop, Triplet>;

interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

// How far each stop travels from the anchor toward the light/dark extreme.
// The anchor is stop 600, which reproduces the input colour exactly — that is
// the stop the primary button uses (`bg-teal-600`), so the client's brand hex
// shows up unmodified where it matters most.
const DISTANCE: Record<Stop, number> = {
  50: 0.96,
  100: 0.9,
  200: 0.78,
  300: 0.62,
  400: 0.42,
  500: 0.2,
  600: 0,
  700: 0.22,
  800: 0.44,
  900: 0.62,
  950: 0.8,
};

const LIGHT_EXTREME = 0.985;
const DARK_EXTREME = 0.1;

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hn = h / 360;
  return [
    Math.round(hue(hn + 1 / 3) * 255),
    Math.round(hue(hn) * 255),
    Math.round(hue(hn - 1 / 3) * 255),
  ];
}

const triplet = (rgb: [number, number, number]): Triplet => rgb.join(" ");

/**
 * Build an 11-stop ramp from one hex. Hue and saturation come from the input;
 * lightness fans out from it toward near-white and near-black. Stop 600 is the
 * input, exactly. Saturation is eased off at the pale end so tints read as
 * tints rather than neon pastels.
 */
export function buildRamp(hex: string): Ramp {
  const base = rgbToHsl(...hexToRgb(hex));
  const out = {} as Ramp;
  for (const stop of STOPS) {
    const d = DISTANCE[stop];
    const lighter = stop < 600;
    const l = lighter
      ? base.l + d * (LIGHT_EXTREME - base.l)
      : base.l - d * (base.l - DARK_EXTREME);
    const s = lighter ? base.s * (1 - 0.3 * d) : base.s * (1 + 0.08 * d);
    out[stop] = triplet(hslToRgb({ h: base.h, s: clamp(s), l: clamp(l) }));
  }
  return out;
}

/**
 * Dark mode is the neutral ramp read backwards. Components say `bg-slate-50`
 * for pale surfaces and `text-slate-900` for body copy; swapping 50↔950 flips
 * the entire interface without a single `dark:` variant being written.
 */
export function invertRamp(ramp: Ramp): Ramp {
  const out = {} as Ramp;
  STOPS.forEach((stop, i) => {
    out[stop] = ramp[STOPS[STOPS.length - 1 - i]];
  });
  return out;
}

/** WCAG relative luminance, used to pick readable text over a filled colour. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text colour that stays legible on top of `hex`. */
export function readableOn(hex: string): Triplet {
  return luminance(hex) > 0.45 ? "15 23 42" : "255 255 255";
}
