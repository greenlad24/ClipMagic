/**
 * Storage for the screenshots a run is given at setup.
 *
 * WHY THESE ARE FILES AND NOT ROWS
 * A tool walkthrough arrives with eight to fifteen screenshots of a dashboard.
 * The run row's `stages_json` is read and written back at every stage boundary
 * (~20 times a run), so a megabyte of base64 in that column would be re-parsed
 * and re-serialised on every persist. The bytes live on disk; the run carries a
 * `ScreenshotRef` — id, name, type, size, note — which is small enough to sit in
 * `input_json` and be logged.
 *
 * Uploads happen BEFORE the run exists: the user picks screenshots alongside the
 * idea, and the run id is only minted when Stage 0 starts. So a shot is keyed by
 * its own id from the moment it lands, and is never moved afterwards. An upload
 * that is never used costs a few hundred KB on a disk that already holds video.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScreenshotRef } from "./types.js";

const DATA_DIR = process.env.DATA_DIR || "/data";
const SHOTS_DIR = path.join(DATA_DIR, "scriptgen", "shots");

/**
 * What Anthropic's vision API accepts, mapped to the extension we store under.
 * Anything else is refused at the door rather than discovered at Stage 0.4,
 * where the failure would cost a model call to find out.
 */
const ACCEPTED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Anthropic rejects an image over ~5MB, and a PNG of a 4K dashboard clears that
 * easily. The cap is enforced on upload so the user is told by the file picker
 * rather than by a failed stage twenty minutes into a run.
 */
export const MAX_SHOT_BYTES = 5 * 1024 * 1024;

/** Everything one run may carry. Past this, the sheet stops being read carefully. */
export const MAX_SHOTS_PER_RUN = 20;

export function acceptedMediaTypes(): string[] {
  return Object.keys(ACCEPTED);
}

function ensureDir(): void {
  if (!existsSync(SHOTS_DIR)) mkdirSync(SHOTS_DIR, { recursive: true });
}

function fileFor(id: string, mediaType: string): string {
  return path.join(SHOTS_DIR, `${id}.${ACCEPTED[mediaType] ?? "png"}`);
}

/**
 * Persist one screenshot and return the reference the run will carry.
 *
 * `dataBase64` may arrive either bare or as a `data:image/png;base64,...` URI —
 * the browser's FileReader produces the second form and stripping it here means
 * the caller never has to care which it sent.
 */
export function saveShot(opts: {
  name: string;
  mediaType: string;
  dataBase64: string;
  note?: string;
}): ScreenshotRef {
  const mediaType = (opts.mediaType || "").toLowerCase().trim();
  if (!ACCEPTED[mediaType]) {
    throw new Error(
      `${opts.name}: ${mediaType || "unknown type"} can't be read. Use PNG, JPEG, WEBP or GIF.`,
    );
  }
  const b64 = opts.dataBase64.includes(",")
    ? opts.dataBase64.slice(opts.dataBase64.indexOf(",") + 1)
    : opts.dataBase64;
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) throw new Error(`${opts.name}: the file came through empty.`);
  if (buf.length > MAX_SHOT_BYTES) {
    throw new Error(
      `${opts.name} is ${(buf.length / 1024 / 1024).toFixed(1)}MB. ` +
        `The limit is ${MAX_SHOT_BYTES / 1024 / 1024}MB per screenshot — crop it or save it as JPEG.`,
    );
  }
  ensureDir();
  const id = randomUUID();
  writeFileSync(fileFor(id, mediaType), buf);
  return {
    id,
    name: opts.name || "screenshot",
    mediaType,
    bytes: buf.length,
    ...(opts.note?.trim() ? { note: opts.note.trim() } : {}),
    uploadedAt: Date.now(),
  };
}

/**
 * Read one screenshot back as base64, or null when the file is gone.
 *
 * Null rather than a throw: a missing shot must degrade the sheet, never take
 * down a run that has already paid for later stages.
 */
export function loadShot(ref: ScreenshotRef): string | null {
  const file = fileFor(ref.id, ref.mediaType);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file).toString("base64");
  } catch {
    return null;
  }
}

export function shotExists(ref: ScreenshotRef): boolean {
  const file = fileFor(ref.id, ref.mediaType);
  try {
    return existsSync(file) && statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** Delete one screenshot. Silent when it is already gone — this is called from a UI. */
export function deleteShot(ref: Pick<ScreenshotRef, "id" | "mediaType">): void {
  const file = fileFor(ref.id, ref.mediaType);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* a screenshot that will not delete is not worth failing a request over */
  }
}
