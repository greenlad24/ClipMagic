/**
 * Fit text to its box — shared by the Deep Dive (both formats) and the AI News
 * story screens (Jake, 2026-10-06: "make sure there's not so much text in each
 * box and that no text is going outside the box").
 *
 * HOW IT WORKS. Every font size on these screens is `calc(var(--u) * N * var(--fit, 1))`
 * (show.css, deepdive.css, story.css), so one number on a box scales all the
 * text inside it while the box itself (its size, padding, gaps) stays put.
 * For each target box this measures whether its content fits (scrollWidth /
 * scrollHeight against the box), and if not, binary-searches the largest
 * `--fit` in [min, 1] that does. Nested targets multiply (an inner box starts
 * from the factor it inherited), and they are fitted outer → inner.
 *
 * LAST RESORT, never a spill: if the text still doesn't fit at the minimum
 * size, the tallest text block in the box is clamped to the lines that fit
 * (ellipsis); a word wider than its box breaks (`overflow-wrap: anywhere`
 * on the text boxes in CSS — switched off while measuring, `[data-fitting]`,
 * so a long word shrinks the text first instead of being chopped).
 *
 * WHEN. On mount and whenever `deps` change (beat, content), when web fonts
 * finish loading (a template's font arriving changes every width), on resize
 * of the root (stage ↔ thumbnail), and once more after the entrance
 * animations settle — a box measured mid-animation re-fits from scratch.
 */
import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';

export interface FitTarget {
  /** The box that gets `--fit` (matched inside the root, root included). */
  sel: string;
  /** The boxes that must fit (default: the target itself) — e.g. every card of a row, so the row shares one size. */
  items?: string;
  /** Instead: the box that must fit is this ancestor (e.g. a headline is scaled, but it's the title column that must fit). */
  within?: string;
  /** Fit after every other box (a fallback that scales a whole column only if its headline couldn't make room). */
  last?: boolean;
  /** 'y': only height counts for the box itself (its decoration bleeds sideways by design); long words still count. */
  axis?: 'y';
  /**
   * Smallest EFFECTIVE factor (default 0.85) — inherited factors count, so a
   * card inside a shrunk body never compounds below it. Jake 2026-10-06: "I
   * want the text to be readable and big" — shrinking is a small final nudge;
   * the room comes from layout and shorter generated text.
   */
  min?: number;
}

const CLAMPED = 'data-fit-clamp';
const TOL = 1;

function overflows(el: HTMLElement): { w: number; h: number } {
  let h = el.scrollHeight - el.clientHeight;
  // A content-sized box with a max-height (a heading's line budget) is only
  // too tall past that budget — not because an italic accent's glyphs poke a
  // few pixels out of a tight line-height.
  const mh = parseFloat(getComputedStyle(el).maxHeight);
  if (Number.isFinite(mh) && el.clientHeight < mh - 1) h = el.scrollHeight - mh;
  return { w: el.scrollWidth - el.clientWidth, h };
}

/** A word wider than its own text block — even when it only pokes into the box's padding. */
function wideWord(box: HTMLElement): boolean {
  for (const el of box.querySelectorAll<HTMLElement>('*')) {
    if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + TOL) continue;
    const cs = getComputedStyle(el);
    // a text block, or a box its text spills out of (a count-up's inline-grid
    // in a card's number) — not a clipping frame like a demo's screen
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
    if (!own && (cs.overflowX !== 'visible' || !el.textContent?.trim())) continue;
    // a box holding a picture: a tilted screenshot frame pokes out a few px by design
    if (!own && el.querySelector('img, video, iframe, canvas')) continue;
    if (cs.textOverflow === 'ellipsis' || cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') continue;
    return true;
  }
  return false;
}

function fitsAll(items: HTMLElement[], axis?: 'y'): boolean {
  for (const el of items) {
    if (!el.isConnected || el.clientWidth === 0) continue;
    const o = overflows(el);
    if ((o.w > TOL && axis !== 'y') || o.h > TOL || wideWord(el)) return false;
  }
  return true;
}

const lineHeight = (el: HTMLElement): number => {
  const cs = getComputedStyle(el);
  return cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
};

/**
 * The text blocks of a box that may be clamped: two lines or more, smallest
 * type first — the fine print gives way before a headline or a number (a
 * clamped "$10…" would say the wrong price).
 */
