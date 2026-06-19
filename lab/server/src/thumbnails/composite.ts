/**
 * PROGRAMMATIC compositing for the contrarian-originals workflow.
 *
 * The character must be the EXACT uploaded pixels — never re-drawn, warped or
 * "cut" by an image model. So instead of asking Nano Banana to compose the
 * character onto the background, we do it deterministically here:
 *
 *   1. CUT OUT the person from their saved photo (background removal → a
 *      transparent PNG). Content-addressed cache so it runs once per photo.
 *   2. From the cut-out's ALPHA silhouette, locate the HEAD: scan row widths,
 *      find the head bulge then the NECK (the narrowing before the shoulders).
 *   3. SCALE the cut-out so the head fills ≥70% of the frame HEIGHT (the spec),
 *      anchor it near the top, and position it left/centre/right per template.
 *   4. Draw the saved background (cover-fit) then the scaled cut-out on top.
 *
 * The result is a clean 16:9 image with the character's real pixels intact; the
 * styled headline is drawn afterwards by textOverlay.ts. Steps 2–3 are PURE +
 * exported (unit-tested without a canvas). The canvas + background-removal are
 * optional/best-effort: if @napi-rs/canvas or @imgly/background-removal-node
 * aren't available (or anything throws), compositeContrarian returns null and the
 * caller falls back to the AI compose so a thumbnail still finishes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

export type Placement = "left" | "center" | "right";

/** Horizontal extent of the silhouette on one image row. */
export interface RowSpan {
  row: number;
  l: number;
  r: number;
  width: number;
}

/**
 * Per-row left/right extent of the non-transparent silhouette. `alpha` is a
 * width*height array of 0..255 alpha values (row-major). Only rows that contain
 * any opaque pixel are returned, top-to-bottom. Pure + exported.
 */
export function rowSpans(alpha: ArrayLike<number>, w: number, h: number, threshold = 16): RowSpan[] {
  const spans: RowSpan[] = [];
  for (let y = 0; y < h; y++) {
    let l = -1;
    let r = -1;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[base + x] >= threshold) {
        if (l < 0) l = x;
        r = x;
      }
    }
    if (l >= 0) spans.push({ row: y, l, r, width: r - l + 1 });
  }
  return spans;
}

export interface HeadBox {
  headTopRow: number;
  headBottomRow: number;
  headCenterX: number;
}

/**
 * Locate the HEAD region from the silhouette row-spans. The head is at the top;
 * its width rises to a max (skull/cheeks) then narrows at the NECK before the
 * shoulders widen again. We take the head as [top .. neck]; if there's no clear
 * neck (a tight head-only crop) the whole silhouette is the head. Pure + exported.
 */
export function detectHead(spans: RowSpan[]): HeadBox {
  if (spans.length === 0) return { headTopRow: 0, headBottomRow: 0, headCenterX: 0 };
  const top = spans[0].row;
  const bottom = spans[spans.length - 1].row;
  const w = (i: number) => spans[i].width;

  // The shoulders are usually WIDER than the head, so the head is NOT the global
  // max — it's the FIRST bulge from the top. Climb the rising/flat plateau to the
  // first PEAK (the head's widest point: cheeks/ears)...
  let peak = 0;
  while (peak + 1 < spans.length && w(peak + 1) >= w(peak)) peak++;
  // ...then descend to the first VALLEY (the narrowest row: the neck).
  let valley = peak;
  while (valley + 1 < spans.length && w(valley + 1) <= w(valley)) valley++;

  // Accept the neck only when it's clearly narrower than the head AND the
  // silhouette widens again below it (the shoulders). Otherwise (a tight head-only
  // crop) treat the whole silhouette as head.
  const hasNeck =
    valley > peak && w(valley) <= w(peak) * 0.82 && valley + 1 < spans.length && w(valley + 1) >= w(valley) * 1.1;
  const headBottomRow = hasNeck ? spans[valley].row : bottom;

  const headRows = spans.filter((s) => s.row >= top && s.row <= headBottomRow);
  const headCenterX = headRows.reduce((a, s) => a + (s.l + s.r) / 2, 0) / Math.max(1, headRows.length);
  return { headTopRow: top, headBottomRow, headCenterX };
}

export interface Placed {
  destX: number;
  destY: number;
  drawW: number;
  drawH: number;
  scale: number;
}

