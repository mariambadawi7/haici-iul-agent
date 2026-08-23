/** @type {import('tailwindcss').Config} */

// Every colour in this app resolves to a CSS variable rather than a literal.
// That is what makes the product white-labelable at runtime: `applyTheme()`
// (src/lib/branding/theme.ts) writes the variables from the tenant config, and
// every `bg-teal-600` / `border-slate-200` already written in a component
// retargets itself with no rebuild and no component edit.
//
// The three Tailwind scales are deliberately REDEFINED rather than aliased:
//   teal  -> brand    (buttons, focus rings, active states)
//   slate -> neutral  (panels, borders, body copy)
//   amber -> warn     (health banner, mock-data badges)
// New code should prefer the semantic names (`bg-brand-600`, `text-neutral-500`);
// the scale names are kept working so existing markup did not need rewriting.

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Build a Tailwind colour object whose stops read `--<name>-<stop>`. */
const ramp = (name) =>
  Object.fromEntries(
    STOPS.map((stop) => [stop, `rgb(var(--${name}-${stop}) / <alpha-value>)`]),
  );

const brand = ramp("brand");
const neutral = ramp("neutral");
const warn = ramp("warn");

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic names — prefer these in new code.
        brand,
        neutral,
        warn,
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
        },
        // Readable text on top of a brand-filled element.
        "on-brand": "rgb(var(--on-brand) / <alpha-value>)",

        // Redefined stock scales, so existing markup themes itself.
        teal: brand,
        slate: neutral,
        amber: warn,

        // Legacy token names still referenced by a few components.
        bg: {
          base: "rgb(var(--surface) / <alpha-value>)",
          panel: "rgb(var(--surface-raised) / <alpha-value>)",
          elevated: "rgb(var(--neutral-50) / <alpha-value>)",
          border: "rgb(var(--neutral-200) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--brand-600) / <alpha-value>)",
          glow: "rgb(var(--brand-400) / <alpha-value>)",
          deep: "rgb(var(--brand-800) / <alpha-value>)",
        },
        ink: {
          100: "rgb(var(--neutral-900) / <alpha-value>)",
          300: "rgb(var(--neutral-500) / <alpha-value>)",
          500: "rgb(var(--neutral-600) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        serif: [
          "var(--font-serif)",
          "'Cormorant Garamond'",
          "Georgia",
          "ui-serif",
          "serif",
        ],
      },
      // Corner rounding scales with the tenant's --radius. The defaults below
      // reproduce Tailwind's stock values exactly when --radius is 1rem, so
      // nothing shifts until a client actually changes it.
      borderRadius: {
        xl: "calc(var(--radius) * 0.75)",
        "2xl": "var(--radius)",
        "3xl": "calc(var(--radius) * 1.5)",
        brand: "var(--radius)",
      },
      boxShadow: {
        glow: "0 0 30px -8px rgb(var(--brand-500) / 0.45)",
        "glow-strong": "0 0 60px -10px rgb(var(--brand-500) / 0.65)",
        soft: "0 10px 30px -15px rgb(var(--neutral-900) / 0.35)",
      },
      animation: {
        "pulse-soft": "pulseSoft 2.6s ease-in-out infinite",
        breathe: "breathe 5s ease-in-out infinite",
      },
      keyframes: {
        pulseSoft: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        breathe: {
          "0%, 100%": { transform: "translateY(0) scale(1)" },
          "50%": { transform: "translateY(-3px) scale(1.01)" },
        },
      },
    },
  },
  plugins: [],
};
