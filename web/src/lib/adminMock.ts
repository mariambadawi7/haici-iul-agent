/**
 * DEV-ONLY fixture client for the admin dashboard.
 *
 * The backend workflow (`/webhook/admin-stats`) is being built by a separate
 * agent in parallel and may 404 or not exist yet. This module lets the UI be
 * developed and verified against the exact §3 JSON contract without the
 * live endpoint — including the sparse (~17 rows, lots of NULLs) and fully
 * empty states the real dataset will actually produce.
 *
 * Never imported from a static top-level import in production code paths —
 * `AdminApp` only reaches for it via a dynamic `import()` when the page is
 * opened as `#/admin?mock=1` or `#/admin?mock=empty`. The production path
 * (no `mock` param) always uses `liveAdminClient` from `adminApi.ts` against
 * the real relative `/webhook/admin-stats` URL.
 */
import type {
  AdminClient,
  AdminRole,
  CorrectionsResponse,
  DayBucket,
  HourBucket,
  Lexicon,
  LogQuery,
  LogResponse,
  LogRow,
  OverviewResponse,
  RangeOption,
  TopQuestion,
  UnknownQuestion,
  WeekdayBucket,
} from "./adminApi";
import {
  AdminAuthError,
  AdminForbiddenError,
  AdminValidationError,
} from "./adminApi";

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function iso(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function zeroFilledHours(overrides: Record<number, number>): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: overrides[hour] ?? 0,
  }));
}

function zeroFilledWeekdays(overrides: Record<number, number>): WeekdayBucket[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    label: WEEKDAY_LABELS[weekday],
    count: overrides[weekday] ?? 0,
  }));
}

function gapFilledDays(days: number, overrides: Record<string, [number, number]>): DayBucket[] {
  const out: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const [count, unknown] = overrides[key] ?? [0, 0];
    out.push({ day: key, count, unknown });
  }
  return out;
}

// ---------------------------------------------------------------------------
// "full" scenario — mirrors the real ~17-row dataset: sparse, several NULLs
// on historical rows, a couple of rows with the new columns populated.
// ---------------------------------------------------------------------------

function buildFullOverview(range: RangeOption): OverviewResponse {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 120;

  const topQuestions: TopQuestion[] = [
    {
      question: "What are the admission deadlines for the fall semester?",
      count: 4,
      lastAsked: iso(1, 10, 15),
      sampleAnswer:
        "Applications for the fall semester close on August 30th. Late applications may be considered on a case-by-case basis.",
      unknownCount: 0,
    },
    {
      question: "ما هي كلفة التسجيل في الجامعة؟",
      count: 3,
      lastAsked: iso(2, 9, 40),
      sampleAnswer: "تختلف الرسوم الدراسية حسب الكلية والبرنامج. يرجى مراجعة قسم القبول والتسجيل للحصول على التفاصيل الدقيقة.",
      unknownCount: 1,
    },
    {
      question: "Where is the main campus located?",
      count: 3,
      lastAsked: iso(4, 14, 5),
      sampleAnswer: "The main campus is located in Beirut, with additional branches across Lebanon.",
      unknownCount: 0,
    },
    {
      question: "What accreditations does IUL hold?",
      count: 2,
      lastAsked: iso(6, 11, 0),
      sampleAnswer: "IUL is accredited by the Lebanese Ministry of Education and Higher Education.",
      unknownCount: 0,
    },
    {
      question: "which languages are the programs taught in",
      count: 2,
      lastAsked: iso(9, 16, 20),
      sampleAnswer: "Programs are primarily taught in Arabic, French, and English depending on the faculty.",
      unknownCount: 0,
    },
  ];

  const unknownQuestions: UnknownQuestion[] = [
    {
      question: "do you offer a dual degree with a partner university in canada",
      count: 1,
      lastAsked: iso(2, 9, 42),
      sampleAnswer: "I'm not sure — I don't have information on that in my current records.",
    },
    {
      question: "what is the wifi password for the library",
      count: 1,
      lastAsked: iso(5, 13, 10),
      sampleAnswer: "I don't have that information available.",
    },
    {
      question: "who won the world cup in 1998",
      count: 1,
      lastAsked: iso(8, 17, 0),
      sampleAnswer: "I'm sorry, I don't have information about that.",
    },
  ];

  return {
    kpis: {
      totalQuestions: 17,
      uniqueQuestions: 13,
      sessions: 6,
      unknownCount: 3,
      unknownRate: 3 / 13,
      cacheHitRate: 6 / 17,
      avgLatencyMs: 1450,
      p95LatencyMs: 2380,
      voiceShare: 3 / 17,
      audioReplyShare: 7 / 17,
      avgQuestionsPerSession: 17 / 6,
      activeDays: 7,
      busiestHour: 10,
      busiestDay: "Wednesday",
      firstSeen: iso(11, 9, 0),
      lastSeen: iso(1, 10, 15),
    },
    byHour: zeroFilledHours({ 9: 3, 10: 4, 11: 2, 13: 1, 14: 2, 16: 3, 17: 2 }),
    byWeekday: zeroFilledWeekdays({ 0: 2, 1: 3, 2: 1, 3: 5, 4: 2, 5: 3, 6: 1 }),
    heatmap: [
      { weekday: 3, hour: 9, count: 2 },
      { weekday: 3, hour: 10, count: 2 },
      { weekday: 1, hour: 14, count: 2 },
      { weekday: 5, hour: 16, count: 3 },
      { weekday: 0, hour: 11, count: 2 },
      { weekday: 2, hour: 17, count: 1 },
    ],
    byDay: gapFilledDays(days, {
      [iso(1, 0).slice(0, 10)]: [2, 0],
      [iso(2, 0).slice(0, 10)]: [3, 1],
      [iso(4, 0).slice(0, 10)]: [1, 0],
      [iso(5, 0).slice(0, 10)]: [2, 1],
      [iso(6, 0).slice(0, 10)]: [2, 0],
      [iso(8, 0).slice(0, 10)]: [3, 1],
      [iso(9, 0).slice(0, 10)]: [2, 0],
      [iso(11, 0).slice(0, 10)]: [2, 0],
    }),
    topQuestions,
    unknownQuestions,
    byLanguage: [
      { language: "en", count: 11 },
      { language: "ar", count: 6 },
    ],
    byInputType: [
      { inputType: "text", count: 14 },
      { inputType: "audio", count: 3 },
    ],
    byMatchType: [
      { matchType: "fresh", count: 11 },
      { matchType: "cache_hit", count: 6 },
    ],
  };
}

