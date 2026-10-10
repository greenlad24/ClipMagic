/**
 * Auto Editor — a PUBLIC SHARE LINK for an editor hand-off package (Jake 2026-10-09: "it needs to produce a
 * public link I can send to an editor").
 *
 *   /share/<token>              a small page: the job's title, the package size, the preview playing, a big
 *                               Download button and a link to the brief
 *   /share/<token>/download     handoff-NN.zip, streamed from the package folder (handoffZip.ts), Range-resumable
 *   /share/<token>/preview.mp4  the preview with a card in every slot (Range, so the player seeks)
 *   /share/<token>/brief        screencasts/BRIEF.html, readable in the browser
 *
 * ⚠️ THE ONLY ROUTE OUTSIDE THE SIGN-IN GATE FOR THE AUTO EDITOR. It is mounted BEFORE requireSession (index.ts),
 * like the AI News follower route, and answers ONLY those four GET/HEAD paths — anything else under /share is a
 * 404 from this router, never the SPA or another route.
 *
 * THE TOKEN IS THE CREDENTIAL: base64url({v, j: job id, p: "handoff-NN", e: expiry (epoch s), n: 128-bit nonce})
 * "." base64url(HMAC-SHA256(SESSION_SECRET, "aieditor-share:v1:" + part1)) — signed over the job, the package
 * and the expiry, compared in constant time, domain-separated from the session cookie. A token is honoured only
 * while ALSO listed, unrevoked and unexpired in that job's share.json — so Revoke works and an expired link is a
 * 404. The files it reaches are fixed by code from the (validated) job id and package name: no path from the
 * request is ever joined to the disk.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { config } from "../config.js";
import { packageEntries, packageZip, sendZip, zipLayout } from "./handoffZip.js";

const ROOT = process.env.AIEDITOR_WORK || "/aieditor-work";
let JOBS = path.join(ROOT, "jobs");
/** tests: point the routes at a scratch jobs folder */
export function setJobsDir(dir: string): void {
  JOBS = dir;
}

export const JOB_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const PKG_RE = /^handoff-(\d{2})$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,400}\.[A-Za-z0-9_-]{43}$/;
export const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

export interface SharePayload {
  v: 1;
  j: string;
  p: string;
  e: number;
  n: string;
}

