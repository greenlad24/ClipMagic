/**
 * The Lab's view of the Video Editor — the JakeDawson Hyperframes skill run as
 * software (`hfp`, /opt/hyperframes-pipeline on the host).
 *
 * ⚠️ THIS MODULE IS A CONTROL PLANE, NOT A RUNNER — the same split as the
 * Render queue (see jobs.ts). It writes a request into a run's control
 * directory and reads files back. The `hfp-worker` systemd service on the HOST
 * is the only thing that executes the pipeline: the pipeline shells out to
 * Docker for ffprobe and was built on the host's Python, and a fourteen-hour
 * edit must outlive this container, a Lab rebuild and the browser tab.
 *
 * ⚠️ AND IT IS NOT THE RENDER QUEUE. Nothing here touches /hyperframes-work.
 * An approved run reaches the renderer through the render API over HTTPS, as
 * every other client does.
 *
 * ⚠️ THE RENDER GATE LIVES IN THE WORKER, NOT HERE. Until request.json says
 * render_approved — or unattended, which is the default since Jake asked that
 * every step run with no human intervention — the worker stops every run after
 * S11 whatever it was asked, so a UI bug cannot start a render.
 *
 *   /hfp-lab/runs/<id>/        hfp's run directory (state/, model/, requests/, …)
 *   /hfp-lab/control/<id>/     request.json, queue.json, cancel, worker.json,
 *                              run.log, ctx.json, inputs/{share,transcript}.json
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = process.env.HFP_LAB || "/hfp-lab";
const RUNS = path.join(ROOT, "runs");
const CONTROL = path.join(ROOT, "control");

/** The spine, mirrored from hfp/stages.py for display only. The worker decides. */
export const STAGES: { id: string; title: string; klass: string; phase: string }[] = [
  { id: "S0", title: "Hub resolve", klass: "deterministic", phase: "Intake" },
  { id: "S1", title: "Composition resolve", klass: "mixed", phase: "Intake" },
  { id: "S2", title: "Source acquire and probe", klass: "deterministic", phase: "Intake" },
  { id: "S3", title: "Transcript from Descript", klass: "deterministic", phase: "Intake" },
  { id: "S4", title: "Transcript correction", klass: "model", phase: "Editorial" },
  { id: "S5", title: "Editorial pass", klass: "model", phase: "Editorial" },
  { id: "S6", title: "Wan generation", klass: "mixed", phase: "Build" },
  { id: "S7", title: "4K conform", klass: "deterministic", phase: "Build" },
  { id: "S8", title: "Screencast handoff", klass: "mixed", phase: "Build" },
  { id: "S9", title: "Template instantiate", klass: "deterministic", phase: "Build" },
  { id: "S10", title: "Project assembly", klass: "deterministic", phase: "Build" },
  { id: "S11", title: "Preflight", klass: "deterministic", phase: "Build" },
  { id: "S12", title: "Transfer", klass: "deterministic", phase: "Render" },
  { id: "S13", title: "Submit", klass: "deterministic", phase: "Render" },
  { id: "S14", title: "Monitor", klass: "deterministic", phase: "Render" },
  { id: "S15", title: "Retrieve", klass: "deterministic", phase: "Render" },
  { id: "S16", title: "Technical QA", klass: "deterministic", phase: "Review" },
  { id: "S17", title: "Editorial QA", klass: "model", phase: "Review" },
  { id: "S18", title: "Package and hub", klass: "deterministic", phase: "Deliver" },
  { id: "S19", title: "Cost ledger", klass: "deterministic", phase: "Deliver" },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const MODEL_STAGES = new Set(["S4", "S5", "S8", "S17"]);

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHARE_RE = /^https:\/\/share\.descript\.com\/view\/[A-Za-z0-9_-]{6,64}\/?$/;
const CADENCE_RE = /^\d{1,3}(?:\.\d{1,3})?(?:\/\d{1,5})?$/;
/** Answers are pasted JSON; the S5 plan for a 15-minute film is large, not huge. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type StageStatus =
  | "pending" | "running" | "done" | "blocked" | "awaiting" | "cached";

export interface EditorStage {
  id: string;
  title: string;
  klass: string;
  phase: string;
  status: StageStatus;
  note: string | null;
  reason: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EditorRequest {
  id: string;
  name: string;
  link: string;
  cadence: string;
  editorial_mode: "offline" | "live";
  accept_long_context_reprice: boolean;
  render_approved: boolean;
  render_approved_at?: number;
  /**
   * Jake, 2026-09-13: "All of the steps should run with no human intervention."
   * The worker then asks GPT-6 Astra itself (retrying rejected answers with
   * their findings), writes the S8 briefs, renders once preflight passes, and
   * files an automated — clearly unapproved — S17 review.
   */
  unattended: boolean;
  created_at: number;
}