function buildFullLog(query: LogQuery): LogResponse {
  const all: LogRow[] = [
    {
      id: 17,
      timestamp: iso(1, 10, 15),
      question: "What are the admission deadlines for the fall semester?",
      answer:
        "Applications for the fall semester close on August 30th. Late applications may be considered on a case-by-case basis.",
      inputType: "text",
      matchType: "fresh",
      isUnknown: false,
      intent: "question",
      language: "en",
      latencyMs: 1820,
      sessionId: "sess-a1b2c3",
      respondedWithAudio: false,
    },
    {
      id: 16,
      timestamp: iso(1, 10, 12),
      question: "hello",
      answer: "Hello! How can I help you today?",
      inputType: "text",
      matchType: "fresh",
      isUnknown: false,
      intent: "greeting",
      language: "en",
      latencyMs: 640,
      sessionId: "sess-a1b2c3",
      respondedWithAudio: false,
    },
    {
      id: 15,
      timestamp: iso(2, 9, 42),
      question: "do you offer a dual degree with a partner university in canada",
      answer: "I'm not sure — I don't have information on that in my current records.",
      inputType: "audio",
      matchType: "fresh",
      isUnknown: true,
      intent: "question",
      language: "en",
      latencyMs: 2380,
      sessionId: "sess-d4e5f6",
      respondedWithAudio: true,
    },
    {
      id: 14,
      timestamp: iso(2, 9, 40),
      question: "ما هي كلفة التسجيل في الجامعة؟",
      answer:
        "تختلف الرسوم الدراسية حسب الكلية والبرنامج. يرجى مراجعة قسم القبول والتسجيل للحصول على التفاصيل الدقيقة.",
      inputType: "text",
      matchType: "cache_hit",
      isUnknown: false,
      intent: "question",
      language: "ar",
      latencyMs: 310,
      sessionId: "sess-d4e5f6",
      respondedWithAudio: false,
    },
    {
      id: 13,
      timestamp: iso(4, 14, 5),
      question: "Where is the main campus located?",
      answer: "The main campus is located in Beirut, with additional branches across Lebanon.",
      inputType: "text",
      matchType: "cache_hit",
      isUnknown: false,
      intent: "question",
      language: "en",
      latencyMs: null,
      sessionId: "sess-g7h8i9",
      respondedWithAudio: false,
    },
    // Historical rows — new columns are NULL, as they would be pre-migration.
    {
      id: 5,
      timestamp: iso(20, 12, 0),
      question: "What programs does the faculty of engineering offer?",
      answer: "The Faculty of Engineering offers programs in Civil, Electrical, and Computer Engineering.",
      inputType: "text",
      matchType: "fresh",
      isUnknown: false,
      intent: "question",
      language: "en",
      latencyMs: null,
      sessionId: null,
      respondedWithAudio: false,
    },
    {
      id: 4,
      timestamp: iso(21, 8, 30),
      question: "مرحبا",
      answer: "أهلاً بك! كيف يمكنني مساعدتك اليوم؟",
      inputType: "text",
      matchType: "fresh",
      isUnknown: false,
      intent: "greeting",
      language: "ar",
      latencyMs: null,
      sessionId: null,
      respondedWithAudio: false,
    },
    {
      id: 3,
      timestamp: iso(22, 15, 10),
      question: "what is the wifi password for the library",
      answer: "I don't have that information available.",
      inputType: "text",
      matchType: "fresh",
      isUnknown: true,
      intent: "question",
      language: "en",
      latencyMs: null,
      sessionId: null,
      respondedWithAudio: false,
    },
  ];

  let rows = all;
  if (query.search.trim()) {
    const needle = query.search.trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.question.toLowerCase().includes(needle) ||
        r.answer.toLowerCase().includes(needle),
    );
  }
  switch (query.filter) {
    case "unknown":
      rows = rows.filter((r) => r.isUnknown);
      break;
    case "voice":
      rows = rows.filter((r) => r.inputType === "audio");
      break;
    case "text":
      rows = rows.filter((r) => r.inputType === "text");
      break;
    case "cache_hit":
      rows = rows.filter((r) => r.matchType === "cache_hit");
      break;
    case "fresh":
      rows = rows.filter((r) => r.matchType === "fresh");
      break;
    default:
      break;
  }

  const total = rows.length;
  const start = (query.page - 1) * query.pageSize;
  const paged = rows.slice(start, start + query.pageSize);

  return { rows: paged, total, page: query.page, pageSize: query.pageSize };
}

