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
 * BEAT TITLES (Jake, 2026-10-07) are NOT drawn here: they are the Deep Dive
 * style marker LINES between the script's parts (cueMarks.ts scriptParts +
 * `newsMarkStyle` below). The story's LAST cue is in its own calm violet
 * (CUE_COLOR.last) — "purple and not alarming".
 */
import type { CSSProperties, ReactNode } from 'react';
import { SCRIPT_FONT, D } from '../../presenter/chrome';

export type { CueSpan } from './cueFind';
export { cueRegex, placeCue, cueSearchStart, findCues } from './cueFind';
import type { CueMark } from './cueMarks';
import { CUE_COLOR } from './cueMarks';

const UNDER = { textDecorationLine: 'underline', textUnderlineOffset: '0.18em' } as const;
const SPAN: Record<'next' | 'later' | 'nextLast' | 'laterLast', CSSProperties> = {
  next: { ...UNDER, color: CUE_COLOR.next, textDecorationColor: CUE_COLOR.next },
  later: { ...UNDER, textDecorationStyle: 'dotted', textDecorationColor: 'rgba(255,255,255,0.35)' },
  nextLast: { ...UNDER, color: CUE_COLOR.last, textDecorationColor: CUE_COLOR.last },
  laterLast: { ...UNDER, textDecorationStyle: 'dotted', textDecorationColor: CUE_COLOR.lastLater },
};

/**
 * The beat marker line — EXACTLY the Deep Dive presenter's `markStyle` (11px,
 * 16px line height, 800, .12em, the script face, margin-bottom fontSize×0.5),
 * plus one line always (nowrap + ellipsis). ⚠️ Must match followerPage.ts
 * `.beat-mark` + `.beat-mark.news`: the marker is part of the script's layout.
 * Yellow = the next press; the story's last marker violet (brighter when it is
 * the next press); the rest faint.
 */
export const newsMarkStyle = (fontSize: number, next: boolean, last: boolean): CSSProperties => ({
  fontSize: 11, lineHeight: '16px', fontWeight: 800, letterSpacing: '0.12em',
  color: last ? (next ? CUE_COLOR.last : CUE_COLOR.lastLater) : next ? CUE_COLOR.next : D.faint,
  margin: `0 0 ${Math.round(fontSize * 0.5)}px`, fontFamily: SCRIPT_FONT,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
});

/**
 * One paragraph of the script with its upcoming cues' words marked — colour
 * and underline only. `offset` = where the paragraph starts in the whole
 * script; `beat` = the story beat on screen now (cues at or before it are no
 * longer marked).
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
    out.push(<span key={s.start} data-cue={s.beat} style={SPAN[kind]}>{para.slice(a, b)}</span>);
    at = b;
  }
  if (at < para.length) out.push(para.slice(at));
  return out;
}
