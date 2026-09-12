/**
 * The machine-facing render API — what ChatGPT talks to.
 *
 * Contract: /opt/hyperframes-runner/API.md
 *
 * ⚠️⚠️ THIS IS THE ONLY PART OF THE LAB THAT IS REACHABLE WITHOUT SIGNING IN,
 * so everything it exposes is deliberate and nothing else moved. It is mounted
 * BEFORE `requireSession` in index.ts, which is exactly why every route here
 * checks the bearer token itself: forget that, and the route is simply public.
 *
 * ⚠️ AN API KEY AUTHENTICATES THE CALLER, NOT THE CALLER'S URLS. Submissions
 * carry links the server then fetches, which would make this an SSRF engine
 * pointed at the droplet's own metadata service and every localhost port. The
 * guard for that lives in the worker's fetcher (`guard_url`), because that is
 * where the request is actually made — including on redirects, and on retries
 * hours later when this process is long gone.
 */
import express, { type Request, type Response, type Router } from "express";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  listJobs,
  getJob,
  createApiJob,
  cancelJob,
  deleteJob,
  serviceStatus,
  safeRelative,
  type HyperframesJob,
} from "./jobs.js";
import {
  createUpload,
  getUpload,
  listUploads,
  putUploadFile,
  deleteUpload,
} from "./uploads.js";

const WORK = process.env.HYPERFRAMES_WORK || "/hyperframes-work";
/** Not under `jobs/`, so the authed static file route can never serve it. */
const KEY_FILE = path.join(WORK, ".api-key");

/* ────────────────────────── the key ────────────────────────── */

/**
 * The API key, generated on first use.
 *
 * ⚠️ NEVER LOGGED AND NEVER RETURNED BY THIS ROUTER. It is read back only by a
 * session-authenticated endpoint, so seeing it requires signing in with Google
 * — the key is for machines, the sign-in is for Jake.
 */
