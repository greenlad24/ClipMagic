/**
 * Where to press → in the script (Daily Show stages, 2026-10-06).
 *
 * The stage build copies a few words of the script per beat (`cues`). The
 * presenter's teleprompter marks them so Jake can see where the next beat
 * goes — COLOUR AND UNDERLINE ONLY. The script must wrap exactly as it does on
 * the follower page and the standalone teleprompter (three renderers that
 * agree to the pixel), so nothing here may add a glyph, change a weight or
 * touch spacing; spans start and end on word boundaries.
 *
 * BEAT TITLES (Jake, 2026-10-07): each upcoming cue carries its beat's title
 * as a TAG — an absolutely positioned child of the cue span, lifted into the
 * gap above the cue's line. Out of flow, so it adds no glyph to the line and
 * moves no line break (measured: identical line tops with and without tags).
 * The follower page draws the SAME tag with the same rules (followerPage.ts
 * `.cue-tag`), from the same marks (cueMarks.ts). The story's LAST cue is in
 * its own colour (CUE_COLOR.last).
 */
import type { CSSProperties, ReactNode } from 'react';

export type { CueSpan } from './cueFind';
export { cueRegex, placeCue, cueSearchStart, findCues } from './cueFind';
import type { CueMark } from './cueMarks';
import { CUE_COLOR } from './cueMarks';

const UNDER = { textDecorationLine: 'underline', textUnderlineOffset: '0.18em' } as const;
const SPAN: Record<'next' | 'later' | 'nextLast' | 'laterLast', CSSProperties> = {
  next: { ...UNDER, color: CUE_COLOR.next, textDecorationColor: CUE_COLOR.next },
  later: { ...UNDER, textDecorationStyle: 'dotted', textDecorationColor: 'rgba(255,255,255,0.35)' },
  nextLast: { ...UNDER, color: CUE_COLOR.last, textDecorationColor: CUE_COLOR.last },
  laterLast: { ...UNDER, textDecorationStyle: 'dotted', textDecorationColor: 'rgba(255,90,78,0.75)' },
};

/**
 * ⚠️ THE TAG MUST STAY OUT OF FLOW — and match followerPage.ts `.cue-tag`.
 * `position: absolute` inside the (position: relative) cue span, so it adds
 * nothing to the line. fitCueTags() then places it (see there): in the
 * margin LEFT of the script, level with the cue's line, when the screen has
 * that margin; else just above the cue's first word.
 */
const TAG_BASE: CSSProperties = {
  position: 'absolute', left: 0, top: 0,
  fontFamily: "'NewsScript', Arial, Helvetica, sans-serif", lineHeight: 1.25,
  fontWeight: 700, letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis',
  padding: '2px 7px', borderRadius: 4, pointerEvents: 'none', userSelect: 'none',
  background: 'rgba(8,8,8,0.85)', border: '1px solid transparent',
};
const TAG: Record<keyof typeof SPAN, CSSProperties> = {
  next: { ...TAG_BASE, color: CUE_COLOR.next, borderColor: 'rgba(255,210,30,0.45)' },
  later: { ...TAG_BASE, color: 'rgba(255,255,255,0.5)' },
  nextLast: { ...TAG_BASE, color: '#1a0605', background: CUE_COLOR.last, borderColor: CUE_COLOR.last },
  // The LAST beat's title is ALWAYS a solid coral block (Jake: "the last beat title should be in a different color").
  laterLast: { ...TAG_BASE, color: '#1a0605', background: 'rgba(255,90,78,0.78)', borderColor: CUE_COLOR.last },
};

/**
 * One paragraph of the script with its upcoming cues marked and titled.
 * `offset` = where the paragraph starts in the whole script; `beat` = the
 * story beat on screen now (cues at or before it are no longer marked).
 */
