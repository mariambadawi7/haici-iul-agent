import { AlertTriangle, CheckCircle2, Loader2, RotateCw } from "lucide-react";
import type { HealthState } from "../lib/health";

interface Props {
  health: HealthState;
  onRecheck: () => void;
}

export default function HealthBanner({ health, onRecheck }: Props) {
  if (health.status === "ok") return null;
  if (health.status === "checking") {
    return (
      <div className="px-4 py-2 text-xs text-ink-300 bg-bg-elevated/60 border-b border-bg-border flex items-center justify-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking connection to the workflow…
      </div>
    );
  }
  return (
    <div className="px-4 py-2 text-xs text-amber-200 bg-amber-500/10 border-b border-amber-500/30 flex items-center justify-center gap-3">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
      <span className="leading-snug">{health.reason}</span>
      <button
        onClick={onRecheck}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-300/40 hover:bg-amber-500/15 transition"
      >
        <RotateCw className="w-3 h-3" />
        Recheck
      </button>
    </div>
  );
}

export function HealthDot({ health }: { health: HealthState }) {
  if (health.status === "checking") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-ink-500">
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
        checking
      </span>
    );
  }
  if (health.status === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-emerald-400/80">
        <CheckCircle2 className="w-2.5 h-2.5" />
        online
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-amber-400/90">
      <AlertTriangle className="w-2.5 h-2.5" />
      offline
    </span>
  );
}
