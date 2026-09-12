import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, ensureDirs, authConfigured, oauthRedirectUri } from "./config.js";
import { auth } from "./middleware.js";
import authRouter from "./auth/routes.js";
import { requireSession } from "./auth/middleware.js";
import { youtubeOAuthRouter } from "./audit/oauthRoutes.js";
import { whatsappProxy } from "./whatsappProxy.js";
import { tutorialRouter } from "./tutorial/route.js";
import { plannerMotionRouter } from "./routes/plannerMotion.js";
import { startWorker } from "./render/worker.js";
import { failInterruptedRuns } from "./db/bulkPreview.js";
import { remotionRuntimeAvailable } from "./motion/render.js";
import { queueDepth } from "./db/jobs.js";
import { failOrphanedRuns } from "./db/scriptRuns.js";
import { googleDocsOAuthRouter } from "./scriptgen/docsOauthRoutes.js";
import { hyperframesApiRouter } from "./hyperframes/api.js";
import { failOrphanedQueueItems } from "./db/scriptQueue.js";
import { failInterruptedRuns as failInterruptedAudits } from "./db/auditRuns.js";
import { startMonitor } from "./engage/monitor.js";
import { startReplyWorker } from "./engage/replyWorker.js";
import { startEngageScheduler } from "./skool/engageSchedule.js";
import { getSkoolSettings } from "./db/skool.js";
import { PUBLIC_ASSET_ROUTE, pruneExpired as pruneAvatarAssets } from "./avatar/publicAssets.js";
import { resumeInterrupted as resumeAvatarRuns } from "./avatar/pipeline.js";
import uploadsRouter from "./routes/uploads.js";
import renderRouter, { rendiRouter } from "./routes/render.js";
import projectsRouter from "./routes/projects.js";
import batchesRouter from "./routes/batches.js";
import fnRouter from "./routes/fn.js";

/**
 * ClipMagic self-hosted server. One process does everything the old multi-
 * service setup did — uploads (no 25MB cap), storage, database, FFmpeg
 * rendering (no Rendi) and bulk batches — so it can all run on a single
 * DigitalOcean droplet.
 */
ensureDirs();

const app = express();
app.use(cors());

// Baseline security headers on every response (no dependency; deliberately NOT
// helmet's default CSP, which breaks the SPA). HSTS is honored only over the
// HTTPS the app is actually served on (Caddy → lab.jakedaw.com).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});

// Large JSON bodies: manifests for a 300-item batch can be sizeable.
app.use(express.json({ limit: "256mb" }));

// ── Avatar Narrator provider drop (the ONE route outside the auth gate) ─────
// Mounted BEFORE requireSession because it is not for the operator — it is for
// kie.ai / WaveSpeed, whose fetchers pull the portrait and the narration by URL
// with no Google session. Everything served here is a copy of a provider INPUT
// under a 128-bit random path that expires within 24h; see
// avatar/publicAssets.ts for the full rationale and the rules. `index: false`
// and `dotfiles: "deny"` so a token cannot be probed by listing.
app.use(
  PUBLIC_ASSET_ROUTE,
  express.static(config.publicAssetsDir, { index: false, dotfiles: "deny", fallthrough: false })
);
// `fallthrough: false` is deliberate — without it an expired token would fall
// through the gate to the SPA and hand the provider an HTML page where it asked
// for a JPEG. But it reports a miss by passing ENOENT to the error handler,
// which answers 500 and logs it. A swept or mistyped token is a 404, not a
// server fault, so it is translated here rather than polluting the error log.
app.use(PUBLIC_ASSET_ROUTE, (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.code === "ENOENT" || err?.statusCode === 404 || err?.status === 404) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  next(err);
});

// ── Google Sign-In auth gate ────────────────────────────────────────────────
// The sign-in routes must be reachable BEFORE the gate; the gate then covers
// everything mounted after it (all /api/*, /v1, the static SPA and the `*`
// fallback) in one place. When Google creds aren't set, requireSession is a
// pass-through and the app stays open (legacy behavior).
app.use(authRouter);

// ⚠️⚠️ THE RENDER API IS MOUNTED BEFORE THE SIGN-IN GATE ON PURPOSE — it is the
// one machine-facing surface, so ChatGPT can reach it with a bearer token while
// every page and every other endpoint stays behind Google Sign-In. Each route in
// that router checks the API key itself; nothing here grants access.
app.use("/api/hyperframes/v1", hyperframesApiRouter());

app.use(requireSession);

// Connecting a YouTube channel for the Channel Audit's paid/organic split.
// AFTER requireSession on purpose: only a signed-in operator may start an OAuth
// flow that will store a token on this server.
app.use(youtubeOAuthRouter());
  app.use(googleDocsOAuthRouter());

