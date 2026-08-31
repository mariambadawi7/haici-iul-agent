import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  BarChart3,
  BookMarked,
  Building2,
  LogOut,
  Palette,
  ShieldCheck,
} from "lucide-react";
import PasscodeGate from "./PasscodeGate";
import KpiCards from "./KpiCards";
import UnknownQuestions from "./UnknownQuestions";
import TopQuestions from "./TopQuestions";
import PeakHoursChart from "./PeakHoursChart";
import UsageHeatmap from "./UsageHeatmap";
import VolumeChart from "./VolumeChart";
import Breakdowns from "./Breakdowns";
import QuestionLog from "./QuestionLog";
import BrandingTab from "./BrandingTab";
import LexiconEditor from "./LexiconEditor";
import { ErrorState } from "./ui";
import { useTenant } from "../../lib/branding/context";
import {
  liveAdminClient,
  AdminAuthError,
  type AdminClient,
  type AdminRole,
  type OverviewResponse,
  type RangeOption,
} from "../../lib/adminApi";

const STORAGE_KEY = "admin_passcode";

/** Reads `?mock=1` / `?mock=full` / `?mock=empty` from the hash query
 *  string, e.g. `#/admin?mock=empty`. Never used by the production path —
 *  see lib/adminMock.ts for why this stays a dynamic import. */
function readMockScenario(): "full" | "empty" | null {
  const hash = window.location.hash; // "#/admin?mock=empty"
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return null;
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  const mock = params.get("mock");
  if (!mock) return null;
  return mock === "empty" ? "empty" : "full";
}

/** Fixture-only role override, e.g. `#/admin?mock=full&role=client`, so the
 *  client dashboard can be previewed without a client passcode. Ignored on
 *  the production path — there the role comes from the server. */
function readMockRole(): AdminRole {
  const hash = window.location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex === -1) return "operator";
  const role = new URLSearchParams(hash.slice(qIndex + 1)).get("role");
  return role === "client" ? "client" : "operator";
}

type Tab = "analytics" | "lexicon" | "branding";

/** Which tabs each role may see. The server enforces the same split — this
 *  only decides what gets drawn. */
const TABS_BY_ROLE: Record<AdminRole, Tab[]> = {
  operator: ["analytics", "lexicon", "branding"],
  client: ["analytics"],
};

const TAB_META: Record<Tab, { label: string; icon: ReactNode }> = {
  analytics: { label: "Analytics", icon: <BarChart3 className="w-3.5 h-3.5" /> },
  lexicon: { label: "Lexicon", icon: <BookMarked className="w-3.5 h-3.5" /> },
  branding: { label: "Branding", icon: <Palette className="w-3.5 h-3.5" /> },
};

