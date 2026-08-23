import { Fragment } from "react";
import type { HeatmapCell } from "../../lib/adminApi";
import { EmptyState, Panel, Skeleton } from "./ui";

interface Props {
  cells: HeatmapCell[];
  loading: boolean;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function intensity(count: number, max: number): string {
  if (count === 0) return "rgba(148, 163, 184, 0.08)";
  const t = max > 0 ? count / max : 0;
  // Interpolate from a pale to a deep teal.
  const alpha = 0.15 + t * 0.75;
  return `rgba(15, 118, 110, ${alpha.toFixed(2)})`;
}

export default function UsageHeatmap({ cells, loading }: Props) {
  // Zero-fill client-side, per spec — backend sends the sparse array.
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of cells) {
    if (c.weekday >= 0 && c.weekday < 7 && c.hour >= 0 && c.hour < 24) {
      grid[c.weekday][c.hour] += c.count;
    }
  }
  const max = Math.max(0, ...grid.flat());

  return (
    <Panel
      title="Usage Heatmap"
      subtitle="Weekday × hour, Asia/Beirut. Darker = busier."
    >
      {loading ? (
        <Skeleton className="h-56 w-full" />
      ) : max === 0 ? (
        <EmptyState title="No activity recorded yet" />
      ) : (
        <div className="overflow-x-auto">
          <div className="inline-block min-w-full">
            <div
              className="grid gap-[3px]"
              style={{ gridTemplateColumns: `32px repeat(24, minmax(14px, 1fr))` }}
            >
              <div />
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="text-[9px] text-slate-400 text-center"
                >
                  {h % 3 === 0 ? h : ""}
                </div>
              ))}
              {WEEKDAY_SHORT.map((label, w) => (
                <Fragment key={label}>
                  <div className="text-[10px] text-slate-500 flex items-center pr-1">
                    {label}
                  </div>
                  {HOURS.map((h) => {
                    const count = grid[w][h];
                    return (
                      <div
                        key={`${w}-${h}`}
                        title={`${label} ${h}:00 — ${count} question${count === 1 ? "" : "s"}`}
                        className="aspect-square rounded-[3px]"
                        style={{ backgroundColor: intensity(count, max) }}
                      />
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