// Health / readiness — no auth, handy for load balancers and uptime checks.
app.get("/health", (_req, res) => {
  res.json({ ok: true, queue: queueDepth(), concurrency: config.renderConcurrency });
});

// Rendered outputs (served statically; long cache since names are unique).
app.use(
  "/api/outputs",
  auth,
  express.static(config.outputsDir, { maxAge: "1y", immutable: true })
);

// Thumbnail Designer character library — read-only reference images stored under
// DATA_DIR/thumbnail-characters. Short cache since a re-upload reuses the name
// (the UI cache-busts the preview URL with the update time).
app.use(
  "/api/thumbnail-characters",
  auth,
  express.static(path.join(config.dataDir, "thumbnail-characters"))
);

// Thumbnail Designer background library — read-only uploaded backgrounds under
// DATA_DIR/thumbnail-backgrounds (same caching/cache-bust scheme as characters).
app.use(
  "/api/thumbnail-backgrounds",
  auth,
  express.static(path.join(config.dataDir, "thumbnail-backgrounds"))
);

// The render API contract, readable from the Render queue page.
//
// Resolved relative to this module rather than the working directory, so the
// same path works from `dist/` in the container and from `src/` in a dev run.
// Served as text/plain so a browser shows it inline instead of downloading it.
app.get("/api/hyperframes/docs", auth, (req, res) => {
  const file = fileURLToPath(new URL("../assets/hyperframes-api.md", import.meta.url));
  if (req.query.download !== undefined) {
    // A real .md file to hand to ChatGPT as an upload. text/markdown rather than
    // text/plain so it keeps its type wherever it lands.
    res.type("text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="hyperframes-render-api.md"');
  } else {
    // Inline reading: text/plain is what makes a browser show it instead of
    // downloading it.
    res.type("text/plain; charset=utf-8");
  }
  res.sendFile(file);
});

// Hyperframes render queue — the editable project, as a stream.
//
// ⚠️ STREAMED, NEVER BUILT ON DISK OR IN MEMORY. A project carries the source
// footage, so it can be gigabytes; writing a temporary tarball would need as
// much free space again, and buffering it would take the server down. `tar`
// writes to stdout and that is piped straight to the response, so the cost is
// constant regardless of project size.
app.get("/api/hyperframes/project/:id.tar.gz", auth, (req, res) => {
  const id = String(req.params.id || "");
  // Same guard as the endpoint handlers: the id is a directory name from a
  // browser and must never be able to climb out of the jobs tree.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) {
    res.status(400).json({ error: "Invalid job id." });
    return;
  }
  const root = path.join(process.env.HYPERFRAMES_WORK || "/hyperframes-work", "jobs", id);
  if (!fs.existsSync(path.join(root, "project"))) {
    res.status(404).json({ error: "No project for that job." });
    return;
  }
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${id}-project.tar.gz"`);
  const tar = spawn("tar", ["-czf", "-", "-C", root, "project"], { stdio: ["ignore", "pipe", "ignore"] });
  tar.stdout.pipe(res);
  // A client that closes the tab must not leave tar running against a dead pipe.
  res.on("close", () => tar.kill("SIGTERM"));
  tar.on("error", () => res.destroy());
});

// Hyperframes render queue — finished MP4s, the editable project and the render
// log, so a job's results can be downloaded from the browser.
//
// ⚠️ BEHIND `auth` LIKE EVERY OTHER MEDIA ROUTE, and read-only. It serves the
// job directory tree, which is the user's own footage and output; there is no
// upload or delete here (those go through the endpoint handlers, which validate
// the job id). Renders can be gigabytes, so `express.static` handles the range
// requests rather than anything buffering a file into memory.
app.use(
  "/api/hyperframes/files",
  auth,
  express.static(path.join(process.env.HYPERFRAMES_WORK || "/hyperframes-work", "jobs"), {
    maxAge: 0,
    // A finished render keeps its name; nothing here should be cached stale.
    etag: true,
    dotfiles: "ignore",
  })
);

// AI Image Generator history — read-only images the generator saved under
// DATA_DIR/image-history (config.imageHistoryDir). Behind `auth` exactly like the
// thumbnail libraries so they load same-origin with the session cookie.
app.use(
  "/api/image-history",
  auth,
  express.static(config.imageHistoryDir)
);

// Avatar Narrator library — persona portraits, narration MP3s and finished
// talking-head MP4s under DATA_DIR/avatar (config.avatarDir). Behind `auth`,
// unlike the provider drop above: this is the operator's library.
app.use(
  "/api/avatar",
  auth,
  express.static(config.avatarDir)
);

