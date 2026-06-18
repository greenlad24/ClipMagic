/**
 * Programmatic TEXT OVERLAY for the contrarian-originals workflow.
 *
 * The image model composes only the BACKGROUND + CHARACTER; the styled headline
 * is drawn here, by code, so the 3 templates land in EXACT, repeatable positions
 * every time (the model can't guarantee that). Three fixed templates, modelled on
 * the reference designs:
 *
 *   1. bottom-bar  — character centred; headline across the BOTTOM, the
 *                    emphasis word(s) in a solid RED rounded box (in place).
 *   2. left-stack  — character on the RIGHT; headline word-wrapped on the LEFT
 *                    (20% larger), the emphasis word(s) in a RED box WHEREVER
 *                    they occur in the copy (start, middle or end).
 *   3. top-strike  — character centred; headline across the TOP, a RED
 *                    strikethrough through the emphasis word(s) in place.
 *
 * All three share one renderer (drawWrapped): the copy keeps its natural word
 * order and the emphasis run is highlighted exactly where it falls — it is never
 * reordered to a fixed line. Font: Helvetica. Real Helvetica can't be bundled, so
 * the font file is configurable via THUMBNAIL_FONT_PATH (the creator mounts their
 * Helvetica Black/Bold); it defaults to Liberation Sans Bold (metric-compatible,
 * installed in the image). All text is UPPERCASE with a 25%-opacity drop shadow
 * (0px 4px 8px rgba(0,0,0,0.25), scaled to the render height).
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

/**
 * Set the white-text drop shadow. The spec is `0px 4px 8px rgba(0,0,0,0.25)`
 * (offsetX 0, offsetY 4, blur 8) authored against a 720p-tall thumbnail, so we
 * scale offset + blur by H/720 to keep it identical at any render resolution.
 */
function setWhiteShadow(ctx: any, H: number): void {
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = Math.round((H * 8) / 720);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.round((H * 4) / 720);
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
      // Image 2: left-aligned, vertically centred, wraps in the left ~58%. Text is
      // 20% BIGGER than the other two templates (per spec). Emphasis = red box.
      drawWrapped(ctx, family, W, H, upperText, upperEmph, {
        align: "left",
        vpos: "middle",
        x0: W * 0.05,
        maxW: W * 0.58,
        startSize: Math.round(H * 0.25 * 1.2),
        emphStyle: "box",
      });
    } else if (template.id === "top-strike") {
      // Image 3: centred top strip; emphasis = red strikethrough. Size unchanged.
      drawWrapped(ctx, family, W, H, upperText, upperEmph, {
        align: "center",
        vpos: "top",
        x0: W * 0.03,
        maxW: W * 0.94,
        startSize: Math.round(H * 0.185),
        emphStyle: "strike",
      });
    } else {
      // Image 1: centred bottom strip; emphasis = red box. Size unchanged.
      drawWrapped(ctx, family, W, H, upperText, upperEmph, {
        align: "center",
        vpos: "bottom",
        x0: W * 0.03,
        maxW: W * 0.94,
        startSize: Math.round(H * 0.185),
        emphStyle: "box",
      });
    }

    return await canvas.encode("jpeg", 92);
  } catch {
    return baseBytes;
  }
}

/** One word, flagged emphasis or not (a finer-grained TextSegment for wrapping). */
export interface Word {
  text: string;
  emph: boolean;
}

/**
 * Split `text` into per-WORD tokens, each carrying the emphasis flag of the
 * segment it came from. Keeps the natural word order (no reordering), so the
 * emphasis stays wherever it occurs — start, middle or end. Pure + exported.
 */
export function toWords(text: string, emphasis: string): Word[] {
  const out: Word[] = [];
  for (const seg of splitByEmphasis(text, emphasis)) {
    for (const w of seg.text.split(/\s+/).filter(Boolean)) out.push({ text: w, emph: seg.emph });
  }
  return out;
}

/**
 * Greedy word-wrap into lines that fit `maxW`, using the injected `measure`
 * (so it's testable without a canvas). A single word wider than maxW gets its own
 * line (the caller shrinks the font until lines fit). Pure + exported.
 */
