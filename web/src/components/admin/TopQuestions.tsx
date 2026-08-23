import { Fragment, useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import type { TopQuestion } from "../../lib/adminApi";
import { formatRelative } from "../../lib/adminFormat";
import { Badge, EmptyState, Panel, PanelSkeleton } from "./ui";

interface Props {
  items: TopQuestion[];
  loading: boolean;
}

export default function TopQuestions({ items, loading }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <Panel
      title="Most Asked Questions"
      subtitle="Ranked by frequency. Greetings and small talk are excluded."
    >
      {loading ? (
        <PanelSkeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No questions yet"
          hint="Once visitors start asking questions, the most-asked ranking will show up here."
          icon={<ListChecks className="w-6 h-6" />}
        />
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                <th className="px-2 py-2 font-medium">Question</th>
                <th className="px-2 py-2 font-medium w-16 text-right">Count</th>
                <th className="px-2 py-2 font-medium w-28">Last Asked</th>
                <th className="px-2 py-2 font-medium w-8" />
              </tr>
            </thead>
            <tbody>
              {items.map((q, i) => (
                <Fragment key={i}>
                  <tr
                    className="border-b border-slate-100 hover:bg-teal-50/40 cursor-pointer"
                    onClick={() => setExpanded(expanded === i ? null : i)}
                  >
                    <td className="px-2 py-2.5 text-slate-800" dir="auto">
                      <div className="flex items-center gap-2">
                        <span>{q.question}</span>
                        {q.unknownCount > 0 && (
                          <Badge tone="amber">{q.unknownCount} unknown</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-right text-slate-500 tabular-nums">
                      {q.count}
                    </td>
                    <td className="px-2 py-2.5 text-slate-400 text-xs">
                      {formatRelative(q.lastAsked)}
                    </td>
                    <td className="px-2 py-2.5 text-slate-300">
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${
                          expanded === i ? "rotate-180" : ""
                        }`}
                      />
                    </td>
                  </tr>
                  {expanded === i && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={4} className="px-2 py-3">
                        <div className="text-xs text-slate-400 mb-1">
                          Sample answer:
                        </div>
                        <div className="text-sm text-slate-600" dir="auto">
                          {q.sampleAnswer || "(empty answer)"}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
