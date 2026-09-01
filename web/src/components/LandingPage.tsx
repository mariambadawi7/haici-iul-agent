import { motion } from "framer-motion";
import { ArrowRight, Mic, MessageSquare } from "lucide-react";
import { useState } from "react";
import BrandStrip, { BrandFooter } from "./BrandStrip";
import Mascot2D from "./Mascot2D";
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

  // The hero is the tenant's avatar at rest: the mascot idles and blinks for
  // real, everyone else gets their still artwork. A tenant running without
  // either (or with the avatar feature switched off) gets a tighter layout.
  const showMascot = features.avatar && avatar.kind === "mascot";
  const hero = features.avatar && !showMascot ? avatar.imageUrl : "";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 0.97 : 1 }}
      transition={{ duration: 0.45, ease: "easeInOut" }}
      className="h-screen w-screen flex flex-col items-center overflow-hidden bg-surface"
    >
      <BrandStrip className="w-full" />

      {/* overflow-y-auto is a safety net, not the primary fix: the hero
          is sized in vh precisely so this content fits without scrolling
          on any realistic window. It only engages on a window shorter than
          a phone in landscape. */}
      <div className="flex-1 w-full min-h-0 flex flex-col items-center justify-center gap-4 md:gap-8 p-4 md:p-8 overflow-y-auto">
        {(showMascot || hero) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            // Viewport-relative, not a fixed rem height: a full-body mascot is
            // tall and narrow, and on a short window (a laptop's browser chrome
            // eating into it, or this app embedded in a small pane) a fixed
            // size can grow past the space the button below needs. Capped at
            // both ends so it neither vanishes nor towers on a tall display.
            className="h-[clamp(8rem,30vh,18rem)] md:h-[clamp(10rem,34vh,22rem)] shrink-0"
          >
            {showMascot ? (
              <Mascot2D state="idle" view="full" className="h-full drop-shadow-2xl" />
            ) : (
              <img
                src={hero}
                alt={`${identity.name} mascot`}
                className="h-full w-auto max-w-[70vw] object-contain drop-shadow-2xl"
              />
            )}
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
