/**
 * The Lab's view of an edit's ELEMENT DENSITY, read before a ~14h 4K render.
 *
 * ⚠️ THIS MODULE COMPUTES NO DENSITY NUMBER AND HOLDS NO THRESHOLD. The single
 * source of truth for every target, floor, ceiling and finding message is
 * `hfp/density.py` in /opt/hyperframes-pipeline, which this container cannot
 * reach: the pipeline tree is not one of its mounts, so `hfp` is neither
 * importable nor executable here. The operator runs
 *
 *     hfp density <job>/project > <job>/project/density.json
 *
 * on the HOST, and that one self-contained document carries BOTH the scorecard
 * AND the thresholds it was judged against. This file's whole job is to find it,
 * prove it is not stale, and hand it to the browser untouched. Re-typing a
 * threshold in TypeScript here would create a second source of truth that
 * silently drifts from the code that actually rejects a cue sheet — so the only
 * numbers below are limits on what we are willing to read and return.
 *
 * ⚠️ AND IT IS READ-ONLY, ON PURPOSE. No writeFile, no mkdir, no rm, no spawn,
 * and no import from the writing half of jobs.ts. A density check must never be
 * able to become a render submit: a render is real money and real hours, and
 * Jake's rule is that a submit is an explicit, gated action in the Render queue.
 *
 * ⚠️ NO FALLBACKS. A missing, unreadable or wrong-schema density.json is
 * reported as exactly that. It is never patched, defaulted or coerced into a
 * partial scorecard — a defaulted count is the same lie as a defaulted
 * threshold, and would show a failing film as passing.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Shared with the host worker via a bind mount; see docker-compose.yml. */
const WORK = process.env.HYPERFRAMES_WORK || "/hyperframes-work";
const JOBS = path.join(WORK, "jobs");

/**
 * The same tree as WORK, spelled the way the HOST sees it.
 *
 * The empty-state copy is a command the operator pastes into a host shell, so it
 * must name the host path (`/opt/hyperframes-work`), not this container's mount
 * point (`/hyperframes-work`). Nothing here ever opens it.
 */
const HOST_WORK = process.env.HYPERFRAMES_HOST_WORK || "/opt/hyperframes-work";

/** The document version this reader understands. Bumped only by hfp. */
const SCHEMA = "hfp.density/1";

/**
 * The artifacts a PROJECT-derived scorecard is computed from. Used only when the
 * document itself names none — see artifactNames(), which prefers the document.
 */
const ARTIFACTS = [
  "camera-plan.json",
  "template-provenance.json",
  "screencast-handoff.json",
  "source-verification.json",
] as const;

/** Longest narration window the browser may ask for, in seconds. */
const MAX_WINDOW_SECONDS = 600;
/** Longest padding either side of a narration window, in seconds. */
const MAX_PAD_SECONDS = 10;
/** Padding used when the caller does not ask for any. */
const DEFAULT_PAD_SECONDS = 1.5;
/** Most words a narration slice will return. words.json itself is never returned. */
const MAX_WORDS = 400;

/**
 * The thinnest overlap that counts as "this was on screen", in seconds.
 *
 * ⚠️ NOT A DENSITY THRESHOLD — a rounding-noise floor, and it exists because of
 * a real defect. density.json rounds every timestamp to 2dp, and the browser
 * hands those rounded numbers straight back as a narration window. The shipped
 * film's longest graphics gap is 283.573→549.517, emitted as 283.57→549.52, so
 * the window overruns the two teaching boards that BOUND the gap by 0.003s at
 * each end. A bare `overlap > 0` test therefore answered the page's single most
 * important question — "what was on screen during the 4m26s dead stretch?" —
 * with "R012, a teaching board", which is the exact opposite of the truth and
 * the exact opposite of the defect the page exists to show. Anything thinner
 * than half a rounded frame is the rounding, not a graphic.
 */
const MIN_OVERLAP_SECONDS = 0.05;

/* ────────────────────────── paths, guarded ────────────────────────── */

