/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Deep midnight + academic warm-gold palette.
        bg: {
          base: "#0c0f1a",
          panel: "#10141f",
          elevated: "#161b2a",
          border: "#222a40",
        },
        // Burnished amber/gold accent — IUL-friendly, less "AI gradient".
        accent: {
          DEFAULT: "#c9a063",
          glow: "#e3bb7a",
          deep: "#8c6a3b",
          cyan: "#5fbfb6",
          pink: "#c9618b",
        },
        ink: {
          100: "#f2eee4",
          300: "#cdc8ba",
          500: "#8a8474",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        serif: [
          "'Cormorant Garamond'",
          "'Playfair Display'",
          "Georgia",
          "ui-serif",
          "serif",
        ],
      },
      boxShadow: {
        glow: "0 0 30px -8px rgba(201,160,99,0.45)",
        "glow-strong": "0 0 60px -10px rgba(201,160,99,0.65)",
        soft: "0 10px 30px -15px rgba(0,0,0,0.6)",
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
