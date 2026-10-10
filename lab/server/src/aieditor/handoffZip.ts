/**
 * The editor hand-off zip, STREAMED at download time from the package folder (aieditor/handoff.py writes
 * handoff-NN/ + preview-NN.mp4 and no zip: a factory server copies one copy of the bytes back, and nothing is
 * stored twice here).
 *
 * The archive is DETERMINISTIC — STORED entries (the media is compressed already), names, sizes, CRC-32s and
 * DOS times all fixed by the files — so its total length is known up front (Content-Length) and any byte range
 * maps back onto header bytes or a slice of one file. That is what makes the download resumable (HTTP Range,
 * If-Range on the ETag) without ever writing the zip to disk. ZIP64 records are written only where a size or
 * an offset needs them (an A-roll over 4 GB, an archive over 4 GB).
 *
 * The CRC-32 of each file is read once and cached next to the package (handoff-NN.zipindex.json, keyed on
 * name + size + mtime), so the first download reads the media once before its first byte and later ones start
 * at once.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";

export interface ZipEntry {
  /** the name inside the archive ("handoff-01/timeline.xml") */
  name: string;
  /** absolute path of the file on disk */
  file: string;
  size: number;
  mtimeMs: number;
  crc?: number;
}

type Part = { off: number; len: number; buf?: Buffer; file?: string; fileOff?: number };

export interface ZipLayout {
  parts: Part[];
  size: number;
  etag: string;
}

const PKG_RE = /^handoff-(\d{2})$/;
const U32 = 0xffffffff;

/** A package-relative path from the manifest: plain segments only — no "..", no dotfile, no absolute path. */
export function safeRel(rel: string): boolean {
  if (typeof rel !== "string" || !rel || rel.length > 300 || rel.includes("\\") || rel.includes("\0")) return false;
  const segs = rel.split("/");
  return segs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}$/.test(s) && !s.includes(".."));
}

/**
 * The entries of package `pkg` in job dir `jobDir`, from the worker's manifest (handoff-NN.json "files"): every
 * file must exist with exactly the size the worker recorded — a package still being copied back is not
 * complete (→ null). "preview.mp4" is the job's preview-NN.mp4 when the folder has none.
 */
export async function packageEntries(jobDir: string, pkg: string): Promise<ZipEntry[] | null> {
  const m = PKG_RE.exec(pkg);
  if (!m) return null;
  const root = path.join(jobDir, pkg);
  let manifest: { files?: Record<string, number> };
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(jobDir, `${pkg}.json`), "utf8"));
  } catch {
    return null;
  }
  const files = manifest?.files;
  if (!files || typeof files !== "object") return null;
  const out: ZipEntry[] = [];
  for (const rel of Object.keys(files).sort()) {
    if (!safeRel(rel)) return null;
    let file = path.join(root, rel);
    if (rel === "preview.mp4" && !fs.existsSync(file)) file = path.join(jobDir, `preview-${m[1]}.mp4`);
    const st = await fsp.lstat(file).catch(() => null);
    if (!st?.isFile() || st.size !== Number(files[rel])) return null;
    out.push({ name: `${pkg}/${rel}`, file, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
  }
  return out.length ? out : null;
}

async function crcOf(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) {
    crc = zlib.crc32(chunk as Buffer, crc);
  }
  return crc >>> 0;
}

/** Fill every entry's CRC-32 from the cache file, reading only files that changed; the cache is rewritten. */
export async function withCrcs(entries: ZipEntry[], cacheFile: string): Promise<ZipEntry[]> {
  let cache: Record<string, { size: number; mtimeMs: number; crc: number }> = {};
  try {
    cache = JSON.parse(await fsp.readFile(cacheFile, "utf8"))?.entries ?? {};
  } catch {
    cache = {};
  }
  let changed = false;
  const out: ZipEntry[] = [];
  for (const e of entries) {
    const c = cache[e.name];
    if (c && c.size === e.size && c.mtimeMs === e.mtimeMs && Number.isInteger(c.crc)) {
      out.push({ ...e, crc: c.crc });
      continue;
    }
    const crc = await crcOf(e.file);
    cache[e.name] = { size: e.size, mtimeMs: e.mtimeMs, crc };
    changed = true;
    out.push({ ...e, crc });
  }
  if (changed) {
    const keep = Object.fromEntries(entries.map((e) => [e.name, cache[e.name]]));
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ entries: keep })).then(() => fsp.rename(tmp, cacheFile)).catch(() => undefined);
  }
  return out;
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function u64(b: Buffer, v: number, at: number): void {
  b.writeBigUInt64LE(BigInt(v), at);
}

/**
 * The archive's byte layout. `force64` writes the ZIP64 records for every entry (tests: the >4 GB path on
 * small files). Entries without a CRC get 0 — only for size estimates, never for serving.
 */