export interface EditorRunSummary {
  id: string;
  name: string;
  link: string;
  createdAt: number;
  title: string | null;
  durationSeconds: number | null;
  /** queued | running | idle */
  worker: "queued" | "running" | "idle" | "new";
  outcome: string | null;
  lastStage: string | null;
  reason: string | null;
  doneStages: number;
  renderApproved: boolean;
  waitingFor: string | null;
  updatedAt: number | null;
}

/** What the run is waiting on, in the operator's terms. */
export interface EditorPending {
  kind:
    | "model-answer" | "rejected-answer" | "composition" | "handoff-tasks"
    | "generations" | "attestation" | "render-approval" | "rendering" | "blocked" | "interrupted";
  stage: string | null;
  message: string;
  jobId?: string | null;
  nextCheckAt?: number | null;
  /** Model stages: the request's cost estimate and its binding digest. */
  estimateUsd?: number | null;
  inputTokens?: number | null;
  promptSha256?: string | null;
  findings?: { code: string; severity: string; message: string; where?: string }[];
  candidates?: { id: string; name: string | null; duration_seconds: number | null }[];
  attestation?: unknown;
  renderSha256?: string | null;
  videoUrl?: string | null;
  framesEstimate?: number | null;
  durationSeconds?: number | null;
  preflightVerdict?: string | null;
}

export interface EditorArtifact {
  path: string;
  bytes: number;
  modifiedAt: number;
}

