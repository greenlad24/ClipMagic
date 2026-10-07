/**
 * The presenter controls BOTH shows share (Jake, 2026-10-07: "these 2
 * presentation types will be delivered in sequence … the UX should be
 * basically the same so there's no confusion for the presenter").
 *
 * LEAVING A STORY / A SECTION TAKES TWO PRESSES. On the last beat of an AI
 * News story or of a Deep Dive section, → (PageDown / a clicker) must be
 * pressed twice within NEXT_WINDOW_MS to go on, so a stray press never jumps
 * the show. The first press arms it (the presenter gets a toast — never the
 * show screen, which is on camera); any other step disarms it. Beats inside a
 * story/section stay single-press, and ← is never guarded.
 */
export const NEXT_WINDOW_MS = 1000;   // Jake: two presses within 1 s

export const ARM_TOAST_ID = 'next-arm';
export const armMessage = (unit: 'story' | 'section'): string =>
  unit === 'story'
    ? 'Last slide of this story — press → twice quickly for the next story'
    : 'Last beat of this section — press → twice quickly for the next section';

export interface LeaveGuard {
  /**
   * A → on the last beat of `where` (a story / section index): true = go on
   * (the second press inside the window), false = this press only armed it.
   */
  press(where: number): boolean;
  /** Any other step: forget a half-done double press. */
  disarm(): void;
}

export function leaveGuard(windowMs = NEXT_WINDOW_MS): LeaveGuard {
  let armed: { where: number; at: number } | null = null;
  return {
    press(where) {
      const now = Date.now();
      if (armed && armed.where === where && now - armed.at <= windowMs) { armed = null; return true; }
      armed = { where, at: now };
      return false;
    },
    disarm() { armed = null; },
  };
}