export function apiKey(): string {
  try {
    const existing = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const key = `hfk_${crypto.randomBytes(24).toString("base64url")}`;
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
  return key;
}

function presented(req: Request): string {
  const header = String(req.get("authorization") || "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  return String(req.get("x-api-key") || "").trim();
}

/**
 * ⚠️ TIMING-SAFE, AND LENGTH IS COMPARED FIRST BECAUSE `timingSafeEqual` THROWS
 * ON A LENGTH MISMATCH. A plain `===` leaks the key one character at a time to
 * anyone patient enough to measure.
 */
function authorised(req: Request): boolean {
  const given = Buffer.from(presented(req));
  const want = Buffer.from(apiKey());
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/* ────────────────────────── rate limiting ────────────────────────── */

// A small fixed window, per address. This is not abuse prevention — the key is
// that — it is a guard against a polling loop hammering a 4-vCPU box that is
// also serving Postiz.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, { n: number; until: number }>();

function rateLimited(req: Request): boolean {
  const now = Date.now();
  const who = req.ip || "unknown";
  const seen = hits.get(who);
  if (!seen || seen.until < now) {
    hits.set(who, { n: 1, until: now + WINDOW_MS });
    if (hits.size > 1000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
    return false;
  }
  seen.n += 1;
  return seen.n > MAX_PER_WINDOW;
}

/* ────────────────────────── shaping ────────────────────────── */

type ApiStatus = "queued" | "fetching" | "rendering" | "done" | "failed" | "cancelled" | "unknown";

/** The internal job state, in the vocabulary the contract promises. */
function apiStatus(job: HyperframesJob): ApiStatus {
  if (job.state !== "running") return job.state as ApiStatus;
  return job.phase === "fetching" ? "fetching" : "rendering";
}

function progress(job: HyperframesJob): Record<string, unknown> {
  return {
    job_id: job.id,
    client_ref: job.clientRef || null,
    status: apiStatus(job),
    step: job.step || "",
    progress_percent: job.percent,
    frames_completed: job.framesCompleted,
    total_frames: job.totalFrames,
    estimated_minutes_remaining: job.estimatedMinutesRemaining,
    attempt: job.attempt,
    elapsed_seconds: job.elapsedSeconds,
    updated_at: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
    message: job.message || "",
    // Present when a chunked render stopped early: the finished chunks, joined.
    ...(job.partialOutput
      ? {
          partial: {
            url: `/api/hyperframes/v1/jobs/${job.id}/partial`,
            seconds: job.partialSeconds,
            chunks: job.partialChunks,
          },
        }
      : {}),
  };
}

function fail(res: Response, code: number, error: string, message: string): void {
  res.status(code).json({ error, message });
}

/* ────────────────────────── the router ────────────────────────── */

export function hyperframesApiRouter(): Router {
  const router = express.Router();

  // Projects arrive inline, and a composition with a base64 font in it is well
  // past the default 100 kB body limit. Anything genuinely large streams into an
  // upload bucket instead, so this ceiling stays modest on purpose.
  // ⚠️ Only applies to JSON bodies: an octet-stream upload is never parsed here,
  // which is what lets `PUT /uploads/:id/*` stream gigabytes without buffering.
  router.use(express.json({ limit: "48mb" }));

  router.use((req, res, next) => {
    if (!authorised(req)) {
      fail(res, 401, "unauthorized", "Missing or invalid API key.");
      return;
    }
    if (rateLimited(req)) {
      fail(res, 429, "rate_limited", `More than ${MAX_PER_WINDOW} requests in a minute.`);
      return;
    }
    next();
  });

  router.get("/ready", async (_req, res) => {
    const s = await serviceStatus();
    const free = s.diskFreeBytes;
    res.json({
      ok: s.ready && s.workerHealthy && free > 5 * 1024 ** 3,
      runtime: {
        hyperframes: "0.8.30",
        browser: "Chrome headless shell 152.0.7977.30",
        node: "24.19.0",
      },
      worker: { healthy: s.workerHealthy, running: s.running, queued: s.queued },
      disk: { free_bytes: free, free_human: `${(free / 1024 ** 3).toFixed(1)}GB` },
      concurrency: 1,
    });
  });

  router.post("/jobs", async (req, res) => {
    const body = req.body ?? {};
    try {
      const job = await createApiJob({
        name: String(body.name || "render"),
        clientRef: body.client_ref ? String(body.client_ref) : undefined,
        projectFiles: body.project?.files,
        projectUrl: body.project?.url ? String(body.project.url) : undefined,
        uploadId: body.project?.upload_id ? String(body.project.upload_id) : undefined,
        sources: Array.isArray(body.sources) ? body.sources : [],
        // Passed through untouched: a rational like "30000/1001" must survive.
        fps: body.render?.fps,
        quality: body.render?.quality,
        outputName: body.render?.output_name,
        chunkSeconds: body.render?.chunk_seconds ? Number(body.render.chunk_seconds) : undefined,
        chunkFrames: body.render?.chunk_frames ? Number(body.render.chunk_frames) : undefined,
      });
      res.status(202).json({
        job_id: job.id,
        client_ref: job.clientRef || null,
        status: "queued",
        runtime: "Hyperframes 0.8.30",
      });
    } catch (err) {
      fail(res, 400, "invalid_request", err instanceof Error ? err.message : "Bad submit.");
    }
  });

  router.get("/jobs", async (_req, res) => {
    res.json({ jobs: (await listJobs()).map(progress) });
  });

  router.get("/jobs/:id", async (req, res) => {
    try {
      const { job } = await getJob(String(req.params.id), 0);
      res.json(progress(job));
    } catch {
      fail(res, 404, "not_found", "No such job.");
    }
  });

  router.get("/jobs/:id/result", async (req, res) => {
    let job: HyperframesJob;
    try {
      ({ job } = await getJob(String(req.params.id), 0));
    } catch {
      fail(res, 404, "not_found", "No such job.");
      return;
    }
    if (job.state !== "done" || !job.output) {
      fail(res, 404, "not_found", `Job is ${apiStatus(job)}, not done.`);
      return;
    }
    const base = `/api/hyperframes/v1/jobs/${job.id}`;
    res.json({
      job_id: job.id,
      client_ref: job.clientRef || null,
      status: "done",
      video: { url: `${base}/video`, bytes: job.outputBytes },
      project: { url: `${base}/project.tar.gz` },
      log: { url: `${base}/log` },
      render: { seconds: job.elapsedSeconds, attempts: job.attempt, frames: job.totalFrames },
      runtime: { hyperframes: "0.8.30", browser: "152.0.7977.30" },
    });
  });

  router.post("/jobs/:id/cancel", async (req, res) => {
    try {
      await cancelJob(String(req.params.id));
      res.json({ ok: true });
    } catch {
      fail(res, 404, "not_found", "No such job.");
    }
  });

  router.delete("/jobs/:id", async (req, res) => {
    try {
      const { freedBytes } = await deleteJob(String(req.params.id), req.query.keep_output === "true");
      res.json({ ok: true, freed_bytes: freedBytes });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Delete failed.";
      // A running job is a conflict, not a client error: cancel then retry.
      if (/still going/i.test(message)) fail(res, 409, "conflict", message);
      else fail(res, 404, "not_found", message);
    }
  });

  /* ── uploads: the way in for bytes with no URL ────────────────────────── */

  /**
   * ⚠️ THE WHOLE POINT IS THAT THE CALLER HAS NO WHERE TO PUT THE FILE. A font,
   * a background image or a clip the caller just produced cannot be given as a
   * URL, and `project.files` is UTF-8 — so without this there is simply no
   * route for it, which is what blocked the first styled render.
   */
  router.post("/uploads", async (req, res) => {
    try {
      const bucket = await createUpload(String(req.body?.name || "assets"));
      res.status(201).json({
        upload_id: bucket.id,
        name: bucket.name,
        expires_in_hours: 24,
        put: `/api/hyperframes/v1/uploads/${bucket.id}/<path>`,
      });
    } catch (err) {
      fail(res, 500, "server_error", err instanceof Error ? err.message : "Could not create upload.");
    }
  });

  router.get("/uploads", async (_req, res) => {
    res.json({
      uploads: (await listUploads()).map((u) => ({
        upload_id: u.id,
        name: u.name,
        created_at: new Date(u.createdAt).toISOString(),
        bytes: u.bytes,
        files: u.files,
      })),
    });
  });

  router.get("/uploads/:id", async (req, res) => {
    try {
      const u = await getUpload(String(req.params.id));
      res.json({
        upload_id: u.id,
        name: u.name,
        created_at: new Date(u.createdAt).toISOString(),
        bytes: u.bytes,
        files: u.files,
      });
    } catch {
      fail(res, 404, "not_found", "No such upload.");
    }
  });

  /**
   * One file, streamed to disk.
   *
   * ⚠️ THE BODY IS NEVER BUFFERED, which is the only reason a 4K master can come
   * through here at all. That also means the Content-Type matters: a JSON body
   * is parsed upstream before this handler ever runs, so it is refused with an
   * explanation rather than silently written as an empty file.
   */
  router.put("/uploads/:id/*", async (req, res) => {
    const rel = String((req.params as Record<string, string>)[0] || "");
    if (!rel) {
      fail(res, 400, "invalid_request", "Give the file a path: PUT /uploads/{id}/fonts/Inter.woff2");
      return;
    }
    if ((req as Request & { _body?: boolean })._body) {
      fail(
        res,
        415,
        "unsupported_media_type",
        "Send the file as application/octet-stream. A JSON body is parsed, not stored — " +
          "for small text-safe assets use base64 in project.files instead.",
      );
      return;
    }
    try {
      const file = await putUploadFile(String(req.params.id), rel, req, safeRelative);
      res.status(201).json({ upload_id: String(req.params.id), ...file });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      if (/no such upload/i.test(message)) fail(res, 404, "not_found", message);
      else if (/disk space/i.test(message)) fail(res, 507, "insufficient_storage", message);
      else fail(res, 400, "invalid_request", message);
    }
  });

  router.delete("/uploads/:id", async (req, res) => {
    try {
      const { freedBytes } = await deleteUpload(String(req.params.id));
      res.json({ ok: true, freed_bytes: freedBytes });
    } catch {
      fail(res, 404, "not_found", "No such upload.");
    }
  });

  /* ── downloads, bearer-authed like everything else here ───────────────── */

  const sendFromJob = (req: Request, res: Response, rel: string, type?: string): void => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
      fail(res, 400, "invalid_request", "Invalid job id.");
      return;
    }
    const file = path.join(WORK, "jobs", id, rel);
    if (!fs.existsSync(file)) {
      fail(res, 404, "not_found", "Not available for that job.");
      return;
    }
    if (type) res.type(type);
    // sendFile handles range requests, so a large result resumes.
    res.sendFile(file);
  };

  router.get("/jobs/:id/video", async (req, res) => {
    try {
      const { job } = await getJob(String(req.params.id), 0);
      if (!job.output) {
        fail(res, 404, "not_found", "No output yet.");
        return;
      }
      sendFromJob(req, res, path.join("output", job.output), "video/mp4");
    } catch {
      fail(res, 404, "not_found", "No such job.");
    }
  });

  /** The salvaged video from a render that stopped before it finished. */
  router.get("/jobs/:id/partial", async (req, res) => {
    try {
      const { job } = await getJob(String(req.params.id), 0);
      if (!job.partialOutput) {
        fail(res, 404, "not_found", "No partial video for that job.");
        return;
      }
      sendFromJob(req, res, path.join("output", job.partialOutput), "video/mp4");
    } catch {
      fail(res, 404, "not_found", "No such job.");
    }
  });

  router.get("/jobs/:id/log", (req, res) => sendFromJob(req, res, "render.log", "text/plain"));

  // The editable project, streamed. Never built on disk: a project carries the
  // source footage, so a temporary tarball would need gigabytes of free space
  // for no reason.
  router.get("/jobs/:id/project.tar.gz", (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
      fail(res, 400, "invalid_request", "Invalid job id.");
      return;
    }
    const root = path.join(WORK, "jobs", id);
    if (!fs.existsSync(path.join(root, "project"))) {
      fail(res, 404, "not_found", "No project for that job.");
      return;
    }
    res.type("application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${id}-project.tar.gz"`);
    const tar = spawn("tar", ["-czf", "-", "-C", root, "project"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    tar.stdout.pipe(res);
    res.on("close", () => tar.kill("SIGTERM"));
    tar.on("error", () => res.destroy());
  });

  return router;
}
