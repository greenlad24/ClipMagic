/**
 * UX Scout — HTTP surface (behind the Lab sign-in).
 *
 *   POST /api/scout/<fn>                 JSON in, JSON out
 *   GET  /api/scout/jobs/:id/files/:f    a screenshot of a job (live view, report)
 *
 * Two callers:
 *   - the Lab UI (Script Generator → "UX Scout"): tools + live login console,
 *     queue a job, watch its progress, read the report;
 *   - scout/cli.ts, run by Claude Code (Max plan) via the host runner: claim a
 *     job, act in the browser, narrate, keep key screenshots, finish.
 * The CLI runs INSIDE the container and signs its own session cookie, so no
 * route here sits outside the sign-in gate.
 *
 * The Lab itself never calls Claude for the Scout (Jake's Max-plan ruling,
 * 2026-10-02): Claude Code does the thinking; this only holds the browser.
 */
import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  listTools, addTool, removeTool, markLoggedIn, getTool, createJob, getJob, listJobs, claimNextJob, requestCancel,
  markCancelled, finishJob, failJob, addEvent, listEvents, countEvents, latestShot, setKeyShots, jobDir, assetsDir,
  type KeyShot,
} from "./store.js";
import { runAction, saveJobShot, importSession, type ScoutAction } from "./browser.js";
import { saveShot } from "../scriptgen/shots.js";
import { attachUxScout } from "../scriptgen/run.js";
import { onScoutFinished, DEMO_CONTEXT_PREFIX } from "../news/deepDiveDemo.js";

type Handler = (input: any) => Promise<unknown> | unknown;
const bad = (message: string, status = 400) => Object.assign(new Error(message), { status });

const shotUrl = (jobId: string, file: string | null) => (file ? `/api/scout/jobs/${jobId}/files/${file}` : null);

function jobView(id: string, afterSeq = 0) {
  const job = getJob(id);
  if (!job) throw bad("Scout job not found.", 404);
  const tool = getTool(job.toolSlug);
  return {
    job: { ...job, keyShots: job.keyShots.map((k) => ({ ...k, url: shotUrl(id, k.file) })) },
    tool: tool ? { slug: tool.slug, name: tool.name, homeUrl: tool.homeUrl } : null,
    events: listEvents(id, afterSeq).map((e) => ({ ...e, url: shotUrl(id, e.file) })),
    steps: countEvents(id, "action"),
    latestShotUrl: shotUrl(id, latestShot(id)),
  };
}

/** Write the files Jake gave the Scout to use (a product photo…) into the job's assets. */
function saveAssets(jobId: string, assets: Array<{ name?: string; dataBase64?: string }>): string[] {
  const dir = assetsDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  for (const a of assets.slice(0, 10)) {
    const name = path.basename(String(a.name || "file")).replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file";
    const b64 = String(a.dataBase64 || "");
    const buf = Buffer.from(b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64, "base64");
    if (!buf.length || buf.length > 50 * 1024 * 1024) continue;
    fs.writeFileSync(path.join(dir, name), buf);
    saved.push(name);
  }
  return saved;
}

function runningJob(jobId: string) {
  const job = getJob(String(jobId ?? ""));
  if (!job) throw bad("Scout job not found.", 404);
  if (job.status !== "running") throw bad(`This Scout is ${job.status} — stop working on it.`, 409);
  return job;
}