// API
app.use("/api/uploads", auth, uploadsRouter);
app.use("/api/render", auth, renderRouter);
app.use("/api/projects", auth, projectsRouter);
app.use("/api/batches", auth, batchesRouter);
// Original frontend's backend calls (projects/shots/music/pipeline) — the
// ported ClipMagic app talks to these via /api/fn/<name>.
app.use("/api/fn", auth, fnRouter);

// Rendi-compatible shim (drop-in replacement for api.rendi.dev/v1).
app.use("/v1", auth, rendiRouter);

// WhatsApp Scheduler sidecar, reverse-proxied here so it lives INSIDE
// lab.jakedaw.com behind the Google Sign-In gate (requireSession, above) rather
// than on a public subdomain. Mounted before the SPA so /wa isn't swallowed by
// the `*` fallback; inert (503) until WHATSAPP_URL is set. See whatsappProxy.ts.
app.use("/wa", whatsappProxy());

// Tutorial Studio reels. The JSON API for this tool rides /api/fn like every
// other tool; only the finished mp4 needs its own route (Range requests, so the
// player can seek). After requireSession, like everything above.
app.use("/api/tutorial", tutorialRouter());

// Video Planner motion graphics — the generated cards for a plan run. A plain
// route, not /api/fn, because the clips need Range requests to scrub; and not
// express.static over the planner dir, because that dir also holds each run's
// multi-gigabyte source narration. See routes/plannerMotion.ts.
app.use("/api/planner-motion", plannerMotionRouter());

// Serve a frontend. Preference order:
//   1. A built Vite app at FRONTEND_DIR (the full ClipMagic UI), if present.
//   2. The bundled self-contained bulk dashboard in server/public — so the
//      droplet is usable end-to-end (upload → render 300+ → download) with no
//      separate frontend build step.
const publicDir = path.join(config.serverRoot, "public");
const uiDir = fs.existsSync(path.join(config.frontendDir, "index.html"))
  ? config.frontendDir
  : fs.existsSync(path.join(publicDir, "index.html"))
  ? publicDir
  : null;

// The standalone bulk editor (no build step) stays available at /bulk even when
// the full React app is the primary UI.
const bulkDir = path.join(config.serverRoot, "public");
if (fs.existsSync(path.join(bulkDir, "index.html"))) {
  app.use("/bulk", express.static(bulkDir));
}

if (uiDir) {
  // CACHING, and why it is spelled out rather than left to express.static:
  //
  // Vite fingerprints every bundle (assets/index-<hash>.js) and rewrites
  // index.html to point at the new name. express.static sends no Cache-Control
  // at all, so a browser applies HEURISTIC freshness and can reuse a cached
  // index.html without revalidating — one that names a bundle the last deploy
  // deleted. The result is a white page that only a hard refresh fixes, which
  // is exactly what happened on 2026-08-24.
  //
  // So: the HTML entry point must always be revalidated, while the fingerprinted
  // assets it names can be cached hard (their name changes when they do).
  const setCacheHeaders = (res: express.Response, filePath: string) => {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else if (/[\\/]assets[\\/]/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  };
  app.use(express.static(uiDir, { setHeaders: setCacheHeaders }));
  app.get("*", (req, res, next) => {
    // NOTE the exact match on /bulk: the standalone dashboard lives at /bulk,
    // but a prefix test also swallows the React route /bulk-scheduler, which
    // then 404s on a direct load or refresh (client-side navigation hides it,
    // so it only bites someone who reloads the page — 2026-08-24).
    if (
      req.path.startsWith("/api/") ||
      req.path === "/api" ||
      req.path.startsWith("/v1/") ||
      req.path === "/v1" ||
      req.path === "/bulk" ||
      req.path.startsWith("/bulk/")
    ) {
      return next();
    }
    // Same rule for the SPA fallback — this is the path most deep links take.
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(uiDir, "index.html"));
  });
  console.log(`[server] serving UI from ${uiDir}`);
}

// Central error handler.
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[error]", err.message);
    if (res.headersSent) return;
    const isLimit = /file too large/i.test(err.message) || (err as { code?: string }).code === "LIMIT_FILE_SIZE";
    res.status(isLimit ? 413 : 500).json({ error: err.message });
  }
);