export function wrapWords(measure: (s: string) => number, words: Word[], maxW: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let lineW = 0;
  const space = measure(" ");
  for (const w of words) {
    const ww = measure(w.text);
    const add = line.length ? space + ww : ww;
    if (line.length && lineW + add > maxW) {
      lines.push(line);
      line = [w];
      lineW = ww;
    } else {
      line.push(w);
      lineW += add;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

/**
 * Merge a line's words into contiguous RUNS of the same emphasis flag, so each
 * emphasis run gets ONE red box (not a box per word). Pure + exported.
 */
export function lineRuns(line: Word[]): TextSegment[] {
  const runs: TextSegment[] = [];
  for (const w of line) {
    const last = runs[runs.length - 1];
    if (last && last.emph === w.emph) last.text += " " + w.text;
    else runs.push({ text: w.text, emph: w.emph });
  }
  return runs;
}

interface WrapOpts {
  align: "left" | "center";
  vpos: "top" | "middle" | "bottom";
  x0: number;
  maxW: number;
  startSize: number;
  emphStyle: "box" | "strike";
}

/**
 * The unified headline renderer for all three templates: word-wrap the copy in
 * its natural order and highlight the emphasis run(s) IN PLACE — a red box (or a
 * strikethrough) drawn exactly where the emphasis word(s) fall, even mid-line.
 * The font shrinks until every wrapped line fits `maxW`.
 */
function drawWrapped(ctx: any, family: string, W: number, H: number, text: string, emphasis: string, opts: WrapOpts): void {
  const words = toWords(text, emphasis);
  if (words.length === 0) return;

  // Shrink the font until every wrapped line fits maxW (incl. emphasis box pad).
  let size = opts.startSize;
  let lines: Word[][] = [];
  const padXFor = (s: number) => Math.round(s * 0.16);
  const lineWidth = (line: Word[], s: number): number => {
    const runs = lineRuns(line);
    const space = ctx.measureText(" ").width;
    const padX = padXFor(s);
    let w = 0;
    runs.forEach((r, i) => {
      if (i > 0) w += space;
      w += ctx.measureText(r.text).width + (r.emph && opts.emphStyle === "box" ? padX * 2 : 0);
    });
    return w;
  };
  while (size > 14) {
    ctx.font = `${size}px "${family}"`;
    lines = wrapWords((s) => ctx.measureText(s).width, words, opts.maxW);
    if (lines.every((ln) => lineWidth(ln, size) <= opts.maxW)) break;
    size -= Math.max(2, Math.round(size * 0.06));
  }
  ctx.font = `${size}px "${family}"`;

  const padX = padXFor(size);
  const boxH = size * 1.18;
  const lineGap = size * 0.3;
  const blockH = lines.length * boxH + (lines.length - 1) * lineGap;
  const margin = H * 0.07;
  const yTop = opts.vpos === "top" ? margin : opts.vpos === "bottom" ? H - margin - blockH : (H - blockH) / 2;
  const space = ctx.measureText(" ").width;

  lines.forEach((line, li) => {
    const cy = yTop + li * (boxH + lineGap) + boxH / 2;
    const runs = lineRuns(line);
    const lw = lineWidth(line, size);
    let x = opts.align === "center" ? Math.max(opts.x0, (W - lw) / 2) : opts.x0;
    runs.forEach((r, ri) => {
      if (ri > 0) x += space;
      const tw = ctx.measureText(r.text).width;
      if (r.emph && opts.emphStyle === "box") {
        clearShadow(ctx);
        ctx.fillStyle = RED;
        roundRectPath(ctx, x, cy - boxH / 2, tw + padX * 2, boxH, size * 0.14);
        ctx.fill();
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(r.text, x + padX, cy);
        x += tw + padX * 2;
      } else {
        setWhiteShadow(ctx, H);
        ctx.fillText(r.text, x, cy);
        if (r.emph && opts.emphStyle === "strike") {
          clearShadow(ctx);
          ctx.strokeStyle = RED;
          ctx.lineWidth = Math.max(3, size * 0.1);
          ctx.beginPath();
          ctx.moveTo(x, cy);
          ctx.lineTo(x + tw, cy);
          ctx.stroke();
        }
        x += tw;
      }
    });
  });
}
