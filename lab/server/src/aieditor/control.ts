/**
 * Auto Editor — the Lab's view of a job (raw narration → clean edit).
 *
 * ⚠️ THIS MODULE IS A CONTROL PLANE, NOT A RUNNER — the same split as the Render
 * queue and the Video Editor. It writes request.json / queue.json / cancel /
 * plan.edit.json into a job directory and reads files back. The
 * `aieditor-worker` systemd service on the HOST (/opt/clipmagic/aieditor) does all
 * media work: it shells out to Docker for ffmpeg and the aligner, and a 46-minute
 * job must outlive this container, a Lab rebuild and the browser tab.
 *
 *   /aieditor-work/jobs/<id>/   (host: /opt/aieditor-work/jobs/<id>/)
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { claimUpload, getUpload, UPLOAD_ID_RE } from "./uploads.js";
import { jobSourceOf } from "./library.js";
import { assertJobDeletable, freedByJobs, readDeleted, walkAll } from "./storage.js";
import { handoffPackages, parseHandoff, withHandoff } from "./handoff.js";

const ROOT = process.env.AIEDITOR_WORK || "/aieditor-work";
const JOBS = path.join(ROOT, "jobs");
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHARE_RE = /^https:\/\/share\.descript\.com\/view\/[A-Za-z0-9_-]{6,64}\/?$/;
const MAX_SCRIPT = 200_000;

export const STAGES: { id: string; title: string }[] = [
  { id: "download", title: "Download from Descript" },
  { id: "audio", title: "Extract audio" },
  { id: "transcribe", title: "Transcribe (word level)" },
  { id: "align", title: "Re-time every word" },
  { id: "takes", title: "Pick the best takes" },
  { id: "cut", title: "Build the cut" },
  { id: "listen", title: "Sound check" },
  { id: "graphics", title: "Plan graphics + camera, render graphics" },
  { id: "preview", title: "Render video preview" },
  { id: "compose", title: "Composite graphics + captions + SFX" },
  { id: "final", title: "Final render (full resolution)" },
];

/**
 * Jake 2026-10-08: "there are 2 workflows: 1. Cut an unedited narration 2. Creative Edit an
 * edited narration." request.json "workflow" — jobs from before the field are "cut".
 *   cut       download → … → takes → cut → sound check → graphics/preview → compose
 *   creative  the narration is already edited: takes/cut/sound check are skipped, the whole
 *             timeline is kept, then pre-production (stage 0 of the creative edit — the
 *             worker runs aieditor/preprod.py when it exists, else marks it skipped)
 * The stage ORDER follows what the worker does: long-form renders the preview first (it is
 * the full edit's base), shorts plan the graphics first (the camera framings need them).
 */
export type Workflow = "cut" | "creative";
export const WORKFLOWS: { id: Workflow; title: string }[] = [
  { id: "cut", title: "Cut an unedited narration" },
  { id: "creative", title: "Creative edit an edited narration" },
];

export function workflowOf(req: any): Workflow {
  return req?.workflow === "creative" ? "creative" : "cut";
}

/**
 * Where source.mp4 comes from — request.json "source.kind" (the worker: aieditor/sources.py).
 *   descript  a Descript share link, downloaded (every job before 2026-10-08)
 *   job       a finished Lab edit of workflow 1 (final-NN.mp4, else preview-NN.mp4) — a
 *             preview only when its cut was reviewed (REVIEW GATE below)
 *   upload    a file uploaded from the computer (aieditor/uploads.ts) — kept as a library
 *             narration after use (./library.ts), any number of jobs may use it
 *   job_source  an uploaded narration whose _uploads folder is gone (before the library):
 *             the source.mp4 of an earlier job that used it (./library.ts)
 * The last three are hard-linked into the job on the host. Jake 2026-10-08: the creative
 * workflow may start from any of the three; the cut workflow keeps Descript only.
 */
export type SourceKind = "descript" | "job" | "upload" | "job_source";
export const SOURCE_KINDS: Record<Workflow, SourceKind[]> = {
  cut: ["descript"],
  creative: ["descript", "job", "upload", "job_source"],
};
const LAB_FILE_RE = /^(final|preview)-\d{2}\.mp4$/;

export function sourceKindOf(req: any): SourceKind {
  const k = req?.source?.kind;
  return k === "job" || k === "upload" || k === "job_source" ? k : "descript";
}

const SOURCE_STAGE_TITLE: Record<SourceKind, string> = {
  descript: "Download from Descript",
  job: "Use the Lab edit",
  upload: "Use the uploaded file",
  job_source: "Use the uploaded file",
};

export function stagesFor(workflow: Workflow, format: string, source: SourceKind = "descript"): { id: string; title: string }[] {
  const t = (id: string, title: string) => ({ id, title });
  const head = [
    t("download", SOURCE_STAGE_TITLE[source] ?? SOURCE_STAGE_TITLE.descript),
    t("audio", "Extract audio"),
    t("transcribe", "Transcribe (word level)"),
    t("align", "Re-time every word"),
  ];
  const cut = workflow === "cut"
    ? [t("takes", "Pick the best takes"), t("cut", "Build the cut"), t("listen", "Sound check")]
    : [t("timeline", "Keep the edited timeline (no cuts)"), t("preprod", "Pre-production")];
  const tail = format === "long"
    ? [
      t("preview", "Render video preview (the edit's base)"),
      t("graphics", "Screencasts + overlays (plan, record, render)"),
      t("compose", "Compose the full edit (camera, bubble, overlays, music)"),
    ]
    : [
      t("graphics", "Plan graphics + camera, render graphics"),
      t("preview", "Render video preview"),
      t("compose", "Composite graphics + captions + SFX"),
    ];
  return [...head, ...cut, ...tail, t("final", "Final render (full resolution)")];
}