export default function AdminApp() {
  const { identity } = useTenant();
  const [tab, setTab] = useState<Tab>("analytics");
  const mockScenario = useMemo(readMockScenario, []);
  const mockRole = useMemo(readMockRole, []);
  const [client, setClient] = useState<AdminClient | null>(
    mockScenario ? null : liveAdminClient,
  );

  useEffect(() => {
    if (!mockScenario) return;
    let cancelled = false;
    import("../../lib/adminMock").then(({ createMockAdminClient }) => {
      if (!cancelled) setClient(createMockAdminClient(mockScenario, mockRole));
    });
    return () => {
      cancelled = true;
    };
  }, [mockScenario, mockRole]);

  const [passcode, setPasscode] = useState<string | null>(() =>
    sessionStorage.getItem(STORAGE_KEY),
  );
  const [authed, setAuthed] = useState(false);
  const [checkingSaved, setCheckingSaved] = useState(!!passcode);

  const [range, setRange] = useState<RangeOption>("30d");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Validate a previously-saved passcode (sessionStorage) once the client
  // is ready, so a page refresh doesn't force re-entering it every time.
  useEffect(() => {
    if (!client || !passcode) {
      setCheckingSaved(false);
      return;
    }
    let cancelled = false;
    client
      .fetchOverview(passcode, range)
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        setOverviewLoading(false);
        setAuthed(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AdminAuthError) {
          sessionStorage.removeItem(STORAGE_KEY);
          setPasscode(null);
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSaved(false);
      });
    return () => {
      cancelled = true;
    };
    // Only re-run when the client itself changes (live vs mock resolves once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Refetch the overview whenever the authed passcode or range changes.
  useEffect(() => {
    if (!client || !authed || !passcode) return;
    let cancelled = false;
    const ctl = new AbortController();
    setOverviewLoading(true);
    setOverviewError(null);
    client
      .fetchOverview(passcode, range, ctl.signal)
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
      })
      .catch((err: any) => {
        if (cancelled || err?.name === "AbortError") return;
        if (err instanceof AdminAuthError) {
          sessionStorage.removeItem(STORAGE_KEY);
          setPasscode(null);
          setAuthed(false);
          return;
        }
        setOverviewError(err?.message || "Failed to load analytics.");
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [client, authed, passcode, range, reloadTick]);

  const handleGateSubmit = useCallback(
    async (candidate: string): Promise<boolean> => {
      if (!client) return false;
      try {
        const data = await client.fetchOverview(candidate, range);
        sessionStorage.setItem(STORAGE_KEY, candidate);
        setPasscode(candidate);
        setOverview(data);
        setOverviewLoading(false);
        setAuthed(true);
        return true;
      } catch (err) {
        if (err instanceof AdminAuthError) return false;
        throw err;
      }
    },
    [client, range],
  );

  const handleLogout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setPasscode(null);
    setAuthed(false);
    setOverview(null);
  }, []);

  if (!client || checkingSaved) {
    return (
      <div className="min-h-screen w-full grid place-items-center app-shell bg-slate-50">
        <div className="text-sm text-slate-400">Loading admin dashboard…</div>
      </div>
    );
  }

  if (!authed) {
    return <PasscodeGate onSubmit={handleGateSubmit} mock={!!mockScenario} />;
  }

  // A backend predating the role split omits `role`; treat that as the old
  // single dashboard rather than silently downgrading the operator.
  const role: AdminRole = overview?.role ?? "operator";
  const visibleTabs = TABS_BY_ROLE[role];
  // Derived rather than corrected-by-effect, so a role change can never leave
  // an operator-only tab rendered for a frame.
  const activeTab: Tab = visibleTabs.includes(tab) ? tab : "analytics";

  return (
    <div className="min-h-screen w-full app-shell bg-slate-50">
      <header className="panel-elevated border-b border-bg-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 md:px-6 py-4 flex items-center justify-between">
          <div>
            <div className="badge-serif">
              {role === "operator" ? "Operator console" : "Analytics"}
            </div>
            <h1 className="font-serif text-xl text-slate-900 leading-tight">
              {identity.name}
            </h1>
          </div>

          {visibleTabs.length > 1 && (
            <nav className="hidden md:inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
              {visibleTabs.map((t) => (
                <TabButton
                  key={t}
                  active={activeTab === t}
                  onClick={() => setTab(t)}
                  icon={TAB_META[t].icon}
                  label={TAB_META[t].label}
                />
              ))}
            </nav>
          )}
          <div className="flex items-center gap-3">
            {mockScenario && (
              <span className="text-[10px] uppercase tracking-[0.2em] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-1">
                Mock: {mockScenario}
              </span>
            )}
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-400">
              {role === "operator" ? (
                <ShieldCheck className="w-3.5 h-3.5 text-teal-500" />
              ) : (
                <Building2 className="w-3.5 h-3.5 text-teal-500" />
              )}
              {role === "operator" ? "Operator" : "Analytics only"}
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="btn-ghost !py-1.5 !px-3 text-xs inline-flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              Lock
            </button>
          </div>
        </div>
      </header>

      {/* The switcher collapses to a full-width row on narrow screens, where
          the header has no space for it. */}
      {visibleTabs.length > 1 && (
        <div className="md:hidden max-w-7xl mx-auto px-4 pt-4">
          <nav className="inline-flex w-full rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            {visibleTabs.map((t) => (
              <TabButton
                key={t}
                active={activeTab === t}
                onClick={() => setTab(t)}
                icon={TAB_META[t].icon}
                label={TAB_META[t].label}
              />
            ))}
          </nav>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-5 md:space-y-6">
        {activeTab === "branding" ? (
          <BrandingTab passcode={passcode} />
        ) : activeTab === "lexicon" ? (
          <LexiconEditor client={client} passcode={passcode!} />
        ) : overviewError ? (
          <ErrorState
            message={overviewError}
            onRetry={() => setReloadTick((t) => t + 1)}
          />
        ) : (
          <>
            <KpiCards kpis={overview?.kpis ?? null} loading={overviewLoading} />

            <UnknownQuestions
              items={overview?.unknownQuestions ?? []}
              loading={overviewLoading}
            />

            <TopQuestions
              items={overview?.topQuestions ?? []}
              loading={overviewLoading}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
              <PeakHoursChart
                byHour={overview?.byHour ?? []}
                busiestHour={overview?.kpis.busiestHour ?? null}
                loading={overviewLoading}
              />
              <UsageHeatmap
                cells={overview?.heatmap ?? []}
                loading={overviewLoading}
              />
            </div>

            <VolumeChart
              byDay={overview?.byDay ?? []}
              range={range}
              onRangeChange={setRange}
              loading={overviewLoading}
            />

            <Breakdowns
              byLanguage={overview?.byLanguage ?? []}
              byInputType={overview?.byInputType ?? []}
              byMatchType={overview?.byMatchType ?? []}
              loading={overviewLoading}
            />
          </>
        )}

        {activeTab === "analytics" && (
          <QuestionLog client={client} passcode={passcode!} />
        )}
      </main>

      {identity.footerCredit && (
        <div className="footer-credit">{identity.footerCredit}</div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 md:flex-none inline-flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors ${
        active
          ? "bg-surface text-teal-700 shadow-sm border border-slate-200"
          : "text-slate-500 hover:text-slate-700"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
