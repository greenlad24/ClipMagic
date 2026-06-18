/**
 * Programmatic TEXT OVERLAY for the contrarian-originals workflow.
 *
 * The image model composes only the BACKGROUND + CHARACTER; the styled headline
 * is drawn here, by code, so the 3 templates land in EXACT, repeatable positions
 * every time (the model can't guarantee that). Three fixed templates, modelled on
 * the reference designs:
 *
 *   1. bottom-bar  — character centred; one headline line across the BOTTOM,
 *                    emphasis word(s) in a solid RED rounded box.
 *   2. left-stack  — character on the RIGHT; two stacked lines on the LEFT,
 *                    the emphasis as the top line in a RED box.
 *   3. top-strike  — character centred; one headline line across the TOP,
 *                    a RED strikethrough through the emphasis word(s).
 *
 * Font: Helvetica. Real Helvetica can't be bundled, so the font file is
 * configurable via THUMBNAIL_FONT_PATH (the creator mounts their Helvetica
 * Black/Bold); it defaults to Liberation Sans Bold (metric-compatible, installed
 * in the image). All text is UPPERCASE with a soft 25%-opacity drop shadow.
 *
 * The renderer is BEST-EFFORT and lazy: if @napi-rs/canvas or the font isn't
 * available, or anything throws, it returns the base image unchanged so a
 * thumbnail always finishes. The layout math is pure + exported for unit tests.
 */

import { uploadedFontPath } from "./fonts.js";

export type ContrarianTemplateId = "bottom-bar" | "left-stack" | "top-strike";

export interface ContrarianTemplate {
  id: ContrarianTemplateId;
  label: string;
  /** Where the AI should compose the character (overridable by a name directive). */
  charPlacement: "center" | "right";
  /** Hint for the compose prompt: which region to leave clear for the headline. */
  textArea: string;
  /** Copy guidance for the writer so the statement suits this template. */
  copyHint: string;
  /**
   * The uploaded background this template ALWAYS uses, matched by name (the
   * creator names their backgrounds these). Falls back to a cycled background
   * when no upload matches.
   */
  backgroundName: string;
}

/** The 3 fixed templates, in the order variations are produced. */
export const CONTRARIAN_TEMPLATES: ContrarianTemplate[] = [
  {
    id: "bottom-bar",
    label: "Bottom headline",
    charPlacement: "center",
    textArea: "the BOTTOM strip (lower ~22% of the frame)",
    copyHint: "ONE very short punchy line (2–4 words); the key word(s) at the END are the red-box emphasis (e.g. \"DON'T RUN VIDEO ADS\" → \"VIDEO ADS\")",
    backgroundName: "Open Space Office With Green",
  },
  {
    id: "left-stack",
    label: "Left stack",
    charPlacement: "right",
    textArea: "the LEFT half of the frame",
    copyHint: "a SHORT hook (1–2 words) then a SHORT follow-up (1–2 words); the hook is the red-box emphasis (e.g. \"#1 MISTAKE\" + \"Everyone Makes\" → \"#1 MISTAKE\")",
    backgroundName: "Black",
  },
  {
    id: "top-strike",
    label: "Top strikethrough",
    charPlacement: "center",
    textArea: "the TOP strip (upper ~18% of the frame)",
    copyHint: "a SHORT 2–3 word phrase where ONE word is 'crossed out' for effect; that word is the emphasis (e.g. \"NEW CUSTOMERS\" → \"CUSTOMERS\")",
    backgroundName: "Office",
  },
];
/** The template for variation index `i` (cycles, though we always make 3). */
export function templateForIndex(i: number): ContrarianTemplate {
  return CONTRARIAN_TEMPLATES[i % CONTRARIAN_TEMPLATES.length];
}

/** One run of text, flagged as emphasis (red box / strikethrough) or not. */
export interface TextSegment {
  text: string;
  emph: boolean;
}

/**
 * Split `text` into segments around the first case-insensitive occurrence of
 * `emphasis`, preserving the surrounding text (incl. spaces). When the emphasis
 * isn't found (or is empty), the whole string is one non-emphasis segment. Pure.
 */