/**
 * Typical seconds per stage for a job with `minutes` of source — the median, per minute of
 * source, of every finished (not reused) run of that stage in the other jobs on disk. It
 * drives the overall progress bar and the ETA of stages that report no fraction of their own.
 * Cached for a minute (it reads every job's status.json).
 */
let expectCache: { at: number; rates: Record<string, number> } | null = null;
async function stageRates(): Promise<Record<string, number>> {
  if (expectCache && Date.now() - expectCache.at < 60_000) return expectCache.rates;
  const samples: Record<string, number[]> = {};
  let names: string[] = [];
  try { names = await fsp.readdir(JOBS); } catch { names = []; }
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const st = await readJson<any>(path.join(JOBS, id, "status.json"));
    const src = await readJson<any>(path.join(JOBS, id, "source.json"));
    const req = await readJson<any>(path.join(JOBS, id, "request.json"));
    const mins = Number(src?.duration) / 60;
    if (!st?.stages || !(mins > 0.1)) continue;
    for (const [name, s] of Object.entries<any>(st.stages)) {
      if (s?.state !== "done" || s.note === "reused" || !s.started_at || !s.finished_at) continue;
      const secs = s.finished_at - s.started_at;
      if (!(secs >= 0) || secs > 6 * 3600) continue;
      const key = ["preview", "graphics", "compose", "final"].includes(name) ? `${name}:${req?.format}` : name;
      (samples[key] ??= []).push(secs / mins);
    }
  }
  const rates: Record<string, number> = {};
  for (const [k, xs] of Object.entries(samples)) {
    xs.sort((a, b) => a - b);
    rates[k] = xs[Math.floor(xs.length / 2)];
  }
  expectCache = { at: Date.now(), rates };
  return rates;
}

async function expectedSeconds(stages: { id: string }[], format: string, sourceSeconds: number | null) {
  const out: Record<string, number | null> = {};
  const rates = await stageRates();
  const mins = sourceSeconds ? sourceSeconds / 60 : null;
  for (const s of stages) {
    const r = rates[`${s.id}:${format}`] ?? rates[s.id];
    out[s.id] = mins && r !== undefined ? Math.round(r * mins * 10) / 10 : null;
  }
  return out;
}

/** One line of events.jsonl (see aieditor/events.py). */
export interface AutoEvent {
  t: number; stage: string; kind: string; level: "info" | "warn" | "error"; msg: string;
  sub?: string; model?: string; usd?: number; secs?: number; frac?: number; proc?: string; phase?: string;
  state?: string; tokens?: Record<string, number>;
}

function levelOf(msg: string): "info" | "warn" | "error" {
  const low = msg.toLowerCase();
  if (msg.startsWith("FAILED") || low.includes("traceback") || low.slice(0, 200).includes(" error")) return "error";
  if (["failed", "dropped", "stopped early", "warning", "retry", "trying again", "not enough", "skipped", "restarting"]
    .some((w) => low.includes(w))) return "warn";
  return "info";
}

/**
 * log.txt → events, for jobs (or the parts of a job) the worker ran before events.jsonl
 * existed: "stage X start" opens a stage, untimestamped lines (tracebacks) continue the
 * previous entry. The worker writes UTC (the box runs UTC).
 */
function parseLegacyLog(text: string): AutoEvent[] {
  const out: AutoEvent[] = [];
  let stage = "job";
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (.*)$/.exec(line);
    if (!m) {
      if (out.length && line.trim()) out[out.length - 1].msg += "\n" + line;
      continue;
    }
    const t = Date.parse(`${m[1]}T${m[2]}Z`) / 1000;
    const msg = m[3];
    const st = /^stage (\w+) (start|done)\b ?(.*)$/.exec(msg);
    if (st) {
      if (st[2] === "start") {
        stage = st[1];
        out.push({ t, stage, kind: "stage", level: "info", msg: `▶ ${st[1]} started`, state: "running" });
      } else {
        out.push({ t, stage: st[1], kind: "stage", level: "info", msg: `✓ ${st[1]} done${st[3] ? ` — ${st[3]}` : ""}`, state: "done" });
        stage = "job";
      }
      continue;
    }
    if (msg.startsWith("claimed action=")) stage = "job";
    out.push({ t, stage, kind: "log", level: levelOf(msg), msg });
    if (msg.startsWith("FAILED") || msg === "cancelled") stage = "job";
  }
  return out;
}

const EVENTS_MAX_BYTES = 3 * 1024 * 1024;     // the first read of a huge log starts here from the end

/**
 * The job's structured log, incrementally: `after` = the byte offset the page already has
 * (0 on the first call). Returns the new events and the offset to ask from next time.
 * `replace` = drop what you have and show these (the first read, or a legacy-only job).
 */
export async function getEvents(id: string, after: unknown) {
  const dir = jobDir(id);
  const file = path.join(dir, "events.jsonl");
  let size = 0;
  try { size = (await fsp.stat(file)).size; } catch { size = -1; }
  let from = Math.max(0, Math.floor(Number(after) || 0));
  if (size < 0) {
    // no structured log yet (an older job, or the worker before events.jsonl): log.txt
    let text = "";
    try { text = await fsp.readFile(path.join(dir, "log.txt"), "utf8"); } catch { text = ""; }
    const truncated = text.length > EVENTS_MAX_BYTES;
    if (truncated) text = text.slice(text.indexOf("\n", text.length - EVENTS_MAX_BYTES) + 1);
    return { events: parseLegacyLog(text), next: 0, replace: true, legacy: true, truncated };
  }
  if (from > size) from = 0;                     // the file was replaced: start over
  const replace = from === 0;
  let truncated = false;
  if (replace && size > EVENTS_MAX_BYTES) {
    from = size - EVENTS_MAX_BYTES;
    truncated = true;
  }
  const fh = await fsp.open(file, "r");
  let buf: Buffer;
  try {
    const len = Math.min(size - from, EVENTS_MAX_BYTES);
    buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from);
  } finally {
    await fh.close();
  }
  // only whole lines: a line the worker is still writing waits for the next poll
  let text = buf.toString("utf8");
  let start = 0;
  if (truncated) start = text.indexOf("\n") + 1;
  const end = text.lastIndexOf("\n") + 1;
  const next = from + Buffer.byteLength(text.slice(0, end), "utf8");
  text = text.slice(start, end);
  const events: AutoEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a torn line: skip it */ }
  }
  let legacyHead: AutoEvent[] = [];
  if (replace && !truncated) {
    // a job that started under the old worker: its earlier history only exists in log.txt
    try {
      const firstT = events[0]?.t ?? Infinity;
      const old = parseLegacyLog(await fsp.readFile(path.join(dir, "log.txt"), "utf8"));
      legacyHead = old.filter((e) => e.t < firstT - 1);
    } catch { legacyHead = []; }
  }
  return { events: [...legacyHead, ...events], next, replace, legacy: false, truncated };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, obj: unknown) {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
  await fsp.rename(tmp, file);
}

