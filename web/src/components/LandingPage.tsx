import { motion } from "framer-motion";
import { ArrowRight, Mic } from "lucide-react";
import { useState } from "react";
import AnimatedFace from "./AnimatedFace";
import { config } from "../lib/api";

interface Props {
  onBegin: () => void;
}

export default function LandingPage({ onBegin }: Props) {
  const [leaving, setLeaving] = useState(false);

  const begin = () => {
    if (leaving) return;
    setLeaving(true);
    // Brief delay so the fade-out plays before the chat mounts.
    setTimeout(onBegin, 450);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 0.97 : 1 }}
      transition={{ duration: 0.45, ease: "easeInOut" }}
      className="h-screen w-screen flex flex-col items-center justify-between px-8 py-10 overflow-hidden"
    >
      {/* Top crest with both logos */}
      <div className="w-full flex items-center justify-between max-w-5xl">
        <LogoBlock
          src={config.logoLeft}
          fallback="C"
          line1="Research Center"
          line2="Center for Studies"
        />
        <div className="text-center">
          <div className="badge-serif">Anno · MMXXVI</div>
        </div>
        <LogoBlock
          src={config.logoRight}
          fallback="IUL"
          line1="Islamic University"
          line2="of Lebanon"
          align="right"
        />
      </div>

      {/* Center hero */}
      <div className="flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="mb-6"
        >
          <div className="badge-serif">Multimodal Assistant</div>
          <h1 className="font-serif text-5xl md:text-6xl text-ink-100 mt-3 leading-tight">
            {config.title}
          </h1>
          <div className="mx-auto mt-3 w-32 divider-gold" />
          <p className="font-serif italic text-ink-300 mt-4 text-base max-w-xl">
            A guide to the faculties, campuses, history, and accreditation
            of the Islamic University of Lebanon — by voice or by text.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <AnimatedFace state="idle" />
        </motion.div>
      </div>

      {/* CTA */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.45 }}
        className="flex flex-col items-center gap-3"
      >
        <button
          onClick={begin}
          className="group inline-flex items-center gap-3 px-8 py-3.5 rounded-md
                     bg-accent text-bg-base font-semibold tracking-wide
                     hover:bg-accent-glow shadow-glow-strong transition"
        >
          <Mic className="w-5 h-5" />
          Begin Conversation
          <ArrowRight className="w-4 h-4 -mr-1 transition group-hover:translate-x-1" />
        </button>
        <div className="text-[11px] text-ink-500 tracking-widest uppercase">
          Press to start · the assistant will greet you
        </div>
      </motion.div>
    </motion.div>
  );
}

function LogoBlock({
  src,
  fallback,
  line1,
  line2,
  align,
}: {
  src: string;
  fallback: string;
  line1: string;
  line2: string;
  align?: "right";
}) {
  const right = align === "right";
  return (
    <div className={`flex items-center gap-3 ${right ? "flex-row-reverse" : ""}`}>
      {src ? (
        <img src={src} alt="" className="h-14 w-14 object-contain" />
      ) : (
        <div className="h-14 w-14 rounded-sm border border-accent/40 bg-gradient-to-br from-bg-elevated to-bg-panel grid place-items-center">
          <span className="font-serif text-accent text-lg italic">{fallback}</span>
        </div>
      )}
      <div className={`leading-tight ${right ? "text-right" : ""}`}>
        <div className="badge-serif">{line1}</div>
        <div className="text-sm font-serif text-ink-100 mt-0.5">{line2}</div>
      </div>
    </div>
  );
}
