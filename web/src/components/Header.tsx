import { Home } from "lucide-react";
import { config } from "../lib/api";
import { HealthDot } from "./HealthBanner";
import type { HealthState } from "../lib/health";

interface Props {
  onHome?: () => void;
  health?: HealthState;
}

export default function Header({ onHome, health }: Props) {
  return (
    <header className="relative z-10 panel border-b">
      <div className="flex items-center justify-between px-6 py-4">
        {/* Left — Center logo */}
        <div className="flex items-center gap-3 min-w-[220px]">
          {config.logoLeft ? (
            <img
              src={config.logoLeft}
              alt="Center logo"
              className="h-12 w-12 object-contain"
            />
          ) : (
            <div className="h-12 w-12 rounded-sm border border-accent/40 bg-gradient-to-br from-bg-elevated to-bg-panel grid place-items-center">
              <span className="font-serif text-accent text-xl italic">C</span>
            </div>
          )}
          <div className="leading-tight">
            <div className="badge-serif">Research Center</div>
            <div className="text-sm font-serif text-ink-100 mt-0.5">
              Center for Studies
            </div>
          </div>
        </div>

        {/* Middle — title */}
        <div className="flex flex-col items-center">
          <div className="badge-serif mb-1">Anno · MMXXVI</div>
          <h1 className="text-2xl font-serif text-ink-100 leading-none">
            {config.title}
          </h1>
          <div className="mt-2 w-24 divider-gold" />
          <div className="text-[11px] uppercase tracking-[0.32em] text-ink-500 mt-1 flex items-center gap-2">
            <span>Multimodal Assistant</span>
            {health && (
              <>
                <span className="opacity-50">·</span>
                <HealthDot health={health} />
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 min-w-[120px] justify-end">
          {onHome && (
            <button
              onClick={onHome}
              className="btn-icon text-slate-700 bg-slate-100/90 border-slate-200/80"
              title="Back to welcome screen"
              type="button"
            >
              <Home className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
      <div className="divider-gold" />
    </header>
  );
}
