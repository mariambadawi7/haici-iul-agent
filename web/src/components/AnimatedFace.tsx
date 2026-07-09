import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { FaceState } from "../types";

interface Props {
  state: FaceState;
  amplitude?: number; // 0..1 — RMS from the TTS analyser, drives mouth
}

/**
 * A humanoid SVG portrait. Anatomy choices:
 *  - face: oval, warm-skin radial gradient kept light at the rim, with a
 *    separate soft form-shadow on the light-away side for volume
 *  - eyes: sclera + hazel iris + pupil + catchlight, a crease line for the
 *    double lid, and a top eyelid that drops to blink. Set ~one eye-width
 *    apart so the face doesn't read wide-eyed/uncanny.
 *  - brows: short strokes that rotate per state (raise = listening,
 *    inner-tilt = thinking, gentle arch = idle/speaking)
 *  - nose: shallow ridge + nostril shadow
 *  - mouth: upper-lip curve + lower-lip whose Y-radius is driven by
 *    `amplitude` (lip-sync to the TTS); idle = soft closed smile
 *  - chest: subtle shoulders that breathe in idle
 */
export default function AnimatedFace({ state, amplitude = 0 }: Props) {
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loop = () => {
      const next = 2200 + Math.random() * 2800;
      setTimeout(() => {
        if (cancelled) return;
        setBlink(true);
        setTimeout(() => !cancelled && setBlink(false), 130);
        loop();
      }, next);
    };
    loop();
    return () => {
      cancelled = true;
    };
  }, []);

  // Brow position by state.
  const browLift =
    state === "listening" ? -4 : state === "thinking" ? 0 : -1;
  const browTiltInner =
    state === "thinking" ? -8 : state === "listening" ? -2 : 0;

  // Eye gaze: thinking looks up-left.
  const gazeX = state === "thinking" ? -1.5 : 0;
  const gazeY = state === "thinking" ? -2 : 0;

  // Mouth: speaking opens jaw with amplitude; idle has a tiny smile.
  const jawDrop =
    state === "speaking" ? 2 + amplitude * 14 : state === "listening" ? 1 : 0;
  const lipPart =
    state === "speaking" ? 3 + amplitude * 11 : state === "idle" ? 0.6 : 1.4;

  // Head tilt when listening.
  const headTilt = state === "listening" ? 4 : 0;

  return (
    <div className="relative flex items-center justify-center select-none">
      {/* Atmospheric halo */}
      <motion.div
        aria-hidden
        className="absolute w-[360px] h-[360px] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(closest-side, rgba(201,160,99,0.25), rgba(201,160,99,0) 70%)",
          filter: "blur(2px)",
        }}
        animate={{
          opacity:
            state === "speaking" ? 0.85 + amplitude * 0.15 : [0.55, 0.8, 0.55],
          scale:
            state === "speaking"
              ? 1 + amplitude * 0.08
              : state === "thinking"
                ? [1, 1.05, 1]
                : 1,
        }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />

      <motion.svg
        viewBox="0 0 220 260"
        className="relative w-[260px] h-[300px]"
        style={{ filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.5))" }}
        animate={{
          rotate: headTilt,
          y: state === "idle" ? [0, -2.5, 0] : 0,
        }}
        transition={{
          rotate: { duration: 0.5, ease: "easeOut" },
          y: { duration: 5, repeat: Infinity, ease: "easeInOut" },
        }}
      >
        <defs>
          {/* Skin: light, warm, and kept off the muddy edge so the face
              reads clean; volume comes from a separate form-shadow. */}
          <radialGradient id="skin" cx="46%" cy="38%" r="68%">
            <stop offset="0%" stopColor="#ffe1c2" />
            <stop offset="52%" stopColor="#f3c79e" />
            <stop offset="100%" stopColor="#d09e73" />
          </radialGradient>
          <radialGradient id="form" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(120,74,42,0.28)" />
            <stop offset="100%" stopColor="rgba(120,74,42,0)" />
          </radialGradient>
          <linearGradient id="hair" x1="0.15" y1="0" x2="0.55" y2="1">
            <stop offset="0%" stopColor="#3a2718" />
            <stop offset="55%" stopColor="#4c3520" />
            <stop offset="100%" stopColor="#281a10" />
          </linearGradient>
          <linearGradient id="hairHi" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="rgba(180,140,90,0.5)" />
            <stop offset="100%" stopColor="rgba(180,140,90,0)" />
          </linearGradient>
          <linearGradient id="shirt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#243047" />
            <stop offset="100%" stopColor="#121a2c" />
          </linearGradient>
          <radialGradient id="iris" cx="44%" cy="38%" r="62%">
            <stop offset="0%" stopColor="#b0894f" />
            <stop offset="55%" stopColor="#7c5a2f" />
            <stop offset="100%" stopColor="#2b1c0d" />
          </radialGradient>
          <linearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c67f74" />
            <stop offset="100%" stopColor="#9c534a" />
          </linearGradient>
          <radialGradient id="cheek" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(206,108,96,0.4)" />
            <stop offset="100%" stopColor="rgba(206,108,96,0)" />
          </radialGradient>
        </defs>

        {/* Shoulders / chest — breathes in idle */}
        <motion.g
          animate={{
            scaleY: state === "idle" ? [1, 1.015, 1] : 1,
          }}
          style={{ transformOrigin: "110px 240px" }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        >
          <path
            d="M 18 260 C 34 212, 74 196, 110 196 C 146 196, 186 212, 202 260 Z"
            fill="url(#shirt)"
            stroke="#0c1120"
            strokeWidth="1"
          />
          {/* Collar */}
          <path
            d="M 86 205 C 99 219, 121 219, 134 205"
            fill="none"
            stroke="#38455f"
            strokeWidth="1.6"
          />
        </motion.g>

        {/* Neck */}
        <path
          d="M 91 185 L 91 214 C 100 222, 120 222, 129 214 L 129 185 Z"
          fill="url(#skin)"
        />
        {/* Neck shadow under the jaw */}
        <path
          d="M 91 187 C 100 200, 120 200, 129 187 L 129 191 C 120 202, 100 202, 91 191 Z"
          fill="rgba(120,74,42,0.28)"
        />

        {/* Hair back layer — frames the face */}
        <path
          d="M 52 100 C 44 58, 78 34, 110 34 C 142 34, 176 58, 168 100
             C 172 122, 174 138, 168 152 L 154 112 C 149 90, 130 74, 110 74
             C 90 74, 71 90, 66 112 L 52 152 C 46 138, 48 122, 52 100 Z"
          fill="url(#hair)"
        />

        {/* Face oval */}
        <ellipse cx="110" cy="120" rx="55" ry="68" fill="url(#skin)" />

        {/* Form shadow on the light-away side (light comes from upper-left) */}
        <ellipse cx="141" cy="128" rx="26" ry="54" fill="url(#form)" />
        {/* Cheek blush */}
        <ellipse cx="82" cy="140" rx="13" ry="8.5" fill="url(#cheek)" />
        <ellipse cx="138" cy="140" rx="13" ry="8.5" fill="url(#cheek)" />

        {/* Hair front — soft side-swept fringe with a sheen */}
        <path
          d="M 57 96 C 66 66, 96 54, 126 62 C 146 68, 159 82, 163 102
             C 150 84, 128 76, 110 80 C 92 84, 76 92, 66 106
             C 62 102, 59 100, 57 96 Z"
          fill="url(#hair)"
        />
        <path
          d="M 62 92 C 74 70, 100 60, 122 66 C 108 66, 88 74, 74 92
             C 69 91, 65 91, 62 92 Z"
          fill="url(#hairHi)"
        />

        {/* Eyebrows */}
        <motion.g
          animate={{ y: browLift }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <motion.path
            d="M 80 101 Q 91 95 103 100"
            fill="none"
            stroke="#3a2417"
            strokeWidth="3.2"
            strokeLinecap="round"
            animate={{ rotate: browTiltInner }}
            style={{ transformOrigin: "103px 100px" }}
            transition={{ duration: 0.35 }}
          />
          <motion.path
            d="M 117 100 Q 129 95 140 101"
            fill="none"
            stroke="#3a2417"
            strokeWidth="3.2"
            strokeLinecap="round"
            animate={{ rotate: -browTiltInner }}
            style={{ transformOrigin: "117px 100px" }}
            transition={{ duration: 0.35 }}
          />
        </motion.g>

        {/* Eyes — ~one eye-width apart */}
        <Eye cx={91} cy={119} blink={blink} gazeX={gazeX} gazeY={gazeY} />
        <Eye cx={129} cy={119} blink={blink} gazeX={gazeX} gazeY={gazeY} />

        {/* Nose */}
        <path
          d="M 110 123 Q 108 140 106 152 Q 110 155 114 152 Q 112 140 110 123 Z"
          fill="rgba(120,74,42,0.12)"
        />
        <path
          d="M 106 152 Q 110 157 114 152"
          fill="none"
          stroke="rgba(90,50,25,0.32)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        {/* Nostril hints */}
        <ellipse cx="106.5" cy="154" rx="1.4" ry="0.9" fill="rgba(70,38,18,0.4)" />
        <ellipse cx="113.5" cy="154" rx="1.4" ry="0.9" fill="rgba(70,38,18,0.4)" />

        {/* Mouth — jaw shifts down on speaking */}
        <motion.g animate={{ y: jawDrop }} transition={{ duration: 0.08 }}>
          {/* Upper lip */}
          <path
            d="M 93 172
               Q 101 167 110 170
               Q 119 167 127 172
               Q 119 174 110 173
               Q 101 174 93 172 Z"
            fill="url(#lip)"
            stroke="#5a2a26"
            strokeWidth="0.6"
          />
          {/* Mouth interior */}
          <ellipse
            cx="110"
            cy={173 + lipPart / 2}
            rx="12.5"
            ry={Math.max(0.6, lipPart)}
            fill="#3a1512"
          />
          {/* Lower lip */}
          <motion.path
            d={`M 93 ${173 + lipPart}
                Q 110 ${181 + lipPart * 1.2} 127 ${173 + lipPart}
                Q 119 ${178 + lipPart * 0.8} 110 ${178 + lipPart * 0.9}
                Q 101 ${178 + lipPart * 0.8} 93 ${173 + lipPart} Z`}
            fill="url(#lip)"
            stroke="#5a2a26"
            strokeWidth="0.6"
          />
          {/* Lower-lip highlight */}
          <path
            d={`M 100 ${176 + lipPart} Q 110 ${178 + lipPart} 120 ${176 + lipPart}`}
            fill="none"
            stroke="rgba(255,220,205,0.45)"
            strokeWidth="1"
            strokeLinecap="round"
          />
        </motion.g>

        {/* Chin shadow */}
        <ellipse cx="110" cy="190" rx="17" ry="4.5" fill="rgba(120,74,42,0.14)" />

        {/* Subtle face rim light */}
        <path
          d="M 62 82 C 55 100, 55 145, 72 172"
          fill="none"
          stroke="rgba(255,228,196,0.35)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </motion.svg>
    </div>
  );
}

function Eye({
  cx,
  cy,
  blink,
  gazeX,
  gazeY,
}: {
  cx: number;
  cy: number;
  blink: boolean;
  gazeX: number;
  gazeY: number;
}) {
  return (
    <g>
      {/* Sclera */}
      <ellipse cx={cx} cy={cy} rx="10" ry="6" fill="#f9f2e7" />
      {/* Soft shadow under the upper lid (kept light) */}
      <ellipse cx={cx} cy={cy - 2.4} rx="10" ry="2.6" fill="rgba(60,35,20,0.1)" />
      {/* Iris */}
      <motion.circle
        cx={cx + gazeX}
        cy={cy + gazeY}
        r="5"
        fill="url(#iris)"
        animate={{ cx: cx + gazeX, cy: cy + gazeY }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
      {/* Limbal ring for depth */}
      <circle
        cx={cx + gazeX}
        cy={cy + gazeY}
        r="5"
        fill="none"
        stroke="rgba(30,18,8,0.35)"
        strokeWidth="0.7"
      />
      {/* Pupil */}
      <circle cx={cx + gazeX} cy={cy + gazeY} r="2.3" fill="#0a0604" />
      {/* Catchlight */}
      <circle
        cx={cx + gazeX + 1.7}
        cy={cy + gazeY - 1.7}
        r="1"
        fill="#fff"
        opacity="0.95"
      />
      {/* Upper eyelid (blink) */}
      <motion.path
        d={`M ${cx - 10.5} ${cy - 6}
            Q ${cx} ${cy - 10} ${cx + 10.5} ${cy - 6}
            L ${cx + 10.5} ${cy + 6}
            Q ${cx} ${cy - 2} ${cx - 10.5} ${cy + 6} Z`}
        fill="url(#skin)"
        animate={{ scaleY: blink ? 1.4 : 0, opacity: blink ? 1 : 0 }}
        style={{ transformOrigin: `${cx}px ${cy - 6}px` }}
        transition={{ duration: 0.11 }}
      />
      {/* Lash line */}
      <path
        d={`M ${cx - 10.5} ${cy - 5.5} Q ${cx} ${cy - 10} ${cx + 10.5} ${cy - 5.5}`}
        fill="none"
        stroke="#2a1a10"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {/* Crease line (double lid) */}
      <path
        d={`M ${cx - 9} ${cy - 8.5} Q ${cx} ${cy - 12} ${cx + 9} ${cy - 8.5}`}
        fill="none"
        stroke="rgba(90,55,30,0.25)"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
      {/* Lower eyelid line */}
      <path
        d={`M ${cx - 9} ${cy + 5.5} Q ${cx} ${cy + 7} ${cx + 9} ${cy + 5.5}`}
        fill="none"
        stroke="rgba(90,55,30,0.22)"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
    </g>
  );
}
