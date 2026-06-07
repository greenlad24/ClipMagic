import { Router } from "express";
import { asyncHandler } from "../middleware.js";
import { HANDLERS } from "../zite/endpoints.js";
import { ZiteError } from "../zite/store.js";

/**
 * Dispatcher for the original frontend's backend calls. The web shim
 * (web/src/shims/endpoints.ts) POSTs to /api/fn/<name>; we run the matching
 * ported handler. Single local user — no auth.
 *
 * Every call is logged with timing + outcome so `docker compose logs` shows a
 * clear trace of what the editor is doing and where it fails.
 */
const router = Router();
const LOCAL_USER = "local";

/**
 * Endpoints whose INPUT carries write-only secrets (API keys, app secrets) —
 * their request body must never be written to logs. Results are safe (the
 * settings store returns only `configured` booleans, never values).
 */
const REDACT_INPUT = new Set(["updatePostizSettings"]);

/** Compact one-line preview of an object for logs (no huge blobs). */
function preview(obj: unknown, max = 300): string {
  try {
    const s = JSON.stringify(obj);
    if (!s) return String(obj);
    return s.length > max ? s.slice(0, max) + `…(${s.length}b)` : s;
  } catch {
    return String(obj);
  }
}

router.post(
  "/:name",
  asyncHandler(async (req, res) => {
    const name = req.params.name;
    const started = Date.now();
    console.log(`[fn] → ${name} input=${REDACT_INPUT.has(name) ? "[redacted]" : preview(req.body)}`);

    const handler = HANDLERS[name];
    if (!handler) {
      console.warn(`[fn] ✗ ${name} — unknown endpoint`);
      res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown endpoint: ${name}` } });
      return;
    }
    try {
      const result = await handler(req.body ?? {}, LOCAL_USER);
      console.log(`[fn] ✓ ${name} (${Date.now() - started}ms) result=${preview(result)}`);
      res.json(result);
    } catch (err) {
      const ms = Date.now() - started;
      if (err instanceof ZiteError) {
        const status = err.code === "NOT_FOUND" ? 404 : err.code === "NOT_IMPLEMENTED" ? 501 : 400;
        console.warn(`[fn] ✗ ${name} (${ms}ms) ${err.code}: ${err.message}`);
        res.status(status).json({ error: { code: err.code, message: err.message } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(`[fn] ✗ ${name} (${ms}ms) INTERNAL: ${message}`);
        if (stack) console.error(stack);
        res.status(500).json({ error: { code: "INTERNAL", message } });
      }
    }
  })
);

export default router;