// ---------------------------------------------------------------------------
// "empty" scenario — a brand new deployment with zero rows.
// ---------------------------------------------------------------------------

function buildEmptyOverview(): OverviewResponse {
  return {
    kpis: {
      totalQuestions: 0,
      uniqueQuestions: 0,
      sessions: 0,
      unknownCount: 0,
      unknownRate: 0,
      cacheHitRate: 0,
      avgLatencyMs: null,
      p95LatencyMs: null,
      voiceShare: 0,
      audioReplyShare: 0,
      avgQuestionsPerSession: 0,
      activeDays: 0,
      busiestHour: null,
      busiestDay: null,
      firstSeen: null,
      lastSeen: null,
    },
    byHour: zeroFilledHours({}),
    byWeekday: zeroFilledWeekdays({}),
    heatmap: [],
    byDay: gapFilledDays(30, {}),
    topQuestions: [],
    unknownQuestions: [],
    byLanguage: [],
    byInputType: [],
    byMatchType: [],
  };
}

function buildEmptyLog(query: LogQuery): LogResponse {
  return { rows: [], total: 0, page: query.page, pageSize: query.pageSize };
}

// ---------------------------------------------------------------------------
// Lexicon + corrections telemetry — module-scoped so a save() persists across
// re-renders within the mock session, same as the real admin_settings row.
// ---------------------------------------------------------------------------

let mockLexicon: Lexicon = {
  version: 1,
  updatedAt: iso(3, 0),
  thresholds: { autoApply: 0.86, clarify: 0.72, gap: 0.08, minFuzzyLen: 5 },
  stoplist: ["where", "when", "the", "is", "are", "a", "an"],
  terms: [
    { canonical: "IUL", aliases: ["iom", "i o m", "ioul", "eul"], fuzzy: false },
    { canonical: "Wardanieh", aliases: ["wardania", "verdania"], fuzzy: true },
    { canonical: "HAICI", aliases: ["hi ci", "hi see", "hyacy"], fuzzy: true },
  ],
};

