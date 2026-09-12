/**
 * Asset uploads — the way in for bytes that have no URL.
 *
 * ⚠️ THIS EXISTS BECAUSE THE ORIGINAL CONTRACT ASSUMED EVERY ASSET WAS ALREADY
 * HOSTED SOMEWHERE. `project.files` writes UTF-8 text, and `project.url` /
 * `sources[]` both need a link the server can fetch — so a caller holding a
 * .woff2 font, a background PNG or a clip it just produced had no route at all.
 * ChatGPT is exactly that caller: it has bytes and nowhere to put them.
 *
 * The shape is a bucket, not a per-job upload, for one reason: **a bucket
 * outlives the job it feeds.** Assets get re-used across revisions of the same
 * video, and re-uploading a 4K clip to change a caption would be absurd.
 *
 * ⚠️ FILES ARE HARD-LINKED INTO A JOB, NEVER COPIED OR MOVED. A move would
 * destroy the bucket on first use (no revisions); a copy would double the disk
 * for every render, which on 4K footage is the difference between fitting on
 * this box and not. Hard links cost nothing and the bucket keeps its own
 * reference, so deleting the job leaves the assets ready for the next one.
 * The one consequence worth knowing: bytes are freed when the LAST link goes,
 * so a job's reported size counts bytes the bucket is also counting.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const WORK = process.env.HYPERFRAMES_WORK || "/hyperframes-work";
const UPLOADS = path.join(WORK, "uploads");

/** Unconsumed buckets are swept after this long. Revisions happen in one sitting. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Never fill the disk: a render needs room for footage, cache and output. */
const MIN_FREE_BYTES = 5 * 1024 ** 3;

/** Per-file ceiling. Well above a 4K master, well below "someone made a mistake". */
const MAX_FILE_BYTES = 8 * 1024 ** 3;

const SAFE_ID = /^up_[A-Za-z0-9_-]{16,40}$/;

export interface UploadFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface UploadBucket {
  id: string;
  name: string;
  createdAt: number;
  files: UploadFile[];
  bytes: number;
}