export interface ShareLink {
  id: string;
  pkg: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

function secret(): string {
  return config.sessionSecret || "";
}

function mac(part1: string, key: string): string {
  return crypto.createHmac("sha256", key).update("aieditor-share:v1:" + part1).digest("base64url");
}

export function signShare(p: SharePayload, key = secret()): string {
  if (!key) throw new Error("Share links need the Lab's session secret (SESSION_SECRET), which is not set.");
  const part1 = Buffer.from(JSON.stringify({ v: 1, j: p.j, p: p.p, e: p.e, n: p.n }), "utf8").toString("base64url");
  return `${part1}.${mac(part1, key)}`;
}

/** The token's payload when its signature, shape and expiry hold — else null. (share.json is checked separately.) */
export function verifyShare(token: unknown, now = Date.now(), key = secret()): SharePayload | null {
  if (!key || typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const [part1, sig] = token.split(".");
  const want = mac(part1, key);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let p: SharePayload;
  try {
    p = JSON.parse(Buffer.from(part1, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!p || p.v !== 1 || typeof p.j !== "string" || !JOB_RE.test(p.j) || typeof p.p !== "string" || !PKG_RE.test(p.p)) return null;
  if (typeof p.n !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(p.n)) return null;
  if (typeof p.e !== "number" || !Number.isFinite(p.e) || p.e * 1000 <= now) return null;
  return p;
}

const shareFile = (job: string) => path.join(JOBS, job, "share.json");

export async function readLinks(job: string): Promise<ShareLink[]> {
  if (!JOB_RE.test(job)) return [];
  try {
    const doc = JSON.parse(await fsp.readFile(shareFile(job), "utf8"));
    return Array.isArray(doc?.links) ? doc.links : [];
  } catch {
    return [];
  }
}

async function writeLinks(job: string, links: ShareLink[]): Promise<void> {
  const f = shareFile(job);
  const tmp = `${f}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify({ links }, null, 1));
  await fsp.rename(tmp, f);
}

/** A token that is signed, unexpired AND still listed (not revoked) in the job's share.json → its payload. */
export async function resolveShare(token: unknown, now = Date.now()): Promise<SharePayload | null> {
  const p = verifyShare(token, now);
  if (!p) return null;
  const link = (await readLinks(p.j)).find((l) => l.id === p.n);
  if (!link || link.pkg !== p.p || link.expiresAt !== p.e || link.revokedAt || link.expiresAt * 1000 <= now) return null;
  return p;
}

export interface ShareView {
  id: string;
  pkg: string;
  path: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  active: boolean;
}

function view(job: string, l: ShareLink, now = Date.now()): ShareView {
  let p = "";
  try {
    p = `/share/${signShare({ v: 1, j: job, p: l.pkg, e: l.expiresAt, n: l.id })}`;
  } catch {
    p = "";
  }
  return {
    id: l.id,
    pkg: l.pkg,
    path: p,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    revoked: !!l.revokedAt,
    active: !l.revokedAt && l.expiresAt * 1000 > now && !!p,
  };
}

/** The job's links (newest first), each with its /share/<token> path (re-derived, never stored). */
export async function listShares(job: string, pkg?: string): Promise<ShareView[]> {
  const now = Date.now();
  return (await readLinks(job))
    .filter((l) => !pkg || l.pkg === pkg)
    .map((l) => view(job, l, now))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function createShare(job: unknown, pkg: unknown, days: unknown = DEFAULT_DAYS): Promise<ShareView> {
  if (typeof job !== "string" || !JOB_RE.test(job)) throw new Error("Unknown job.");
  if (typeof pkg !== "string" || !PKG_RE.test(pkg)) throw new Error("Unknown hand-off package.");
  if (!secret()) throw new Error("Share links need the Lab's session secret (SESSION_SECRET), which is not set.");
  const d = days === undefined || days === null ? DEFAULT_DAYS : Number(days);
  if (!Number.isFinite(d) || d <= 0 || d > MAX_DAYS) throw new Error(`A link lasts 1 to ${MAX_DAYS} days.`);
  if (!(await packageEntries(path.join(JOBS, job), pkg)) && !fs.existsSync(path.join(JOBS, job, `${pkg}.zip`))) {
    throw new Error("That hand-off package is not finished (or is still being copied back).");
  }
  const now = Date.now();
  const link: ShareLink = {
    id: crypto.randomBytes(16).toString("base64url"),
    pkg,
    createdAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000 + d * 86400),
  };
  await writeLinks(job, [...(await readLinks(job)), link]);
  // warm the zip index (CRC-32 of every file) so the editor's first download starts at once
  void packageZip(path.join(JOBS, job), pkg).catch(() => undefined);
  return view(job, link, now);
}

export async function revokeShare(job: unknown, id: unknown): Promise<ShareView> {
  if (typeof job !== "string" || !JOB_RE.test(job)) throw new Error("Unknown job.");
  const links = await readLinks(job);
  const l = links.find((x) => x.id === id);
  if (!l) throw new Error("No such link.");
  if (!l.revokedAt) {
    l.revokedAt = Math.floor(Date.now() / 1000);
    await writeLinks(job, links);
  }
  return view(job, l);
}

// ────────────────────────────── the public routes ──────────────────────────────

function notFound(res: Response): void {
  res.status(404).type("text/plain").send("This link does not exist or has expired.");
}

/** A file of the job that must be a REGULAR file inside the job folder (no symlink out of it). */
async function jobFile(job: string, rel: string): Promise<string | null> {
  const dir = path.join(JOBS, job);
  const f = path.join(dir, rel);
  const st = await fsp.lstat(f).catch(() => null);
  if (!st?.isFile()) return null;
  const real = await fsp.realpath(f).catch(() => "");
  const realDir = await fsp.realpath(dir).catch(() => "");
  return realDir && real.startsWith(realDir + path.sep) ? f : null;
}

async function titleOf(job: string): Promise<string> {
  for (const f of ["request.json", "source.json"]) {
    try {
      const d = JSON.parse(await fsp.readFile(path.join(JOBS, job, f), "utf8"));
      const t = d?.title || d?.source?.name || d?.filename;
      if (typeof t === "string" && t.trim()) return t.trim().slice(0, 140);
    } catch {
      /* next */
    }
  }
  return job;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function gb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

async function zipSizeOf(job: string, pkg: string): Promise<number | null> {
  const dir = path.join(JOBS, job);
  const legacy = await jobFile(job, `${pkg}.zip`);
  if (legacy) return (await fsp.stat(legacy)).size;
  const entries = await packageEntries(dir, pkg);
  return entries ? zipLayout(entries).size : null;
}

function page(o: { token: string; title: string; size: number; slots: number; expires: number; preview: boolean; brief: boolean }): string {
  const t = esc(o.token);
  const exp = new Date(o.expires * 1000).toUTCString().replace(/ GMT$/, " UTC");
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content="noindex,nofollow">
<title>Hand-off package — ${esc(o.title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#16181d;--muted:#5b6270;--line:#dfe3e8;--accent:#2457d6;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#9aa4b2;--line:#2a313c;--accent:#4c8dff;--accent-fg:#fff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Inter,Helvetica,Arial,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
video{width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;display:block}
.dl{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;font-size:17px;padding:14px 22px;border-radius:10px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}a.link{color:var(--accent)}ol{margin:8px 0 0;padding-left:20px}
</style></head><body><main>
<h1>${esc(o.title)}</h1>
<p class=muted>Editor hand-off package · ${o.slots} screencast slot${o.slots === 1 ? "" : "s"} to record · ${gb(o.size)} · link valid until ${esc(exp)}</p>
<div class="card row"><a class=dl href="/share/${t}/download" download>Download the package (${gb(o.size)})</a>
${o.brief ? `<a class=link href="/share/${t}/brief" target=_blank rel=noopener>Read the screencast brief</a>` : ""}</div>
${o.preview ? `<div class=card><video controls preload=metadata src="/share/${t}/preview.mp4"></video>
<p class=muted>The finished edit with a labelled card where each screencast goes.</p></div>` : ""}
<div class=card><b>How to use it</b><ol>
<li>Unzip it and keep the folder together (every file is referenced relative to the timeline).</li>
<li>Premiere Pro: File &gt; Import &gt; <code>timeline.xml</code>. DaVinci Resolve: File &gt; Import &gt; Timeline &gt; <code>timeline.fcpxml</code>.</li>
<li>Record each screencast from the brief and put it on V2 over its marker. Do not cut the narration.</li>
</ol><p class=muted>A big download: if it stops, start it again — it resumes where it stopped.</p></div>
</main></body></html>`;
}

/** The public router, mounted at /share BEFORE requireSession. GET/HEAD only; four paths; everything else 404. */
export function sharePublicRouter(): express.Router {
  const r = express.Router();
  r.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
    next();
  });
  const resolve = async (req: Request, res: Response) => {
    const p = await resolveShare(req.params.token);
    if (!p) notFound(res);
    return p;
  };
  r.get("/:token", async (req, res) => {
    const p = await resolve(req, res);
    if (!p) return;
    const nn = PKG_RE.exec(p.p)![1];
    const size = await zipSizeOf(p.j, p.p);
    if (size === null) return notFound(res);
    let slots = 0;
    try {
      slots = (JSON.parse(await fsp.readFile(path.join(JOBS, p.j, `${p.p}.json`), "utf8"))?.slots ?? []).length;
    } catch {
      slots = 0;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'");
    res.type("html").send(
      page({
        token: req.params.token,
        title: await titleOf(p.j),
        size,
        slots,
        expires: p.e,
        preview: !!(await jobFile(p.j, `preview-${nn}.mp4`)),
        brief: !!(await jobFile(p.j, `${p.p}/screencasts/BRIEF.html`)),
      }),
    );
  });
  r.get("/:token/download", async (req, res) => {
    const p = await resolve(req, res);
    if (!p) return;
    const name = `${(await titleOf(p.j)).replace(/[\\/:*?"<>|]+/g, " ").trim()} - ${p.p}.zip`;
    const legacy = await jobFile(p.j, `${p.p}.zip`); // a package built before the zip was streamed
    if (legacy) {
      res.setHeader("Cache-Control", "private");
      res.attachment(name);
      return res.sendFile(legacy, { dotfiles: "deny", lastModified: true });
    }
    const layout = await packageZip(path.join(JOBS, p.j), p.p);
    if (!layout) return notFound(res);
    await sendZip(req, res, layout, name);
  });
  r.get("/:token/preview.mp4", async (req, res) => {
    const p = await resolve(req, res);
    if (!p) return;
    const f = await jobFile(p.j, `preview-${PKG_RE.exec(p.p)![1]}.mp4`);
    if (!f) return notFound(res);
    res.setHeader("Cache-Control", "private");
    res.sendFile(f, { dotfiles: "deny" });
  });
  r.get("/:token/brief", async (req, res) => {
    const p = await resolve(req, res);
    if (!p) return;
    const f = await jobFile(p.j, `${p.p}/screencasts/BRIEF.html`);
    if (!f) return notFound(res);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; sandbox");
    res.type("html").send(await fsp.readFile(f, "utf8"));
  });
  r.use((_req, res) => notFound(res));
  return r;
}

/** The operator's side (behind requireSession + auth): list, create, revoke. Mounted at /api/aieditor/share. */
export function shareAdminRouter(): express.Router {
  const r = express.Router();
  const fail = (res: Response, err: unknown) => res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  r.get("/:job", async (req, res) => {
    try {
      if (!JOB_RE.test(req.params.job)) throw new Error("Unknown job.");
      res.setHeader("Cache-Control", "no-store");
      res.json({ links: await listShares(req.params.job), configured: !!secret() });
    } catch (err) {
      fail(res, err);
    }
  });
  r.post("/:job", async (req, res) => {
    try {
      res.json({ link: await createShare(req.params.job, req.body?.pkg, req.body?.days) });
    } catch (err) {
      fail(res, err);
    }
  });
  r.post("/:job/revoke", async (req, res) => {
    try {
      res.json({ link: await revokeShare(req.params.job, req.body?.id) });
    } catch (err) {
      fail(res, err);
    }
  });
  return r;
}