export function splitByEmphasis(text: string, emphasis: string): TextSegment[] {
  const t = text;
  const e = (emphasis || "").trim();
  if (!e) return [{ text: t, emph: false }];
  const idx = t.toLowerCase().indexOf(e.toLowerCase());
  if (idx < 0) return [{ text: t, emph: false }];
  const out: TextSegment[] = [];
  if (idx > 0) out.push({ text: t.slice(0, idx), emph: false });
  out.push({ text: t.slice(idx, idx + e.length), emph: true });
  if (idx + e.length < t.length) out.push({ text: t.slice(idx + e.length), emph: false });
  return out;
}

/**
 * For the left-stack template: line 1 is the emphasis, line 2 is the rest of the
 * text with the emphasis removed (trimmed, collapsed spaces). Pure + exported.
 */
export function stackLines(text: string, emphasis: string): { line1: string; line2: string } {
  const strip = (s: string) => s.replace(/^[\s,;:.–—-]+|[\s,;:.–—-]+$/g, "").replace(/\s+/g, " ").trim();
  const e = strip(emphasis || "");
  if (!e) return { line1: strip(text), line2: "" };
  const idx = text.toLowerCase().indexOf(e.toLowerCase());
  if (idx < 0) return { line1: e, line2: strip(text) };
  const rest = strip(text.slice(0, idx) + " " + text.slice(idx + e.length));
  return { line1: strip(text.slice(idx, idx + e.length)), line2: rest };
}

/**
 * Resolve the headline font file, in priority order:
 *   1. an UPLOADED font (managed in the UI, stored under the data dir),
 *   2. THUMBNAIL_FONT_PATH (a mounted file),
 *   3. the bundled Liberation Sans Bold (metric-compatible Helvetica).
 */
export function thumbnailFontPath(): string {
  try {
    // Lazy require so the pure exports here don't pull the data-dir store.
    const uploaded = uploadedFontPath();
    if (uploaded) return uploaded;
  } catch {
    /* fall through to env / default */
  }
  return process.env.THUMBNAIL_FONT_PATH || "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
}

const RED = "#E01B1B";
const FONT_FAMILY = "ThumbHeadline";
/** The font path we last registered (re-register when the user uploads a new one). */
let registeredPath: string | null = null;

/** Best-effort font registration (re-registers when the resolved path changes). */
async function ensureFont(canvasMod: any): Promise<string> {
  try {
    const p = thumbnailFontPath();
    if (registeredPath !== p) {
      const ok = canvasMod.GlobalFonts.registerFromPath(p, FONT_FAMILY);
      registeredPath = ok ? p : null;
    }
    return registeredPath ? FONT_FAMILY : "sans-serif";
  } catch {
    return "sans-serif";
  }
}

/** Set the white-text-with-soft-shadow style for the given height. */
function setWhiteShadow(ctx: any, H: number): void {
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = Math.round(H * 0.012);
  ctx.shadowOffsetX = Math.round(H * 0.004);
  ctx.shadowOffsetY = Math.round(H * 0.006);
}

