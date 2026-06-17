/**
 * Character library for the Thumbnail Designer — the user uploads up to four
 * named expression reference images ONCE, and every thumbnail run reuses them.
 *
 * Storage: each expression is a single PNG under
 *   <dataDir>/thumbnail-characters/<expression>.png
 * served read-only at /api/thumbnail-characters/<expression>.png (see index.ts).
 * A tiny JSON manifest tracks which expressions exist + when they were updated
 * so the UI can show previews and gate the tool.
 *
 * The four expressions map to video types in the generator (recreate.ts):
 *   smile → Tutorial/How-to · surprise → Viral/Shock · secret → Secret/Insider
 *   · calm → Review/Calm.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export const EXPRESSIONS = ["smile", "surprise", "secret", "calm"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export function isExpression(x: unknown): x is Expression {
  return typeof x === "string" && (EXPRESSIONS as readonly string[]).includes(x);
}

function charsDir(): string {
  const dir = path.join(config.dataDir, "thumbnail-characters");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(): string {
  return path.join(charsDir(), "manifest.json");
}

/** Absolute path to an expression's stored PNG. */
export function expressionFile(expr: Expression): string {
  return path.join(charsDir(), `${expr}.png`);
}

/** Public, read-only serve URL for an expression image. */
export function expressionUrl(expr: Expression): string {
  return `/api/thumbnail-characters/${expr}.png`;
}

interface ManifestEntry {
  expression: Expression;
  updatedAt: string;
}
type Manifest = Record<string, ManifestEntry>;

function readManifest(): Manifest {
  try {
    const raw = fs.readFileSync(manifestPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Manifest = {};
      for (const [k, v] of Object.entries(parsed as Record<string, any>)) {
        if (isExpression(k) && fs.existsSync(expressionFile(k))) {
          out[k] = { expression: k, updatedAt: typeof v?.updatedAt === "string" ? v.updatedAt : new Date().toISOString() };
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
  fs.mkdirSync(charsDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

export interface CharacterState {
  expression: Expression;
  uploaded: boolean;
  url: string | null;
  updatedAt: string | null;
}

/** Per-expression state for the UI (always all four, in canonical order). */
export function listCharacters(): CharacterState[] {
  const m = readManifest();
  return EXPRESSIONS.map((expr) => {
    const entry = m[expr];
    const onDisk = !!entry && fs.existsSync(expressionFile(expr));
    return {
      expression: expr,
      uploaded: onDisk,
      // Cache-bust the preview with the update time so a re-upload shows instantly.
      url: onDisk ? `${expressionUrl(expr)}?t=${Date.parse(entry!.updatedAt) || Date.now()}` : null,
      updatedAt: onDisk ? entry!.updatedAt : null,
    };
  });
}

/** Which expressions are uploaded (for thumbnailStatus / gating). */
export function uploadedExpressions(): Expression[] {
  return listCharacters().filter((c) => c.uploaded).map((c) => c.expression);
}

/**
 * Save an expression image from base64 (the UI reads the file to a data URL and
 * sends the bare base64). Decodes, writes the PNG, updates the manifest. Throws
 * on an unknown expression or empty/oversized data.
 */
export function saveCharacter(expr: Expression, base64: string): CharacterState {
  if (!isExpression(expr)) throw new Error(`Unknown expression: ${String(expr)}`);
  const clean = (base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!clean) throw new Error("No image data provided.");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new Error("Image data is empty or not valid base64.");
  // Sanity cap (10MB) — character refs are small portraits, not videos.
  if (buf.length > 10 * 1024 * 1024) throw new Error("Character image too large (max 10MB).");
  fs.writeFileSync(expressionFile(expr), buf);
  const m = readManifest();
  m[expr] = { expression: expr, updatedAt: new Date().toISOString() };
  writeManifest(m);
  return listCharacters().find((c) => c.expression === expr)!;
}

/** Delete an expression image + manifest entry. Idempotent. */
export function deleteCharacter(expr: Expression): CharacterState {
  if (!isExpression(expr)) throw new Error(`Unknown expression: ${String(expr)}`);
  try {
    fs.rmSync(expressionFile(expr), { force: true });
  } catch {
    /* already gone */
  }
  const m = readManifest();
  delete m[expr];
  writeManifest(m);
  return listCharacters().find((c) => c.expression === expr)!;
}

/** Read an expression's image bytes (for feeding into the Nano Banana chain). */
export function readCharacterImage(expr: Expression): Buffer | null {
  try {
    return fs.readFileSync(expressionFile(expr));
  } catch {
    return null;
  }
}
