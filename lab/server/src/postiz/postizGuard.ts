/**
 * Postiz write GUARD (PURE — no IO). A single, un-bypassable chokepoint that
 * decides which Postiz API writes this backend is EVER allowed to make. It exists
 * to protect the flagship YouTube channel @jake.dawson (and, as a strict superset,
 * every channel) from being edited or deleted through this backend.
 *
 * Two rules, checked on every non-GET request in client.ts `request()`:
 *
 *  1. PROTECTED-CHANNEL block — any mutating request that references a protected
 *     channel (by Postiz integration id or handle) is refused UNLESS it is the one
 *     allowed create flow (POST /posts). This catches a future edit/delete that
 *     carries the channel id.
 *
 *  2. OPERATION ALLOWLIST — only POST /upload, /upload-from-url, /posts are
 *     permitted. Every other write — crucially all edit (PUT/PATCH) and delete
 *     (DELETE) — is refused, so a delete-by-post-id (which does NOT carry the
 *     channel id, and so slips past rule 1) is still blocked. This is the
 *     un-bypassable half of "never edit or delete @jake.dawson".
 *
 * NOTE on long-form uploads: this guard does NOT enforce Shorts-only — it can't
 * see a video's aspect ratio at the HTTP layer. Long-form blocking lives in the
 * schedule-time gate (postiz/youtubeGate.ts), which probes the media. By design
 * that gate blocks only CONFIRMED long-form and lets unverifiable media through,
 * so a real Short is never blocked just because its aspect couldn't be measured.
 *
 * Protected channels are configurable via env so this isn't a brittle hardcode:
 *   POSTIZ_PROTECTED_YT_IDS      comma-separated Postiz integration ids
 *   POSTIZ_PROTECTED_YT_HANDLES  comma-separated handles (with or without '@')
 * Defaults cover the @jake.dawson main channel connected 2026-07-18.
 */

/** Thrown when the guard refuses a Postiz write. Distinct so callers can detect it. */
export class PostizGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostizGuardError";
  }
}

function envSet(raw: string | undefined, fallback: string, lower = false): Set<string> {
  const src = (raw && raw.trim().length ? raw : fallback).split(",");
  const out = new Set<string>();
  for (const item of src) {
    let v = item.trim();
    if (!v) continue;
    if (lower) v = v.toLowerCase().replace(/^@/, "");
    out.add(v);
  }
  return out;
}

/** Protected Postiz integration ids (exact match). Default: @jake.dawson main channel. */
export const PROTECTED_YT_IDS = envSet(process.env.POSTIZ_PROTECTED_YT_IDS, "cmrq626ks0001kk6xyg215pee");
/** Protected handles, normalized lowercase without a leading '@'. */
export const PROTECTED_YT_HANDLES = envSet(process.env.POSTIZ_PROTECTED_YT_HANDLES, "jake.dawson", true);

/** True when a channel (by id and/or handle/profile) is protected. */
export function isProtectedChannel(ch: { id?: string; profile?: string; name?: string }): boolean {
  if (ch.id && PROTECTED_YT_IDS.has(ch.id)) return true;
  const handle = (ch.profile ?? "").trim().toLowerCase().replace(/^@/, "");
  return handle.length > 0 && PROTECTED_YT_HANDLES.has(handle);
}

/** The only writes this backend may perform. Everything else is refused. */
const ALLOWED_WRITES: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/upload"],
  ["POST", "/upload-from-url"],
  ["POST", "/posts"],
];

/** True when any protected id/handle appears in the request path or JSON body. */
function referencesProtectedChannel(path: string, body: unknown): boolean {
  const hay = `${path}\n${body === undefined ? "" : safeStringify(body)}`;
  for (const id of PROTECTED_YT_IDS) if (hay.includes(id)) return true;
  const lower = hay.toLowerCase();
  for (const h of PROTECTED_YT_HANDLES) if (lower.includes(h)) return true;
  return false;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * Assert a Postiz write is permitted. Throws PostizGuardError otherwise. GET is
 * always allowed (reads never mutate). Call this at the top of every request.
 */
export function assertPostizWriteAllowed(method: string, path: string, body?: unknown): void {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return;
  const p = (path.split("?")[0] || "").replace(/\/+$/, "") || "/";

  const isAllowedCreate = m === "POST" && ALLOWED_WRITES.some(([am, ap]) => am === m && ap === p);

  // Rule 1 — protected channel: only the create flow may touch it; edit/delete/other refused.
  if (referencesProtectedChannel(path, body) && !isAllowedCreate) {
    throw new PostizGuardError(
      `Blocked ${m} ${p}: the protected channel @jake.dawson may only receive new posts — editing, deleting, or any other write to it is disabled.`,
    );
  }

  // Rule 2 — operation allowlist: no edit/delete (or unknown write) via this backend, any channel.
  if (!isAllowedCreate) {
    throw new PostizGuardError(
      `Blocked ${m} ${p}: this backend may only upload media and create posts. Edit/delete operations are disabled (protects @jake.dawson from modification or removal).`,
    );
  }
}
