/**
 * Where to press → in the script (Daily Show stages, 2026-10-06).
 *
 * The stage build copies a few words of the script per beat (`cues`). The
 * presenter's teleprompter marks them so Jake can see where the next beat
 * goes — COLOUR AND UNDERLINE ONLY. The script must wrap exactly as it does on
 * the follower page and the standalone teleprompter (three renderers that
 * agree to the pixel), so nothing here may add a glyph, change a weight or
 * touch spacing; spans start and end on word boundaries.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface CueSpan { start: number; end: number; beat: number }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each cue's position in `script`, in order (cue i leads to story beat i+1). Unfound cues are skipped. */
export function findCues(script: string, cues: string[]): CueSpan[] {
  const out: CueSpan[] = [];
  let from = 0;
  cues.forEach((cue, i) => {
    const words = cue.replace(/[“”"]/g, ' ').split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '')).filter(Boolean);
    if (!words.length) return;
    const re = new RegExp(words.map(esc).join('[^\\p{L}\\p{N}]+'), 'giu');
    re.lastIndex = from;
    let m = re.exec(script);
    if (!m) { re.lastIndex = 0; m = re.exec(script); }
    if (!m) return;
    out.push({ start: m.index, end: m.index + m[0].length, beat: i + 1 });
    from = m.index + m[0].length;
  });
  return out.sort((a, b) => a.start - b.start);
}

const NEXT: CSSProperties = { color: '#ffd21e', textDecoration: 'underline', textDecorationColor: '#ffd21e', textUnderlineOffset: '0.18em' };
const LATER: CSSProperties = { textDecoration: 'underline dotted', textDecorationColor: 'rgba(255,255,255,0.35)', textUnderlineOffset: '0.18em' };

/**
 * One paragraph of the script with its cues marked. `offset` = where the
 * paragraph starts in the whole script; `beat` = the story beat on screen now.
 */
export function markCues(para: string, offset: number, spans: CueSpan[], beat: number): ReactNode {
  const mine = spans.filter((s) => s.end > offset && s.start < offset + para.length && s.beat > beat);
  if (!mine.length) return para;
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of mine) {
    const a = Math.max(0, s.start - offset), b = Math.min(para.length, s.end - offset);
    if (a < at) continue;
    if (a > at) out.push(para.slice(at, a));
    out.push(<span key={s.start} data-cue={s.beat} style={s.beat === beat + 1 ? NEXT : LATER}>{para.slice(a, b)}</span>);
    at = b;
  }
  if (at < para.length) out.push(para.slice(at));
  return out;
}
