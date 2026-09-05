// Face-bound visitor records: the transcript and the profile the kiosk restores
// when the camera recognises someone.
//
// WHAT A UID IS, AND WHY IT IS THE GALLERY LABEL
//
// The vision backend never sends a face embedding to the browser. It matches
// SFace vectors against a gallery it rebuilds from its faces directory every
// five seconds and returns one thing: a label (opencam/backend/pipeline/
// face_matcher.py). So the only durable identifier this kiosk can ever hold is
// a gallery entry — which means "give this stranger a UID" and "enroll this
// stranger" are the same operation, and it is the one this module performs.
//
// Enrollment writes `<FACES_DIR>/<uid>/1.jpg`, a per-person SUBDIRECTORY. That
// is not a style choice. `_label_from_path` takes `relative.parts[0]` for a
// nested file, so the directory name becomes the label verbatim, and extra
// samples dropped in beside it strengthen the same identity. The flat
// alternative, `<uid>.jpg`, is passed through `_TRAILING_INDEX = /_\d+$/`,
// which would silently eat the tail of any uid ending in `_<digits>` and fuse
// two visitors into one. Generated uids avoid that shape anyway (see newUid),
// but the directory form makes it structurally impossible rather than merely
// unlikely.
//
// A uid NEVER changes. When a visitor later gives their name it is stored as
// `profile.displayName`; renaming the gallery directory would rewrite the key
// that every record and every n8n memory thread is filed under.

import { mkdir, readdir, rename, rm } from "node:fs/promises";

/** Per-uid JSON records. Bind-mounted; see docker-compose.yml. */
export const VISITOR_DIR = process.env.VISITOR_DIR ?? "/app/visitors";

/**
 * The vision backend's reference gallery — the SAME host directory it mounts
 * read-only at /faces. We hold it read-write because enrollment is a write to
 * that gallery and there is no other way in: the backend's REST surface is
 * GET /api/faces and POST /api/faces/reload, neither of which accepts an
 * upload. The backend rescans on a timer, so a written file is live within
 * about five seconds without calling back to it at all.
 */
export const FACES_DIR = process.env.FACES_DIR ?? "/app/faces";

/**
 * A uid is a path segment in two different filesystems, so it is validated
 * rather than sanitised — anything not obviously safe is refused, and nothing
 * is silently rewritten into something that is.
 *
 * Letters, digits, spaces, underscores and hyphens only, and it must both
 * start and end alphanumeric. That bars `.` and `..` outright, bars every path
 * separator on Linux and Windows, and bars the trailing dot or space that
 * Windows silently strips — which would otherwise let `foo ` and `foo` name
 * one directory while reading as two distinct uids.
 *
 * Spaces are allowed because human-enrolled identities already use them:
 * `faces/Mariam_Badawi.jpeg` is the label "Mariam Badawi", and that is as much
 * a uid as a generated one. One code path serves both.
 */
const UID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/;

export const isValidUid = (uid: unknown): uid is string =>
  typeof uid === "string" && UID_RE.test(uid);

/**
 * `v` + 10 hex characters.
 *
 * The leading letter is load-bearing: an all-digit uid would be a plausible
 * `_\d+` sample suffix, and `.replace("_", " ")` in the backend labeller means
 * underscores and hyphens are not identity-preserving either. Hex behind an
 * alpha prefix survives that function unchanged, so the label the camera
 * reports back is byte-identical to the uid written here.
 */
export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return "v" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VisitorFact {
  /** Short label, e.g. "faculty". Lowercased and deduplicated on write. */
  key: string;
  value: string;
  updatedAt: number;
}

export interface VisitorProfile {
  /** What the visitor said their name is, or null while still anonymous. */
  displayName: string | null;
  facts: VisitorFact[];
}

export interface VisitorRecord {
  uid: string;
  createdAt: number;
  updatedAt: number;
  lastSeen: number;
  /** Conversations, not turns: incremented once per wake, never per message. */
  visits: number;
  /** True when this kiosk enrolled the face itself, false for a staff photo. */
  enrolled: boolean;
  profile: VisitorProfile;
  messages: unknown[];
}

