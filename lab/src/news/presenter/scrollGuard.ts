/**
 * Which scrolls of a teleprompter are the USER's (2026-10-07, Jake: "Sometimes
 * when I go to the next slide I am still brought to the bottom of the script
 * of the next slide").
 *
 * ⚠️ A SCROLL EVENT IS NOT A USER SCROLL. Every screen publishes its scrolls
 * as seeks that move the whole room, and it used to publish ANY scroll that
 * was not its own write. On a slide change three things scroll the element
 * without anyone touching it, all of them on the NEW script:
 *   · the layout CLAMP — scrolled to the bottom of a long script, the shorter
 *     next one cannot be that far down, so the browser clamps scrollTop to the
 *     new bottom and fires a scroll event (before the screen's own reset when
 *     the change came from the room, i.e. on every follower and every second
 *     screen) → "new script at fraction 1.0" went out to everyone;
 *   · a trackpad / touch FLING that began on the old script keeps scrolling
 *     the new one for a second or two;
 *   · a re-layout (font size, width, a script edited mid-show).
 * So a scroll is published only when a gesture STARTED after the last slide
 * change: a fresh wheel burst (a gap of WHEEL_GAP_MS since the last wheel
 * event — a fling's momentum events come back to back), a touch, a press on
 * the scroller (its scrollbar) or a key in it. Anything else is not
 * published, and for SETTLE_MS after a change the screen is put back where
 * the room is. A wheel burst that began on the old script is cancelled on the
 * new one (preventDefault), so the flick cannot move this screen either.
 *
 * The follower page (server followerPage.ts) carries the same rules inline.
 */
import { useEffect, useRef } from 'react';

/** A wheel event this long after the previous one starts a new gesture. */
export const WHEEL_GAP_MS = 200;
/** After a slide change, a scroll nobody started is undone for this long. */
export const SETTLE_MS = 1500;

export interface ScrollGuard {
  /** A new script is on screen: whatever is still moving belongs to the old one. */
  markNav(): void;
  /** The scroll happening now was started by the user after the last slide change. */
  userScrolling(): boolean;
  /** Milliseconds since the last slide change. */
  sinceNav(): number;
  dispose(): void;
}

export function guardScroll(el: HTMLElement): ScrollGuard {
  // A counter, not timestamps: the key that changes the slide and its keydown land in the same millisecond.
  let seq = 0;
  let gestureSeq = 0;
  let navSeq = 0;
  let navAt = -Infinity;
  let lastWheelAt = -Infinity;
  let lastTouchAt = -Infinity;
  const now = () => performance.now();
  const gesture = () => { gestureSeq = ++seq; };

  const onWheel = (e: WheelEvent) => {
    const t = now();
    if (t - lastWheelAt > WHEEL_GAP_MS) gesture();
    lastWheelAt = t;
    // A flick that began on the previous script never scrolls this one.
    if (gestureSeq < navSeq) e.preventDefault();
  };
  const onTouch = () => { lastTouchAt = now(); gesture(); };
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('touchstart', onTouch, { passive: true });
  // A press on the scrollbar (a mouse cannot drag the text itself), or a touch/pen press.
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.clientX >= el.getBoundingClientRect().left + el.clientWidth) gesture();
  };
  el.addEventListener('pointerdown', onPointer);
  el.addEventListener('keydown', gesture);

  return {
    markNav() {
      navSeq = ++seq;
      navAt = now();
      // A touch fling (phone / iPad) does not send events while it coasts; cutting the
      // overflow for a frame is the one thing that stops it.
      if (now() - lastTouchAt < 3000) {
        const prev = el.style.overflowY;
        el.style.overflowY = 'hidden';
        requestAnimationFrame(() => { el.style.overflowY = prev; });
      }
    },
    userScrolling: () => gestureSeq > navSeq,
    sinceNav: () => now() - navAt,
    dispose() {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouch);
      el.removeEventListener('pointerdown', onPointer);
      el.removeEventListener('keydown', gesture);
    },
  };
}

/**
 * The guard for a scroller that mounts and unmounts (the teleprompter view is
 * swapped for the notes view). `deps` must change whenever the element might
 * have been replaced. The returned object is stable; with no element it lets
 * nothing through.
 */
export function useScrollGuard(ref: { current: HTMLElement | null }, deps: unknown[]): ScrollGuard {
  const cur = useRef<ScrollGuard | null>(null);
  const api = useRef<ScrollGuard>({
    markNav: () => cur.current?.markNav(),
    userScrolling: () => cur.current?.userScrolling() ?? false,
    sinceNav: () => cur.current?.sinceNav() ?? Infinity,
    dispose: () => {},
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const g = guardScroll(el);
    cur.current = g;
    return () => { g.dispose(); if (cur.current === g) cur.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return api.current;
}
