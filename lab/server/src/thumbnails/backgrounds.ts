/**
 * Background library for the Thumbnail Designer.
 *
 * The creator can upload any number of named background images. During a
 * recreation the art-director may pick ONE of them to swap in behind the subject
 * — but ONLY when an uploaded background clearly fits that variation; otherwise
 * the original (popped) background is kept. So uploading backgrounds is purely
 * additive: with none uploaded, nothing changes.
 *
 * Storage mirrors the character library: each background is a single image under
 *   <dataDir>/thumbnail-backgrounds/<id>.png
 * served read-only at /api/thumbnail-backgrounds/<id>.png (see index.ts). A JSON
 * manifest tracks id → { label, updatedAt }.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Turn a free-text name into a safe id (lowercase, dashes). "" when unusable. */
export function slugifyBackgroundId(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function isValidBackgroundId(x: unknown): x is string {
  return typeof x === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(x);
}

function bgDir(): string {
  const dir = path.join(config.dataDir, "thumbnail-backgrounds");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(): string {
  return path.join(bgDir(), "manifest.json");
}

/** Absolute path to a background's stored PNG. */
export function backgroundFile(id: string): string {
  return path.join(bgDir(), `${id}.png`);
}

/** Public, read-only serve URL for a background image. */
export function backgroundUrl(id: string): string {
  return `/api/thumbnail-backgrounds/${id}.png`;
}

interface ManifestEntry {
  id: string;
  label: string;
  updatedAt: string;
}
type Manifest = Record<string, ManifestEntry>;

function defaultLabel(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function readManifest(): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Manifest = {};
      for (const [k, v] of Object.entries(parsed as Record<string, any>)) {
        if (isValidBackgroundId(k) && fs.existsSync(backgroundFile(k))) {
          out[k] = {
            id: k,
            label: typeof v?.label === "string" && v.label.trim() ? v.label : defaultLabel(k),
            updatedAt: typeof v?.updatedAt === "string" ? v.updatedAt : new Date().toISOString(),
          };
        }
      }
      return out;
    }
  } catch {
    /* missing / corrupt → empty */
  }
  return {};
}

function writeManifest(m: Manifest): void {
  fs.mkdirSync(bgDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

export interface BackgroundState {
  id: string;
  label: string;
  url: string;
  updatedAt: string;
}

function stateFor(entry: ManifestEntry): BackgroundState {
  return {
    id: entry.id,
    label: entry.label,
    url: `${backgroundUrl(entry.id)}?t=${Date.parse(entry.updatedAt) || Date.now()}`,
    updatedAt: entry.updatedAt,
  };
}

/** All uploaded backgrounds, alphabetical by label. */
export function listBackgrounds(): BackgroundState[] {
  return Object.values(readManifest())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(stateFor);
}

/** Uploaded background ids. */
export function uploadedBackgrounds(): string[] {
  return listBackgrounds().map((b) => b.id);
}

/** id → label map for the uploaded backgrounds. */
export function backgroundLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of listBackgrounds()) out[b.id] = b.label;
  return out;
}

/**
 * Create/replace a background from a free-text name + base64 image. Slugifies the
 * name to an id; rejects empty names and unusable slugs. 10MB cap.
 */
export function saveBackground(name: string, base64: string): BackgroundState {
  const label = (name || "").trim();
  if (!label) throw new Error("Please give the background a name.");
  const id = slugifyBackgroundId(label);
  if (!id) throw new Error("That name has no usable letters or numbers.");
  const clean = (base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!clean) throw new Error("No image data provided.");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new Error("Image data is empty or not valid base64.");
  if (buf.length > 10 * 1024 * 1024) throw new Error("Background image too large (max 10MB).");
  fs.writeFileSync(backgroundFile(id), buf);
  const m = readManifest();
  m[id] = { id, label, updatedAt: new Date().toISOString() };
  writeManifest(m);
  return listBackgrounds().find((b) => b.id === id)!;
}

/** Delete a background image + manifest entry. Idempotent. */
export function deleteBackground(id: string): void {
  if (!isValidBackgroundId(id)) throw new Error(`Invalid background id: ${String(id)}`);
  try {
    fs.rmSync(backgroundFile(id), { force: true });
  } catch {
    /* already gone */
  }
  const m = readManifest();
  delete m[id];
  writeManifest(m);
}

/** Read a background's image bytes (for feeding into the Nano Banana chain). */
export function readBackgroundImage(id: string): Buffer | null {
  try {
    return fs.readFileSync(backgroundFile(id));
  } catch {
    return null;
  }
}
