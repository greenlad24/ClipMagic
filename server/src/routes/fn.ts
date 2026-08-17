import { Router } from "express";
import { asyncHandler } from "../middleware.js";
import { HANDLERS, ZiteError } from "../zite/handlers.js";

/**
 * Dispatcher for the web app's backend calls. The shim
 * (web/src/shims/endpoints.ts) POSTs to /api/fn/<name>; we run the matching
 * handler. Single local user — no auth.
 *
 * Every call is logged with timing + outcome so the terminal shows a clear
 * trace of what the tool is doing and where it failed.
 */
const router = Router();
const LOCAL_USER = "local";

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

/**
 * Endpoints whose input carries a large base64 payload (a portrait, a room
 * plate, a voice sample). No secrets, but logging them would flood the output
 * on every call — so their bodies are redacted.
 */
const REDACT_INPUT = new Set(["avatarCloneVoice", "avatarPlaceInRoom", "avatarCharacterSheet"]);

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
        const status =
          err.code === "NOT_FOUND" ? 404 : err.code === "NOT_IMPLEMENTED" ? 501 : 400;
        console.warn(`[fn] ✗ ${name} (${ms}ms) ${err.code}: ${err.message}`);
        res.status(status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[fn] ✗ ${name} (${ms}ms) INTERNAL: ${message}`);
      res.status(500).json({ error: { code: "INTERNAL", message } });
    }
  })
);

export default router;
