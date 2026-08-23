import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DayBucket, RangeOption } from "../../lib/adminApi";
import { formatDate } from "../../lib/adminFormat";
import { chartColors, EmptyState, Panel, Skeleton } from "./ui";

interface Props {
  byDay: DayBucket[];
  range: RangeOption;
  onRangeChange: (range: RangeOption) => void;
  loading: boolean;
}

const RANGES: { value: RangeOption; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

export default function VolumeChart({ byDay, range, onRangeChange, loading }: Props) {
  const total = byDay.reduce((s, d) => s + d.count, 0);
  const C = chartColors();

  return (
    <Panel
      title="Volume Over Time"
      subtitle="Daily totals with unknown answers overlaid."
      action={
        <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => onRangeChange(r.value)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-all ${
                range === r.value
                  ? "bg-surface text-teal-700 shadow-sm border border-slate-200"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : total === 0 ? (
        <EmptyState
          title="No volume in this range"
          hint="Try a wider range, or check back once more turns have been logged."
        />
      ) : (
        <div className="h-64 -ml-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={byDay} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="volTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.brandMid} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={C.brandMid} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="volUnknown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={C.warnMid} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={C.warnMid} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={C.grid} />
              <XAxis
                dataKey="day"
                tickFormatter={(d) => formatDate(d)}
                tick={{ fontSize: 10, fill: C.axis }}
                axisLine={{ stroke: C.grid }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 10, fill: C.axis }}
                axisLine={false}
                tickLine={false}
                width={28}
              />
              <Tooltip
                labelFormatter={(d) => formatDate(d as string)}
                contentStyle={{
                  borderRadius: 12,
                  border: `1px solid ${C.grid}`,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="count"
                name="Total"
                stroke={C.brandDeep}
                strokeWidth={2}
                fill="url(#volTotal)"
              />
              <Area
                type="monotone"
                dataKey="unknown"
                name="Unknown"
                stroke={C.warnDeep}
                strokeWidth={2}
                fill="url(#volUnknown)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}
