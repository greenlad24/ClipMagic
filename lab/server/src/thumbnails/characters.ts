/**
 * Character library for the Thumbnail Designer.
 *
 * There are FOUR built-in expression slots (smile / surprise / secret / calm)
 * that map to video types, PLUS any number of USER-DEFINED custom expressions
 * (e.g. "pointing", "shocked-mouth-open") the creator uploads with their own
 * label. The art-director picks the best-fit expression — built-in OR custom —
 * per source thumbnail.
 *
 * Storage: each expression is a single PNG under
 *   <dataDir>/thumbnail-characters/<id>.png
 * served read-only at /api/thumbnail-characters/<id>.png (see index.ts).
 * A JSON manifest tracks id → { label, builtin, updatedAt } so the UI can show
 * previews + names and the generator can list what's available.
 *
 * Built-in slots always appear in the library (uploaded or not); custom ones
 * appear once created (by uploading with a name) and can be deleted entirely.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** The four built-in expression slots, tied to video types in videoType.ts. */
export const BUILTIN_EXPRESSIONS = ["smile", "surprise", "secret", "calm"] as const;
export type BuiltinExpression = (typeof BUILTIN_EXPRESSIONS)[number];

/** Back-compat alias: callers that only care about the built-ins import this. */
export const EXPRESSIONS = BUILTIN_EXPRESSIONS;

/**
 * An expression id is now any safe identifier: a built-in name or a custom slug.
 * (Kept as a string alias so the rest of the pipeline treats expressions
 * generically; the built-in union lives in BuiltinExpression.)
 */
export type Expression = string;

const BUILTIN_LABEL: Record<BuiltinExpression, string> = {
  smile: "Smile",
  surprise: "Surprise",
  secret: "Secret",
  calm: "Calm",
};

/** UI hint shown under each built-in slot (which video type it suits). */
const BUILTIN_HINT: Record<BuiltinExpression, string> = {
  smile: "Tutorials / How-to",
  surprise: "Viral / Shock",
  secret: "Secret / Insider",
  calm: "Reviews / Calm",
};

export function isBuiltinExpression(x: unknown): x is BuiltinExpression {
  return typeof x === "string" && (BUILTIN_EXPRESSIONS as readonly string[]).includes(x);
}

/**
 * Turn a free-text name into a safe, file-system-friendly id (lowercase, dashes,
 * no leading "builtin collision"). Returns "" when nothing usable remains.
 */
