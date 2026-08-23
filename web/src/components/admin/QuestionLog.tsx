import { Fragment, useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import type { AdminClient, LogFilter, LogRow } from "../../lib/adminApi";
import { downloadCsv, formatDateTime, formatMs, toCsv } from "../../lib/adminFormat";
import { Badge, EmptyState, ErrorState, Panel, PanelSkeleton } from "./ui";

interface Props {
  client: AdminClient;
  passcode: string;
}

const FILTERS: { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unknown", label: "Unknown" },
  { value: "voice", label: "Voice" },
  { value: "text", label: "Text" },
  { value: "cache_hit", label: "Cache hit" },
  { value: "fresh", label: "Fresh" },
];

const PAGE_SIZE = 50;

export default function QuestionLog({ client, passcode }: Props) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<LogFilter>("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Any filter/search change resets to page 1.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filter]);

  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    client
      .fetchLog(
        passcode,
        { search: debouncedSearch, filter, page, pageSize: PAGE_SIZE },
        ctl.signal,
      )
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((err: any) => {
        if (cancelled || err?.name === "AbortError") return;
        setError(err?.message || "Failed to load the Q&A log.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, passcode, debouncedSearch, filter, page, reloadTick]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function exportCsv() {
    const csv = toCsv(
      rows.map((r) => ({
        ...r,
        timestamp: formatDateTime(r.timestamp),
      })),
      [
        "id",
        "timestamp",
        "question",
        "answer",
        "inputType",
        "matchType",
        "isUnknown",
        "intent",
        "language",
        "latencyMs",
        "sessionId",
        "respondedWithAudio",
      ],
    );
    downloadCsv(`qa-log-page-${page}.csv`, csv);
  }

  return (
    <Panel
      title="Full Q&A Log"
      subtitle="Searchable, filterable history of every turn."
      action={
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="btn-ghost !py-1.5 !px-3 text-xs inline-flex items-center gap-1.5 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          Export page CSV
        </button>
      }
    >
      <div className="flex flex-col sm:flex-row gap-2.5 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search question or answer…"
            className="input !pl-9 !py-2"
            dir="auto"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                filter === f.value
                  ? "bg-teal-50 border-teal-300 text-teal-700"
                  : "bg-surface border-slate-200 text-slate-500 hover:border-slate-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <PanelSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setReloadTick((t) => t + 1)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matching rows"
          hint={
            search || filter !== "all"
              ? "Try clearing the search or filter."
              : "No turns have been logged yet."
          }
        />
      ) : (
        <>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                  <th className="px-2 py-2 font-medium w-32">Time</th>
                  <th className="px-2 py-2 font-medium">Question</th>
                  <th className="px-2 py-2 font-medium w-20">Type</th>
                  <th className="px-2 py-2 font-medium w-20">Match</th>
                  <th className="px-2 py-2 font-medium w-20">Latency</th>
                  <th className="px-2 py-2 font-medium w-16" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={`border-b border-slate-100 cursor-pointer ${
                        r.isUnknown ? "bg-amber-50/30 hover:bg-amber-50/60" : "hover:bg-slate-50"
                      }`}
                      onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    >
                      <td className="px-2 py-2.5 text-slate-400 text-xs whitespace-nowrap">
                        {formatDateTime(r.timestamp)}
                      </td>
                      <td className="px-2 py-2.5 text-slate-800 max-w-[28rem] truncate" dir="auto">
                        {r.intent === "greeting" ? (
                          <span className="text-slate-400 italic">{r.question}</span>
                        ) : (
                          r.question
                        )}
                        {r.isUnknown && (
                          <Badge tone="amber">
                            <span className="ml-0">unknown</span>
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone={r.inputType === "audio" ? "violet" : "slate"}>
                          {r.inputType}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5">
                        <Badge tone={r.matchType === "cache_hit" ? "teal" : "slate"}>
                          {r.matchType}
                        </Badge>
                      </td>
                      <td className="px-2 py-2.5 text-slate-500 text-xs tabular-nums">
                        {formatMs(r.latencyMs)}
                      </td>
                      <td className="px-2 py-2.5 text-slate-300">
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${
                            expanded === r.id ? "rotate-180" : ""
                          }`}
                        />
                      </td>
                    </tr>
                    {expanded === r.id && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={6} className="px-2 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <div className="text-xs text-slate-400 mb-1">Question</div>
                              <div className="text-sm text-slate-700" dir="auto">
                                {r.question || "(empty)"}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-slate-400 mb-1">Answer</div>
                              <div className="text-sm text-slate-700" dir="auto">
                                {r.answer || "(empty)"}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-slate-400">
                            <span>Intent: {r.intent}</span>
                            <span>Language: {r.language}</span>
                            <span>Audio reply: {r.respondedWithAudio ? "yes" : "no"}</span>
                            <span>Session: {r.sessionId ?? "—"}</span>
                            <span>Id: {r.id}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-4 text-xs text-slate-500">
            <span>
              {total} row{total === 1 ? "" : "s"} · page {page} of {pageCount}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="btn-icon !w-8 !h-8 disabled:opacity-30"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                disabled={page >= pageCount}
                className="btn-icon !w-8 !h-8 disabled:opacity-30"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}
