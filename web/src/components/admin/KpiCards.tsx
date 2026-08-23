import {
  MessagesSquare,
  Sparkles,
  Users,
  HelpCircle,
  Zap,
  Clock,
  Gauge,
  Mic,
} from "lucide-react";
import type { OverviewKpis } from "../../lib/adminApi";
import {
  formatDecimal,
  formatMs,
  formatNumber,
  formatPercent,
} from "../../lib/adminFormat";
import { Skeleton } from "./ui";

interface Props {
  kpis: OverviewKpis | null;
  loading: boolean;
}

interface Kpi {
  label: string;
  value: string;
  hint?: string;
  icon: typeof MessagesSquare;
}

export default function KpiCards({ kpis, loading }: Props) {
  const cards: Kpi[] = kpis
    ? [
        {
          label: "Total Questions",
          value: formatNumber(kpis.totalQuestions),
          icon: MessagesSquare,
        },
        {
          label: "Unique Questions",
          value: formatNumber(kpis.uniqueQuestions),
          icon: Sparkles,
        },
        {
          label: "Sessions",
          value: formatNumber(kpis.sessions),
          hint: `${formatDecimal(kpis.avgQuestionsPerSession)} q/session`,
          icon: Users,
        },
        {
          label: "Unknown Rate",
          value: formatPercent(kpis.unknownRate),
          hint: `${formatNumber(kpis.unknownCount)} unanswered`,
          icon: HelpCircle,
        },
        {
          label: "Cache Hit Rate",
          value: formatPercent(kpis.cacheHitRate),
          icon: Zap,
        },
        {
          label: "Avg Latency",
          value: formatMs(kpis.avgLatencyMs),
          hint: `p95 ${formatMs(kpis.p95LatencyMs)}`,
          icon: Clock,
        },
        {
          label: "Voice Share",
          value: formatPercent(kpis.voiceShare),
          hint: `${formatPercent(kpis.audioReplyShare)} audio replies`,
          icon: Mic,
        },
        {
          label: "Active Days",
          value: formatNumber(kpis.activeDays),
          icon: Gauge,
        },
      ]
    : [];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
      {loading &&
        Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="panel rounded-2xl border border-slate-200/80 bg-surface p-4"
          >
            <Skeleton className="h-3 w-20 mb-3" />
            <Skeleton className="h-6 w-14" />
          </div>
        ))}
      {!loading &&
        cards.map((c) => (
          <div
            key={c.label}
            className="panel rounded-2xl border border-slate-200/80 bg-surface p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="badge-serif !text-[10px]">{c.label}</span>
              <c.icon className="w-3.5 h-3.5 text-teal-500/70" />
            </div>
            <div className="text-2xl font-serif text-slate-900 leading-none">
              {c.value}
            </div>
            {c.hint && (
              <div className="text-[11px] text-slate-400 mt-1.5">{c.hint}</div>
            )}
          </div>
        ))}
    </div>
  );
}
