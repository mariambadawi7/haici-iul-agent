import type {
  InputTypeBucket,
  LanguageBucket,
  MatchTypeBucket,
} from "../../lib/adminApi";
import { EmptyState, Panel, Skeleton } from "./ui";

interface Props {
  byLanguage: LanguageBucket[];
  byInputType: InputTypeBucket[];
  byMatchType: MatchTypeBucket[];
  loading: boolean;
}

const LANGUAGE_LABELS: Record<string, string> = { en: "English", ar: "Arabic" };
const INPUT_TYPE_LABELS: Record<string, string> = { text: "Text", audio: "Voice" };
const MATCH_TYPE_LABELS: Record<string, string> = {
  fresh: "Fresh",
  cache_hit: "Cache hit",
};

function BarList({
  items,
  labels,
}: {
  items: { key: string; count: number }[];
  labels: Record<string, string>;
}) {
  const total = items.reduce((s, i) => s + i.count, 0);
  if (total === 0) {
    return <EmptyState title="No data yet" />;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.key}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-600">{labels[i.key] ?? i.key}</span>
            <span className="text-slate-400 tabular-nums">
              {i.count} ({total > 0 ? Math.round((i.count / total) * 100) : 0}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full bg-teal-500/80"
              style={{ width: `${(i.count / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Breakdowns({
  byLanguage,
  byInputType,
  byMatchType,
  loading,
}: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
      <Panel title="Language">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <BarList
            items={byLanguage.map((l) => ({ key: l.language, count: l.count }))}
            labels={LANGUAGE_LABELS}
          />
        )}
      </Panel>
      <Panel title="Input Type">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <BarList
            items={byInputType.map((t) => ({ key: t.inputType, count: t.count }))}
            labels={INPUT_TYPE_LABELS}
          />
        )}
      </Panel>
      <Panel title="Match Type">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <BarList
            items={byMatchType.map((t) => ({ key: t.matchType, count: t.count }))}
            labels={MATCH_TYPE_LABELS}
          />
        )}
      </Panel>
    </div>
  );
}