const HANDLERS: Record<string, Handler> = {
  /* ── tools + live login console (UI) ── */
  listTools: () => ({ tools: listTools() }),
  addTool: (i) => ({ tool: addTool({ name: i?.name, homeUrl: i?.homeUrl, note: i?.note }) }),
  removeTool: (i) => { removeTool(String(i?.slug ?? "")); return { ok: true }; },
  /** Paste a session from Jake's own browser (cookies and/or a localStorage copy). */
  importSession: (i) => importSession(String(i?.slug ?? ""), { cookies: i?.cookies ? String(i.cookies) : undefined, storage: i?.storage ? String(i.storage) : undefined }),
  markLoggedIn: (i) => { markLoggedIn(String(i?.slug ?? "")); return { tool: getTool(String(i?.slug ?? "")) }; },
  /** One console step for logging in: { slug, act: ScoutAction } → the page after it (base64 JPEG). */
  console: async (i) => {
    const slug = String(i?.slug ?? "");
    if (!getTool(slug)) throw bad("Unknown tool.");
    const act: ScoutAction = i?.act ?? { action: "screenshot" };
    if (act.action === "upload") throw bad("Uploads are for Scout jobs only.");
    return runAction(slug, act);
  },

  /* ── jobs (UI) ── */
  createJob: (i) => {
    const job = createJob({ toolSlug: String(i?.toolSlug ?? ""), goal: String(i?.goal ?? ""), context: i?.context ? String(i.context) : undefined, runId: i?.runId ? String(i.runId) : undefined });
    const saved = Array.isArray(i?.assets) ? saveAssets(job.id, i.assets) : [];
    if (saved.length) addEvent(job.id, "note", `Files to use: ${saved.join(", ")}`);
    return jobView(job.id);
  },
  getJob: (i) => jobView(String(i?.id ?? ""), Number(i?.afterSeq) || 0),
  listJobs: (i) => ({ jobs: listJobs({ runId: i?.runId ? String(i.runId) : undefined, limit: Number(i?.limit) || 20 }) }),
  cancelJob: (i) => ({ job: requestCancel(String(i?.id ?? "")) }),
  /** Attach a finished Scout to a run at the checkpoint, or detach with jobId null. */
  attachToRun: (i) => attachUxScout(String(i?.runId ?? ""), i?.jobId ? String(i.jobId) : null),

  /* ── runner / Claude Code (via cli.ts) ── */
  claim: () => {
    const job = claimNextJob();
    if (!job) return { job: null };
    const tool = getTool(job.toolSlug)!;
    const assets = fs.existsSync(assetsDir(job.id)) ? fs.readdirSync(assetsDir(job.id)) : [];
    return { job, tool, assets, dir: jobDir(job.id) };
  },
  status: (i) => {
    const job = getJob(String(i?.jobId ?? ""));
    if (!job) throw bad("Scout job not found.", 404);
    return { status: job.status, cancelRequested: job.cancelRequested };
  },
  act: async (i) => {
    const job = runningJob(i?.jobId);
    if (job.cancelRequested) return { ok: false, cancelled: true, message: "STOP: Jake cancelled this Scout. Do not take any more actions; end now." };
    const act: ScoutAction = { ...(i?.act ?? {}), ...(i?.act?.action === "upload" ? { jobId: job.id } : {}) };
    const r = await runAction(job.toolSlug, act);
    const seq = addEvent(job.id, r.ok ? "action" : "error", `${describe(act)} — ${r.message}`);
    let file: string | null = null;
    if (r.image && act.action !== "read" && act.action !== "text" && act.action !== "tabs") {
      file = saveJobShot(job.id, r.image, seq);
      // Attach the file to the event that produced it, for the live view.
      addEvent(job.id, "shot", r.title ? `${r.title}` : (r.url ?? "screenshot"), file);
    }
    return { ok: r.ok, message: r.message, url: r.url, title: r.title, file: file ? path.join(jobDir(job.id), file) : null, output: r.output };
  },
  note: (i) => { const job = runningJob(i?.jobId); addEvent(job.id, "note", String(i?.text ?? "").slice(0, 2000)); return { ok: true }; },
  /** Mark a screenshot as one of the report's key shots: { jobId, caption, file? } (default: the latest). */
  keep: (i) => {
    const job = runningJob(i?.jobId);
    const file = i?.file ? path.basename(String(i.file)) : latestShot(job.id);
    if (!file || !fs.existsSync(path.join(jobDir(job.id), file))) throw bad("No such screenshot in this job.");
    const caption = String(i?.caption ?? "").trim().slice(0, 300);
    if (!caption) throw bad("Give the key screenshot a caption — what it shows and why it matters.");
    const shots = [...job.keyShots.filter((k) => k.file !== file), { file, caption }];
    if (shots.length > 16) throw bad("16 key screenshots is the limit — keep only the ones the script needs.");
    setKeyShots(job.id, shots);
    addEvent(job.id, "key_shot", caption, file);
    return { ok: true, keyShots: shots.length, id: `K${shots.length}` };
  },
  finish: (i) => {
    const job = runningJob(i?.jobId);
    const report = String(i?.report ?? "").trim();
    // DEMO MODE (Deep Dive's demo agent) writes a 3-line report by design.
    const demo = (job.context ?? "").startsWith(DEMO_CONTEXT_PREFIX);
    if (report.length < (demo ? 40 : 400)) throw bad(demo ? "Write the 3-line demo report first." : "The report is too short — write the full report (see the skill's template).");
    // Key shots become ordinary Script Generator screenshots, so Stage 0.4 reads them too.
    const keyShots: KeyShot[] = job.keyShots.map((k, n) => {
      try {
        const data = fs.readFileSync(path.join(jobDir(job.id), k.file)).toString("base64");
        return { ...k, ref: saveShot({ name: `UX Scout K${n + 1} — ${k.caption}`.slice(0, 200), mediaType: "image/jpeg", dataBase64: data, note: k.caption }) };
      } catch { return k; }
    });
    const done = finishJob(job.id, { report, summary: i?.summary ? String(i.summary).slice(0, 1000) : undefined, keyShots });
    if (done.runId && !onScoutFinished(done)) { try { attachUxScout(done.runId, done.id); } catch (e) { addEvent(done.id, "note", `Not attached to the script run: ${(e as Error).message}`); } }
    return { ok: true };
  },
  fail: (i) => { failJob(String(i?.jobId ?? ""), String(i?.error ?? "The Scout failed.")); return { ok: true }; },
  stopped: (i) => { markCancelled(String(i?.jobId ?? "")); return { ok: true }; },
};