app.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(`[server] data dir: ${config.dataDir}`);
  // Script-generator jobs live in memory; a restart strands any run that was
  // mid-flight as 'running' forever. Mark them failed so they read as dead.
  const orphaned = failOrphanedRuns();
  if (orphaned > 0) console.log(`[server] marked ${orphaned} interrupted script run(s) as failed`);
  // The bulk queue is durable but its WORKER is not: nothing is auto-restarted,
  // because silently resuming hours of paid generation after a deploy is not a
  // decision a boot sequence should make. The queue is left paused and visible.
  failOrphanedQueueItems();
  // Same for a Channel Audit: its progress lives in memory, so a restart leaves
  // a working status with nothing working on it. Marked failed, it can be
  // carried on from where it stopped instead of being re-run from nothing.
  const deadAudits = failInterruptedAudits();
  if (deadAudits > 0) console.log(`[audit] marked ${deadAudits} interrupted audit(s) as failed — they can be carried on`);
  // Auth gate status — a missing config means the app is OPEN, which must be
  // impossible to miss in the logs.
  if (authConfigured()) {
    console.log(
      `[auth] Google Sign-In ENABLED — allow-list: ${config.authAllowedEmails.join(", ")} · ` +
        `redirect_uri=${oauthRedirectUri() || "(unset!)"}`
    );
  } else {
    console.warn(
      "[auth] Google Sign-In DISABLED — app is OPEN (no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET). " +
        "Set them to lock the app to the allow-list."
    );
  }
  // Surface which AI providers are configured so a missing/unpropagated key is
  // obvious in the logs at boot (values are never printed — only presence).
  const yn = (v: unknown) => (v ? "yes" : "NO");
  console.log(
    `[server] AI config — transcription(GROQ_API_KEY)=${yn(process.env.GROQ_API_KEY)} ` +
      `director(ANTHROPIC_API_KEY)=${yn(process.env.ANTHROPIC_API_KEY)} ` +
      `kinovi(ZITE_KINOVI_API_KEY)=${yn(process.env.ZITE_KINOVI_API_KEY)}`
  );
  // Remotion readiness probe at boot: logs whether motion graphics + stickers
  // can actually render here and the resolved Chromium executable, so a missing
  // browser / failed launch is obvious immediately rather than at first render.
  void logMotionReadiness();
// A plan that was building when the process stopped has no worker any more —
// fail it so a reconnecting page gets an answer instead of a spinner.
{
  const ghosts = failInterruptedRuns();
  if (ghosts) console.log(`[bulk] ${ghosts} interrupted plan build(s) marked failed`);
}
  startWorker();
  // Engagement Manager: always-on read-only YouTube comment monitor. Resilient
  // (never throws), quota-bounded, 10-min interval. Durable data lives in SQLite.
  startMonitor();
  // Engagement Manager: autonomous reply worker. Inert while the kill-switch is
  // armed (its default), so this is a no-op until someone opts in.
  startReplyWorker();
  // Skool Manager: the autonomous community poster. Inert until the schedule is
  // enabled (off by default) AND dry run is turned off (on by default), so
  // arming it is two deliberate acts, not one. The community URL is read per
  // tick rather than captured here — the lab boots before it is set.
  startEngageScheduler(() => String(getSkoolSettings().communityUrl ?? "").trim());

  // Avatar Narrator: an avatar render runs for tens of minutes on the
  // provider's side, so a deploy will land mid-render. Re-attach to anything
  // already submitted rather than abandoning a render that has been paid for,
  // and sweep any capability URLs the last process left behind.
  try {
    const { resumed, failed } = resumeAvatarRuns();
    if (resumed || failed) console.log(`[avatar] resumed ${resumed} interrupted run(s), failed ${failed} pre-submit`);
    const swept = pruneAvatarAssets();
    if (swept) console.log(`[avatar] swept ${swept} expired public asset(s)`);
  } catch (e) {
    console.warn(`[avatar] startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});

/**
 * Probe and log Remotion/Chromium readiness once at boot. Non-blocking: the
 * server is already listening; this just surfaces the resolved browser path (or
 * the failure reason) in the logs. The probe result is cached, so getServiceStatus
 * reuses it without re-launching Chromium.
 */
async function logMotionReadiness(): Promise<void> {
  const exe = config.remotionBrowserExecutable || "(Remotion-managed download)";
  if (config.motionGraphicsForceDisabled) {
    console.log(
      `[motion] short-form motion graphics FORCE-DISABLED via MOTION_GRAPHICS=0 ` +
        `(stickers still run when Chromium is available) — chromium=${exe}`
    );
  }
  try {
    const ready = await remotionRuntimeAvailable();
    if (ready) {
      console.log(`[motion] Remotion ready — chromium=${exe}`);
    } else {
      console.warn(
        `[motion] Remotion NOT ready — Chromium could not launch (chromium=${exe}). ` +
          `Motion graphics & stickers will fall back to a normal render.`
      );
    }
  } catch (e) {
    console.warn(
      `[motion] Remotion readiness probe errored: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