function jobDir(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Unknown job.");
  return path.join(JOBS, id);
}

async function exists(file: string) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function serviceStatus() {
  const hb = await readJson<{ at: number }>(path.join(ROOT, "worker-heartbeat.json"));
  const seen = hb?.at ?? null;
  return {
    workerAlive: !!seen && Date.now() / 1000 - seen < 30,
    workerSeenAt: seen,
    stages: STAGES,
  };
}

export interface CreateInput {
  /** a Descript share link (source kind "descript") */
  url?: string;
  /** a Lab edit or an upload instead of a link (creative workflow) */
  source?: { kind?: string; job?: string; file?: string; upload?: string };
  // kind "job_source" = a library narration of an earlier job (./library.ts): {kind, job}
  format?: string;
  sponsored?: boolean | null;
  script?: string;
  title?: string;
  /** long-form: websites the screencasts may show, one per line */
  sites?: string;
  /** "cut" = 1. Cut an unedited narration, "creative" = 2. Creative edit an edited narration */
  workflow?: string;
  /** where the heavy steps run: "auto" (a factory server when the factory is on), "factory", "box" */
  runOn?: string;
  /**
   * "creative" = ONE SUBMISSION = A FINISHED EDIT (the "Full edit: raw narration → finished video"
   * card): a cut job (factory takes policy, no review step) that the worker carries on into a creative
   * edit by itself — aieditor/chain.py. Only with workflow "cut".
   */
  chain?: string;
  /** "Graphics only — editor adds screencasts" (./handoff.ts): long-form creative only */
  handoff?: boolean;
}

export type RunOn = "auto" | "factory" | "box";
/** request.json "run_on" — the worker honours it (aieditor/cloud.enabled_for). */
export function parseRunOn(v: unknown): RunOn {
  if (v === undefined || v === null || v === "") return "auto";
  if (v === "auto" || v === "factory" || v === "box") return v;
  throw new Error("Run on must be auto, factory or box.");
}

