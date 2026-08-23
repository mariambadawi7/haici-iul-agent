import { motion } from "framer-motion";
import { ArrowRight, Mic, MessageSquare } from "lucide-react";
import { useState } from "react";
import BrandStrip, { BrandFooter } from "./BrandStrip";
import { useTenant } from "../lib/branding/context";

interface Props {
  onBegin: () => void;
}

export default function LandingPage({ onBegin }: Props) {
  const { identity, avatar, features } = useTenant();
  const [leaving, setLeaving] = useState(false);

  const begin = () => {
    if (leaving) return;
    setLeaving(true);
    // Brief delay so the fade-out plays before the chat mounts.
    setTimeout(onBegin, 450);
  };

  // The hero image is the tenant's still avatar. A tenant running without one
  // (or with the avatar feature switched off) simply gets a tighter layout.
  const hero = features.avatar ? avatar.imageUrl : "";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 0.97 : 1 }}
      transition={{ duration: 0.45, ease: "easeInOut" }}
      className="h-screen w-screen flex flex-col items-center overflow-hidden bg-surface"
    >
      <BrandStrip className="w-full" />

      <div className="flex-1 w-full flex flex-col items-center justify-center p-8">
        {hero && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            className="mb-10"
          >
            <img
              src={hero}
              alt={`${identity.name} mascot`}
              className="w-72 h-72 md:w-80 md:h-80 object-contain drop-shadow-2xl"
            />
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="flex flex-col items-center gap-3"
        >
          <button
            onClick={begin}
            className="group inline-flex items-center gap-3 px-8 py-4 rounded-xl
                       bg-brand-600 text-on-brand font-semibold tracking-wide text-lg
                       hover:bg-brand-500 shadow-lg hover:shadow-xl transition-all hover:-translate-y-0.5"
          >
            {features.voice ? (
              <Mic className="w-5 h-5" />
            ) : (
              <MessageSquare className="w-5 h-5" />
            )}
            Begin Conversation
            <ArrowRight className="w-5 h-5 -mr-1 transition group-hover:translate-x-1" />
          </button>
          <div className="text-[12px] text-ink-500 tracking-widest uppercase mt-2">
            {features.voice
              ? "Press to start · the assistant will greet you"
              : "Press to start · type your first question"}
          </div>
        </motion.div>
      </div>

      <BrandFooter />
    </motion.div>
  );
}
