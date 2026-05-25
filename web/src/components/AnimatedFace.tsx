import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { FaceState } from "../types";

interface Props {
  state: FaceState;
  amplitude?: number; // 0..1 — RMS from the TTS analyser, drives mouth
}

/**
 * A humanoid SVG portrait. Anatomy choices:
 *  - face: oval, warm-skin radial gradient with a darker rim for shading
 *  - eyes: sclera + iris + pupil + catchlight, top eyelid that drops to blink
 *  - brows: short strokes that rotate per state (raise = listening,
 *    inner-tilt = thinking, gentle arch = idle/speaking)
 *  - nose: shallow ridge + nostril shadow
 *  - mouth: upper-lip curve + lower-lip ellipse whose Y-radius is driven by
 *    `amplitude` (lip-sync to Piper); idle = soft closed smile
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
        style={{ filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.55))" }}
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
          <radialGradient id="skin" cx="50%" cy="42%" r="62%">
            <stop offset="0%" stopColor="#f1d6b1" />
            <stop offset="55%" stopColor="#d6b187" />
            <stop offset="100%" stopColor="#7a5634" />
          </radialGradient>
          <linearGradient id="hair" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#241a14" />
            <stop offset="100%" stopColor="#3a2a1e" />
          </linearGradient>
          <linearGradient id="shirt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1b2233" />
            <stop offset="100%" stopColor="#0f1422" />
          </linearGradient>
          <radialGradient id="iris" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#8c6a3b" />
            <stop offset="60%" stopColor="#4a3520" />
            <stop offset="100%" stopColor="#1a1107" />
          </radialGradient>
          <linearGradient id="lip" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a35a55" />
            <stop offset="100%" stopColor="#6e2f2c" />
          </linearGradient>
          <radialGradient id="cheek" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(192,90,80,0.45)" />
            <stop offset="100%" stopColor="rgba(192,90,80,0)" />
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
            d="M 20 260 C 35 215, 75 200, 110 200 C 145 200, 185 215, 200 260 Z"
            fill="url(#shirt)"
            stroke="#0a0d18"
            strokeWidth="1"
          />
          {/* Collar */}
          <path
            d="M 88 208 C 100 220, 120 220, 132 208"
            fill="none"
            stroke="#2a3247"
            strokeWidth="1.5"
          />
        </motion.g>

        {/* Neck */}
        <path
          d="M 92 188 L 92 215 C 100 222, 120 222, 128 215 L 128 188 Z"
          fill="url(#skin)"
        />
        <path
          d="M 92 215 C 100 222, 120 222, 128 215"
          fill="none"
          stroke="rgba(0,0,0,0.18)"
          strokeWidth="1.2"
        />

        {/* Hair back layer */}
        <path
          d="M 55 95 C 50 60, 80 38, 110 38 C 140 38, 170 60, 165 95 C 168 115, 172 130, 168 145 L 155 110 C 150 90, 130 75, 110 75 C 90 75, 70 90, 65 110 L 52 145 C 48 130, 52 115, 55 95 Z"
          fill="url(#hair)"
        />

        {/* Face oval */}
        <ellipse cx="110" cy="120" rx="55" ry="68" fill="url(#skin)" />
        {/* Cheekbone shading */}
        <ellipse cx="80" cy="138" rx="14" ry="9" fill="url(#cheek)" />
        <ellipse cx="140" cy="138" rx="14" ry="9" fill="url(#cheek)" />

        {/* Hair front fringe */}
        <path
          d="M 60 92 C 75 70, 100 60, 125 65 C 145 70, 158 82, 162 100 C 150 86, 130 78, 112 82 C 96 86, 80 92, 70 102 Z"
          fill="url(#hair)"
        />

        {/* Eyebrows */}
        <motion.g
          animate={{ y: browLift }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        >
          <motion.path
            d="M 78 100 Q 88 95 98 99"
            fill="none"
            stroke="#221610"
            strokeWidth="3.2"
            strokeLinecap="round"
            animate={{ rotate: browTiltInner }}
            style={{ transformOrigin: "98px 99px" }}
            transition={{ duration: 0.35 }}
          />
          <motion.path
            d="M 122 99 Q 132 95 142 100"
            fill="none"
            stroke="#221610"
            strokeWidth="3.2"
            strokeLinecap="round"
            animate={{ rotate: -browTiltInner }}
            style={{ transformOrigin: "122px 99px" }}
            transition={{ duration: 0.35 }}
          />
        </motion.g>

        {/* Eyes */}
        <Eye cx={88} cy={118} blink={blink} gazeX={gazeX} gazeY={gazeY} />
        <Eye cx={132} cy={118} blink={blink} gazeX={gazeX} gazeY={gazeY} />

        {/* Nose */}
        <path
          d="M 110 122 Q 108 140 105 152 Q 110 156 115 152 Q 112 140 110 122 Z"
          fill="rgba(0,0,0,0.07)"
        />
        <path
          d="M 105 152 Q 110 158 115 152"
          fill="none"
          stroke="rgba(0,0,0,0.2)"
          strokeWidth="1"
          strokeLinecap="round"
        />
        {/* Nostril hints */}
        <ellipse cx="106" cy="155" rx="1.5" ry="1" fill="rgba(0,0,0,0.35)" />
        <ellipse cx="114" cy="155" rx="1.5" ry="1" fill="rgba(0,0,0,0.35)" />

        {/* Mouth — jaw shifts down on speaking */}
        <motion.g animate={{ y: jawDrop }} transition={{ duration: 0.08 }}>
          {/* Upper lip */}
          <path
            d="M 92 172
               Q 100 167 110 170
               Q 120 167 128 172
               Q 120 174 110 173
               Q 100 174 92 172 Z"
            fill="url(#lip)"
            stroke="#3b1716"
            strokeWidth="0.6"
          />
          {/* Mouth interior */}
          <ellipse
            cx="110"
            cy={173 + lipPart / 2}
            rx="13"
            ry={Math.max(0.6, lipPart)}
            fill="#1a0707"
          />
          {/* Lower lip */}
          <motion.path
            d={`M 92 ${173 + lipPart}
                Q 110 ${181 + lipPart * 1.2} 128 ${173 + lipPart}
                Q 120 ${178 + lipPart * 0.8} 110 ${178 + lipPart * 0.9}
                Q 100 ${178 + lipPart * 0.8} 92 ${173 + lipPart} Z`}
            fill="url(#lip)"
            stroke="#3b1716"
            strokeWidth="0.6"
          />
        </motion.g>

        {/* Chin shadow */}
        <ellipse
          cx="110"
          cy="190"
          rx="18"
          ry="5"
          fill="rgba(0,0,0,0.08)"
        />

        {/* Subtle face rim light */}
        <ellipse
          cx="110"
          cy="120"
          rx="55"
          ry="68"
          fill="none"
          stroke="rgba(255,220,180,0.12)"
          strokeWidth="1.4"
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
      <ellipse cx={cx} cy={cy} rx="9.5" ry="5.8" fill="#f8efe2" />
      {/* Sclera shadow under upper lid */}
      <ellipse
        cx={cx}
        cy={cy - 2}
        rx="9.5"
        ry="3"
        fill="rgba(0,0,0,0.18)"
      />
      {/* Iris */}
      <motion.circle
        cx={cx + gazeX}
        cy={cy + gazeY}
        r="4.6"
        fill="url(#iris)"
        animate={{
          cx: cx + gazeX,
          cy: cy + gazeY,
        }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
      {/* Pupil */}
      <circle cx={cx + gazeX} cy={cy + gazeY} r="2.2" fill="#0a0604" />
      {/* Catchlight */}
      <circle
        cx={cx + gazeX + 1.6}
        cy={cy + gazeY - 1.6}
        r="0.9"
        fill="#fff"
        opacity="0.95"
      />
      {/* Upper eyelid (blink) */}
      <motion.path
        d={`M ${cx - 10} ${cy - 5.5}
            Q ${cx} ${cy - 9.5} ${cx + 10} ${cy - 5.5}
            L ${cx + 10} ${cy + 5.5}
            Q ${cx} ${cy - 1.5} ${cx - 10} ${cy + 5.5} Z`}
        fill="url(#skin)"
        animate={{ scaleY: blink ? 1.4 : 0, opacity: blink ? 1 : 0 }}
        style={{ transformOrigin: `${cx}px ${cy - 5.5}px` }}
        transition={{ duration: 0.11 }}
      />
      {/* Lash line */}
      <path
        d={`M ${cx - 10} ${cy - 5.5} Q ${cx} ${cy - 9.5} ${cx + 10} ${cy - 5.5}`}
        fill="none"
        stroke="#1c120b"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* Lower eyelid line */}
      <path
        d={`M ${cx - 9} ${cy + 5.5} Q ${cx} ${cy + 7} ${cx + 9} ${cy + 5.5}`}
        fill="none"
        stroke="rgba(0,0,0,0.25)"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
    </g>
  );
}
