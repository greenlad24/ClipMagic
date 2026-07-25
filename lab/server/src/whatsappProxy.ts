/**
 * Reverse proxy for the WhatsApp Scheduler sidecar.
 *
 * The scheduler is a self-contained service (its own container + persistent
 * WhatsApp Web session) that Jake wanted served INSIDE lab.jakedaw.com and only
 * after signing in — not on a separate subdomain. So rather than expose it, we
 * mount this proxy at /wa in the Lab's Express app AFTER `requireSession`: a
 * request only reaches here once the Google Sign-In gate has passed, and the
 * sidecar has no public port of its own (it's reachable only over the Docker
 * network at config.whatsappUrl).
 *
 * The sidecar's front-end is served base-path-aware (`<base href="/wa/">`), so
 * every asset + API request arrives here as /wa/<something>; Express strips the
 * /wa mount, leaving req.url as the sidecar-relative path we forward verbatim.
 *
 * We inject the shared Bearer token so the sidecar's OWN /api auth also passes
 * (defense in depth — even the internal endpoint refuses an un-tokened call).
 *
 * Best-effort: an unreachable sidecar becomes a 502, never an unhandled throw.
 */
import type { RequestHandler } from "express";
import { config } from "./config.js";

/** Hop-by-hop / host headers we must NOT forward to the upstream. */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "authorization", // replaced with the sidecar's shared token below
]);

export function whatsappProxy(): RequestHandler {
  return async (req, res) => {
    if (!config.whatsappUrl) {
      res.status(503).json({ error: "WhatsApp Scheduler is not configured." });
      return;
    }

    // req.url is already relative to the /wa mount ("/", "/api/status", …).
    const base = config.whatsappUrl.replace(/\/+$/, "");
    const target = base + (req.url || "/");

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    if (config.whatsappToken) headers["authorization"] = `Bearer ${config.whatsappToken}`;

    // Only the JSON API carries a body, and express.json() already parsed it;
    // re-serialize for those, none for GET/HEAD.
    let body: string | undefined;
    if (req.method !== "GET" && req.method !== "HEAD" && req.body && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    }

    let upstream: Response;
    try {
      upstream = await fetch(target, { method: req.method, headers, body });
    } catch {
      res.status(502).json({ error: "WhatsApp Scheduler is unreachable." });
      return;
    }

    res.status(upstream.status);
    // Carry the content type + caching intent; skip hop-by-hop headers.
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    const cc = upstream.headers.get("cache-control");
    if (cc) res.setHeader("cache-control", cc);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  };
}