export function markCues(para: string, offset: number, marks: CueMark[], beat: number): ReactNode {
  const mine = marks.filter((s) => s.end > offset && s.start < offset + para.length && s.beat > beat);
  if (!mine.length) return para;
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of mine) {
    const a = Math.max(0, s.start - offset), b = Math.min(para.length, s.end - offset);
    if (a < at) continue;
    if (a > at) out.push(para.slice(at, a));
    const kind = ((s.beat === beat + 1 ? 'next' : 'later') + (s.last ? 'Last' : '')) as keyof typeof SPAN;
    out.push(
      <span key={s.start} data-cue={s.beat} data-cue-last={s.last ? '' : undefined} style={{ ...SPAN[kind], position: 'relative' }}>
        {/* The title, once — on the paragraph where the cue starts. */}
        {s.start >= offset && <span data-cue-tag style={TAG[kind]}>{s.tag}</span>}
        {para.slice(a, b)}
      </span>,
    );
    at = b;
  }
  if (at < para.length) out.push(para.slice(at));
  return out;
}

/**
 * Place every cue's title tag. Moves tags only — never text (they are out of
 * flow), so this cannot change a line break. The follower page runs the same
 * steps (followerPage.ts `fitTags`); keep the two in step.
 *   · GUTTER — when there are ≥ 170 px left of the script's text (a monitor):
 *     the tag sits in that margin, right-aligned against the text, vertically
 *     centred on the cue's first line, wrapping onto a second line if long.
 *     Tags that would overlap stack downwards.
 *   · ABOVE — no margin (a phone, or a wide column on a small screen): a
 *     one-line tag in the gap just above the cue's first word, ellipsised to
 *     the column's width and pulled left if it would run past the right edge.
 * Works mirrored too (the column is scaleX(-1) then: positions are computed in
 * the column's own, unmirrored coordinates).
 */
export function fitCueTags(col: HTMLElement | null): void {
  if (!col) return;
  const cs = getComputedStyle(col);
  const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  const colW = col.offsetWidth;
  const mirrored = /^matrix\(-1/.test(cs.transform);
  const cr = col.getBoundingClientRect();
  const pr = (col.parentElement ?? col).getBoundingClientRect();
  // Free space left of the text, in the column's own coordinates.
  const room = (mirrored ? pr.right - cr.right : cr.left - pr.left) + padL;
  const gutter = room >= 170;
  let lastBottom = -Infinity;
  col.querySelectorAll<HTMLElement>('[data-cue-tag]').forEach((tag) => {
    const fr = tag.parentElement?.getClientRects()[0];
    if (!fr) return;
    const cueLeft = mirrored ? cr.right - fr.right : fr.left - cr.left;
    const st = tag.style;
    if (gutter) {
      st.whiteSpace = 'normal'; st.textAlign = 'right'; st.fontSize = 'max(13px, 0.42em)'; st.padding = '2px 7px'; st.lineHeight = '1.25';
      st.maxWidth = `${Math.min(300, room - 28)}px`; st.width = 'max-content';
      const tw = tag.offsetWidth, th = tag.offsetHeight;
      let top = (fr.height - th) / 2;
      let y = fr.top - cr.top + top;
      if (y < lastBottom + 4) { top += lastBottom + 4 - y; y = lastBottom + 4; }
      lastBottom = y + th;
      st.left = `${-(cueLeft - padL) - tw - 14}px`;
      st.top = `${top}px`;
    } else {
      // Slimmer here: it shares the gap between two lines.
      st.whiteSpace = 'nowrap'; st.textAlign = 'left'; st.fontSize = 'max(11px, 0.36em)'; st.padding = '0 6px'; st.lineHeight = '1.15';
      st.maxWidth = `${Math.max(40, colW - padL - padR)}px`; st.width = '';
      const tw = tag.offsetWidth, th = tag.offsetHeight;
      const over = cueLeft + tw - (colW - padR);
      st.left = `${over > 0 ? -over : 0}px`;
      st.top = `${-th - 2}px`;
    }
  });
}
