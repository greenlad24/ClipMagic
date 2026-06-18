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
   * The rectangle (as fractions of W,H) the headline must fit inside. The text
   * size is MEASURED to fit this box (width + height) — so the copy fills, but
   * never overflows, its allotted space.
   */
  textBox: { x: number; y: number; w: number; h: number };
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
    textBox: { x: 0.04, y: 0.74, w: 0.92, h: 0.22 },
    backgroundName: "Open Space Office With Green",
  },
  {
    id: "left-stack",
    label: "Left stack",
    charPlacement: "right",
    textArea: "the LEFT half of the frame",
    copyHint: "a SHORT hook (1–2 words) then a SHORT follow-up (1–2 words); the hook is the red-box emphasis (e.g. \"#1 MISTAKE\" + \"Everyone Makes\" → \"#1 MISTAKE\")",
    textBox: { x: 0.05, y: 0.12, w: 0.46, h: 0.76 },
    backgroundName: "Black",
  },
  {
    id: "top-strike",
    label: "Top strikethrough",
    charPlacement: "center",
    textArea: "the TOP strip (upper ~18% of the frame)",
    copyHint: "a SHORT 2–3 word phrase where ONE word is 'crossed out' for effect; that word is the emphasis (e.g. \"NEW CUSTOMERS\" → \"CUSTOMERS\")",
    textBox: { x: 0.04, y: 0.05, w: 0.92, h: 0.17 },
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
  sizeScale = 1,
  offsetY = 0,
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
    // The headline is MEASURED to fit the template's text box (width + height),
    // then the user's sizeScale (UI slider, default 1) nudges it.
    const box = {
      x: template.textBox.x * W,
      y: template.textBox.y * H,
      w: template.textBox.w * W,
      h: template.textBox.h * H,
    };
    drawWrapped(ctx, family, upperText, upperEmph, {
      box,
      align: template.id === "left-stack" ? "left" : "center",
      emphStyle: template.id === "top-strike" ? "strike" : "box",
      sizeScale,
      offsetY,
    });

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

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface WrapOpts {
  box: Box;
  align: "left" | "center";
  emphStyle: "box" | "strike";
  /** User multiplier on the fitted size (UI slider; 1 = fit the box). */
  sizeScale?: number;
  /** Vertical nudge as a fraction of frame height (UI slider; +down, −up, 0 = centred). */
  offsetY?: number;
}

/** A line's rendered width at `size`, including inter-run spaces + emphasis box pad. */
function measuredLineWidth(
  measureAt: (text: string, size: number) => number,
  line: Word[],
  size: number,
  emphBox: boolean,
): number {
  const runs = lineRuns(line);
  const space = measureAt(" ", size);
  const padX = Math.round(size * 0.16);
  let w = 0;
  runs.forEach((r, i) => {
    if (i > 0) w += space;
    w += measureAt(r.text, size) + (r.emph && emphBox ? padX * 2 : 0);
  });
  return w;
}

/**
 * Largest font size whose wrapped lines all FIT the box (width + total height).
 * `measureAt(text,size)` returns the rendered width at that size. Pure + exported
 * so the box-fit contract is unit-tested without a canvas.
 */
export function fitFontToBox(
  measureAt: (text: string, size: number) => number,
  words: Word[],
  boxW: number,
  boxH: number,
  emphBox: boolean,
): { size: number; lines: Word[][] } {
  // A single line can't be taller than the box → that bounds the start size.
  let size = Math.max(10, Math.floor(boxH / 1.18));
  let lines = wrapWords((s) => measureAt(s, size), words, boxW);
  while (size > 10) {
    lines = wrapWords((s) => measureAt(s, size), words, boxW);
    const blockH = lines.length * (size * 1.18) + (lines.length - 1) * (size * 0.3);
    const widthOk = lines.every((ln) => measuredLineWidth(measureAt, ln, size, emphBox) <= boxW);
    if (widthOk && blockH <= boxH) break;
    size -= Math.max(2, Math.round(size * 0.06));
  }
  return { size, lines };
}

/**
 * The unified headline renderer for all three templates: MEASURE the copy to fit
 * the template's text box (so it never overflows its space), apply the user's
 * size slider, then word-wrap in natural order and highlight the emphasis run(s)
 * IN PLACE — a red box (or strikethrough) exactly where the emphasis word(s) fall.
 */
function drawWrapped(ctx: any, family: string, text: string, emphasis: string, opts: WrapOpts): void {
  const words = toWords(text, emphasis);
  if (words.length === 0) return;
  const emphBox = opts.emphStyle === "box";
  const measureAt = (s: string, size: number): number => {
    ctx.font = `${size}px "${family}"`;
    return ctx.measureText(s).width;
  };

  // Fit to the box, then nudge by the user's slider (clamped so it stays sane).
  const fit = fitFontToBox(measureAt, words, opts.box.w, opts.box.h, emphBox);
  const scale = Math.min(2, Math.max(0.4, opts.sizeScale ?? 1));
  const size = Math.max(10, Math.round(fit.size * scale));
  ctx.font = `${size}px "${family}"`;
  const lines = wrapWords((s) => measureAt(s, size), words, opts.box.w);

  const padX = Math.round(size * 0.16);
  const lineH = size * 1.18;
  const lineGap = size * 0.3;
  const blockH = lines.length * lineH + (lines.length - 1) * lineGap;
  // The drop shadow scales with the render height (see setWhiteShadow).
  const frameH = ctx.canvas?.height ?? 1080;
  // Vertically centre the block within the box, then apply the user's up/down nudge
  // (a fraction of frame height); keep the block fully on-canvas.
  const centred = opts.box.y + (opts.box.h - blockH) / 2;
  const nudged = centred + (opts.offsetY ?? 0) * frameH;
  const yTop = Math.max(0, Math.min(nudged, frameH - blockH));
  const space = measureAt(" ", size);

  lines.forEach((line, li) => {
    const cy = yTop + li * (lineH + lineGap) + lineH / 2;
    const runs = lineRuns(line);
    const lw = measuredLineWidth(measureAt, line, size, emphBox);
    let x = opts.align === "center" ? opts.box.x + Math.max(0, (opts.box.w - lw) / 2) : opts.box.x;
    runs.forEach((r, ri) => {
      if (ri > 0) x += space;
      const tw = measureAt(r.text, size);
      if (r.emph && emphBox) {
        clearShadow(ctx);
        ctx.fillStyle = RED;
        roundRectPath(ctx, x, cy - lineH / 2, tw + padX * 2, lineH, size * 0.14);
        ctx.fill();
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(r.text, x + padX, cy);
        x += tw + padX * 2;
      } else {
        setWhiteShadow(ctx, frameH);
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