async function readJson<T = any>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await fsp.rename(tmp, p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function checkId(id: unknown): string {
  const s = String(id ?? "");
  if (!ID_RE.test(s)) throw new Error("Invalid run id.");
  return s;
}

function ctl(id: string) {
  return path.join(CONTROL, id);
}
function runDir(id: string) {
  return path.join(RUNS, id);
}

/** A run is busy while the worker holds it or a request is waiting. */
async function busy(id: string): Promise<"queued" | "running" | null> {
  const w = await readJson(path.join(ctl(id), "worker.json"));
  if (w?.state === "running") return "running";
  if (await exists(path.join(ctl(id), "queue.json"))) return "queued";
  if (await exists(path.join(ctl(id), "queue.claimed.json"))) return "running";
  return null;
}

async function enqueue(id: string, body: Record<string, unknown>) {
  const b = await busy(id);
  if (b) throw new Error(`This run is already ${b}.`);
  await writeJson(path.join(ctl(id), "queue.json"), { action: "run", requested_at: Date.now() / 1000, ...body });
}

/* ────────────────────────────── reading ────────────────────────────── */

async function stageRows(id: string): Promise<EditorStage[]> {
  const report = await readJson(path.join(runDir(id), "reports", "pipeline-status.json"));
  const rows: Record<string, any> = {};
  for (const r of report?.stages ?? []) rows[r.stage] = r;
  return Promise.all(
    STAGES.map(async (s) => {
      const st = (await readJson(path.join(runDir(id), "state", `${s.id}.json`))) ?? {};
      let status: StageStatus = "pending";
      if (st.status === "done") status = rows[s.id]?.status === "cached" ? "cached" : "done";
      else if (st.status === "running") status = "running";
      else if (st.status === "blocked") {
        status = rows[s.id]?.status === "awaiting-model" || st.reason === "awaiting editorial decision"
          ? "awaiting" : "blocked";
      }
      return {
        ...s,
        status,
        note: st.note || rows[s.id]?.note || null,
        reason: st.reason && st.reason !== "awaiting editorial decision" ? st.reason : null,
        startedAt: st.started_at ?? null,
        finishedAt: st.finished_at ?? st.at ?? null,
      };
    }),
  );
}

function modelUsd(req: any): number | null {
  const c = req?.cost_estimate;
  return typeof c?.usd === "number" ? c.usd : null;
}

/** Decide what the run needs from the operator, from the files alone. */
async function pendingFor(id: string, stages: EditorStage[], request: EditorRequest | null, worker: any):
  Promise<EditorPending | null> {
  const dir = runDir(id);
  if (worker?.state === "running") return null;
  if (worker?.outcome === "interrupted") {
    return { kind: "interrupted", stage: worker.last_stage ?? null, message: worker.reason };
  }
  if (worker?.outcome === "error") {
    return { kind: "blocked", stage: null, message: worker.reason || "The run could not start." };
  }
  const stuck = stages.find((s) => s.status === "awaiting" || s.status === "blocked");
  if (!stuck) {
    const s11 = stages.find((s) => s.id === "S11");
    const s12 = stages.find((s) => s.id === "S12");
    if (s11 && (s11.status === "done" || s11.status === "cached") && s12?.status === "pending"
        && !request?.render_approved && !request?.unattended) {
      const project = await readJson(path.join(dir, "project.json"));
      const pre = await readJson(path.join(dir, "preflight.json"));
      return {
        kind: "render-approval",
        stage: "S12",
        message: "The edit is built and preflight passed. Nothing is sent to the render server until you approve it.",
        framesEstimate: project?.composition?.frames_estimate ?? null,
        durationSeconds: project?.composition?.duration_seconds ?? null,
        preflightVerdict: pre?.verdict ?? pre?.status ?? null,
      };
    }
    return null;
  }
  const sid = stuck.id;

  if (MODEL_STAGES.has(sid)) {
    const rejected = await readJson(path.join(dir, "model", `${sid}-rejected.json`));
    if (rejected && stuck.status === "blocked") {
      return {
        kind: "rejected-answer",
        stage: sid,
        message: "The answer failed validation and was not applied. It is never repaired: discard it, then ask again or paste a new one.",
        findings: rejected.findings ?? [],
      };
    }
  }
  if (sid === "S14" && stuck.status === "blocked") {
    // S14 checks once an hour and returns; the worker re-queues it when the
    // hour is up. "Still rendering" is the normal state here, not a failure.
    const mon = await readJson(path.join(dir, "monitor.json"));
    if (mon && !mon.terminal && !mon.stale_heartbeat) {
      const l = mon.latest ?? {};
      return {
        kind: "rendering", stage: sid,
        message: `Render ${mon.job_id} is ${l.status ?? "queued"}` +
          (l.total_frames ? ` — ${l.frames_completed ?? 0}/${l.total_frames} frames` : "") +
          ". Checked once an hour; the Render queue shows it live.",
        jobId: mon.job_id ?? null,
        nextCheckAt: mon.next_check_not_before ?? null,
      };
    }
  }
  if (stuck.status === "blocked") {
    return { kind: "blocked", stage: sid, message: stuck.reason || "This stage stopped." };
  }
  if (sid === "S1") {
    const q = await readJson(path.join(dir, "requests", "S1-composition.json"));
    return {
      kind: "composition", stage: sid, message: q?.reason || "Pick the composition to edit.",
      candidates: q?.candidates ?? [],
    };
  }
  if (sid === "S6") {
    const g = await readJson(path.join(dir, "requests", "S6-generations.json"));
    return {
      kind: "generations", stage: sid,
      message: `${(g?.prepared_requests ?? []).length} stock-footage placement(s) need a Wan generation. ` +
        "Generation is not switched on yet: the APIMart video endpoint has not been verified, and a guessed request is discovered on the bill.",
      estimateUsd: typeof g?.total_estimate_credits === "number" ? g.total_estimate_credits / 10 : null,
    };
  }
  if (sid === "S8" && !(await exists(path.join(dir, "model", "S8-request.json")))) {
    return {
      kind: "handoff-tasks", stage: sid,
      message: "The plan has screencast sections. Describe what each clip must show (handoff-tasks.json), then continue.",
    };
  }
  if (sid === "S17") {
    const qa = await readJson(path.join(dir, "qa-editorial.json"));
    if (qa?.verdict === "not_reviewed") {
      const result = await readJson(path.join(dir, "result.json"));
      const video: string | undefined = result?.downloads?.video?.path;
      const rel = video && video.startsWith(dir + "/") ? video.slice(dir.length + 1) : null;
      return {
        kind: "attestation", stage: sid,
        message: "Watch the render with sound and sign off every cue. The pipeline cannot pass this for you.",
        attestation: qa.attestation_template,
        renderSha256: qa.render?.sha256 ?? null,
        videoUrl: rel ? `/api/hfp-editor/files/${id}/${rel}` : null,
      };
    }
  }
  const req = await readJson(path.join(dir, "model", `${sid}-request.json`));
  return {
    kind: "model-answer", stage: sid,
    message: sid === "S4"
      ? "Transcript correction: which words Descript misheard. Ask GPT-6 Astra, or paste an answer."
      : sid === "S8"
      ? "Screencast briefs: GPT-6 Astra writes what each screen recording must show. Ask it, or paste the briefs."
      : sid === "S17"
        ? "Review worksheet: GPT-6 Astra lists what to check in the render. Ask it, or paste one."
        : "Editorial pass: which approved template goes on which beat. Ask GPT-6 Astra, or paste an answer.",
    estimateUsd: modelUsd(req),
    inputTokens: req?.cost_estimate?.input_tokens ?? null,
    promptSha256: req?.prompt_sha256 ?? null,
  };
}

async function summarize(id: string): Promise<EditorRunSummary | null> {
  const request = await readJson<EditorRequest>(path.join(ctl(id), "request.json"));
  if (!request) return null;
  const worker = await readJson(path.join(ctl(id), "worker.json"));
  const share = await readJson(path.join(ctl(id), "inputs", "share.json"));
  const stages = await stageRows(id);
  const b = await busy(id);
  const pending = await pendingFor(id, stages, request, worker);
  return {
    id,
    name: request.name,
    link: request.link,
    createdAt: request.created_at,
    title: share?.title ?? null,
    durationSeconds: share?.duration_seconds ?? null,
    worker: b ?? (worker ? "idle" : "new"),
    outcome: worker?.outcome ?? null,
    lastStage: worker?.last_stage ?? null,
    reason: worker?.reason ?? null,
    doneStages: stages.filter((s) => s.status === "done" || s.status === "cached").length,
    renderApproved: !!request.render_approved,
    waitingFor: pending?.kind ?? null,
    updatedAt: worker?.updated_at ?? request.created_at,
  };
}

export async function listRuns(): Promise<EditorRunSummary[]> {
  let ids: string[] = [];
  try {
    ids = (await fsp.readdir(CONTROL)).filter((d) => ID_RE.test(d));
  } catch {
    return [];
  }
  const rows = (await Promise.all(ids.map(summarize))).filter(Boolean) as EditorRunSummary[];
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

async function listArtifacts(id: string): Promise<EditorArtifact[]> {
  const base = runDir(id);
  const out: EditorArtifact[] = [];
  async function walk(rel: string, depth: number) {
    if (depth > 4 || out.length > 400) return;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name.endsWith(".tmp")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (r === "state") continue;
        await walk(r, depth + 1);
      } else if (e.isFile()) {
        const st = await fsp.stat(path.join(base, r));
        out.push({ path: r, bytes: st.size, modifiedAt: st.mtimeMs / 1000 });
      }
    }
  }
  await walk("", 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function tail(p: string, bytes: number): Promise<string> {
  try {
    const fh = await fsp.open(p, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

export async function getRun(idIn: unknown, logBytes = 20000) {
  const id = checkId(idIn);
  const request = await readJson<EditorRequest>(path.join(ctl(id), "request.json"));
  if (!request) throw new Error("No such run.");
  const worker = await readJson(path.join(ctl(id), "worker.json"));
  const stages = await stageRows(id);
  const summary = await summarize(id);
  const share = await readJson(path.join(ctl(id), "inputs", "share.json"));
  const report = await readJson(path.join(runDir(id), "reports", "pipeline-status.json"));
  const crashed = (report?.stages ?? []).find((r: any) => r.crashed);
  return {
    run: summary!,
    request,
    share,
    worker,
    stages,
    pending: await pendingFor(id, stages, request, worker),
    crashTraceback: crashed?.traceback ?? null,
    artifacts: await listArtifacts(id),
    log: await tail(path.join(ctl(id), "run.log"), Math.min(Math.max(logBytes, 2000), 200000)),
  };
}

/** Read one run file as text. Path-checked; never leaves the run directory. */
export async function readArtifact(idIn: unknown, relIn: unknown) {
  const id = checkId(idIn);
  const rel = String(relIn ?? "");
  if (!rel || rel.includes("\0") || rel.split("/").some((seg) => !seg || seg === ".." || seg.startsWith("."))) {
    throw new Error("Invalid file path.");
  }
  const base = runDir(id);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) throw new Error("Invalid file path.");
  const st = await fsp.stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error("No such file.");
  const truncated = st.size > MAX_ARTIFACT_BYTES;
  const fh = await fsp.open(full, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_ARTIFACT_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    return { path: rel, bytes: st.size, truncated, text: buf.toString("utf8") };
  } finally {
    await fh.close();
  }
}

/* ────────────────────────────── writing ────────────────────────────── */

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "edit";
}

export async function createRun(input: {
  name?: string; link?: string; cadence?: string;
  editorialMode?: string; acceptLongContextReprice?: boolean; stopAfter?: string;
  unattended?: boolean;
}) {
  const link = String(input.link ?? "").trim();
  if (!SHARE_RE.test(link)) {
    throw new Error("Paste a published Descript share link: https://share.descript.com/view/…");
  }
  const cadence = String(input.cadence ?? "30").trim();
  if (!CADENCE_RE.test(cadence)) throw new Error('Cadence must look like "30" or "30000/1001".');
  const name = String(input.name ?? "").trim().slice(0, 120) || "Untitled edit";
  const d = new Date();
  const stamp = `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const id = `${slug(name)}-${stamp}-${randomBytes(3).toString("hex")}`;
  const request: EditorRequest = {
    id, name, link, cadence,
    editorial_mode: input.editorialMode === "live" ? "live" : "offline",
    accept_long_context_reprice: !!input.acceptLongContextReprice,
    render_approved: false,
    unattended: input.unattended !== false,
    created_at: Date.now() / 1000,
  };
  await writeJson(path.join(ctl(id), "request.json"), request);
  const stop = STAGE_IDS.has(String(input.stopAfter)) ? String(input.stopAfter) : undefined;
  await enqueue(id, { reason: "new edit", ...(stop ? { stop_after: stop } : {}) });
  return (await summarize(id))!;
}

export async function updateSettings(idIn: unknown, input: {
  editorialMode?: string; acceptLongContextReprice?: boolean; cadence?: string; name?: string;
  unattended?: boolean;
}) {
  const id = checkId(idIn);
  const p = path.join(ctl(id), "request.json");
  const request = await readJson<EditorRequest>(p);
  if (!request) throw new Error("No such run.");
  if (input.editorialMode !== undefined) request.editorial_mode = input.editorialMode === "live" ? "live" : "offline";
  if (input.acceptLongContextReprice !== undefined) request.accept_long_context_reprice = !!input.acceptLongContextReprice;
  if (input.unattended !== undefined) request.unattended = !!input.unattended;
  if (input.cadence !== undefined) {
    const c = String(input.cadence).trim();
    if (!CADENCE_RE.test(c)) throw new Error('Cadence must look like "30" or "30000/1001".');
    request.cadence = c;
  }
  if (input.name !== undefined) request.name = String(input.name).trim().slice(0, 120) || request.name;
  if (await busy(id) === "running") throw new Error("Wait for the running step to finish before changing settings.");
  await writeJson(p, request);
  return request;
}

export async function continueRun(idIn: unknown, input: {
  force?: string[]; refreshShare?: boolean; statusRequest?: boolean; stopAfter?: string;
}) {
  const id = checkId(idIn);
  if (!(await exists(path.join(ctl(id), "request.json")))) throw new Error("No such run.");
  const force = (input.force ?? []).filter((s) => STAGE_IDS.has(s));
  const stop = STAGE_IDS.has(String(input.stopAfter)) ? String(input.stopAfter) : undefined;
  await enqueue(id, {
    reason: force.length ? `re-run ${force.join(", ")}` : input.statusRequest ? "render status check" : "continue",
    ...(force.length ? { force } : {}),
    ...(input.refreshShare ? { refresh_share: true } : {}),
    ...(input.statusRequest ? { status_request: true } : {}),
    ...(stop ? { stop_after: stop } : {}),
  });
  return (await summarize(id))!;
}

/**
 * Ask GPT-6 Astra for this stage now: flips the run to live editorial mode and
 * continues. An answer already on disk always wins over a live call, so this
 * never re-bills a stage that was answered.
 */
export async function askModel(idIn: unknown) {
  const id = checkId(idIn);
  await updateSettings(id, { editorialMode: "live" });
  return continueRun(id, {});
}

/** The render gate. The only place render_approved is set. */
export async function approveRender(idIn: unknown) {
  const id = checkId(idIn);
  const p = path.join(ctl(id), "request.json");
  const request = await readJson<EditorRequest>(p);
  if (!request) throw new Error("No such run.");
  const s11 = await readJson(path.join(runDir(id), "state", "S11.json"));
  if (s11?.status !== "done") throw new Error("Preflight (S11) has not passed; there is nothing to render yet.");
  if (await busy(id)) throw new Error("This run is busy.");
  request.render_approved = true;
  request.render_approved_at = Date.now() / 1000;
  await writeJson(p, request);
  await enqueue(id, { reason: "render approved" });
  return (await summarize(id))!;
}

export async function cancelRun(idIn: unknown) {
  const id = checkId(idIn);
  const q = path.join(ctl(id), "queue.json");
  if (await exists(q)) {
    await fsp.unlink(q).catch(() => undefined);
    return { ok: true, stopped: "queued" };
  }
  await fsp.writeFile(path.join(ctl(id), "cancel"), String(Date.now()));
  return { ok: true, stopped: "running" };
}

export async function deleteRun(idIn: unknown) {
  const id = checkId(idIn);
  if (await busy(id)) throw new Error("Cancel the run before deleting it.");
  const job = await readJson(path.join(runDir(id), "job.json"));
  await fsp.writeFile(path.join(ctl(id), "deleting"), "1").catch(() => undefined);
  await fsp.rm(runDir(id), { recursive: true, force: true });
  await fsp.rm(ctl(id), { recursive: true, force: true });
  // The render job (if one was submitted) belongs to the Render queue and is
  // deleted there — this tool never reaches into the queue's directories.
  return { ok: true, renderJobId: job?.job_id ?? null };
}

/** Paste an answer for S4/S5 (or the S17 worksheet), bound to the current question. */
export async function submitAnswer(idIn: unknown, stageIn: unknown, contentIn: unknown) {
  const id = checkId(idIn);
  const stage = String(stageIn ?? "");
  if (!MODEL_STAGES.has(stage)) throw new Error("Answers are only for S4, S5, S8 and S17.");
  const raw = String(contentIn ?? "");
  if (Buffer.byteLength(raw) > MAX_ANSWER_BYTES) throw new Error("That answer is larger than 4 MB.");
  let content: unknown;
  try {
    content = JSON.parse(raw.trim().replace(/^```[A-Za-z0-9_-]*\s*/, "").replace(/\s*```\s*$/, ""));
  } catch (e) {
    throw new Error(`The answer is not valid JSON: ${(e as Error).message}`);
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("The answer must be a JSON object.");
  }
  const req = await readJson(path.join(runDir(id), "model", `${stage}-request.json`));
  if (!req?.prompt_sha256) throw new Error(`${stage} has not asked a question yet.`);
  if (await busy(id)) throw new Error("This run is busy.");
  // ⚠️ The digest binds the answer to THIS question (hfp/editorial.py). It is
  // copied from the request the operator was shown, never typed.
  await writeJson(path.join(runDir(id), "model", `${stage}-answer.json`), {
    request_sha256: req.prompt_sha256, content, source: "lab-paste", written_at: Date.now() / 1000,
  });
  await fsp.unlink(path.join(runDir(id), "model", `${stage}-rejected.json`)).catch(() => undefined);
  return continueRun(id, {});
}

/** Throw away a rejected (or unwanted) answer so the stage asks again. */
export async function discardAnswer(idIn: unknown, stageIn: unknown) {
  const id = checkId(idIn);
  const stage = String(stageIn ?? "");
  if (!MODEL_STAGES.has(stage)) throw new Error("Only S4, S5, S8 and S17 have answers.");
  if (await busy(id)) throw new Error("This run is busy.");
  const dir = path.join(runDir(id), "model");
  const stamp = Date.now();
  // Kept beside the run rather than deleted: a rejected plan and its findings
  // are evidence of what the model proposed.
  for (const f of [`${stage}-answer.json`, `${stage}-rejected.json`]) {
    await fsp.rename(path.join(dir, f), path.join(dir, `discarded-${stamp}-${f}`)).catch(() => undefined);
  }
  return { ok: true };
}

export async function chooseComposition(idIn: unknown, compositionIdIn: unknown) {
  const id = checkId(idIn);
  const q = await readJson(path.join(runDir(id), "requests", "S1-composition.json"));
  if (!q?.asked_digest) throw new Error("S1 is not asking which composition to use.");
  const compositionId = String(compositionIdIn ?? "");
  if (!(q.candidates ?? []).some((c: any) => c.id === compositionId)) {
    throw new Error("Pick one of the listed compositions.");
  }
  await writeJson(path.join(runDir(id), "decisions", "S1-composition.json"), {
    composition_id: compositionId, asked_digest: q.asked_digest, why: "chosen in the Lab",
  });
  return continueRun(id, {});
}

export async function saveHandoffTasks(idIn: unknown, jsonIn: unknown) {
  const id = checkId(idIn);
  let tasks: unknown;
  try {
    tasks = JSON.parse(String(jsonIn ?? ""));
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
    throw new Error('handoff-tasks.json is an object keyed by screencast id, e.g. {"SC001": {...}}.');
  }
  if (await busy(id)) throw new Error("This run is busy.");
  await writeJson(path.join(runDir(id), "handoff-tasks.json"), tasks);
  return continueRun(id, {});
}

/**
 * The S17 sign-off. The pipeline validates it (named human reviewer, sound,
 * every cue, the render's own sha256); this only refuses the obvious so the
 * operator hears about it before a round trip through the worker.
 */
export async function submitAttestation(idIn: unknown, att: any) {
  const id = checkId(idIn);
  const qa = await readJson(path.join(runDir(id), "qa-editorial.json"));
  const sha = qa?.render?.sha256;
  if (!sha) throw new Error("There is no rendered video to sign off yet.");
  if (!att || typeof att !== "object") throw new Error("Missing sign-off.");
  if (!String(att.reviewer ?? "").trim()) throw new Error("Put your name on the review.");
  if (att.watched_with_sound !== true) throw new Error("The review must be done with sound on.");
  if (!["pass", "fail"].includes(att.verdict)) throw new Error("Choose pass or fail.");
  if (await busy(id)) throw new Error("This run is busy.");
  await writeJson(path.join(runDir(id), "model", "S17-attestation.json"), {
    reviewer: String(att.reviewer).trim().slice(0, 120),
    watched_with_sound: true,
    render_sha256: sha,
    reviewed_at: new Date().toISOString(),
    cues: att.cues ?? {},
    subjective_checks: att.subjective_checks ?? {},
    verdict: att.verdict,
  });
  return continueRun(id, {});
}

/** For the page header: is the worker alive? */
export async function serviceStatus() {
  const heartbeat = await readJson(path.join(ROOT, "worker-heartbeat.json"));
  const now = Date.now() / 1000;
  return {
    root: ROOT,
    workerAlive: !!heartbeat && now - (heartbeat.at ?? 0) < 60,
    workerSeenAt: heartbeat?.at ?? null,
    stages: STAGES,
  };
}