function describe(a: ScoutAction): string {
  switch (a.action) {
    case "goto": return `Open ${a.url}`;
    case "click": return `Click at ${a.x},${a.y}`;
    case "click_ref": return `Click ${a.ref}`;
    case "hover_ref": return `Hover ${a.ref}`;
    case "type": return `Type "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"`;
    case "key": return `Press ${a.combo}`;
    case "scroll": return `Scroll ${a.direction}`;
    case "wait": return `Wait ${a.seconds}s`;
    case "read": return "Read the page";
    case "upload": return `Upload ${a.file}`;
    default: return a.action[0].toUpperCase() + a.action.slice(1);
  }
}

export const scoutRouter = express.Router();

scoutRouter.get("/jobs/:id/files/:file", (req: Request, res: Response) => {
  try {
    const file = path.basename(String(req.params.file));
    if (!/^\d{4}\.jpg$/.test(file)) { res.status(404).end(); return; }
    const p = path.join(jobDir(String(req.params.id)), file);
    if (!fs.existsSync(p)) { res.status(404).end(); return; }
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.type("image/jpeg").sendFile(p);
  } catch { res.status(404).end(); }
});

scoutRouter.post("/:fn", express.json({ limit: "120mb" }), async (req: Request, res: Response) => {
  const h = Object.prototype.hasOwnProperty.call(HANDLERS, req.params.fn) ? HANDLERS[req.params.fn] : undefined;
  if (!h) { res.status(404).json({ error: { message: `Unknown function ${req.params.fn}` } }); return; }
  try {
    res.json(await h(req.body ?? {}));
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error(`[scout] ${req.params.fn} failed:`, err);
    res.status(status).json({ error: { message: err?.message ?? String(err) } });
  }
});
