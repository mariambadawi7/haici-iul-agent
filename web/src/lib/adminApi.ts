/**
 * Typed client for the admin analytics workflow at `/webhook/admin-stats`.
 *
 * This is a RELATIVE url, so it rides the existing Vite proxy defined in
 * `vite.config.ts` (`/webhook/*` → `http://n8n:5678/webhook/*`) — no new
 * proxy rule, no CORS. The frontend never talks to Postgres or n8n directly
 * outside of that one webhook.
 *
 * All interfaces below mirror §3 of the build contract
 * (admin-dashboard-spec.md) field-for-field. Do not rename a field here
 * without updating the spec and the backend workflow in lockstep.
 */

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export type RangeOption = "7d" | "30d" | "90d" | "all";

/** Who is holding the passcode. Resolved server-side by the workflow's
 *  `Resolve Role` node — never asserted by the browser. `operator` gets the
 *  full console; `client` gets analytics only. */
export type AdminRole = "operator" | "client";

export type LogFilter =
  | "all"
  | "unknown"
  | "voice"
  | "text"
  | "cache_hit"
  | "fresh";

export interface LogQuery {
  search: string;
  filter: LogFilter;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Response shapes — view: "overview"
// ---------------------------------------------------------------------------

export interface OverviewKpis {
  totalQuestions: number;
  uniqueQuestions: number;
  sessions: number;
  unknownCount: number;
  /** 0..1 — share of intent='question' rows that are unknown. */
  unknownRate: number;
  /** 0..1 */
  cacheHitRate: number;
  /** null when there is no latency data at all. */
  avgLatencyMs: number | null;
  /** null when there is no latency data at all. */
  p95LatencyMs: number | null;
  /** 0..1 — input_type='audio' / total */
  voiceShare: number;
  /** 0..1 */
  audioReplyShare: number;
  avgQuestionsPerSession: number;
  activeDays: number;
  busiestHour: number | null;
  busiestDay: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface HourBucket {
  hour: number; // 0..23
  count: number;
}

export interface WeekdayBucket {
  weekday: number; // 0 = Sunday
  label: string;
  count: number;
}

export interface HeatmapCell {
  weekday: number; // 0 = Sunday
  hour: number; // 0..23
  count: number;
}

export interface DayBucket {
  day: string; // "2026-08-15"
  count: number;
  unknown: number;
}

export interface TopQuestion {
  question: string;
  count: number;
  lastAsked: string; // ISO
  sampleAnswer: string;
  unknownCount: number;
}

export interface UnknownQuestion {
  question: string;
  count: number;
  lastAsked: string; // ISO
  sampleAnswer: string;
}

export interface LanguageBucket {
  language: string;
  count: number;
}

export interface InputTypeBucket {
  inputType: string;
  count: number;
}

export interface MatchTypeBucket {
  matchType: string;
  count: number;
}

export interface OverviewResponse {
  kpis: OverviewKpis;
  byHour: HourBucket[];
  byWeekday: WeekdayBucket[];
  heatmap: HeatmapCell[];
  byDay: DayBucket[];
  topQuestions: TopQuestion[];
  unknownQuestions: UnknownQuestion[];
  byLanguage: LanguageBucket[];
  byInputType: InputTypeBucket[];
  byMatchType: MatchTypeBucket[];
  /** Optional so a backend predating the role split still parses — the UI
   *  treats a missing role as `operator`, i.e. the old single dashboard. */
  role?: AdminRole;
}

// ---------------------------------------------------------------------------
// Response shapes — view: "log"
// ---------------------------------------------------------------------------

export interface LogRow {
  id: number;
  timestamp: string; // ISO
  question: string;
  answer: string;
  inputType: string;
  matchType: string;
  isUnknown: boolean;
  intent: string;
  language: string;
  latencyMs: number | null;
  sessionId: string | null;
  respondedWithAudio: boolean;
}

export interface LogResponse {
  rows: LogRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Response/request shapes — view: "lexicon" / "lexiconSave"
// ---------------------------------------------------------------------------

export interface LexiconThresholds {
  /** 0..1 — score at/above which a Tier-B fuzzy match is applied silently. */
  autoApply: number;
  /** 0..1 — score at/above which the assistant asks "did you mean…?" instead
   *  of silently correcting or ignoring. Must be < autoApply. */
  clarify: number;
  /** Minimum score gap from the runner-up candidate to accept a match. */
  gap: number;
  /** A token shorter than this is never fuzzy-matched, no matter what
   *  `fuzzy` says on the term — see LexiconTerm.fuzzy doc comment. */
  minFuzzyLen: number;
}

export interface LexiconTerm {
  canonical: string;
  /** Exact mis-hearings. Always corrected silently (Tier A), regardless of
   *  `fuzzy` or token length — this is the ONLY mechanism that can fix a
   *  short acronym (e.g. "IUL"), since Levenshtein distance can't safely
   *  distinguish a 2-edit acronym typo from an unrelated short word. */
  aliases: string[];
  /** Enables approximate (Levenshtein) matching for this term, but only for
   *  spoken tokens >= thresholds.minFuzzyLen characters. Turning this on for
   *  a short acronym does nothing — add an alias instead. */
  fuzzy: boolean;
}

export interface Lexicon {
  version: number;
  /** Stamped server-side on every save; any client-sent value is ignored. */
  updatedAt: string;
  thresholds: LexiconThresholds;
  stoplist: string[];
  terms: LexiconTerm[];
}

// ---------------------------------------------------------------------------
// Response shapes — view: "corrections"
// ---------------------------------------------------------------------------

export interface CorrectionStat {
  from: string;
  to: string;
  count: number;
  tier: string | null;
}

export interface ClarifyRow {
  id: number;
  timestamp: string; // ISO
  rawQuestion: string | null;
  question: string | null;
  answer: string | null;
  sessionId: string | null;
}

export interface CorrectionsResponse {
  topPairs: CorrectionStat[];
  clarifications: ClarifyRow[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdminApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/** Thrown specifically on a 401 — the passcode gate should treat this
 *  differently from a generic connectivity/server failure. */
export class AdminAuthError extends AdminApiError {
  constructor(message = "Incorrect passcode.") {
    super(message, 401);
    this.name = "AdminAuthError";
  }
}

/** Thrown on a 403 — the passcode is valid but lacks the role for this view
 *  (e.g. a client passcode asking for the lexicon). Distinct from a 401 so the
 *  UI shows "not allowed" rather than kicking back to the passcode gate. */
export class AdminForbiddenError extends AdminApiError {
  constructor(message = "Your passcode does not allow this.") {
    super(message, 403);
    this.name = "AdminForbiddenError";
  }
}

/** Thrown specifically on a 400 from `view: "lexiconSave"` — the server's
 *  `Validate Lexicon` node names the offending term in `message`, so this
 *  is kept distinct from a generic `AdminApiError` for inline display. */
export class AdminValidationError extends AdminApiError {
  constructor(message: string) {
    super(message, 400);
    this.name = "AdminValidationError";
  }
}

// ---------------------------------------------------------------------------
// Client interface — swappable so the UI can be pointed at a local mock
// while the backend is still being built (see lib/adminMock.ts). Production
// always uses `liveAdminClient`.
// ---------------------------------------------------------------------------

export interface AdminClient {
  fetchOverview(
    passcode: string,
    range: RangeOption,
    signal?: AbortSignal,
  ): Promise<OverviewResponse>;
  fetchLog(
    passcode: string,
    query: LogQuery,
    signal?: AbortSignal,
  ): Promise<LogResponse>;
  fetchLexicon(passcode: string, signal?: AbortSignal): Promise<Lexicon>;
  /** Throws `AdminValidationError` (not a generic `AdminApiError`) on a 400 —
   *  the message names the offending term. */
  saveLexicon(
    passcode: string,
    lexicon: Lexicon,
    signal?: AbortSignal,
  ): Promise<Lexicon>;
  fetchCorrections(
    passcode: string,
    range: RangeOption,
    signal?: AbortSignal,
  ): Promise<CorrectionsResponse>;
}

const ADMIN_STATS_URL = "/webhook/admin-stats";

async function postAdminStats<T>(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ADMIN_STATS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    throw new AdminApiError(
      "Could not reach the admin stats workflow through the Vite proxy. Check that n8n is running and /webhook/admin-stats is Active.",
    );
  }

  if (res.status === 401) {
    throw new AdminAuthError();
  }
  if (res.status === 403) {
    let message = "Your passcode does not allow this.";
    try {
      const body = await res.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch {
      // fall through with the generic message
    }
    throw new AdminForbiddenError(message);
  }
  if (res.status === 404) {
    throw new AdminApiError(
      "Admin stats workflow not found (404). It may not be created/activated in n8n yet.",
      404,
    );
  }
  if (res.status === 400) {
    let message = "Invalid request.";
    try {
      const body = await res.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch {
      // fall through with the generic message
    }
    throw new AdminValidationError(message);
  }
  if (!res.ok) {
    throw new AdminApiError(
      `Admin stats request failed (HTTP ${res.status}).`,
      res.status,
    );
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new AdminApiError(
      "The response was cut off before the browser could read it.",
    );
  }
  if (!text.trim()) {
    throw new AdminApiError("Admin stats workflow returned an empty response.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AdminApiError("Admin stats workflow returned invalid JSON.");
  }
}

export const liveAdminClient: AdminClient = {
  fetchOverview(passcode, range, signal) {
    return postAdminStats<OverviewResponse>(
      { passcode, view: "overview", range },
      signal,
    );
  },
  fetchLog(passcode, query, signal) {
    return postAdminStats<LogResponse>(
      {
        passcode,
        view: "log",
        search: query.search,
        filter: query.filter,
        page: query.page,
        pageSize: query.pageSize,
      },
      signal,
    );
  },
  fetchLexicon(passcode, signal) {
    return postAdminStats<Lexicon>({ passcode, view: "lexicon" }, signal);
  },
  async saveLexicon(passcode, lexicon, signal) {
    const res = await postAdminStats<{ ok: boolean; lexicon: Lexicon }>(
      { passcode, view: "lexiconSave", lexicon },
      signal,
    );
    return res.lexicon;
  },
  fetchCorrections(passcode, range, signal) {
    return postAdminStats<CorrectionsResponse>(
      { passcode, view: "corrections", range },
      signal,
    );
  },
};
