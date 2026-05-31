import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "./config.js";
import { auth } from "./middleware.js";
import { startWorker } from "./render/worker.js";
import { queueDepth } from "./db/jobs.js";
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
// Large JSON bodies: manifests for a 300-item batch can be sizeable.
app.use(express.json({ limit: "256mb" }));

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
  app.use(express.static(uiDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/v1") || req.path.startsWith("/bulk")) {
      return next();
    }
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
  startWorker();
});
