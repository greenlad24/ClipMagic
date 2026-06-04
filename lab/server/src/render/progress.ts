/**
 * Progress banding for the render pipeline.
 *
 * A `manifest` job can have two phases: the main caption ffmpeg render, then an
 * optional post-render Remotion stage (motion graphics / emphasis stickers) that
 * renders N clips in headless Chromium and re-encodes the whole video to
 * composite them. The post-render stage used to run with NO progress updates, so
 * the bar hit 100% during the main render and then SAT there for minutes while
 * the slowest part finished.
 *
 * The fix: when a job has post-render work, reserve the tail of the bar for it.
 * The main render drives a sub-band ([0, MAIN_BAND_END]); the post-render stage
 * drives the remainder ([MAIN_BAND_END, 1]). The bar only reaches 1.0 when the
 * final output is actually done. With no post-render work, the main render owns
 * the whole bar (0 → 1) exactly as before.
 */

/**
 * Where the main caption render's band ends when a post-render stage follows.
 * The remaining [MAIN_BAND_END, 1] is reserved for the sticker/motion stage
 * (per-clip Remotion renders + the final composite re-encode), which is the
 * slow part that previously showed no progress.
 */
export const MAIN_BAND_END = 0.55;

/** Clamp a value into [0, 1]. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Map a sub-fraction (0..1) into the band [lo, hi]. Both inputs and the band are
 * clamped so the result never escapes [0, 1] and is monotonic in `frac`.
 */
export function bandFraction(frac: number, lo: number, hi: number): number {
  const l = clamp01(lo);
  const h = clamp01(hi);
  return clamp01(l + (h - l) * clamp01(frac));
}

/**
 * Map the MAIN render's 0..1 progress onto the job bar. With post-render work it
 * scales into [0, MAIN_BAND_END]; otherwise it owns the whole bar [0, 1].
 */
export function mainRenderProgress(frac: number, hasPostRender: boolean): number {
  return bandFraction(frac, 0, hasPostRender ? MAIN_BAND_END : 1);
}

/**
 * Map a post-render STAGE's 0..1 progress onto the job bar's reserved tail
 * [MAIN_BAND_END, 1]. Only the final composite completing (frac → 1) reaches 1.0.
 */
export function stageProgress(frac: number): number {
  return bandFraction(frac, MAIN_BAND_END, 1);
}

/**
 * Combine per-clip render progress and the final-composite progress into a
 * single 0..1 stage fraction. The first `renderShare` of the stage is the N
 * Remotion clip renders; the remainder is the composite re-encode. Used by the
 * sticker/motion stages so "rendering clips" and "compositing" feel continuous.
 */
export const STAGE_RENDER_SHARE = 0.6;

export function stageFraction(opts: {
  /** Clips rendered so far (Remotion phase). */
  rendered: number;
  /** Total clips to render. */
  total: number;
  /** Composite re-encode progress 0..1 (0 until it starts). */
  composite: number;
  /** Fraction of the stage given to the render phase (rest is composite). */
  renderShare?: number;
}): number {
  const share = opts.renderShare ?? STAGE_RENDER_SHARE;
  const renderFrac = opts.total > 0 ? clamp01(opts.rendered / opts.total) : 1;
  return clamp01(renderFrac * share + clamp01(opts.composite) * (1 - share));
}
