import { motion } from "framer-motion";
import { ArrowRight, Mic } from "lucide-react";
import { useState } from "react";

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
      className="h-screen w-screen flex flex-col items-center overflow-hidden bg-[#f8fafc]"
    >
      
      {/* --- UNIFIED BRAND STRIP --- */}
      <section className="w-full brand-strip panel-elevated border-b border-bg-border shrink-0">
        <div className="brand-row">
          
          {/* Left: IUL Logo */}
          <div className="brand-icon-wrap">
            <img
              src="/iul_logo.png"
              alt="IUL Logo"
              className="brand-icon"
            />
          </div>
          
          {/* Center: Title */}
          <div className="brand-copy">
            <div className="brand-label">IUL • HAICI</div>
            <h2 className="brand-heading">IUL Agent</h2>
            <p className="brand-subtitle">
              Premium robot assistant design for intelligent campus guidance.
            </p>
          </div>
          
          {/* Right: HAICI Logo */}
          <div className="brand-right-actions flex items-center gap-3 md:gap-5">
            <div className="brand-icon-wrap hidden sm:block">
              <img
                src="/haici_logo.png"
                alt="HAICI Logo"
                className="brand-icon"
              />
            </div>
          </div>

        </div>
      </section>
      {/* ---------------------------------------------------- */}

      {/* Main Content Area */}
      <div className="flex-1 w-full flex flex-col items-center justify-center p-8">

 {/* Mascot Avatar - Increased size for 'Hero' effect */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.1 }}
          className="mb-10"
        >
          <img 
            src="/mascot_avatar.png" 
            alt="IUL Agent Mascot"
            // Changed from w-48/h-48 to w-72/h-72 for that zoomed-in "Hero" look
            className="w-72 h-72 md:w-80 md:h-80 object-contain drop-shadow-2xl"
          />
        </motion.div>

        {/* CTA Button */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="flex flex-col items-center gap-3"
        >
          <button
            onClick={begin}
            className="group inline-flex items-center gap-3 px-8 py-4 rounded-xl
                       bg-teal-600 text-white font-semibold tracking-wide text-lg
                       hover:bg-teal-500 shadow-lg hover:shadow-xl transition-all hover:-translate-y-0.5"
          >
            <Mic className="w-5 h-5" />
            Begin Conversation
            <ArrowRight className="w-5 h-5 -mr-1 transition group-hover:translate-x-1" />
          </button>
          <div className="text-[12px] text-ink-500 tracking-widest uppercase mt-2">
            Press to start · the assistant will greet you
          </div>
        </motion.div>

      </div>
    </motion.div>
  );
}