function clearShadow(ctx: any): void {
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** Draw a filled rounded rectangle (manual path — no roundRect dependency). */
function roundRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Largest font size (≤ `start`) whose measured width fits `maxWidth`. */
function fitFont(ctx: any, family: string, text: string, maxWidth: number, start: number): number {
  let size = start;
  while (size > 12) {
    ctx.font = `${size}px "${family}"`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= Math.max(2, Math.round(size * 0.06));
  }
  return size;
}

/**
 * Draw the headline for a template onto the base image bytes, returning JPEG
 * bytes. BEST-EFFORT: returns the base bytes unchanged if canvas/font/render
 * fails. `text` + `emphasis` are the copy; everything is drawn UPPERCASE.
 */
export async function renderContrarianText(
  baseBytes: Buffer,
  template: ContrarianTemplate,
  text: string,
  emphasis: string,
): Promise<Buffer> {
  let canvasMod: any;
  try {
    // Indirect specifier so the type-checker/bundler doesn't hard-require the
    // optional native dep; it's loaded at runtime only when present.
    const spec = "@napi-rs/canvas";
    canvasMod = await import(/* @vite-ignore */ spec);
  } catch {
    return baseBytes; // canvas not installed (e.g. tests) → leave image as-is
  }
  try {
    const family = (await ensureFont(canvasMod)) ?? "sans-serif";
    const img = await canvasMod.loadImage(baseBytes);
    const W = img.width;
    const H = img.height;
    const canvas = canvasMod.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const upperText = text.toUpperCase();
    const upperEmph = emphasis.toUpperCase();

    if (template.id === "left-stack") {
      drawLeftStack(ctx, family, W, H, upperText, upperEmph);
    } else if (template.id === "top-strike") {
      drawSingleLine(ctx, family, W, H, upperText, upperEmph, "top");
    } else {
      drawSingleLine(ctx, family, W, H, upperText, upperEmph, "bottom");
    }

    return await canvas.encode("jpeg", 92);
  } catch {
    return baseBytes;
  }
}

/** bottom-bar + top-strike: one line; bottom uses a red box, top uses a strike. */
function drawSingleLine(
  ctx: any,
  family: string,
  W: number,
  H: number,
  text: string,
  emphasis: string,
  pos: "top" | "bottom",
): void {
  const margin = W * 0.03;
  const maxW = W - margin * 2;
  // Big, bold headline like the reference designs — short copy keeps it huge.
  const size = fitFont(ctx, family, text, maxW, Math.round(H * 0.185));
  ctx.font = `${size}px "${family}"`;
  const segs = splitByEmphasis(text, emphasis);
  const padX = Math.round(size * 0.18);
  const widths = segs.map((s) => ctx.measureText(s.text).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + segs.filter((s) => s.emph).length * padX * 2;
  let x = Math.max(margin, (W - totalW) / 2);
  const y = pos === "bottom" ? H * 0.87 : H * 0.13;
  const boxH = size * 1.18;

  segs.forEach((s, i) => {
    const w = widths[i];
    if (s.emph && pos === "bottom") {
      clearShadow(ctx);
      ctx.fillStyle = RED;
      roundRectPath(ctx, x, y - boxH / 2, w + padX * 2, boxH, size * 0.14);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(s.text, x + padX, y);
      x += w + padX * 2;
    } else {
      setWhiteShadow(ctx, H);
      ctx.fillText(s.text, x, y);
      if (s.emph && pos === "top") {
        // Red strikethrough across the emphasis word(s).
        clearShadow(ctx);
        ctx.strokeStyle = RED;
        ctx.lineWidth = Math.max(3, size * 0.1);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.stroke();
      }
      x += w;
    }
  });
}

/** left-stack: hook line (red box) over a white follow-up line, left-aligned. */
function drawLeftStack(ctx: any, family: string, W: number, H: number, text: string, emphasis: string): void {
  const { line1, line2 } = stackLines(text, emphasis);
  const x = W * 0.05;
  const maxW = W * 0.58;
  // Large stacked headline like the "$40M / At 20" reference — short copy → huge.
  const size = fitFont(ctx, family, line1.length >= line2.length ? line1 : line2, maxW, Math.round(H * 0.25));
  ctx.font = `${size}px "${family}"`;
  const padX = Math.round(size * 0.16);
  const boxH = size * 1.2;
  const gap = size * 0.28;
  const total = line2 ? boxH + gap + size : boxH;
  let y = (H - total) / 2 + boxH / 2;

  // Line 1 — the hook in a red box.
  const w1 = ctx.measureText(line1).width;
  clearShadow(ctx);
  ctx.fillStyle = RED;
  roundRectPath(ctx, x, y - boxH / 2, w1 + padX * 2, boxH, size * 0.14);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(line1, x + padX, y);

  // Line 2 — white follow-up with a soft shadow.
  if (line2) {
    y += boxH / 2 + gap + size / 2;
    setWhiteShadow(ctx, H);
    ctx.fillText(line2, x, y);
  }
}