// ⚠️ NAMES COME FROM A BROWSER, SO THEY ARE NEVER TRUSTED AS PATHS. Copied
// verbatim from jobs.ts, where both the pattern and the resolve re-check are
// module-private. Re-declared rather than exported from there because jobs.ts
// owns the render queue and is not edited by this tool. DO NOT WIDEN IT.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function safeJoin(root: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid name: ${name}`);
  const full = path.resolve(root, name);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Invalid name: ${name}`);
  }
  return full;
}

const jobDir = (id: string): string => safeJoin(JOBS, id);
const projectDir = (id: string): string => path.join(jobDir(id), "project");

/**
 * Resolve a relative path recorded INSIDE a project file (e.g. a scene config)
 * and prove it stays under the project directory.
 *
 * ⚠️ The contents of a project file are no more trusted than a URL parameter:
 * `"config": "../../../etc/passwd"` is one string edit away. Containment is
 * re-checked after resolution rather than by inspecting the string.
 */
function safeUnder(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the project: ${rel}`);
  }
  return full;
}

/* ────────────────────────── json, without lying ────────────────────────── */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isEnoent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One decimal place, for a duration we derived rather than were handed. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The swallow-everything read, used ONLY where a missing or half-written file is
 * genuinely normal — job.json for a display name. Never used for density.json:
 * see readDensity, which distinguishes absent from corrupt on purpose.
 */
async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/* ────────────────────────── the four-state read ────────────────────────── */

/**
 * Where density.json may live, in priority order.
 * a. project/density.json — canonical; survives the inbox→project move.
 * b. density.json         — a hand-placed file at the job root.
 * Nowhere else.
 */
const CANDIDATES = ["project/density.json", "density.json"] as const;

type Read =
  | { state: "ok"; doc: Json; path: string }
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | { state: "wrong-schema"; reason: string; found: string | null };

/**
 * ⚠️ DELIBERATELY NOT readJson(file, fallback). That helper swallows a corrupt
 * file, and an empty fallback here would render a failing film against zero
 * targets and show it as a pass. Absent, unreadable and wrong-schema are three
 * different answers and the UI shows three different screens.
 */
async function readDensity(id: string): Promise<Read> {
  const dir = jobDir(id);
  let firstFailure: Read | null = null;

  for (const rel of CANDIDATES) {
    const file = path.join(dir, rel);
    let text: string;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      const reason = err instanceof Error ? err.message : String(err);
      firstFailure ??= { state: "unreadable", reason };
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      firstFailure ??= { state: "unreadable", reason: `${rel}: ${reason}` };
      continue;
    }

    if (!isObj(parsed)) {
      firstFailure ??= {
        state: "wrong-schema",
        reason: `${rel} is not a JSON object.`,
        found: null,
      };
      continue;
    }

    // A STRUCTURAL check and nothing more. This module does not validate the
    // scorecard's contents — hfp already did, and re-checking here would be a
    // second opinion with no source of truth behind it.
    const found = str(parsed.schema);
    const verdict = isObj(parsed.verdict) ? parsed.verdict : null;
    const edit = isObj(parsed.edit) ? parsed.edit : null;
    const structural =
      found === SCHEMA &&
      typeof verdict?.ok === "boolean" &&
      Array.isArray(parsed.elements) &&
      typeof edit?.durationSeconds === "number";

    if (!structural) {
      const reason =
        found !== SCHEMA
          ? `${rel} declares schema ${found === null ? "nothing" : `"${found}"`}; this Lab reads "${SCHEMA}".`
          : `${rel} is missing one of verdict.ok, elements[] or edit.durationSeconds.`;
      firstFailure ??= { state: "wrong-schema", reason, found };
      continue;
    }

    return { state: "ok", doc: parsed, path: rel };
  }

  return firstFailure ?? { state: "absent" };
}

/** The command that produces the file. Typed on the HOST, never run from here. */
function densityCommand(id: string): string {
  const project = `${HOST_WORK}/jobs/${id}/project`;
  return `hfp density ${project} > ${project}/density.json`;
}

async function jobName(id: string): Promise<string> {
  const spec = await readJsonOr<{ name?: string }>(path.join(jobDir(id), "job.json"), {});
  return spec.name || id;
}

/* ────────────────────────── the report ────────────────────────── */

/** One source artifact, re-hashed off disk right now. */
export interface DensityArtifact {
  name: string;
  present: boolean;
  /** sha256 of the bytes on disk this instant; null when the file is gone. */
  sha256: string | null;
  /** What density.json recorded when it was computed; null when it recorded none. */
  expected: string | null;
  matches: boolean;
}