/**
 * Compute where + how big to draw the cut-out so the HEAD fills `faceFrac` of the
 * frame height (default 0.72 → ≥70%, per spec), anchored `headTopFrac` down from
 * the top and positioned by `placement`. Pure + exported.
 */
export function computeCharacterPlacement(opts: {
  head: HeadBox;
  cutoutW: number;
  cutoutH: number;
  frameW: number;
  frameH: number;
  placement: Placement;
  faceFrac?: number;
  headTopFrac?: number;
  /** User nudges (UI sliders): fractions of frame W/H, and a zoom multiplier. */
  charOffsetX?: number;
  charOffsetY?: number;
  charZoom?: number;
}): Placed {
  const faceFrac = opts.faceFrac ?? 0.72;
  const topMargin = (opts.headTopFrac ?? 0.05) * opts.frameH;
  const headH = Math.max(1, opts.head.headBottomRow - opts.head.headTopRow + 1);
  const zoom = Math.min(2.2, Math.max(0.4, opts.charZoom ?? 1));
  const scale = ((faceFrac * opts.frameH) / headH) * zoom;
  const drawW = opts.cutoutW * scale;
  const drawH = opts.cutoutH * scale;
  const anchorX =
    opts.placement === "center" ? opts.frameW * 0.5 : opts.placement === "right" ? opts.frameW * 0.7 : opts.frameW * 0.3;
  // Auto-anchor the head, then apply the user's X/Y nudge (fractions of the frame).
  const destX = anchorX - opts.head.headCenterX * scale + (opts.charOffsetX ?? 0) * opts.frameW;
  const destY = topMargin - opts.head.headTopRow * scale + (opts.charOffsetY ?? 0) * opts.frameH;
  return { destX, destY, drawW, drawH, scale };
}

/** The reason a module failed to load (captured for the diagnostics badge). */
let canvasError = "";
let removalError = "";

