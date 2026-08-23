import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HourBucket } from "../../lib/adminApi";
import { formatHour } from "../../lib/adminFormat";
import { chartColors, EmptyState, Panel, Skeleton } from "./ui";

interface Props {
  byHour: HourBucket[];
  busiestHour: number | null;
  loading: boolean;
}

export default function PeakHoursChart({ byHour, busiestHour, loading }: Props) {
  const total = byHour.reduce((s, b) => s + b.count, 0);
  const C = chartColors();

  return (
    <Panel
      title="Peak Hours"
      subtitle="Questions by hour of day — Asia/Beirut."
    >
      {loading ? (
        <Skeleton className="h-56 w-full" />
      ) : total === 0 ? (
        <EmptyState title="No activity recorded yet" />
      ) : (
        <>
          <div className="h-56 -ml-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byHour} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={C.grid} />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h) => String(h)}
                  tick={{ fontSize: 10, fill: C.axis }}
                  axisLine={{ stroke: C.grid }}
                  tickLine={false}
                  interval={1}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: C.axis }}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <Tooltip
                  cursor={{ fill: C.brandFaint }}
                  formatter={(value: number) => [value, "Questions"]}
                  labelFormatter={(h) => formatHour(h as number)}
                  contentStyle={{
                    borderRadius: 12,
                    border: `1px solid ${C.grid}`,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {byHour.map((b) => (
                    <Cell
                      key={b.hour}
                      fill={b.hour === busiestHour ? C.brandDeep : C.brandPale}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {busiestHour !== null && (
            <p className="text-xs text-slate-500 mt-2">
              Busiest hour:{" "}
              <span className="font-medium text-teal-700">
                {formatHour(busiestHour)}
              </span>
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