export type DensityReport =
  | {
      state: "ok";
      id: string;
      name: string;
      /** Which candidate hit, relative to the job directory. */
      path: string;
      rawUrl: string;
      /** True iff any source artifact no longer hashes to what was scored. */
      stale: boolean;
      artifacts: DensityArtifact[];
      /** hfp's document, passed through VERBATIM. No mapping, no defaults. */
      scorecard: Json;
    }
  | { state: "absent"; id: string; name: string; reason: string; command: string }
  | { state: "unreadable"; id: string; name: string; reason: string; command: string }
  | {
      state: "wrong-schema";
      id: string;
      name: string;
      reason: string;
      found: string | null;
      expected: string;
      command: string;
    };

async function sha256File(file: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(file);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * ⚠️ FRESHNESS IS PROVED BY CONTENT, NOT BY mtime. An artifact rewritten with
 * the same timestamp, or re-staged from a copy, lies about its mtime; a hash
 * does not. The four files total ~65KB, so this is cheap enough to do on every
 * report and needs no cache.
 */
/**
 * Which files this document claims to have been computed from.
 *
 * ⚠️ THE DOCUMENT DECIDES, NOT A CONSTANT HERE. `hfp density` also accepts a
 * cue-sheet.json, and that document records exactly one artifact — its own file
 * name. Hashing the four project artifacts against it made all four `expected`
 * null, every `matches` false, and every cue-sheet scorecard render as "the edit
 * changed after it was scored" the moment it loaded. A false stale banner on a
 * fresh document is the same class of lie as a stale pass. The frozen four are
 * kept only as the fallback for a document that names none.
 */
function artifactNames(doc: Json): string[] {
  const source = isObj(doc.source) ? doc.source : null;
  const declared = source && Array.isArray(source.artifacts) ? source.artifacts : null;
  const names = (declared ?? [])
    .map(str)
    .filter((n): n is string => n !== null && n.length > 0);
  return names.length ? names : [...ARTIFACTS];
}

async function verifyArtifacts(id: string, doc: Json): Promise<DensityArtifact[]> {
  const source = isObj(doc.source) ? doc.source : null;
  const recorded = source && isObj(source.sha256) ? source.sha256 : null;
  const dir = projectDir(id);

  return Promise.all(
    artifactNames(doc).map(async (name): Promise<DensityArtifact> => {
      // A name out of a project file is no more trusted than a URL parameter.
      let file: string | null = null;
      try {
        file = safeUnder(dir, name);
      } catch {
        file = null;
      }
      const sha256 = file === null ? null : await sha256File(file);
      const expected = recorded ? str(recorded[name]) : null;
      return {
        name,
        present: sha256 !== null,
        sha256,
        expected,
        // Unproven is not the same as proven-equal: a file we cannot read, or
        // one the scorecard never recorded, does NOT get a green tick.
        matches: sha256 !== null && expected !== null && sha256 === expected,
      };
    }),
  );
}

export async function report(id: string): Promise<DensityReport> {
  if (!(await exists(jobDir(id)))) throw new Error("No such job.");
  const name = await jobName(id);
  const read = await readDensity(id);
  const command = densityCommand(id);

  if (read.state === "absent") {
    return { state: "absent", id, name, reason: "No density.json in this job.", command };
  }
  if (read.state === "unreadable") {
    return { state: "unreadable", id, name, reason: read.reason, command };
  }
  if (read.state === "wrong-schema") {
    return {
      state: "wrong-schema",
      id,
      name,
      reason: read.reason,
      found: read.found,
      expected: SCHEMA,
      command,
    };
  }

  const artifacts = await verifyArtifacts(id, read.doc);
  return {
    state: "ok",
    id,
    name,
    path: read.path,
    rawUrl: `/api/hyperframes/files/${id}/${read.path}`,
    stale: artifacts.some((a) => !a.matches),
    artifacts,
    scorecard: read.doc,
  };
}

/* ────────────────────────── the triage index ────────────────────────── */

export interface DensityIndexRow {
  id: string;
  name: string;
  hasScorecard: boolean;
  state: "ok" | "absent" | "unreadable" | "wrong-schema";
  generatedAt: string | null;
  hfpVersion: string | null;
  durationSeconds: number | null;
  ok: boolean | null;
  errors: number | null;
  warnings: number | null;
}

/**
 * Every job, newest first, with just enough of its scorecard to triage.
 *
 * ⚠️ NO ARTIFACT HASHING HERE. Fifty jobs would be two hundred file hashes on a
 * page load; staleness is a per-report question. And a job with no density.json
 * is a NORMAL row with nulls — never an error, and never zeros, because a zero
 * count reads as a measurement.
 */
export async function index(): Promise<{ jobs: DensityIndexRow[] }> {
  let names: string[];
  try {
    names = (await fsp.readdir(JOBS, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name))
      .map((e) => e.name);
  } catch {
    return { jobs: [] };
  }

  const rows = await Promise.all(
    names.map(async (id) => {
      const mtime = await fsp
        .stat(jobDir(id))
        .then((st) => st.mtimeMs)
        .catch(() => 0);
      const name = await jobName(id);
      const read = await readDensity(id);

      if (read.state !== "ok") {
        return {
          mtime,
          row: {
            id,
            name,
            hasScorecard: false,
            state: read.state,
            generatedAt: null,
            hfpVersion: null,
            durationSeconds: null,
            ok: null,
            errors: null,
            warnings: null,
          } satisfies DensityIndexRow,
        };
      }

      const verdict = isObj(read.doc.verdict) ? read.doc.verdict : null;
      const edit = isObj(read.doc.edit) ? read.doc.edit : null;
      return {
        mtime,
        row: {
          id,
          name,
          hasScorecard: true,
          state: "ok",
          generatedAt: str(read.doc.generatedAt),
          hfpVersion: str(read.doc.hfpVersion),
          durationSeconds: edit ? num(edit.durationSeconds) : null,
          ok: verdict && typeof verdict.ok === "boolean" ? verdict.ok : null,
          errors: verdict ? num(verdict.errors) : null,
          warnings: verdict ? num(verdict.warnings) : null,
        } satisfies DensityIndexRow,
      };
    }),
  );

  rows.sort((a, b) => b.mtime - a.mtime);
  return { jobs: rows.map((r) => r.row) };
}

/* ────────────────────────── the narration slice ────────────────────────── */

export interface NarrationWord {
  word: string;
  start: number;
  end: number;
  /** False for the padding either side of the asked-for window. */
  inSpan: boolean;
}

export interface NarrationSlice {
  id: string;
  window: { start: number; end: number; padSeconds: number };
  words: NarrationWord[];
  text: string;
  truncated: boolean;
  onScreen: {
    template: string;
    scene: string;
    start: number;
    end: number;
    /** The scene config, parsed verbatim. Null-checked by returning onScreen:null. */
    config: unknown;
  } | null;
  screencast: {
    id: string;
    title: string;
    start: number;
    end: number;
    seconds: number;
    narration: string;
  } | null;
}

/**
 * ⚠️ words.json IS 507KB AND USES startTime/endTime, NOT start/end. It is never
 * returned — only the slice — because every /api/fn result is stringified for
 * the log preview. One entry of cache, keyed by path+mtime, so clicking through
 * marks on the film strip does not re-parse half a megabyte each time.
 */
let wordsCache: { key: string; words: NarrationWord[] } | null = null;

async function loadWords(id: string): Promise<NarrationWord[]> {
  const file = path.join(projectDir(id), "words.json");
  let mtimeMs: number;
  try {
    mtimeMs = (await fsp.stat(file)).mtimeMs;
  } catch {
    return [];
  }
  const key = `${file}:${mtimeMs}`;
  if (wordsCache && wordsCache.key === key) return wordsCache.words;

  const raw = await readJsonOr<unknown>(file, null);
  if (!Array.isArray(raw)) return [];

  const words: NarrationWord[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const word = str(entry.word);
    const start = num(entry.startTime);
    const end = num(entry.endTime);
    if (word === null || start === null || end === null) continue;
    words.push({ word, start, end, inSpan: false });
  }
  words.sort((a, b) => a.start - b.start);
  wordsCache = { key, words };
  return words;
}

/** Do [aStart,aEnd] and [bStart,bEnd] overlap at all? */
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

/** Length of the overlap, or 0. Used to pick the BEST match, not the first. */
const overlapSeconds = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * Overlap that survives the document's 2dp rounding. See MIN_OVERLAP_SECONDS:
 * a span that merely abuts the window was not on screen during it.
 */
const reallyOverlaps = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean => overlapSeconds(aStart, aEnd, bStart, bEnd) >= MIN_OVERLAP_SECONDS;

async function onScreenAt(
  id: string,
  start: number,
  end: number,
): Promise<NarrationSlice["onScreen"]> {
  const dir = projectDir(id);
  const rows = await readJsonOr<unknown>(path.join(dir, "template-provenance.json"), null);
  if (!Array.isArray(rows)) return null;

  let best: { template: string; scene: string; start: number; end: number; config: string | null } | null = null;
  let bestOverlap = 0;
  for (const row of rows) {
    if (!isObj(row)) continue;
    const rStart = num(row.start);
    const rEnd = num(row.end);
    const template = str(row.template);
    if (rStart === null || rEnd === null || template === null) continue;
    if (!reallyOverlaps(rStart, rEnd, start, end)) continue;
    const o = overlapSeconds(rStart, rEnd, start, end);
    if (best !== null && o <= bestOverlap) continue;
    bestOverlap = o;
    best = { template, scene: str(row.scene) ?? "", start: rStart, end: rEnd, config: str(row.config) };
  }
  if (!best) return null;
  if (best.config === null) return null;

  // A missing or unreadable config is reported as "nothing on screen we can
  // show", never as a guess at what the template would have rendered.
  let config: unknown;
  try {
    const file = safeUnder(dir, best.config);
    config = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
  return { template: best.template, scene: best.scene, start: best.start, end: best.end, config };
}

async function screencastAt(
  id: string,
  start: number,
  end: number,
): Promise<NarrationSlice["screencast"]> {
  const rows = await readJsonOr<unknown>(
    path.join(projectDir(id), "screencast-handoff.json"),
    null,
  );
  if (!Array.isArray(rows)) return null;

  let best: NarrationSlice["screencast"] = null;
  let bestOverlap = 0;
  for (const row of rows) {
    if (!isObj(row)) continue;
    // ⚠️ destination_in / destination_out, NOT start / end. Reading start/end
    // here silently yields nothing at all.
    const rStart = num(row.destination_in);
    const rEnd = num(row.destination_out);
    if (rStart === null || rEnd === null) continue;
    if (!reallyOverlaps(rStart, rEnd, start, end)) continue;
    const o = overlapSeconds(rStart, rEnd, start, end);
    if (best !== null && o <= bestOverlap) continue;
    bestOverlap = o;
    best = {
      id: str(row.id) ?? "",
      title: str(row.title) ?? "",
      start: rStart,
      end: rEnd,
      seconds: round1(rEnd - rStart),
      narration: str(row.narration) ?? "",
    };
  }
  return best;
}

export async function narration(
  id: string,
  start: number,
  end: number,
  padSeconds?: number,
): Promise<NarrationSlice> {
  if (!(await exists(jobDir(id)))) throw new Error("No such job.");

  if (!Number.isFinite(start) || start < 0) throw new Error("start must be a number >= 0.");
  if (!Number.isFinite(end) || end <= start) throw new Error("end must be greater than start.");
  if (end - start > MAX_WINDOW_SECONDS) {
    throw new Error(`Window is longer than ${MAX_WINDOW_SECONDS}s.`);
  }
  const pad = padSeconds === undefined ? DEFAULT_PAD_SECONDS : padSeconds;
  if (!Number.isFinite(pad) || pad < 0 || pad > MAX_PAD_SECONDS) {
    throw new Error(`padSeconds must be between 0 and ${MAX_PAD_SECONDS}.`);
  }

  const from = Math.max(0, start - pad);
  const to = end + pad;

  const all = await loadWords(id);
  const inWindow = all.filter((w) => overlaps(w.start, w.end, from, to));
  const truncated = inWindow.length > MAX_WORDS;
  const words = inWindow.slice(0, MAX_WORDS).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    inSpan: overlaps(w.start, w.end, start, end),
  }));

  const [onScreen, screencast] = await Promise.all([
    onScreenAt(id, start, end),
    screencastAt(id, start, end),
  ]);

  return {
    id,
    window: { start, end, padSeconds: pad },
    words,
    text: words.map((w) => w.word).join(" "),
    truncated,
    onScreen,
    screencast,
  };
}
