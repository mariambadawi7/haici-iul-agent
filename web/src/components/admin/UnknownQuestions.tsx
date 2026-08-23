import { Fragment, useState } from "react";
import { Download, ChevronDown, Sparkles } from "lucide-react";
import type { UnknownQuestion } from "../../lib/adminApi";
import { downloadCsv, formatRelative, toCsv } from "../../lib/adminFormat";
import { EmptyState, Panel, PanelSkeleton } from "./ui";

interface Props {
  items: UnknownQuestion[];
  loading: boolean;
}

export default function UnknownQuestions({ items, loading }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  function exportCsv() {
    const csv = toCsv(
      items.map((q) => ({ ...q })),
      ["question", "count", "lastAsked", "sampleAnswer"],
    );
    downloadCsv("unknown-questions.csv", csv);
  }

  return (
    <Panel
      title="Unknown / Unanswered Questions"
      subtitle="What the assistant couldn't answer — the content-gap worklist for shared_docs/."
      action={
        <button
          type="button"
          onClick={exportCsv}
          disabled={items.length === 0}
          className="btn-ghost !py-1.5 !px-3 text-xs inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      }
    >
      {loading ? (
        <PanelSkeleton rows={4} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No unknown questions yet"
          hint="The assistant has answered everything it's been asked in this range. Nice."
          icon={<Sparkles className="w-6 h-6" />}
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
                    className="border-b border-slate-100 hover:bg-amber-50/40 cursor-pointer"
                    onClick={() => setExpanded(expanded === i ? null : i)}
                  >
                    <td className="px-2 py-2.5 text-slate-800" dir="auto">
                      {q.question}
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
                          Answer given:
                        </div>
                        <div
                          className="text-sm text-slate-600 italic"
                          dir="auto"
                        >
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