export function slugifyExpressionId(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** A valid id is a built-in name or a safe custom slug. */
export function isValidExpressionId(x: unknown): x is Expression {
  if (typeof x !== "string") return false;
  if (isBuiltinExpression(x)) return true;
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(x);
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
export function expressionFile(id: Expression): string {
  return path.join(charsDir(), `${id}.png`);
}

/** Public, read-only serve URL for an expression image. */
export function expressionUrl(id: Expression): string {
  return `/api/thumbnail-characters/${id}.png`;
}

interface ManifestEntry {
  id: Expression;
  label: string;
  builtin: boolean;
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
        if (isValidExpressionId(k) && fs.existsSync(expressionFile(k))) {
          out[k] = {
            id: k,
            label: typeof v?.label === "string" && v.label.trim() ? v.label : defaultLabel(k),
            builtin: isBuiltinExpression(k),
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

function defaultLabel(id: Expression): string {
  return isBuiltinExpression(id) ? BUILTIN_LABEL[id] : id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function writeManifest(m: Manifest): void {
  fs.mkdirSync(charsDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2));
}

export interface CharacterState {
  /** Stable id (built-in name or custom slug). */
  id: Expression;
  /** @deprecated kept for back-compat with older UI builds — same as `id`. */
  expression: Expression;
  /** Display name. */
  label: string;
  /** UI hint (which video type a built-in suits); empty for custom. */
  hint: string;
  /** Whether this is one of the four built-in slots. */
  builtin: boolean;
  uploaded: boolean;
  url: string | null;
  updatedAt: string | null;
}

function stateFor(id: Expression, entry: ManifestEntry | undefined): CharacterState {
  const onDisk = !!entry && fs.existsSync(expressionFile(id));
  const builtin = isBuiltinExpression(id);
  return {
    id,
    expression: id,
    label: entry?.label || defaultLabel(id),
    hint: builtin ? BUILTIN_HINT[id as BuiltinExpression] : "",
    builtin,
    uploaded: onDisk,
    // Cache-bust the preview with the update time so a re-upload shows instantly.
    url: onDisk ? `${expressionUrl(id)}?t=${Date.parse(entry!.updatedAt) || Date.now()}` : null,
    updatedAt: onDisk ? entry!.updatedAt : null,
  };
}

/**
 * Per-expression state for the UI: the four built-in slots ALWAYS (in canonical
 * order, uploaded or not), then any custom expressions (alphabetical by label).
 */
export function listCharacters(): CharacterState[] {
  const m = readManifest();
  const builtins = BUILTIN_EXPRESSIONS.map((id) => stateFor(id, m[id]));
  const customs = Object.values(m)
    .filter((e) => !e.builtin)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((e) => stateFor(e.id, e));
  return [...builtins, ...customs];
}

/** Which expression ids are uploaded (for thumbnailStatus / gating + generation). */
export function uploadedExpressions(): Expression[] {
  return listCharacters().filter((c) => c.uploaded).map((c) => c.id);
}

/** id → label map for the uploaded expressions (drives the art-director prompt). */
export function expressionLabels(): Record<Expression, string> {
  const out: Record<Expression, string> = {};
  for (const c of listCharacters()) if (c.uploaded) out[c.id] = c.label;
  return out;
}

/**
 * Save an expression image from base64. `id` is a built-in name OR a custom slug;
 * `label` names a custom one (ignored for built-ins, which have fixed labels).
 * Decodes, writes the PNG, updates the manifest. Throws on an invalid id or
 * empty/oversized data.
 */
export function saveCharacter(id: Expression, base64: string, opts: { label?: string } = {}): CharacterState {
  if (!isValidExpressionId(id)) throw new Error(`Invalid expression id: ${String(id)}`);
  const clean = (base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!clean) throw new Error("No image data provided.");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new Error("Image data is empty or not valid base64.");
  // Sanity cap (10MB) — character refs are small portraits, not videos.
  if (buf.length > 10 * 1024 * 1024) throw new Error("Character image too large (max 10MB).");
  fs.writeFileSync(expressionFile(id), buf);
  const builtin = isBuiltinExpression(id);
  const label = builtin ? BUILTIN_LABEL[id as BuiltinExpression] : (opts.label?.trim() || defaultLabel(id));
  const m = readManifest();
  m[id] = { id, label, builtin, updatedAt: new Date().toISOString() };
  writeManifest(m);
  return listCharacters().find((c) => c.id === id)!;
}

/**
 * Create a CUSTOM expression from a free-text name + image. Slugifies the name to
 * an id; rejects empty names, ids that collide with a built-in, and duplicates.
 */
export function saveCustomCharacter(name: string, base64: string): CharacterState {
  const label = (name || "").trim();
  if (!label) throw new Error("Please give the expression a name.");
  const id = slugifyExpressionId(label);
  if (!id) throw new Error("That name has no usable letters or numbers.");
  if (isBuiltinExpression(id)) throw new Error(`"${label}" collides with a built-in expression — pick another name.`);
  return saveCharacter(id, base64, { label });
}

/** Delete an expression image + manifest entry. Idempotent. */
export function deleteCharacter(id: Expression): CharacterState | null {
  if (!isValidExpressionId(id)) throw new Error(`Invalid expression id: ${String(id)}`);
  try {
    fs.rmSync(expressionFile(id), { force: true });
  } catch {
    /* already gone */
  }
  const m = readManifest();
  delete m[id];
  writeManifest(m);
  // Built-in slots persist (now empty); custom ones disappear entirely.
  return listCharacters().find((c) => c.id === id) ?? null;
}

/** Read an expression's image bytes (for feeding into the Nano Banana chain). */
export function readCharacterImage(id: Expression): Buffer | null {
  try {
    return fs.readFileSync(expressionFile(id));
  } catch {
    return null;
  }
}

/**
 * Parse a PLACEMENT directive out of an expression's label/name. Creators can
 * encode where the character should sit in the frame, e.g.
 *   "Pointing to the left - place on the right"  → "right"
 *   "Place on the left"                          → "left"
 * Only an explicit "place … left/right" counts (so "pointing to the left" alone,
 * which describes the pose, does NOT move him). Returns null when there's no
 * placement instruction. Pure + exported.
 */
export function placementFromLabel(label: string): "left" | "right" | null {
  const m = (label || "").toLowerCase().match(/place[^.]*?\b(left|right)\b/);
  return m ? (m[1] as "left" | "right") : null;
}