function bucketDir(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid upload id: ${id}`);
  const dir = path.join(UPLOADS, id);
  // Re-checked after resolution, not just pattern-matched: the pattern is the
  // kind of thing that gets widened later without anyone re-reading this.
  if (path.resolve(dir) !== dir || !dir.startsWith(UPLOADS + path.sep)) {
    throw new Error(`Invalid upload id: ${id}`);
  }
  return dir;
}

const filesDir = (id: string): string => path.join(bucketDir(id), "files");
const metaFile = (id: string): string => path.join(bucketDir(id), "meta.json");

/**
 * Remembered SHA-256s, beside the bucket rather than inside `files/` so the
 * index can never be linked into a project.
 *
 * ⚠️ WITHOUT THIS, LISTING A BUCKET RE-HASHES EVERY BYTE IN IT. The Render queue
 * page polls uploads every 5 seconds, and a bucket holding a 3 GB master would
 * mean re-reading 3 GB from disk every 5 seconds — on the same two cores a
 * render is using. Entries are keyed on size AND mtime, so a file replaced in
 * place (or dropped in out-of-band) is re-hashed exactly once.
 */
const indexFile = (id: string): string => path.join(bucketDir(id), "hashes.json");

interface HashEntry {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

async function readIndex(id: string): Promise<Record<string, HashEntry>> {
  try {
    return JSON.parse(await fsp.readFile(indexFile(id), "utf8")) as Record<string, HashEntry>;
  } catch {
    return {};
  }
}

async function writeIndex(id: string, index: Record<string, HashEntry>): Promise<void> {
  try {
    await fsp.writeFile(indexFile(id), JSON.stringify(index) + "\n");
  } catch {
    /* the index is a cache; failing to save it must never fail the request */
  }
}

async function freeBytes(): Promise<number> {
  try {
    const st = await fsp.statfs(WORK);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER; // statfs is best-effort; never block on it
  }
}

/**
 * Every file under `dir`, relative, with size and hash.
 *
 * `index` supplies remembered hashes and receives any that had to be computed;
 * pass none to skip hashing altogether, which is what linking wants.
 */
async function walk(
  dir: string,
  base = dir,
  index?: Record<string, HashEntry>,
): Promise<UploadFile[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: UploadFile[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base, index)));
    else if (e.isFile()) {
      const st = await fsp.stat(full);
      const rel = path.relative(base, full).split(path.sep).join("/");
      let sha = "";
      if (index) {
        const known = index[rel];
        if (known && known.bytes === st.size && known.mtimeMs === st.mtimeMs) {
          sha = known.sha256;
        } else {
          sha = await sha256File(full);
          index[rel] = { bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha };
        }
      }
      out.push({ path: rel, bytes: st.size, sha256: sha });
    }
  }
  return out;
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

export async function createUpload(name: string): Promise<UploadBucket> {
  const id = `up_${crypto.randomBytes(15).toString("base64url")}`;
  await fsp.mkdir(filesDir(id), { recursive: true });
  const meta = { id, name: String(name || "assets").slice(0, 80), createdAt: Date.now() };
  await fsp.writeFile(metaFile(id), JSON.stringify(meta, null, 2) + "\n");
  void sweepUploads();
  return { ...meta, files: [], bytes: 0 };
}

export async function getUpload(id: string): Promise<UploadBucket> {
  const dir = bucketDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such upload.");
  let meta: { id: string; name: string; createdAt: number };
  try {
    meta = JSON.parse(await fsp.readFile(metaFile(id), "utf8"));
  } catch {
    meta = { id, name: "assets", createdAt: (await fsp.stat(dir)).birthtimeMs };
  }
  const index = await readIndex(id);
  const before = JSON.stringify(index);
  const files = await walk(filesDir(id), filesDir(id), index);
  // Dropped entries for files that are gone, and saved only when it changed.
  for (const key of Object.keys(index)) {
    if (!files.some((f) => f.path === key)) delete index[key];
  }
  if (JSON.stringify(index) !== before) await writeIndex(id, index);
  return { ...meta, id, files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

export async function listUploads(): Promise<UploadBucket[]> {
  let ids: string[];
  try {
    ids = await fsp.readdir(UPLOADS);
  } catch {
    return [];
  }
  const out: UploadBucket[] = [];
  for (const id of ids) {
    if (!SAFE_ID.test(id)) continue;
    try {
      out.push(await getUpload(id));
    } catch {
      /* a half-written bucket is not worth failing a listing over */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Stream one file into a bucket.
 *
 * ⚠️ STREAMED, NEVER BUFFERED. This route accepts gigabytes; reading the body
 * into memory first would take the Lab down with it. The size limit is enforced
 * DURING the stream rather than from Content-Length, because a caller controls
 * that header and can simply lie.
 */
export async function putUploadFile(
  id: string,
  relPath: string,
  body: Readable,
  safeRelative: (name: string) => string,
): Promise<UploadFile> {
  const root = filesDir(id);
  if (!fs.existsSync(root)) throw new Error("No such upload.");
  const rel = safeRelative(relPath);
  const dest = path.join(root, rel);
  if (!path.resolve(dest).startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Unsafe upload path: ${relPath}`);
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const room = (await freeBytes()) - MIN_FREE_BYTES;
  if (room <= 0) throw new Error("Not enough disk space on the server for uploads.");

  const hash = crypto.createHash("sha256");
  let written = 0;
  let refused: string | null = null;
  const out = fs.createWriteStream(dest);
  try {
    await pipeline(body, async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        written += chunk.length;
        if (written > MAX_FILE_BYTES) {
          refused = `File exceeds the ${MAX_FILE_BYTES / 1024 ** 3} GB per-file limit.`;
          throw new Error(refused);
        }
        if (written > room) {
          refused = "Not enough disk space on the server for that file.";
          throw new Error(refused);
        }
        hash.update(chunk);
        yield chunk;
      }
    }, out);
  } catch (err) {
    // A partial file is worse than no file: it would render as a corrupt asset.
    await fsp.rm(dest, { force: true });
    throw new Error(refused || (err instanceof Error ? err.message : "Upload failed."));
  }
  const sha256 = hash.digest("hex");
  // Recorded here so a listing never has to read the file back to learn it.
  const index = await readIndex(id);
  index[rel] = { bytes: written, mtimeMs: (await fsp.stat(dest)).mtimeMs, sha256 };
  await writeIndex(id, index);
  return { path: rel, bytes: written, sha256 };
}

export async function deleteUpload(id: string): Promise<{ freedBytes: number }> {
  const dir = bucketDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such upload.");
  const { bytes } = await getUpload(id);
  await fsp.rm(dir, { recursive: true, force: true });
  return { freedBytes: bytes };
}

/**
 * Hard-link every file in a bucket into `destDir`, preserving sub-paths.
 *
 * Falls back to a copy across devices — correct rather than fast, and the
 * bind-mounted work directory is one filesystem in practice.
 */
export async function linkUploadInto(id: string, destDir: string): Promise<number> {
  const root = filesDir(id);
  if (!fs.existsSync(root)) throw new Error("No such upload.");
  const files = await walk(root); // no index: hashing gigabytes to copy them is waste
  if (!files.length) throw new Error("That upload has no files in it.");
  for (const f of files) {
    const src = path.join(root, f.path);
    const dest = path.join(destDir, f.path);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rm(dest, { force: true });
    try {
      await fsp.link(src, dest);
    } catch {
      await fsp.copyFile(src, dest);
    }
  }
  return files.length;
}

/** Drop buckets nobody came back for. Opportunistic — no cron, no timer. */
export async function sweepUploads(): Promise<void> {
  const cutoff = Date.now() - TTL_MS;
  for (const bucket of await listUploads()) {
    if (bucket.createdAt < cutoff) {
      try {
        await deleteUpload(bucket.id);
      } catch {
        /* best effort */
      }
    }
  }
}