function buildCorrections(): CorrectionsResponse {
  return {
    topPairs: [
      { from: "iom", to: "IUL", count: 12, tier: "A" },
      { from: "verdania", to: "Wardanieh", count: 4, tier: "B" },
      { from: "hi see", to: "HAICI", count: 2, tier: "B" },
    ],
    clarifications: [
      {
        id: 41,
        timestamp: iso(1, 11, 20),
        rawQuestion: "is the campus near sourr",
        question: "is the campus near sourr",
        answer: 'I heard "sourr". Did you mean Tyre? Please ask again.',
        sessionId: "sess-clarify-1",
      },
      {
        id: 33,
        timestamp: iso(3, 15, 5),
        rawQuestion: "how do i get to khaldia",
        question: "how do i get to khaldia",
        answer: 'I heard "khaldia". Did you mean Khaldeh? Please ask again.',
        sessionId: "sess-clarify-2",
      },
    ],
  };
}

// Mirrors the real `Validate Lexicon` node closely enough to exercise the
// UI's error-surfacing path in mock mode — not a full reimplementation.
function validateMockLexicon(input: Lexicon): string | null {
  if (!input || !Array.isArray(input.terms)) return "lexicon.terms must be an array.";
  const seenCanonical = new Map<string, string>();
  const seenAlias = new Map<string, string>();
  for (const t of input.terms) {
    if (!t.canonical || !t.canonical.trim()) return "Every term needs a non-empty canonical name.";
    const canonKey = t.canonical.trim().toLowerCase();
    if (seenCanonical.has(canonKey)) {
      return `Duplicate canonical term "${t.canonical}" (also used by "${seenCanonical.get(canonKey)}").`;
    }
    seenCanonical.set(canonKey, t.canonical);
    for (const a of t.aliases) {
      const aliasKey = a.trim().toLowerCase();
      const owner = seenAlias.get(aliasKey);
      if (owner && owner !== t.canonical) {
        return `Alias "${a}" is claimed by both "${owner}" and "${t.canonical}" — aliases must be unique across all terms.`;
      }
      seenAlias.set(aliasKey, t.canonical);
    }
  }
  if (input.thresholds.autoApply <= input.thresholds.clarify) {
    return "thresholds.autoApply must be greater than thresholds.clarify.";
  }
  return null;
}

export type MockScenario = "full" | "empty";

/** A passcode of "" or the literal "wrong" is treated as incorrect even in
 *  mock mode, so the gate's 401 error path is exercisable too. Anything
 *  else "succeeds" like a real passcode would. */
function assertPasscode(passcode: string) {
  if (!passcode.trim() || passcode === "wrong") throw new AdminAuthError();
}

export function createMockAdminClient(
  scenario: MockScenario,
  role: AdminRole = "operator",
): AdminClient {
  /** Mirrors the workflow's 403: a client passcode cannot reach these. */
  function assertOperator() {
    if (role !== "operator") {
      throw new AdminForbiddenError(
        "This dashboard is analytics-only. Ask an operator for lexicon or branding changes.",
      );
    }
  }
  return {
    async fetchOverview(passcode, range) {
      assertPasscode(passcode);
      await new Promise((r) => setTimeout(r, 250));
      const base =
        scenario === "empty" ? buildEmptyOverview() : buildFullOverview(range);
      return { ...base, role };
    },
    async fetchLog(passcode, query) {
      assertPasscode(passcode);
      await new Promise((r) => setTimeout(r, 200));
      return scenario === "empty" ? buildEmptyLog(query) : buildFullLog(query);
    },
    async fetchLexicon(passcode) {
      assertPasscode(passcode);
      assertOperator();
      await new Promise((r) => setTimeout(r, 200));
      return mockLexicon;
    },
    async saveLexicon(passcode, lexicon) {
      assertPasscode(passcode);
      assertOperator();
      await new Promise((r) => setTimeout(r, 200));
      const err = validateMockLexicon(lexicon);
      if (err) throw new AdminValidationError(err);
      mockLexicon = { ...lexicon, updatedAt: new Date().toISOString() };
      return mockLexicon;
    },
    async fetchCorrections(passcode) {
      assertPasscode(passcode);
      assertOperator();
      await new Promise((r) => setTimeout(r, 200));
      return scenario === "empty" ? { topPairs: [], clarifications: [] } : buildCorrections();
    },
  };
}