/** Caps. A kiosk transcript that grows without bound eventually stops loading. */
const MAX_MESSAGES = 400;
const MAX_FACTS = 60;
const MAX_FACT_LEN = 400;
/** Reference photos per visitor. More samples match better, with diminishing returns. */
export const MAX_SAMPLES = 5;

const recordPath = (uid: string) => `${VISITOR_DIR}/${encodeURIComponent(uid)}.json`;
const faceDir = (uid: string) => `${FACES_DIR}/${uid}`;

export function emptyRecord(uid: string, enrolled = false): VisitorRecord {
  const now = Date.now();
  return {
    uid,
    createdAt: now,
    updatedAt: now,
    lastSeen: now,
    visits: 0,
    enrolled,
    profile: { displayName: null, facts: [] },
    messages: [],
  };
}

export async function readRecord(uid: string): Promise<VisitorRecord | null> {
  const file = Bun.file(recordPath(uid));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as VisitorRecord;
    // A record written by an older shape, or a corrupt one, must not take the
    // kiosk down — the visitor is standing right there. Fill the gaps instead.
    return { ...emptyRecord(uid, parsed?.enrolled ?? false), ...parsed, uid };
  } catch (err) {
    console.error(`[visitors] record for ${uid} is not valid JSON`, err);
    return null;
  }
}

/**
 * Serialises writes per uid. Two saves can finish close together — the
 * transcript after a turn, and a profile delta from that same reply — and both
 * rewrite the whole record, so without ordering the later read-modify-write
 * can be built on a snapshot the earlier one has already superseded.
 */
const writeChains = new Map<string, Promise<unknown>>();

async function persist(record: VisitorRecord): Promise<void> {
  await mkdir(VISITOR_DIR, { recursive: true });
  const target = recordPath(record.uid);
  // Temp file in the SAME directory: a rename across filesystems fails with
  // EXDEV rather than moving anything. Same reasoning as persistBranding.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(tmp, JSON.stringify(record, null, 2));
  await rename(tmp, target);
}

/** Read-modify-write under this uid's chain. */
export async function updateRecord(
  uid: string,
  mutate: (record: VisitorRecord) => VisitorRecord,
): Promise<VisitorRecord> {
  const previous = writeChains.get(uid) ?? Promise.resolve();
  const job = previous.then(async () => {
    const current = (await readRecord(uid)) ?? emptyRecord(uid);
    const next = mutate(current);
    next.uid = uid;
    next.updatedAt = Date.now();
    await persist(next);
    return next;
  });
  // Keep the chain alive past a failure, so one bad write does not wedge every
  // subsequent save for this visitor.
  writeChains.set(uid, job.catch(() => undefined));
  return job;
}

/** Clamp anything that arrived from the browser before it reaches disk. */
export function sanitiseProfile(input: unknown, base: VisitorProfile): VisitorProfile {
  const raw = (input ?? {}) as Partial<VisitorProfile>;
  const displayName =
    typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim().slice(0, 120)
      : raw.displayName === null
        ? null
        : base.displayName;

  if (!Array.isArray(raw.facts)) return { displayName, facts: base.facts };

  // Later facts win: the extractor emits deltas, and a visitor correcting
  // themselves mid-conversation must overwrite rather than leave both on file.
  const merged = new Map<string, VisitorFact>();
  for (const fact of [...base.facts, ...raw.facts]) {
    const key = String((fact as VisitorFact)?.key ?? "").trim().toLowerCase().slice(0, 60);
    const value = String((fact as VisitorFact)?.value ?? "").trim().slice(0, MAX_FACT_LEN);
    if (!key || !value) continue;
    merged.set(key, { key, value, updatedAt: Date.now() });
  }

  return { displayName, facts: [...merged.values()].slice(-MAX_FACTS) };
}

export function clampMessages(input: unknown, base: unknown[]): unknown[] {
  if (!Array.isArray(input)) return base;
  return input.slice(-MAX_MESSAGES);
}