export function zipLayout(entries: ZipEntry[], opts: { force64?: boolean } = {}): ZipLayout {
  const parts: Part[] = [];
  const central: Buffer[] = [];
  let off = 0;
  const push = (p: Omit<Part, "off">) => {
    parts.push({ ...p, off });
    off += p.len;
  };
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const { time, date } = dosTime(e.mtimeMs);
    const crc = (e.crc ?? 0) >>> 0;
    const big = opts.force64 || e.size >= U32;
    const offBig = opts.force64 || off >= U32;
    const local = Buffer.alloc(30 + name.length + (big ? 20 : 0));
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(big ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(big ? U32 : e.size, 18);
    local.writeUInt32LE(big ? U32 : e.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(big ? 20 : 0, 28);
    name.copy(local, 30);
    if (big) {
      const x = 30 + name.length;
      local.writeUInt16LE(0x0001, x);
      local.writeUInt16LE(16, x + 2);
      u64(local, e.size, x + 4);
      u64(local, e.size, x + 12);
    }
    const localOff = off;
    push({ len: local.length, buf: local });
    if (e.size > 0) push({ len: e.size, file: e.file, fileOff: 0 });
    const ext: number[] = [];
    if (big) ext.push(e.size, e.size);
    if (offBig) ext.push(localOff);
    const extLen = ext.length ? 4 + 8 * ext.length : 0;
    const c = Buffer.alloc(46 + name.length + extLen);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 45, 4); // made by: unix, 4.5
    c.writeUInt16LE(big || offBig ? 45 : 20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(big ? U32 : e.size, 20);
    c.writeUInt32LE(big ? U32 : e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extLen, 30);
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    c.writeUInt32LE(offBig ? U32 : localOff, 42);
    name.copy(c, 46);
    if (extLen) {
      const x = 46 + name.length;
      c.writeUInt16LE(0x0001, x);
      c.writeUInt16LE(8 * ext.length, x + 2);
      ext.forEach((v, i) => u64(c, v, x + 4 + 8 * i));
    }
    central.push(c);
  }
  const cdOff = off;
  const cd = Buffer.concat(central);
  push({ len: cd.length, buf: cd });
  const n = entries.length;
  const need64 = opts.force64 || n >= 0xffff || cdOff >= U32 || cd.length >= U32;
  if (need64) {
    const z = Buffer.alloc(56 + 20);
    const z64Off = off;
    z.writeUInt32LE(0x06064b50, 0);
    u64(z, 44, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    u64(z, n, 24);
    u64(z, n, 32);
    u64(z, cd.length, 40);
    u64(z, cdOff, 48);
    z.writeUInt32LE(0x07064b50, 56);
    z.writeUInt32LE(0, 60);
    u64(z, z64Off, 64);
    z.writeUInt32LE(1, 72);
    push({ len: z.length, buf: z });
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(need64 ? 0xffff : n, 8);
  eocd.writeUInt16LE(need64 ? 0xffff : n, 10);
  eocd.writeUInt32LE(need64 ? U32 : cd.length, 12);
  eocd.writeUInt32LE(need64 ? U32 : cdOff, 16);
  push({ len: eocd.length, buf: eocd });
  const etag =
    '"hz-' +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(entries.map((e) => [e.name, e.size, e.mtimeMs, e.crc ?? null])))
      .digest("base64url")
      .slice(0, 27) +
    '"';
  return { parts, size: off, etag };
}

/** The bytes [start, end] (inclusive) of the archive, in order. */
export async function* zipBytes(layout: ZipLayout, start: number, end: number): AsyncGenerator<Buffer> {
  for (const p of layout.parts) {
    const a = Math.max(start, p.off);
    const b = Math.min(end, p.off + p.len - 1);
    if (a > b) continue;
    if (p.buf) {
      yield p.buf.subarray(a - p.off, b - p.off + 1);
      continue;
    }
    const s = fs.createReadStream(p.file!, { start: (p.fileOff ?? 0) + a - p.off, end: (p.fileOff ?? 0) + b - p.off, highWaterMark: 1 << 20 });
    for await (const chunk of s) yield chunk as Buffer;
  }
}

/** Parse ONE "bytes=a-b" range against a length → [start, end] | "none" (no/ignored header) | "bad" (416). */
export function parseRange(header: string | undefined, size: number): [number, number] | "none" | "bad" {
  if (!header) return "none";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "none"; // multi-range / other units: answer with the whole archive
  if (m[1] === "" && m[2] === "") return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n <= 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "bad";
  return [start, end];
}

/** Answer a GET/HEAD for the streamed zip: 200 whole, 206 a range (If-Range honoured), 416 out of range. */
export async function sendZip(req: Request, res: Response, layout: ZipLayout, filename: string): Promise<void> {
  const ascii = filename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-") || "handoff.zip";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("ETag", layout.etag);
  res.setHeader("Cache-Control", "private, no-transform");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const ifRange = req.get("if-range");
  let range = parseRange(req.get("range"), layout.size);
  if (ifRange && ifRange !== layout.etag) range = "none"; // the package changed: start over with the whole file
  if (range === "bad") {
    res.status(416).setHeader("Content-Range", `bytes */${layout.size}`);
    res.end();
    return;
  }
  const [start, end] = range === "none" ? [0, layout.size - 1] : range;
  if (range !== "none") {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${layout.size}`);
  }
  res.setHeader("Content-Length", String(end - start + 1));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.from(zipBytes(layout, start, end)), res);
  } catch {
    // the client went away mid-download (it resumes with a Range) — nothing to clean up
  }
}

/** The package's zip, ready to serve (CRCs read or cached) — null when the package is missing or incomplete. */
export async function packageZip(jobDir: string, pkg: string): Promise<ZipLayout | null> {
  const entries = await packageEntries(jobDir, pkg);
  if (!entries) return null;
  return zipLayout(await withCrcs(entries, path.join(jobDir, `${pkg}.zipindex.json`)));
}

/** The streamed zip's exact size without reading any file (the layout does not depend on the CRCs). */
export async function packageZipSize(jobDir: string, pkg: string): Promise<number | null> {
  const entries = await packageEntries(jobDir, pkg);
  return entries ? zipLayout(entries).size : null;
}