/** "one URL per line (optional: url — note)" → [{url, note}], public http(s) only, ≤ 6 */
function parseSites(raw: unknown): { url: string; note: string }[] {
  const out: { url: string; note: string }[] = [];
  for (const line of String(raw ?? "").split(/\n+/)) {
    const [u, ...rest] = line.trim().split(/\s+[—-]\s+/);
    if (!u) continue;
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); } catch { throw new Error(`Not a website address: ${u}`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a website address: ${u}`);
    out.push({ url: url.toString(), note: rest.join(" — ").slice(0, 200) });
  }
  if (out.length > 6) throw new Error("Up to 6 websites.");
  return out;
}

/**
 * ⚠️ REVIEW GATE (Jake 2026-10-09: "it also did cuts inside the narration that I didn't ask
 * for"). A cut job writes preview-NN.mp4 as soon as its AUTOMATIC cut exists, before Jake has
 * seen one removal; the factory edit he watched started from such a preview (factory-e2e-test:
 * 53 joins incl. 3 whole sentences, review.json edited:false, no final). Mirrors
 * aieditor/sources.py review_status():
 *   final       the final itself, or a preview whose final-NN.mp4 exists
 *   reviewed    review.json edited:true (Jake changed the cut) or approved:true
 *   verified    wordiff.json: a factory-policy cut with 0 unapproved removals
 *   unreviewed  anything else — "Unreviewed automatic cut": NEVER a creative source, not offered
 *               in the picker, refused by createJob. There is no override (Jake 2026-10-09: "when a
 *               job is being submitted for a new video - I don't want a review step from my side -
 *               everything should be made automatically"): a Full edit re-cuts a cut that fails the
 *               word check by itself (aieditor/chain.py).
 */
export type ReviewStatus = "final" | "reviewed" | "verified" | "unreviewed";
export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  final: "Final render",
  reviewed: "Reviewed cut",
  verified: "Factory cut — every word kept",
  unreviewed: "Unreviewed automatic cut",
};
export const ACCEPTED: ReviewStatus[] = ["final", "reviewed", "verified"];

/** Pure: the review status of one video file of a cut job + the spoken words its joins removed. */
export function reviewStatusOf(
  file: string, hasFinal: boolean, review: any, edl: any, wordiff: any,
): { review: ReviewStatus; removedWords: number | null; removals: number | null } {
  const m = /^(final|preview)-(\d{2})\.mp4$/.exec(file);
  const k = m ? Number(m[2]) : 1;
  const v = edl?.videos?.[k - 1];
  const joins: any[] = Array.isArray(v?.joins) ? v.joins : [];
  const words = (j: any) => String(j?.removed ?? "").split(/\s+/).filter(Boolean).length;
  const removedWords = v ? joins.reduce((n, j) => n + words(j), 0) : null;
  const removals = v ? joins.filter((j) => words(j) > 0).length : null;
  const out = { removedWords, removals };
  if (m?.[1] === "final" || hasFinal) return { review: "final", ...out };
  if (review?.edited === true || review?.approved === true) return { review: "reviewed", ...out };
  if (wordiff?.policy === "factory" && wordiff?.unapproved === 0 && "approved_by" in wordiff) {
    return { review: "verified", ...out };
  }
  return { review: "unreviewed", ...out };
}

/** A finished Lab edit of workflow 1 that may be a creative edit's source. */
export interface LabEdit {
  id: string;
  title: string;
  format: string | null;
  createdAt: number | null;
  videos: {
    file: string; k: number; quality: "final" | "preview"; title: string | null;
    duration: number | null; width: number | null; height: number | null; bytes: number; modifiedAt: number;
    /** see REVIEW GATE; label = what the picker says ("Unreviewed automatic cut") */
    review: ReviewStatus; reviewLabel: string; removedWords: number | null; removals: number | null;
  }[];
}

/** final-NN.mp4 = the source resolution; preview-NN.mp4 = 1080 on the short side */
function dimsOf(quality: "final" | "preview", src: any): [number | null, number | null] {
  const w = Number(src?.width), h = Number(src?.height);
  if (!(w > 0 && h > 0)) return [null, null];
  if (quality === "final") return [w, h];
  const s = 1080 / Math.min(w, h);
  return [Math.round((w * s) / 2) * 2, Math.round((h * s) / 2) * 2];
}

/**
 * Finished edits of workflow 1 ("cut", or no workflow = cut) — per video the full-resolution
 * final-NN.mp4, else the newest preview-NN.mp4 (1080p). Jobs with no video are left out, and so
 * is every video that is not an ACCEPTED source (an unreviewed automatic cut is never offered).
 */
export async function listLabEdits(): Promise<LabEdit[]> {
  let names: string[] = [];
  try { names = await fsp.readdir(JOBS); } catch { return []; }
  const out: LabEdit[] = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const dir = path.join(JOBS, id);
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req || workflowOf(req) !== "cut") continue;
    if (isHeld(await readJson<any>(path.join(dir, "status.json")))) continue;   // a held edit is not finished
    const src = await readJson<any>(path.join(dir, "source.json"));
    const edl = await readJson<any>(path.join(dir, "edl.json"));
    const review = await readJson<any>(path.join(dir, "review.json"));
    const wordiff = await readJson<any>(path.join(dir, "wordiff.json"));
    const byK = new Map<number, LabEdit["videos"][number]>();
    let files: string[] = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      const m = /^(final|preview)-(\d{2})\.mp4$/.exec(f);
      if (!m) continue;
      const st = await fsp.stat(path.join(dir, f)).catch(() => null);
      if (!st?.isFile() || st.size === 0) continue;
      const quality = m[1] as "final" | "preview";
      const k = Number(m[2]);
      const have = byK.get(k);
      // a final always wins; between two of the same kind the newer one
      if (have && (have.quality === "final" && quality === "preview")) continue;
      if (have && have.quality === quality && have.modifiedAt >= st.mtimeMs / 1000) continue;
      const v = edl?.videos?.[k - 1];
      const [width, height] = dimsOf(quality, src);
      const rs = reviewStatusOf(f, files.includes(`final-${m[2]}.mp4`), review, edl, wordiff);
      byK.set(k, {
        file: f, k, quality, title: v?.title ?? null,
        duration: Number.isFinite(Number(v?.duration)) ? Number(v.duration) : null,
        width, height, bytes: st.size, modifiedAt: st.mtimeMs / 1000,
        review: rs.review, reviewLabel: REVIEW_LABEL[rs.review], removedWords: rs.removedWords, removals: rs.removals,
      });
    }
    for (const [k, v] of byK) if (!ACCEPTED.includes(v.review)) byK.delete(k);
    if (!byK.size) continue;
    out.push({
      id,
      title: req.title || src?.title || id,
      format: req.format ?? null,
      // (one hand-made job wrote milliseconds)
      createdAt: Number(req.created_at) > 1e11 ? Number(req.created_at) / 1000 : req.created_at ?? null,
      videos: [...byK.values()].sort((a, b) => a.k - b.k),
    });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** The request.json "source" for a new job, validated (path-safe names, the file exists). */
export async function parseSource(input: CreateInput, workflow: Workflow): Promise<
  { kind: "descript"; url: string }
  | { kind: "job"; job: string; file: string; title: string }
  | { kind: "upload"; upload: string; name: string }
  | { kind: "job_source"; job: string; upload: string; name: string }
> {
  const sk = input.source?.kind;
  const kind: SourceKind = sk === "job" || sk === "upload" || sk === "job_source" ? sk : "descript";
  if (!SOURCE_KINDS[workflow].includes(kind)) {
    throw new Error("This workflow starts from a Descript share link.");
  }
  if (kind === "job") {
    const job = String(input.source?.job ?? "");
    const file = String(input.source?.file ?? "");
    if (!ID_RE.test(job) || !LAB_FILE_RE.test(file)) throw new Error("Choose a finished Lab edit.");
    const req = await readJson<any>(path.join(JOBS, job, "request.json"));
    if (!req) throw new Error("That Lab edit no longer exists.");
    if (workflowOf(req) !== "cut") throw new Error("Only edits made with “Cut an unedited narration” can be used.");
    if (isHeld(await readJson<any>(path.join(JOBS, job, "status.json")))) {
      throw new Error("That Lab edit is held (it failed the quality check) — it is not a finished edit.");
    }
    const st = await fsp.lstat(path.join(JOBS, job, file)).catch(() => null);
    if (!st?.isFile() || st.size === 0) throw new Error(`That Lab edit has no ${file}.`);
    const src = await readJson<any>(path.join(JOBS, job, "source.json"));
    const hasFinal = /^preview-/.test(file)
      ? !!(await fsp.lstat(path.join(JOBS, job, file.replace(/^preview-/, "final-"))).catch(() => null))?.isFile()
      : false;
    const rs = reviewStatusOf(file, hasFinal,
      await readJson<any>(path.join(JOBS, job, "review.json")),
      await readJson<any>(path.join(JOBS, job, "edl.json")),
      await readJson<any>(path.join(JOBS, job, "wordiff.json")));
    const title = String(req.title || src?.title || job).slice(0, 120);
    if (!ACCEPTED.includes(rs.review)) {
      throw new Error(
        `That Lab edit is an unreviewed automatic cut${rs.removedWords ? ` (${rs.removedWords} spoken words removed)` : ""} ` +
        "that did not pass the word check — only a final render, a reviewed cut or a factory cut with every word kept " +
        "can start a creative edit. Use “Full edit” to go from the raw recording to the finished video automatically.",
      );
    }
    return { kind, job, file, title };
  }
  if (kind === "upload") {
    const upload = String(input.source?.upload ?? "");
    if (!UPLOAD_ID_RE.test(upload)) throw new Error("Upload the video first.");
    const up = await getUpload(upload);
    if (!up.complete) throw new Error("The upload has not finished yet.");
    return { kind, upload, name: up.name };     // a library narration: any number of jobs may use it
  }
  if (kind === "job_source") return jobSourceOf(input.source?.job);
  const url = String(input.url ?? "").trim();
  if (!SHARE_RE.test(url)) {
    throw new Error("Paste a Descript share link like https://share.descript.com/view/AbC123xyz");
  }
  return { kind, url };
}

export async function createJob(input: CreateInput) {
  if (input.workflow !== "cut" && input.workflow !== "creative") {
    throw new Error("Choose the workflow: cut an unedited narration, or creative edit an edited one.");
  }
  const workflow: Workflow = input.workflow;
  if (input.chain !== undefined && input.chain !== null && input.chain !== "" && input.chain !== "creative") {
    throw new Error("Unknown chain.");
  }
  const chain = input.chain === "creative";
  if (chain && workflow !== "cut") throw new Error("A full edit starts from the raw recording (the cut workflow).");
  const source = await parseSource(input, workflow);
  if (input.format !== "short" && input.format !== "long") throw new Error("Choose Shorts or Long-form.");
  // Jake: "important you know if it's sponsored or not" — never defaulted.
  if (input.sponsored !== true && input.sponsored !== false) throw new Error("Say whether the video is sponsored.");
  const runOn = parseRunOn(input.runOn);
  const handoff = parseHandoff(input);
  const script = String(input.script ?? "");
  if (script.length > MAX_SCRIPT) throw new Error("The script is too long.");
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const fallback = source.kind === "descript" ? source.url.split("/").filter(Boolean).pop()
    : source.kind === "job" ? source.title : source.name.replace(/\.[^.]+$/, "");
  const slug = String(input.title || fallback || "job")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "job";
  const id = `${slug}-${stamp}-${randomBytes(2).toString("hex")}`;
  const dir = path.join(JOBS, id);
  if (source.kind === "upload") {
    await claimUpload(source.upload, id);         // complete (a finished upload is never swept)
  }
  await fsp.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "request.json"), {
    id,
    source,
    workflow,
    format: input.format,
    sponsored: input.sponsored,
    script: script.trim() || null,
    title: input.title ? String(input.title).slice(0, 120) : null,
    sites: input.format === "long" ? parseSites(input.sites) : [],
    run_on: runOn,
    // ONE SUBMISSION = A FINISHED EDIT: the factory takes policy (only retakes / false starts /
    // whitelisted fillers; never a pause, never a content cut), no review step, no full edit on the
    // cut itself — the worker's chain (aieditor/chain.py) carries it on into the creative edit
    ...(chain ? { chain: "creative", takes_policy: "factory", no_edit: true } : {}),
    ...(handoff ? { handoff: true } : {}),
    created_at: Date.now() / 1000,
  });
  await writeJson(path.join(dir, "status.json"), {
    state: "queued",
    message: "Waiting for the worker…",
    stages: Object.fromEntries(withHandoff(stagesFor(workflow, input.format, source.kind), handoff).map((s) => [s.id, { state: "pending" }])),
    workflow,
    cost_usd: 0,
    updated_at: Date.now() / 1000,
  });
  await writeJson(path.join(dir, "queue.json"), { action: "run" });
  return { id };
}

/**
 * HELD (architecture recommendation §4): an edit that fails the ship rule or a gate is never shipped
 * quietly. The worker ends such a job in state "held" (status.held = true) and lists why in held.json
 * {reasons (stages that stopped it), failures [{dim, beat, t, why, remedies_tried}]} and in each
 * edit-NN/verdict.json. A held edit is never listed as a finished edit or offered as a creative source.
 */
export interface HeldFailure {
  dim: string; beat: string | null; t: number | null; why: string; remedies_tried: string[]; edit?: number;
}
export function isHeld(st: any): boolean {
  return st?.state === "held" || st?.held === true;
}
/** Pure: held.json + status.json + the edits' verdicts -> the failure list the Lab shows. */
export function heldFailuresOf(status: any, heldDoc: any, verdicts: any[]): HeldFailure[] {
  const norm = (f: any): HeldFailure => ({
    dim: String(f?.dim ?? "held"), beat: f?.beat ?? null, t: Number.isFinite(Number(f?.t)) && f?.t !== null ? Number(f.t) : null,
    why: String(f?.why ?? ""), remedies_tried: Array.isArray(f?.remedies_tried) ? f.remedies_tried.map(String) : [],
    ...(f?.edit ? { edit: Number(f.edit) } : {}),
  });
  if (Array.isArray(status?.held_failures) && status.held_failures.length) return status.held_failures.map(norm);
  const out: HeldFailure[] = [];
  for (const r of heldDoc?.reasons ?? []) {
    out.push(norm({ dim: "held", why: `${r?.reason ?? ""}${r?.detail ? ` (${r.detail})` : ""}` }));
  }
  for (const f of heldDoc?.failures ?? []) out.push(norm(f));
  verdicts.forEach((v, n) => {
    if (v?.held && !heldDoc?.failures?.length) for (const f of v.failures ?? []) out.push(norm({ ...f, edit: n + 1 }));
  });
  return out;
}

async function heldOf(dir: string, status: any) {
  if (!isHeld(status)) return null;
  const heldDoc = await readJson<any>(path.join(dir, "held.json"));
  const verdicts: any[] = [];
  try {
    for (const d of (await fsp.readdir(dir)).filter((x) => /^edit-\d{2}$/.test(x)).sort()) {
      verdicts.push(await readJson<any>(path.join(dir, d, "verdict.json")));
    }
  } catch { /* no edits */ }
  const scores = verdicts.map((v) => (v ? { dims: v.dims ?? {}, overall: v.overall ?? null, ship: v.ship ?? null } : null));
  return { failures: heldFailuresOf(status, heldDoc, verdicts), scores };
}

export async function listJobs() {
  let names: string[] = [];
  try {
    names = await fsp.readdir(JOBS);
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const dir = path.join(JOBS, id);
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req) continue;
    const st = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
    const src = await readJson<any>(path.join(dir, "source.json"));
    out.push({
      id,
      title: req.title || src?.title || id,
      format: req.format,
      workflow: workflowOf(req),
      sponsored: req.sponsored,
      state: (await exists(path.join(dir, "queue.json"))) && st.state !== "running" ? "queued" : (isHeld(st) ? "held" : st.state),
      message: st.message ?? null,
      held: isHeld(st),
      createdAt: req.created_at ?? null,
      updatedAt: st.updated_at ?? null,
    });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getJob(id: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new Error("Unknown job.");
  const status = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
  const queued = await exists(path.join(dir, "queue.json"));
  const source = await readJson<any>(path.join(dir, "source.json"));
  const review = await readJson<any>(path.join(dir, "review.json"));
  const edl = await readJson<any>(path.join(dir, "edl.json"));
  let previews: { name: string; bytes: number; modifiedAt: number }[] = [];
  let listens: { name: string; bytes: number; modifiedAt: number }[] = [];
  let edits: { name: string; bytes: number; modifiedAt: number }[] = [];
  let finals: { name: string; bytes: number; modifiedAt: number }[] = [];
  // phase 2 (shorts): Claude's graphics plan per video — what goes on screen, on which words
  const graphics: { t0: number; t1: number; template: string; fields: unknown; why?: string }[][] = [];
  try {
    for (const f of (await fsp.readdir(dir)).sort()) {
      const m = /^(preview|listen|edit|final)-\d{2}\.mp4$/.exec(f);
      if (m) {
        const s = await fsp.stat(path.join(dir, f));
        const list = { preview: previews, edit: edits, final: finals, listen: listens }[m[1] as "preview"];
        list.push({ name: f, bytes: s.size, modifiedAt: s.mtimeMs / 1000 });
      }
      const g = /^graphics-(\d{2})\.json$/.exec(f);
      if (g) {
        const doc = await readJson<any>(path.join(dir, f));
        graphics[Number(g[1]) - 1] = (doc?.plan?.events ?? []).map((e: any) => ({
          t0: e.t0, t1: e.t1, template: e.template, fields: e.fields, why: e.why,
        }));
      }
    }
  } catch {
    previews = [];
    listens = [];
    edits = [];
    finals = [];
  }
  const nudgeDoc = await readJson<any>(path.join(dir, "joins.edit.json"));
  const nudges = nudgeDoc?.nudges ?? {};
  const edlMtime = (await fsp.stat(path.join(dir, "edl.json")).catch(() => null))?.mtimeMs ?? null;
  // saved corrections the current cut / sound check does not contain yet
  const nudgesPending = !!nudgeDoc?.saved_at && edlMtime !== null && nudgeDoc.saved_at * 1000 > edlMtime + 500;
  let log = "";
  try {
    const buf = await fsp.readFile(path.join(dir, "log.txt"), "utf8");
    log = buf.slice(-8000);
  } catch {
    log = "";
  }
  // what the (one-at-a-time) worker is busy with, so a queued save never looks lost
  let busyWith: { id: string; title: string | null; message: string | null } | null = null;
  if (queued && status.state !== "running") {
    try {
      for (const other of await fsp.readdir(path.dirname(dir))) {
        if (other === id) continue;
        const st = await readJson<any>(path.join(path.dirname(dir), other, "status.json"));
        if (st?.state === "running") {
          const r = await readJson<any>(path.join(path.dirname(dir), other, "request.json"));
          busyWith = { id: other, title: r?.title ?? null, message: st.message ?? null };
          break;
        }
      }
    } catch {
      busyWith = null;
    }
  }
  const workflow = workflowOf(req);
  const stageList = withHandoff(stagesFor(workflow, req.format, sourceKindOf(req)), req.handoff === true);
  // a HELD edit is not a finished edit: its files are kept for inspection, never listed as edits/finals
  const held = await heldOf(dir, status);
  const heldEdits = held ? [...edits, ...finals] : [];
  if (held) {
    edits = [];
    finals = [];
  }
  return {
    id,
    busyWith,
    workflow,
    stageList,
    /** typical seconds per stage for this source length (null = no history yet) */
    expect: await expectedSeconds(stageList, req.format, Number(source?.duration) || null),
    request: { ...req, workflow, run_on: req.run_on ?? "auto", script: req.script ? String(req.script).slice(0, 2000) : null },
    status: { ...status, state: queued && status.state !== "running" ? "queued" : (held ? "held" : status.state) },
    /** set when the job is HELD: why (one line per failure) + the edits' rubric scores */
    held,
    heldEdits,
    source,
    review,
    videos: (edl?.videos ?? []).map((v: any) => ({
      title: v.title, duration: v.duration, cuts: v.cuts, warnings: v.warnings ?? [],
      words: (v.words ?? []).length,
      joins: v.joins ?? [],
    })),
    previews,
    listens,
    /** files removed from the server (Stored files / the library) — the view says "deleted" */
    deleted: await readDeleted(dir),
    edits,
    finals,
    graphics,
    nudges,
    nudgesPending,
    edlAt: (await fsp.stat(path.join(dir, "edl.json")).catch(() => null))?.mtimeMs ?? null,
    log,
    /** "Graphics only — editor adds screencasts": the hand-off packages (handoff-NN.zip), null for other jobs */
    handoff: req.handoff === true ? await handoffPackages(dir) : null,
    /** where the current/last run executed (host writes it: aieditor/cloud.runner) — null = never routed */
    runner: await readJson<any>(path.join(dir, "runner.json")),
    /** the cut → creative chain (aieditor/chain.py): what comes next / where this job started from */
    chain: await chainOf(dir, req),
  };
}

export interface ChainLink { id: string; title: string; state: string | null }
export interface ChainInfo {
  /** a Full edit's cut job: the creative edit it created (null = not created yet) */
  next: ChainLink | null;
  /** set on a Full edit's cut job: the step the chain is at (final / recut / creative / held) */
  step: string | null;
  isChain: boolean;
  /** a chained creative edit: the cut job it started from */
  from: ChainLink | null;
}

async function linkOf(id: unknown): Promise<ChainLink | null> {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const dir = path.join(JOBS, id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) return { id, title: id, state: "deleted" };
  const st = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
  const queued = await exists(path.join(dir, "queue.json"));
  return {
    id,
    title: String(req.title || id),
    state: queued && st.state !== "running" ? "queued" : isHeld(st) ? "held" : st.state ?? null,
  };
}

/** Pure-ish: the chain links of one job (request.json chain / chained_from + chain.json). */
export async function chainOf(dir: string, req: any): Promise<ChainInfo | null> {
  const isChain = req?.chain === "creative";
  if (!isChain && !req?.chained_from) return null;
  const doc = isChain ? await readJson<any>(path.join(dir, "chain.json")) : null;
  return {
    isChain,
    step: doc?.step ?? null,
    next: isChain ? await linkOf(doc?.next) : null,
    from: req?.chained_from ? await linkOf(req.chained_from) : null,
  };
}

/** Jake's edits on the review screen: the kept sentences (and dropped words) per video. */
export async function saveEdits(id: string, videos: unknown) {
  const dir = jobDir(id);
  if (workflowOf(await readJson<any>(path.join(dir, "request.json"))) === "creative") {
    throw new Error("A creative edit keeps the narration as it is — there is no cut to edit.");
  }
  if (!Array.isArray(videos) || videos.length === 0) throw new Error("Nothing to save.");
  const clean = videos.slice(0, 50).map((v: any, k: number) => ({
    title: String(v?.title ?? `Video ${k + 1}`).slice(0, 120),
    segments: (Array.isArray(v?.segments) ? v.segments : []).slice(0, 5000).map((s: any) => ({
      s: Number(s?.s),
      drop: (Array.isArray(s?.drop) ? s.drop : []).map(Number).filter(Number.isInteger).slice(0, 500),
    })).filter((s: any) => Number.isInteger(s.s) && s.s >= 0),
  }));
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  await writeJson(path.join(dir, "plan.edit.json"), { videos: clean, saved_at: Date.now() / 1000 });
  await writeJson(path.join(dir, "queue.json"), { action: "rebuild" });
  return { ok: true };
}

/**
 * Jake's hand nudges of single cuts (Descript-style): ms per edge, keyed
 * "a:<first word id>" (where a piece starts) / "b:<last word id>" (where it ends).
 * Rebuilds the cut + the sound check only — the video is not re-rendered.
 */
export async function saveNudges(id: string, nudges: unknown, apply = false) {
  const dir = jobDir(id);
  if (!nudges || typeof nudges !== "object" || Array.isArray(nudges)) throw new Error("Nothing to save.");
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(nudges as Record<string, unknown>).slice(0, 5000)) {
    const ms = Math.round(Number(v));
    if (/^[ab]:\d{1,7}$/.test(k) && Number.isFinite(ms) && ms !== 0 && Math.abs(ms) <= 1000) clean[k] = ms;
  }
  // Always accepted, even while the worker is busy (Jake's nudges autosave as he works:
  // refusing them made the editor drop his cuts). An autosave only STORES them — Jake:
  // "each save shouldn't rebuild the whole soundcheck - the rebuild should happen only
  // when I finish all of the corrections" — `apply` (his Rebuild button) queues the one
  // recut, which runs as soon as the current step is done; the latest nudges win.
  await writeJson(path.join(dir, "joins.edit.json"), { nudges: clean, saved_at: Date.now() / 1000 });
  if (!apply) return { ok: true, count: Object.keys(clean).length };
  const st = await readJson<any>(path.join(dir, "status.json"));
  const queued = await readJson<any>(path.join(dir, "queue.json"));
  // never downgrade a queued full run / render to a recut
  if (!queued || queued.action === "recut" || queued.action === "rebuild") {
    await writeJson(path.join(dir, "queue.json"), { action: st?.state === "running" && queued?.action === "rebuild" ? "rebuild" : "recut" });
  }
  return { ok: true, count: Object.keys(clean).length };
}

/**
 * Long-form: the FULL EDIT (screencasts of the job's websites, facecam bubble, overlays,
 * A-roll camera, music) → edit-NN.mp4. `sites` (optional) replaces the job's websites.
 */
export async function buildEdit(id: string, sites?: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (req?.format !== "long") throw new Error("The full edit is for long-form videos.");
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  if (!(await readJson<any>(path.join(dir, "edl.json")))) throw new Error("There is no cut yet.");
  if (sites !== undefined) {
    const next = parseSites(sites);
    if (JSON.stringify(next) !== JSON.stringify(req.sites ?? [])) {
      await writeJson(path.join(dir, "request.json"), { ...req, sites: next });
      // new websites = a new plan: drop the old one so the worker re-plans
      for (const d of await fsp.readdir(dir)) if (/^edit-\d{2}$/.test(d)) await fsp.rm(path.join(dir, d, "direct.json"), { force: true });
    }
  }
  await writeJson(path.join(dir, "queue.json"), { action: "edit" });
  return { ok: true };
}

/** Render the video preview of the current cut (edits never do this on their own). */
export async function renderVideo(id: string) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  await writeJson(path.join(dir, "queue.json"), { action: "render" });
  return { ok: true };
}

/**
 * The deliverable, final-NN.mp4 at the source resolution. Shorts: cut + 2× graphics +
 * captions + SFX. Long-form: the full edit (screencasts, bubble, overlays, music) at source
 * resolution when one has been built, else the current cut alone.
 */
export async function renderFinal(id: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (req?.format !== "short" && req?.format !== "long") throw new Error("Unknown video format.");
  if (req.format === "long" && !(await readJson<any>(path.join(dir, "edl.json")))) {
    throw new Error("There is no cut yet — let the job reach the sound check first.");
  }
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  if (isHeld(st)) throw new Error("This edit is held — it failed the quality check, so there is no final to render.");
  await writeJson(path.join(dir, "queue.json"), { action: "final" });
  return { ok: true };
}

/**
 * A slice of the job's original 48 kHz recording as a small WAV, for the cut editor's
 * in-browser audition. full48k.wav is plain PCM, so this is a byte-range copy.
 */
export async function audioSlice(id: string, from: number, to: number): Promise<Buffer> {
  const dir = jobDir(id);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 12) {
    throw new Error("Bad range.");
  }
  const fh = await fsp.open(path.join(dir, "full48k.wav"), "r");
  try {
    const head = Buffer.alloc(4096);
    await fh.read(head, 0, 4096, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV.");
    let off = 12;
    let fmt: { ch: number; sr: number; bits: number } | null = null;
    let dataAt = -1;
    let dataLen = 0;
    while (off + 8 <= head.length) {
      const idc = head.toString("ascii", off, off + 4);
      const len = head.readUInt32LE(off + 4);
      if (idc === "fmt ") fmt = { ch: head.readUInt16LE(off + 10), sr: head.readUInt32LE(off + 12), bits: head.readUInt16LE(off + 22) };
      if (idc === "data") {
        dataAt = off + 8;
        dataLen = len;
        break;
      }
      off += 8 + len + (len % 2);
    }
    if (!fmt || dataAt < 0 || fmt.bits !== 16) throw new Error("Unsupported WAV.");
    const block = fmt.ch * 2;
    const total = Math.floor(((await fh.stat()).size - dataAt) / block);
    const frames = Math.min(total, dataLen ? Math.floor(dataLen / block) : total);
    const f0 = Math.max(0, Math.min(frames, Math.round(Math.max(0, from) * fmt.sr)));
    const f1 = Math.max(f0, Math.min(frames, Math.round(to * fmt.sr)));
    const body = Buffer.alloc((f1 - f0) * block);
    await fh.read(body, 0, body.length, dataAt + f0 * block);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.writeUInt32LE(36 + body.length, 4);
    h.write("WAVEfmt ", 8, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(fmt.ch, 22);
    h.writeUInt32LE(fmt.sr, 24);
    h.writeUInt32LE(fmt.sr * block, 28);
    h.writeUInt16LE(block, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii");
    h.writeUInt32LE(body.length, 40);
    return Buffer.concat([h, body]);
  } finally {
    await fh.close();
  }
}

export async function resetEdits(id: string) {
  const dir = jobDir(id);
  await fsp.rm(path.join(dir, "plan.edit.json"), { force: true });
  await writeJson(path.join(dir, "queue.json"), { action: "rebuild" });
  return { ok: true };
}

export async function continueJob(id: string, runOn?: unknown) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("It is already running.");
  if (runOn !== undefined && runOn !== null && runOn !== "") {
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req) throw new Error("Unknown job.");
    await writeJson(path.join(dir, "request.json"), { ...req, run_on: parseRunOn(runOn) });
  }
  await writeJson(path.join(dir, "queue.json"), { action: "run" });
  return { ok: true };
}

export async function cancelJob(id: string) {
  const dir = jobDir(id);
  await fsp.rm(path.join(dir, "queue.json"), { force: true });
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st && st.state !== "running") {
    // nothing is executing: settle the status here, the worker never claims it
    await writeJson(path.join(dir, "status.json"), {
      ...st, state: "cancelled", message: "Cancelled", updated_at: Date.now() / 1000,
    });
    return { ok: true };
  }
  await fsp.writeFile(path.join(dir, "cancel"), String(Date.now()));
  return { ok: true };
}

/**
 * Delete a job and all its files. Refused while it is running or queued, and while another
 * job that has not started yet still needs one of its files as its source (./storage.ts).
 * `freed` = the bytes that really come back (hard links shared with other jobs or the
 * narration library stay on disk).
 */
export async function deleteJob(id: string) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Cancel it first.");
  await assertJobDeletable(id);
  const freed = freedByJobs(await walkAll(), [id]);
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true, freed };
}

export const filesRoot = JOBS;
