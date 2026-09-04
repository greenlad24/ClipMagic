/**
 * Serves a plan run's generated motion graphics — the sample stills and the
 * finished clips.
 *
 * These cannot come back through /api/fn: that surface is JSON, and a video
 * player needs Range requests to seek. So this is a plain route mounted after
 * the auth gate, exactly like the Tutorial Studio reel route beside it.
 *
 * It is NOT `express.static` over the planner directory, deliberately. That
 * directory also holds each run's ingested narration — the 3GB source video and
 * its audio — and a static mount would publish those too. Only the `motion`
 * subdirectory of a run is reachable here, and only files whose names this
 * pipeline actually produces.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { motionDir } from "../planner/motion.js";

/** nanoid, as `startPlan` mints it. */
const RUN_ID = /^[A-Za-z0-9_-]{6,32}$/;
/** `sample-…-1.png`, `slot-007.mp4`, `slot-007-fit.mp4` — nothing else exists. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|mp4)$/;

export function plannerMotionRouter(): express.Router {
  const router = express.Router();

  router.get("/:runId/:file", (req, res) => {
    const runId = String(req.params.runId || "");
    const file = String(req.params.file || "");
    if (!RUN_ID.test(runId) || !FILE_NAME.test(file)) {
      res.status(400).json({ error: "bad asset path" });
      return;
    }

    const dir = motionDir(runId);
    const full = path.join(dir, file);
    // Belt and braces on top of the name check: the resolved path must still be
    // inside this run's own motion directory.
    if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) {
      res.status(400).json({ error: "bad asset path" });
      return;
    }
    if (!fs.existsSync(full)) {
      res.status(404).json({ error: "no such graphic" });
      return;
    }

    // The operator's own generated output behind the sign-in gate — cacheable
    // in their browser (names are unique per generation) but never shared.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.sendFile(full);
  });

  return router;
}
