import { Router } from "express";
import { asyncHandler } from "../middleware.js";
import { HANDLERS } from "../zite/endpoints.js";
import { ZiteError } from "../zite/store.js";

/**
 * Dispatcher for the original frontend's backend calls. The web shim
 * (web/src/shims/endpoints.ts) POSTs to /api/fn/<name>; we run the matching
 * ported handler. Single local user — no auth.
 */
const router = Router();
const LOCAL_USER = "local";

router.post(
  "/:name",
  asyncHandler(async (req, res) => {
    const handler = HANDLERS[req.params.name];
    if (!handler) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown endpoint: ${req.params.name}` } });
      return;
    }
    try {
      const result = await handler(req.body ?? {}, LOCAL_USER);
      res.json(result);
    } catch (err) {
      if (err instanceof ZiteError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "NOT_IMPLEMENTED" ? 501 : 400;
        res.status(status).json({ error: { code: err.code, message: err.message } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: { code: "INTERNAL", message } });
      }
    }
  })
);

export default router;