/**
 * Add one reference photo for `uid`, creating the gallery directory on first
 * call. Returns the sample number written, or null when the visitor already
 * holds MAX_SAMPLES.
 */
export async function addFaceSample(uid: string, file: Blob): Promise<number | null> {
  const dir = faceDir(uid);
  await mkdir(dir, { recursive: true });
  const existing = await readdir(dir).catch(() => [] as string[]);
  const samples = existing.filter((n) => /^\d+\.jpg$/.test(n));
  if (samples.length >= MAX_SAMPLES) return null;

  // Highest existing number + 1, rather than count + 1: a deleted middle
  // sample would otherwise make the next write overwrite a live one.
  const next =
    samples.reduce((max, name) => Math.max(max, parseInt(name, 10) || 0), 0) + 1;
  await Bun.write(`${dir}/${next}.jpg`, file);
  return next;
}

export async function countFaceSamples(uid: string): Promise<number> {
  const existing = await readdir(faceDir(uid)).catch(() => [] as string[]);
  return existing.filter((n) => /^\d+\.jpg$/.test(n)).length;
}

/**
 * Every gallery FILE that resolves to this uid.
 *
 * A uid this kiosk minted owns a directory, which is easy. A face a member of
 * staff added is a flat file at the gallery root — `Mariam_Badawi.jpeg`, or
 * `Mariam_Badawi_2.jpg` for a second reference — and the label is derived from
 * the filename by rules that live in the vision backend. This mirrors
 * `_label_from_path` in opencam/backend/pipeline/face_matcher.py: take the
 * stem, drop a trailing `_<digits>`, turn underscores and hyphens into spaces.
 *
 * The two are not one code path, and treating them as one is how "forget this
 * person" quietly became "forget their history but keep recognising them".
 */
async function flatGalleryFilesFor(uid: string): Promise<string[]> {
  const entries = await readdir(FACES_DIR, { withFileTypes: true }).catch(() => []);
  const wanted = uid.toLowerCase();
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = entry.name.slice(dot + 1).toLowerCase();
    if (!["png", "jpg", "jpeg", "bmp", "webp"].includes(ext)) continue;
    const label = entry.name
      .slice(0, dot)
      .replace(/_\d+$/, "")
      .replace(/[_-]/g, " ")
      .trim()
      .toLowerCase();
    if (label === wanted) out.push(`${FACES_DIR}/${entry.name}`);
  }
  return out;
}

/**
 * Forget a visitor completely: the transcript, the profile, and the face.
 *
 * Deleting the record alone would be worse than doing nothing — the gallery
 * entry would survive, so the person is still recognised, and the kiosk would
 * greet them under a uid it no longer holds any history for. Every half goes,
 * and the face goes even when the record was already missing.
 *
 * That includes a staff-curated photo. Removing someone's own file is a real
 * act and not one to take lightly, but this is the button a person is pointed
 * at when they ask to be forgotten, and a "deletion" that leaves them
 * recognisable is not one. The admin console labels which faces the kiosk
 * enrolled itself so an operator can see what they are about to remove.
 */
export async function forgetVisitor(uid: string): Promise<void> {
  await rm(recordPath(uid), { force: true });
  await rm(faceDir(uid), { recursive: true, force: true });
  for (const file of await flatGalleryFilesFor(uid)) {
    await rm(file, { force: true });
  }
}

export type VisitorSummary = Omit<VisitorRecord, "messages"> & {
  messageCount: number;
  samples: number;
};

/** Summaries for the admin console. Transcripts are deliberately not included. */
export async function listVisitors(): Promise<VisitorSummary[]> {
  const names = await readdir(VISITOR_DIR).catch(() => [] as string[]);
  const out: VisitorSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const uid = decodeURIComponent(name.slice(0, -".json".length));
    if (!isValidUid(uid)) continue;
    const record = await readRecord(uid);
    if (!record) continue;
    const { messages, ...rest } = record;
    out.push({
      ...rest,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      samples: await countFaceSamples(uid),
    });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}
