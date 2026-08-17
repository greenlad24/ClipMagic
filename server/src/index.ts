import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "./config.js";
import { PUBLIC_ASSET_ROUTE, pruneExpired as pruneAvatarAssets } from "./avatar/publicAssets.js";
import { resumeInterrupted as resumeAvatarRuns } from "./avatar/pipeline.js";
import fnRouter from "./routes/fn.js";

/**
 * Avatar Narrator server. One process serves the UI and the API: the React app
 * from web/dist, the persona library as static files, the provider drop, and
 * the endpoint dispatcher the app calls.
 */
ensureDirs();

const app = express();
app.use(cors());

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Portraits and voice samples are POSTed as base64, so the body limit has to
// clear a full-resolution PNG comfortably.
app.use(express.json({ limit: "64mb" }));

// ── Provider drop ───────────────────────────────────────────────────────────
// kie.ai / WaveSpeed / Segmind fetch the portrait and the narration by URL with
// their own HTTP client. Everything served here is a copy of a provider INPUT
// under a 128-bit random path that expires within 24h; see
// avatar/publicAssets.ts for the rules. `index: false` and `dotfiles: "deny"`
// so a token cannot be probed by listing.
app.use(
  PUBLIC_ASSET_ROUTE,
  express.static(config.publicAssetsDir, { index: false, dotfiles: "deny", fallthrough: false })
);
// `fallthrough: false` is deliberate — without it an expired token would fall
// through to the SPA and hand the provider an HTML page where it asked for a
// JPEG. But it reports a miss by passing ENOENT to the error handler, which
// would answer 500 and log it. A swept or mistyped token is a 404, not a server
// fault, so it is translated here rather than polluting the error log.
app.use(
  PUBLIC_ASSET_ROUTE,
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.code === "ENOENT" || err?.statusCode === 404 || err?.status === 404) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    next(err);
  }
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, publicBaseUrl: config.publicBaseUrl || null });
});

// The operator's library: persona portraits, character sheets, narration MP3s
// and finished talking-head MP4s under DATA_DIR/avatar.
app.use("/api/avatar", express.static(config.avatarDir));

// The web app's backend calls.
app.use("/api/fn", fnRouter);

// The built Vite app, when there is one. In development you run `npm run dev`
// in web/ instead and Vite proxies /api back here.
const uiDir = fs.existsSync(path.join(config.frontendDir, "index.html")) ? config.frontendDir : null;
if (uiDir) {
  app.use(express.static(uiDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(uiDir, "index.html"));
  });
  console.log(`[server] serving UI from ${uiDir}`);
} else {
  console.log(`[server] no built UI at ${config.frontendDir} — run \`npm run build\` in web/, or use the Vite dev server`);
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[error]", err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: err.message });
});

app.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(`[server] data dir: ${config.dataDir}`);

  // PUBLIC_BASE_URL is not optional in practice: the render providers fetch the
  // portrait and the narration from URLs built off it, and they cannot reach
  // localhost. Say so at boot rather than letting the first render die with a
  // confusing provider-side error.
  if (!config.publicBaseUrl) {
    console.warn(
      "[server] PUBLIC_BASE_URL is unset — portraits and voices will still generate, " +
        "but no VIDEO can render: the provider has nowhere to fetch its inputs from. " +
        "Set it to a publicly reachable origin for this server (a cloudflared/ngrok " +
        "tunnel is fine for local work)."
    );
  }

  // A render runs for tens of minutes on the provider's side, so a restart will
  // land mid-render. Re-attach to anything already submitted rather than
  // abandoning a render that has been paid for, and sweep any capability URLs
  // the last process left behind.
  try {
    const { resumed, failed } = resumeAvatarRuns();
    if (resumed || failed) {
      console.log(`[avatar] resumed ${resumed} interrupted run(s), failed ${failed} pre-submit`);
    }
    const swept = pruneAvatarAssets();
    if (swept) console.log(`[avatar] swept ${swept} expired public asset(s)`);
  } catch (e) {
    console.warn(`[avatar] startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
});