function clampable(box: HTMLElement): HTMLElement[] {
  const out: { el: HTMLElement; fs: number }[] = [];
  const own = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
  for (const el of [box, ...box.querySelectorAll<HTMLElement>('*')]) {
    if (!own(el) || el.hasAttribute(CLAMPED)) continue;
    const d = getComputedStyle(el).display;
    if (d === 'inline' || d === 'contents' || d === 'none' || d.includes('grid') || d.includes('flex')) continue;
    if (getComputedStyle(el).whiteSpace === 'nowrap') continue;
    if (el.getBoundingClientRect().height < lineHeight(el) * 1.8) continue;
    // never a counted number (sized count-up: the cells of an inline-grid)
    if (el.parentElement && getComputedStyle(el.parentElement).display === 'inline-grid') continue;
    out.push({ el, fs: parseFloat(getComputedStyle(el).fontSize) });
  }
  return out.sort((a, b) => a.fs - b.fs).map((x) => x.el);
}

function clampToFit(item: HTMLElement): void {
  for (let pass = 0; pass < 4; pass++) {
    const o = overflows(item);
    if (o.h <= TOL) return;
    const el = clampable(item)[0];
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    const lines = Math.max(1, Math.floor((h - o.h) / Math.max(1, lineHeight(el))));
    el.setAttribute(CLAMPED, '');
    Object.assign(el.style, { display: '-webkit-box', webkitBoxOrient: 'vertical', webkitLineClamp: String(lines), overflow: 'hidden' });
  }
}

function unclamp(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>(`[${CLAMPED}]`)) {
    el.removeAttribute(CLAMPED);
    for (const p of ['display', '-webkit-box-orient', '-webkit-line-clamp', 'overflow']) el.style.removeProperty(p);
  }
}

const inherited = (el: HTMLElement): number => {
  const v = el.parentElement ? parseFloat(getComputedStyle(el.parentElement).getPropertyValue('--fit')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 1;
};

/** Fit every target inside `root`, now. Cheap when everything already fits (one measure per box). */
export function fitText(root: HTMLElement | null, targets: FitTarget[]): void {
  if (!root || !root.isConnected || root.clientWidth === 0) return;
  unclamp(root);
  const boxes: { el: HTMLElement; t: FitTarget }[] = [];
  for (const t of targets) {
    const found = [...(root.matches(t.sel) ? [root] : []), ...root.querySelectorAll<HTMLElement>(t.sel)];
    for (const el of found) boxes.push({ el, t });
  }
  // outer → inner: document order puts an ancestor before its descendants
  boxes.sort((a, b) => (+!!a.t.last - +!!b.t.last) || (a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const b of boxes) b.el.style.removeProperty('--fit');
  for (const { el, t } of boxes) {
    const up = t.within ? el.parentElement?.closest<HTMLElement>(t.within) : null;
    const items = up ? [up] : t.items ? [...el.querySelectorAll<HTMLElement>(t.items)] : [el];
    if (!items.length) continue;
    el.setAttribute('data-fitting', '');
    const base = inherited(el);
    if (!fitsAll(items, t.axis)) {
      const floor = Math.min(1, (t.min ?? 0.85) / base);
      let lo = floor, hi = 1, best = floor;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        el.style.setProperty('--fit', String(+(base * mid).toFixed(4)));
        if (fitsAll(items, t.axis)) { best = mid; lo = mid; } else hi = mid;
      }
      // a hair of slack: the measured fit is exact, and real wrapping (overflow-wrap: anywhere) is less forgiving
      el.style.setProperty('--fit', String(+(base * Math.max(floor, best * 0.97)).toFixed(4)));
    }
    el.removeAttribute('data-fitting');
    for (const it of items) if (it.clientWidth > 0 && overflows(it).h > TOL) clampToFit(it);
  }
}

/**
 * Keep the text inside `ref` fitted (see the top of this file). `deps` = what
 * changes the text or the layout (beat, chapter, template…).
 */
export function useFitText(ref: RefObject<HTMLElement>, targets: FitTarget[], deps: DependencyList): void {
  const tRef = useRef(targets);
  tRef.current = targets;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let raf = 0;
    const run = () => fitText(ref.current, tRef.current);
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(run); };
    run();
    const timers = [setTimeout(run, 350), setTimeout(run, 1300)];
    let lastW = root.clientWidth, lastH = root.clientHeight;
    const ro = new ResizeObserver(() => {
      if (root.clientWidth === lastW && root.clientHeight === lastH) return;
      lastW = root.clientWidth; lastH = root.clientHeight;
      soon();
    });
    ro.observe(root);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    let live = true;
    fonts?.ready.then(() => { if (live) soon(); });
    fonts?.addEventListener?.('loadingdone', soon);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      ro.disconnect();
      fonts?.removeEventListener?.('loadingdone', soon);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * A count-up number that never changes its box while it counts: the final
 * value is laid out (invisible) under the live one, so the box is measured —
 * and fitted — at its real width from the first frame.
 */
export const sizedStyle = { display: 'inline-grid' } as const;
export const ghostStyle = { gridArea: '1 / 1', visibility: 'hidden' } as const;
export const liveStyle = { gridArea: '1 / 1' } as const;
