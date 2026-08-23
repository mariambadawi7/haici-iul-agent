/**
 * Editor for the speech-to-text "typo lexicon" — the JSON blob at Postgres
 * `admin_settings.typo_lexicon` that the live Agent Workflow reads on every
 * turn to repair mis-transcribed domain terms (e.g. Groq Whisper hearing
 * "IOM" and mapping it back to "IUL").
 *
 * Two tiers, and the UI has to make the difference obvious:
 *  - `aliases` are exact mis-hearings, always corrected silently. This is
 *    the ONLY mechanism that works for a short acronym — Levenshtein
 *    distance can't tell a 2-edit acronym typo from an unrelated short
 *    word, so short tokens are never fuzzy-matched no matter what `fuzzy`
 *    says on the term.
 *  - `fuzzy: true` additionally enables approximate matching, but only for
 *    spoken tokens >= thresholds.minFuzzyLen characters.
 *
 * Validation is mirrored client-side for instant feedback, but the server's
 * `Validate Lexicon` node is the authority — a save can still come back
 * with a 400 naming the offending term, which is surfaced inline here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  AdminClient,
  ClarifyRow,
  CorrectionStat,
  Lexicon,
  LexiconTerm,
  LexiconThresholds,
} from "../../lib/adminApi";
import { AdminValidationError } from "../../lib/adminApi";
import { formatDateTime } from "../../lib/adminFormat";
import { Badge, EmptyState, ErrorState, Panel, PanelSkeleton } from "./ui";

interface Props {
  client: AdminClient;
  passcode: string;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; termIndex?: number };

interface LocalIssue {
  message: string;
  termIndex?: number;
}

const EMPTY_THRESHOLDS: LexiconThresholds = {
  autoApply: 0.86,
  clarify: 0.72,
  gap: 0.08,
  minFuzzyLen: 5,
};

function cloneLexicon(l: Lexicon): Lexicon {
  return {
    version: l.version,
    updatedAt: l.updatedAt,
    thresholds: { ...l.thresholds },
    stoplist: [...l.stoplist],
    terms: l.terms.map((t) => ({ ...t, aliases: [...t.aliases] })),
  };
}

/** Client-side mirror of the server's `Validate Lexicon` node. Catches the
 *  same shape of mistakes before a round trip, but never replaces it —
 *  the server re-validates from scratch on save. */
function validateLocal(terms: LexiconTerm[], thresholds: LexiconThresholds): LocalIssue | null {
  const seenCanonical = new Map<string, string>();
  const seenAlias = new Map<string, string>();

  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    const canonical = t.canonical.trim();
    if (!canonical) {
      return { message: `Term #${i + 1} needs a canonical name.`, termIndex: i };
    }
    const canonKey = canonical.toLowerCase();
    if (seenCanonical.has(canonKey)) {
      return {
        message: `Duplicate canonical term "${canonical}" (also used by "${seenCanonical.get(canonKey)}").`,
        termIndex: i,
      };
    }
    seenCanonical.set(canonKey, canonical);

    for (const a of t.aliases) {
      const alias = a.trim();
      if (!alias) {
        return { message: `Term "${canonical}" has an empty alias.`, termIndex: i };
      }
      const aliasKey = alias.toLowerCase();
      const owner = seenAlias.get(aliasKey);
      if (owner && owner !== canonical) {
        return {
          message: `Alias "${alias}" is already used by "${owner}" — aliases must be unique across all terms.`,
          termIndex: i,
        };
      }
      seenAlias.set(aliasKey, canonical);
    }
  }

  if (!(thresholds.autoApply > 0 && thresholds.autoApply <= 1)) {
    return { message: "Auto-apply threshold must be a number in (0, 1]." };
  }
  if (!(thresholds.clarify > 0 && thresholds.clarify <= 1)) {
    return { message: "Clarify threshold must be a number in (0, 1]." };
  }
  if (!(thresholds.autoApply > thresholds.clarify)) {
    return { message: "Auto-apply threshold must be greater than the clarify threshold." };
  }
  if (!(thresholds.gap >= 0 && thresholds.gap <= 1)) {
    return { message: "Gap threshold must be a number in [0, 1]." };
  }
  if (!Number.isInteger(thresholds.minFuzzyLen) || thresholds.minFuzzyLen < 3) {
    return { message: "Minimum fuzzy length must be a whole number >= 3." };
  }
  return null;
}