/** Lazy, optional @napi-rs/canvas loader (indirect specifier; null when absent). */
async function loadCanvas(): Promise<any | null> {
  try {
    const spec = "@napi-rs/canvas";
    return await import(/* @vite-ignore */ spec);
  } catch (e) {
    canvasError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

/** Lazy import of the background-removal module (or null when unavailable). */
async function loadRemoval(): Promise<any | null> {
  try {
    const spec = "@imgly/background-removal-node";
    return await import(/* @vite-ignore */ spec);
  } catch (e) {
    removalError = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export interface CompositeProbe {
  canvas: boolean;
  removal: boolean;
  /** Why the unavailable module failed to load (for the UI badge / debugging). */
  reason?: string;
}

/**
 * Probe whether the PROGRAMMATIC 1:1 composite can actually run here: both the
 * canvas and the background-removal module must import. Surfaced in the UI so the
 * creator can confirm the character is composited from their real pixels (not the
 * AI fallback). Captures the load error so a failure is diagnosable without server
 * logs. Best-effort + cached (the import cost is paid once).
 */
let probeCache: CompositeProbe | null = null;
export async function probeCompositeAvailable(force = false): Promise<CompositeProbe> {
  if (probeCache && !force) return probeCache;
  canvasError = "";
  removalError = "";
  const canvasMod = await loadCanvas();
  const canvas = canvasMod != null;
  const rm = await loadRemoval();
  const fn = rm && (rm.removeBackground ?? rm.default?.removeBackground);
  const removalImports = typeof fn === "function";

  // Importing isn't enough — the model has to actually RUN (it can fail at runtime:
  // missing libgomp1 for onnxruntime, a blocked model download, etc.). Do a real
  // cut-out on a tiny image, with a timeout so the status call never hangs.
  let removal = removalImports;
  let runtimeError = "";
  if (canvas && removalImports) {
    try {
      const c = canvasMod.createCanvas(48, 48);
      const cx = c.getContext("2d");
      cx.fillStyle = "#888888";
      cx.fillRect(0, 0, 48, 48);
      const testPng: Buffer = await c.encode("png");
      const run = (async () => {
        const blob = await fn(testPng, { output: { format: "image/png" } });
        const ab = await blob.arrayBuffer();
        if (!ab || ab.byteLength === 0) throw new Error("removal returned no bytes");
      })();
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timed out loading the removal model")), 12000));
      await Promise.race([run, timeout]);
    } catch (e) {
      removal = false;
      runtimeError = e instanceof Error ? e.message : String(e);
    }
  }

  const reasons = [
    !canvas ? `@napi-rs/canvas: ${canvasError || "not loaded"}` : "",
    !removalImports ? `@imgly/background-removal-node: ${removalError || "loaded but no removeBackground export"}` : "",
    removalImports && runtimeError ? `background-removal runtime: ${runtimeError}` : "",
  ].filter(Boolean);
  probeCache = { canvas, removal, reason: reasons.join("; ") || undefined };
  return probeCache;
}

/** Best-effort background removal via @imgly/background-removal-node → PNG bytes. */
async function removeBackground(bytes: Buffer): Promise<Buffer | null> {
  try {
    const mod: any = await loadRemoval();
    const fn = mod?.removeBackground ?? mod?.default?.removeBackground;
    if (typeof fn !== "function") return null;
    const blob = await fn(bytes, { output: { format: "image/png" } });
    const ab = await blob.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/** Content-addressed cut-out cache dir (one transparent PNG per source photo). */
function cutoutCacheFile(bytes: Buffer): string {
  const key = crypto.createHash("sha1").update(bytes).digest("hex");
  return path.join(config.dataDir, "thumbnail-cutouts", `${key}.png`);
}

/**
 * Cut the character out of their photo (transparent PNG). Cached by content hash
 * so the model runs once per photo. Best-effort: null when removal is unavailable.
 */
export async function cutoutCharacter(bytes: Buffer): Promise<Buffer | null> {
  const file = cutoutCacheFile(bytes);
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file);
  } catch {
    /* fall through to recompute */
  }
  const removed = await removeBackground(bytes);
  if (!removed || removed.length === 0) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, removed);
  } catch {
    /* cache is best-effort */
  }
  return removed;
}

/** Draw `img` to cover the whole WxH frame (scale to fill, centre-crop). */
function drawCover(ctx: any, img: any, W: number, H: number): void {
  const s = Math.max(W / img.width, H / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * Compose the contrarian thumbnail PROGRAMMATICALLY: the saved background
 * (cover-fit) + the EXACT character pixels (cut out, head ≥70% of height, placed
 * per template). Returns 16:9 PNG bytes, or null when canvas/removal is
 * unavailable (the caller then falls back to the AI compose). No headline text
 * here — textOverlay draws it onto the finalized image.
 */
export async function compositeContrarian(opts: {
  backgroundBytes: Buffer;
  characterBytes: Buffer;
  placement: Placement;
  headTopFrac?: number;
  frameW?: number;
  frameH?: number;
  /** User character nudges (UI sliders): fractions of frame W/H + zoom multiplier. */
  charOffsetX?: number;
  charOffsetY?: number;
  charZoom?: number;
}): Promise<Buffer | null> {
  const canvasMod = await loadCanvas();
  if (!canvasMod) return null;
  const cut = await cutoutCharacter(opts.characterBytes);
  if (!cut) return null;
  try {
    const W = opts.frameW ?? 1920;
    const H = opts.frameH ?? 1080;
    const canvas = canvasMod.createCanvas(W, H);
    const ctx = canvas.getContext("2d");

    // Background, cover-fit to a clean 16:9.
    const bg = await canvasMod.loadImage(opts.backgroundBytes);
    drawCover(ctx, bg, W, H);

    // Cut-out → read its alpha → locate the head → size + place it.
    const cutImg = await canvasMod.loadImage(cut);
    const cw = cutImg.width;
    const ch = cutImg.height;
    const probe = canvasMod.createCanvas(cw, ch);
    const pctx = probe.getContext("2d");
    pctx.drawImage(cutImg, 0, 0);
    const rgba = pctx.getImageData(0, 0, cw, ch).data as ArrayLike<number>;
    const alpha = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) alpha[i] = rgba[i * 4 + 3];

    const head = detectHead(rowSpans(alpha, cw, ch));
    const placed = computeCharacterPlacement({
      head,
      cutoutW: cw,
      cutoutH: ch,
      frameW: W,
      frameH: H,
      placement: opts.placement,
      headTopFrac: opts.headTopFrac,
      charOffsetX: opts.charOffsetX,
      charOffsetY: opts.charOffsetY,
      charZoom: opts.charZoom,
    });
    ctx.drawImage(cutImg, placed.destX, placed.destY, placed.drawW, placed.drawH);

    return await canvas.encode("png");
  } catch {
    return null;
  }
}
