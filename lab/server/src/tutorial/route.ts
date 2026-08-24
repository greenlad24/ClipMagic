/**
 * Streams a finished Tutorial Studio reel to the browser.
 *
 * The mp4 can't come back through /api/fn — that surface is JSON, and a video
 * has to support Range requests or the player can't seek. So this is a plain
 * route, mounted AFTER requireSession, that forwards the browser's Range header
 * to the sidecar and pipes the response straight back.
 *
 * The sidecar has no public port, so this is the only path to the file, and the
 * Google gate upstream is what authorizes it.
 */
import express from "express";
import { Readable } from "node:stream";
import { call, isConfigured, TutorialUnavailable } from "./client.js";

export function tutorialRouter(): express.Router {
  const router = express.Router();

  router.get("/reel/:id.mp4", async (req, res) => {
    if (!isConfigured()) {
      res.status(503).json({ error: "Tutorial Studio is not configured." });
      return;
    }
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9]/g, "");
    if (!id) {
      res.status(400).json({ error: "bad job id" });
      return;
    }

    let upstream: Response;
    try {
      // `call` attaches the shared token; the Range header rides along so the
      // sidecar can answer 206 and the player can scrub.
      const range = req.headers.range;
      upstream = await call(`/api/jobs/${id}/reel.mp4`, range ? { headers: { range } } : {});
    } catch (err) {
      const unavailable = err instanceof TutorialUnavailable;
      res.status(unavailable ? 503 : 502).json({
        error: err instanceof Error ? err.message : "Tutorial Studio is unreachable.",
      });
      return;
    }

    if (!upstream.ok && upstream.status !== 206) {
      res.status(upstream.status).json({ error: "No reel for this job yet." });
      return;
    }

    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // The file is per-user output behind the auth gate — never let a shared
    // cache hold on to it.
    res.setHeader("Cache-Control", "private, no-store");

    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  });

  // Avatar preview images. Same reasoning as the reel above: binary payload, so
  // it cannot ride /api/fn. No Range handling — these are small stills.
  router.get("/avatar/:id.img", async (req, res) => {
    if (!isConfigured()) {
      res.status(503).json({ error: "Tutorial Studio is not configured." });
      return;
    }
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9]/g, "");
    if (!id) {
      res.status(400).json({ error: "bad avatar id" });
      return;
    }

    let upstream: Response;
    try {
      upstream = await call(`/api/avatars/${id}/image`);
    } catch (err) {
      const unavailable = err instanceof TutorialUnavailable;
      res.status(unavailable ? 503 : 502).json({
        error: err instanceof Error ? err.message : "Tutorial Studio is unreachable.",
      });
      return;
    }
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: "No such avatar." });
      return;
    }

    res.status(200);
    for (const h of ["content-type", "content-length"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // The operator's own uploads, behind the auth gate — no shared cache, but
    // let the browser reuse it while the page is open.
    res.setHeader("Cache-Control", "private, max-age=300");
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  });

  return router;
}