/** Best-effort extraction of the canonical the assistant guessed at in a
 *  "did you mean X?" clarify reply. There's no structured field for it —
 *  `raw_question` and `question` are identical on a clarify row, since no
 *  correction was actually applied — so this is a heuristic starting point
 *  for the admin, not a guaranteed match. */
function guessCandidateFromAnswer(answer: string | null): string | null {
  if (!answer) return null;
  const m = answer.match(/did you mean\s+([^?]+)\?/i);
  return m ? m[1].trim() : null;
}

export default function LexiconEditor({ client, passcode }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [saved, setSaved] = useState<Lexicon | null>(null);
  const [version, setVersion] = useState(1);
  const [thresholds, setThresholds] = useState<LexiconThresholds>(EMPTY_THRESHOLDS);
  const [stoplist, setStoplist] = useState<string[]>([]);
  const [terms, setTerms] = useState<LexiconTerm[]>([]);

  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [aliasDrafts, setAliasDrafts] = useState<Record<number, string>>({});

  const [corrections, setCorrections] = useState<{
    topPairs: CorrectionStat[];
    clarifications: ClarifyRow[];
  } | null>(null);
  const [correctionsLoading, setCorrectionsLoading] = useState(true);
  const [correctionsError, setCorrectionsError] = useState<string | null>(null);
  const [clarifyDrafts, setClarifyDrafts] = useState<Record<number, string>>({});
  const [flash, setFlash] = useState<string | null>(null);

  // -- load -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .fetchLexicon(passcode)
      .then((data) => {
        if (cancelled) return;
        const clone = cloneLexicon(data);
        setSaved(clone);
        setVersion(clone.version);
        setThresholds(clone.thresholds);
        setStoplist(clone.stoplist);
        setTerms(clone.terms);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setLoadError(err?.message || "Failed to load the typo lexicon.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, passcode, reloadTick]);

  useEffect(() => {
    let cancelled = false;
    setCorrectionsLoading(true);
    setCorrectionsError(null);
    client
      .fetchCorrections(passcode, "30d")
      .then((data) => {
        if (cancelled) return;
        setCorrections(data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setCorrectionsError(err?.message || "Failed to load correction telemetry.");
      })
      .finally(() => {
        if (!cancelled) setCorrectionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, passcode, reloadTick]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  // -- dirty tracking -----------------------------------------------------
  const dirty = useMemo(() => {
    if (!saved) return false;
    const current = JSON.stringify({ thresholds, stoplist, terms });
    const base = JSON.stringify({
      thresholds: saved.thresholds,
      stoplist: saved.stoplist,
      terms: saved.terms,
    });
    return current !== base;
  }, [saved, thresholds, stoplist, terms]);

  const localIssue = useMemo(() => validateLocal(terms, thresholds), [terms, thresholds]);

  // -- term mutations -------------------------------------------------------
  const updateTerm = useCallback((i: number, patch: Partial<LexiconTerm>) => {
    setTerms((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
    setStatus({ kind: "idle" });
  }, []);

  const removeTerm = useCallback((i: number) => {
    setTerms((prev) => prev.filter((_, idx) => idx !== i));
    setStatus({ kind: "idle" });
  }, []);

  const addTerm = useCallback(() => {
    setTerms((prev) => [...prev, { canonical: "", aliases: [], fuzzy: false }]);
    setStatus({ kind: "idle" });
  }, []);

  const addAlias = useCallback((i: number, alias: string) => {
    const trimmed = alias.trim();
    if (!trimmed) return;
    setTerms((prev) =>
      prev.map((t, idx) => {
        if (idx !== i) return t;
        if (t.aliases.some((a) => a.toLowerCase() === trimmed.toLowerCase())) return t;
        return { ...t, aliases: [...t.aliases, trimmed] };
      }),
    );
    setAliasDrafts((prev) => ({ ...prev, [i]: "" }));
    setStatus({ kind: "idle" });
  }, []);

  const removeAlias = useCallback((i: number, aliasIdx: number) => {
    setTerms((prev) =>
      prev.map((t, idx) =>
        idx === i ? { ...t, aliases: t.aliases.filter((_, ai) => ai !== aliasIdx) } : t,
      ),
    );
    setStatus({ kind: "idle" });
  }, []);

  /** Adds `alias` to whichever term's canonical matches `targetCanonical`
   *  (case-insensitive), creating a new term if none matches yet. Used by
   *  both "Add as alias" flows below — this is the loop-closing action the
   *  whole telemetry panel exists for. */
  const addAliasToCanonical = useCallback((targetCanonical: string, alias: string) => {
    const trimmedAlias = alias.trim();
    const trimmedTarget = targetCanonical.trim();
    if (!trimmedAlias || !trimmedTarget) return;
    setTerms((prev) => {
      const idx = prev.findIndex(
        (t) => t.canonical.trim().toLowerCase() === trimmedTarget.toLowerCase(),
      );
      if (idx === -1) {
        setFlash(`Created new term "${trimmedTarget}" with alias "${trimmedAlias}". Review before saving.`);
        return [...prev, { canonical: trimmedTarget, aliases: [trimmedAlias], fuzzy: false }];
      }
      const existing = prev[idx];
      if (existing.aliases.some((a) => a.toLowerCase() === trimmedAlias.toLowerCase())) {
        setFlash(`"${trimmedAlias}" is already an alias of "${existing.canonical}".`);
        return prev;
      }
      setFlash(`Added "${trimmedAlias}" as an alias of "${existing.canonical}". Not saved yet.`);
      return prev.map((t, i) =>
        i === idx ? { ...t, aliases: [...t.aliases, trimmedAlias] } : t,
      );
    });
    setStatus({ kind: "idle" });
  }, []);

  // -- save -------------------------------------------------------------
  async function handleSave() {
    if (localIssue) return;
    setStatus({ kind: "saving" });
    const payload: Lexicon = {
      version,
      updatedAt: new Date().toISOString(), // ignored server-side; stamped there
      thresholds,
      stoplist,
      terms,
    };
    try {
      const result = await client.saveLexicon(passcode, payload);
      const clone = cloneLexicon(result);
      setSaved(clone);
      setVersion(clone.version);
      setThresholds(clone.thresholds);
      setStoplist(clone.stoplist);
      setTerms(clone.terms);
      setStatus({ kind: "saved" });
      setTimeout(() => setStatus((s) => (s.kind === "saved" ? { kind: "idle" } : s)), 2500);
    } catch (err) {
      if (err instanceof AdminValidationError) {
        const termIndex = terms.findIndex(
          (t) => t.canonical && err.message.includes(`"${t.canonical}"`),
        );
        setStatus({
          kind: "error",
          message: err.message,
          termIndex: termIndex >= 0 ? termIndex : undefined,
        });
      } else {
        setStatus({
          kind: "error",
          message: (err as any)?.message || "Save failed.",
        });
      }
    }
  }

  function handleDiscard() {
    if (!saved) return;
    setThresholds(saved.thresholds);
    setStoplist(saved.stoplist);
    setTerms(saved.terms.map((t) => ({ ...t, aliases: [...t.aliases] })));
    setStatus({ kind: "idle" });
  }

  const errorTermIndex = status.kind === "error" ? status.termIndex : undefined;

  return (
    <div className="space-y-4 md:space-y-6">
      <Panel
        title="Typo Lexicon"
        subtitle="Domain terms Groq Whisper mishears, and how the assistant repairs them before answering."
        action={
          <div className="flex items-center gap-2">
            {dirty && !localIssue && status.kind !== "saving" && (
              <span className="text-[11px] uppercase tracking-widest text-amber-600">
                Unsaved
              </span>
            )}
            <button
              type="button"
              onClick={handleDiscard}
              disabled={!dirty || status.kind === "saving"}
              className="btn-ghost text-xs px-3 py-1.5"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || !!localIssue || status.kind === "saving"}
              className="btn-primary text-xs px-3 py-1.5"
              title={localIssue ? localIssue.message : undefined}
            >
              {status.kind === "saving" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : status.kind === "saved" ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {status.kind === "saved" ? "Saved" : "Save"}
            </button>
          </div>
        }
      >
        {loading ? (
          <PanelSkeleton rows={5} />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />
        ) : (
          <>
            {status.kind === "error" && (
              <div className="mb-4 flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span dir="auto">{status.message}</span>
              </div>
            )}
            {localIssue && dirty && status.kind !== "error" && (
              <div className="mb-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span dir="auto">{localIssue.message}</span>
              </div>
            )}

            <ThresholdsBar thresholds={thresholds} onChange={setThresholds} />

            <div className="mt-5 flex items-center justify-between">
              <h4 className="text-[11px] uppercase tracking-[0.25em] text-slate-500">
                Terms
              </h4>
              <button type="button" onClick={addTerm} className="btn-ghost text-xs px-3 py-1.5">
                <Plus className="w-3.5 h-3.5" />
                Add term
              </button>
            </div>

            {terms.length === 0 ? (
              <EmptyState
                title="No terms yet"
                hint="Add a term for any name, place, or acronym Groq Whisper tends to mis-hear."
              />
            ) : (
              <div className="mt-3 space-y-3">
                {terms.map((t, i) => (
                  <TermRow
                    key={i}
                    term={t}
                    index={i}
                    minFuzzyLen={thresholds.minFuzzyLen}
                    highlighted={errorTermIndex === i}
                    aliasDraft={aliasDrafts[i] ?? ""}
                    onCanonicalChange={(v) => updateTerm(i, { canonical: v })}
                    onFuzzyChange={(v) => updateTerm(i, { fuzzy: v })}
                    onAliasDraftChange={(v) => setAliasDrafts((prev) => ({ ...prev, [i]: v }))}
                    onAddAlias={() => addAlias(i, aliasDrafts[i] ?? "")}
                    onRemoveAlias={(aliasIdx) => removeAlias(i, aliasIdx)}
                    onRemoveTerm={() => removeTerm(i)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="Corrections"
        subtitle="What's actually being mis-heard — the worklist for what to add above."
        action={
          flash && (
            <span className="text-xs text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2.5 py-1">
              {flash}
            </span>
          )
        }
      >
        {correctionsLoading ? (
          <PanelSkeleton rows={4} />
        ) : correctionsError ? (
          <ErrorState
            message={correctionsError}
            onRetry={() => setReloadTick((t) => t + 1)}
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div>
              <h4 className="text-[11px] uppercase tracking-[0.25em] text-slate-500 mb-2">
                Top mishearings (last 30d)
              </h4>
              {!corrections || corrections.topPairs.length === 0 ? (
                <EmptyState title="No corrections logged yet" />
              ) : (
                <div className="space-y-1.5">
                  {corrections.topPairs.map((p, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 flex items-center gap-1.5" dir="auto">
                        <span className="text-slate-500 truncate">{p.from}</span>
                        <span className="text-slate-300">→</span>
                        <span className="text-slate-900 font-medium truncate">{p.to}</span>
                        <Badge tone={p.tier === "A" ? "teal" : "violet"}>
                          {p.tier ?? "?"}
                        </Badge>
                        <span className="text-slate-400 text-xs shrink-0">×{p.count}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => addAliasToCanonical(p.to, p.from)}
                        className="btn-ghost !py-1 !px-2.5 text-[11px] shrink-0"
                      >
                        <Plus className="w-3 h-3" />
                        Add as alias
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="text-[11px] uppercase tracking-[0.25em] text-slate-500 mb-2">
                Unresolved clarifications
              </h4>
              {!corrections || corrections.clarifications.length === 0 ? (
                <EmptyState
                  title="Nothing unresolved"
                  hint="No turn asked 'did you mean…?' in this range."
                  icon={<Sparkles className="w-5 h-5" />}
                />
              ) : (
                <div className="space-y-2">
                  {corrections.clarifications.map((c) => {
                    const candidate = guessCandidateFromAnswer(c.answer);
                    return (
                      <div
                        key={c.id}
                        className="rounded-xl border border-amber-200 bg-amber-50/40 px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-slate-800" dir="auto">
                            {c.rawQuestion || "(empty)"}
                          </span>
                          <span className="text-[11px] text-slate-400 shrink-0">
                            {formatDateTime(c.timestamp)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1" dir="auto">
                          {c.answer}
                        </p>
                        <div className="flex items-center gap-1.5 mt-2">
                          {candidate ? (
                            <Badge tone="amber">guessed: {candidate}</Badge>
                          ) : (
                            <span className="text-[11px] text-slate-400">
                              Couldn't detect the intended term — pick it manually below.
                            </span>
                          )}
                          <input
                            type="text"
                            value={clarifyDrafts[c.id] ?? ""}
                            onChange={(e) =>
                              setClarifyDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))
                            }
                            placeholder="alias to add, e.g. the mis-heard word"
                            dir="auto"
                            className="input !py-1 !px-2.5 text-xs flex-1 min-w-0"
                          />
                          <button
                            type="button"
                            disabled={!candidate || !(clarifyDrafts[c.id] ?? "").trim()}
                            onClick={() =>
                              candidate && addAliasToCanonical(candidate, clarifyDrafts[c.id] ?? "")
                            }
                            className="btn-ghost !py-1 !px-2.5 text-[11px] shrink-0 disabled:opacity-40"
                          >
                            <Plus className="w-3 h-3" />
                            Add as alias
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThresholdsBar({
  thresholds,
  onChange,
}: {
  thresholds: LexiconThresholds;
  onChange: (next: LexiconThresholds) => void;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <NumberField
        label="Auto-apply"
        hint="Score to silently correct (Tier B)."
        value={thresholds.autoApply}
        step={0.01}
        onChange={(v) => onChange({ ...thresholds, autoApply: v })}
      />
      <NumberField
        label="Clarify"
        hint="Score to ask 'did you mean…?'."
        value={thresholds.clarify}
        step={0.01}
        onChange={(v) => onChange({ ...thresholds, clarify: v })}
      />
      <NumberField
        label="Gap"
        hint="Min. lead over runner-up."
        value={thresholds.gap}
        step={0.01}
        onChange={(v) => onChange({ ...thresholds, gap: v })}
      />
      <NumberField
        label="Min. fuzzy length"
        hint="Shorter tokens never fuzzy-match."
        value={thresholds.minFuzzyLen}
        step={1}
        onChange={(v) => onChange({ ...thresholds, minFuzzyLen: Math.round(v) })}
      />
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="input !py-2 mt-1.5 text-sm"
      />
    </label>
  );
}

function TermRow({
  term,
  index,
  minFuzzyLen,
  highlighted,
  aliasDraft,
  onCanonicalChange,
  onFuzzyChange,
  onAliasDraftChange,
  onAddAlias,
  onRemoveAlias,
  onRemoveTerm,
}: {
  term: LexiconTerm;
  index: number;
  minFuzzyLen: number;
  highlighted: boolean;
  aliasDraft: string;
  onCanonicalChange: (v: string) => void;
  onFuzzyChange: (v: boolean) => void;
  onAliasDraftChange: (v: string) => void;
  onAddAlias: () => void;
  onRemoveAlias: (aliasIdx: number) => void;
  onRemoveTerm: () => void;
}) {
  const canonical = term.canonical.trim();
  const isShortAcronym = canonical.length > 0 && canonical.length < minFuzzyLen;

  return (
    <div
      className={`rounded-xl border px-3 py-3 ${
        highlighted ? "border-red-300 bg-red-50/40" : "border-slate-200 bg-surface"
      }`}
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[10rem]">
          <span className="text-[11px] text-slate-400">Canonical</span>
          <input
            type="text"
            value={term.canonical}
            onChange={(e) => onCanonicalChange(e.target.value)}
            placeholder="e.g. IUL"
            dir="auto"
            className="input !py-2 mt-0.5 text-sm font-medium"
          />
        </div>

        <label className="flex flex-col items-start gap-0.5 shrink-0">
          <span className="text-[11px] text-slate-400">Fuzzy match</span>
          <span className="inline-flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              checked={term.fuzzy}
              onChange={(e) => onFuzzyChange(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-400/40"
            />
            <span className="text-xs text-slate-600">
              {term.fuzzy ? "On" : "Off"}
            </span>
          </span>
        </label>

        <button
          type="button"
          onClick={onRemoveTerm}
          className="btn-ghost !py-2 !px-2.5 text-red-600 hover:!bg-red-50 shrink-0 mt-4"
          aria-label={`Delete term ${canonical || `#${index + 1}`}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {isShortAcronym && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
          "{canonical}" is shorter than the min. fuzzy length ({minFuzzyLen} chars) — fuzzy
          matching can never apply to it, regardless of the toggle above. Add every mis-hearing
          as an alias instead; that's the only thing that works for short acronyms.
        </p>
      )}

      <div className="mt-2.5">
        <span className="text-[11px] text-slate-400">Aliases (exact mis-hearings)</span>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {term.aliases.map((a, ai) => (
            <span
              key={ai}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-700"
              dir="auto"
            >
              {a}
              <button
                type="button"
                onClick={() => onRemoveAlias(ai)}
                className="text-slate-400 hover:text-red-600"
                aria-label={`Remove alias ${a}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input
              type="text"
              value={aliasDraft}
              onChange={(e) => onAliasDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAddAlias();
                }
              }}
              placeholder="add alias…"
              dir="auto"
              className="text-xs px-2.5 py-1 rounded-full border border-dashed border-slate-300 bg-surface focus:outline-none focus:border-teal-400 w-32"
            />
            <button
              type="button"
              onClick={onAddAlias}
              disabled={!aliasDraft.trim()}
              className="text-slate-400 hover:text-teal-600 disabled:opacity-30"
              aria-label="Add alias"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
