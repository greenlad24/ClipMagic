/**
 * The SOURCE beat's scroll — Jake scrolls the captured page himself (Jake,
 * 2026-10-07: "instead of auto scrolling — let me scroll my self — I love that
 * it's an image and nothing pops up").
 *
 * WHERE: `y` = the fraction of the IMAGE's height at the screen's top edge
 * (0 = the top of the page). A fraction of the page — not pixels, not a
 * fraction of "how far it can scroll" — so every screen shows the same line of
 * the page at its top whatever its size; each clamps to its own bottom.
 *
 * INPUTS:
 *   - Screen window (the audience view): mouse wheel / trackpad, drag, ↑/↓.
 *   - Presenter (NotesPage): Shift+↓ / Shift+↑ (a third of a screen; plain ↑/↓
 *     still nudge the teleprompter, ←/→ PageUp/PageDown still step beats,
 *     Shift alone still toggles the video), and the mini-map on the right edge
 *     while the source is on screen (wheel over it, click / drag on it).
 * SYNC: socket event `source-scroll {idx, y}` (server liveSync.ts) — its own
 * event like `beat`, never the teleprompter's anchor or tpRevision; the
 * presenter relays it to a same-browser Display tab (BroadcastChannel `src`).
 * Reset to the top on every new story (server resets on slide change; every
 * screen keys the value by its story index).
 */
import type { SourceShot } from './story';

/** The show screens are 16:9: screen height ÷ width. */
export const SHOW_ASPECT = 9 / 16;

/** The furthest `y` can go on a screen of this shape (height ÷ width): the page's bottom at the screen's bottom. */
export function maxSrcY(shot: Pick<SourceShot, 'w' | 'h'>, aspect = SHOW_ASPECT): number {
  if (!(shot.w > 0) || !(shot.h > 0)) return 0;
  return Math.max(0, 1 - (aspect * shot.w) / shot.h);
}

export const clampSrcY = (y: number, shot: Pick<SourceShot, 'w' | 'h'>, aspect = SHOW_ASPECT): number =>
  Math.max(0, Math.min(maxSrcY(shot, aspect), Number.isFinite(y) ? y : 0));

/** A wheel event's distance in px (lines and pages converted). */
export const srcWheelPx = (e: WheelEvent, pageH: number): number =>
  e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? pageH : 1);

/** One Shift+↓ / ↓ step: a third of a 16:9 screen, as a fraction of the page. */
export const srcStep = (shot: Pick<SourceShot, 'w' | 'h'>, aspect = SHOW_ASPECT): number =>
  shot.h > 0 ? ((aspect * shot.w) / shot.h) / 3 : 0;
