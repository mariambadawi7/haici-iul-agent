import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cssColor } from "../../lib/branding/theme";

/** Shared visual atoms for the admin dashboard, matching the kiosk's
 *  Tailwind language (surface panels, neutral borders, serif headings, brand
 *  accent, badge-serif uppercase labels). Every colour resolves through the
 *  tenant theme variables, so the dashboard rebrands along with the app. */

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`panel rounded-2xl border border-slate-200/80 bg-surface p-5 md:p-6 ${className}`}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="font-serif text-lg text-slate-900">{title}</h3>
          {subtitle && (
            <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/60">
      {icon && <div className="text-slate-300 mb-2">{icon}</div>}
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint && <p className="text-xs text-slate-400 mt-1 max-w-sm">{hint}</p>}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-xl border border-red-200 bg-red-50/60">
      <AlertTriangle className="w-5 h-5 text-red-400 mb-2" />
      <p className="text-sm font-medium text-red-700">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="btn-ghost mt-3 !py-1.5 !px-3 text-xs inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-slate-100 ${className}`}
      aria-hidden="true"
    />
  );
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function Badge({
  tone = "slate",
  children,
}: {
  tone?: "slate" | "teal" | "amber" | "red" | "violet";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    teal: "bg-teal-50 text-teal-700 border-teal-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Concrete colours for Recharts.
 *
 * Recharts emits its colours as SVG presentation attributes, which never
 * resolve a `var()` reference — so charts have to read the computed theme
 * values instead of pointing at the variables. Call this during render (not at
 * module scope) so the values reflect whatever theme is currently applied.
 */
export function chartColors() {
  return {
    grid: cssColor("neutral-200"),
    axis: cssColor("neutral-400"),
    brandDeep: cssColor("brand-700"),
    brandMid: cssColor("brand-500"),
    brandPale: cssColor("brand-200"),
    brandFaint: cssColor("brand-500", 0.08),
    warnDeep: cssColor("warn-600"),
    warnMid: cssColor("warn-500"),
  };
}
