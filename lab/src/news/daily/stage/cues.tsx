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

/** The regex a cue is matched with: its words in order, any punctuation/space between. Null = no words. */
export function cueRegex(cue: string): RegExp | null {
  const words = cue.replace(/[“”"]/g, ' ').split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '')).filter(Boolean);
  if (!words.length) return null;
  // A straight and a curly apostrophe are the same letter here ("it's" / "it’s").
  return new RegExp(words.map((w) => esc(w).replace(/['’‘]/g, "['’‘]")).join('[^\\p{L}\\p{N}]+'), 'giu');
}

/** Where `cue` first occurs in `script` at or after `from` (forward only), or null. */
export function placeCue(script: string, cue: string, from: number): { start: number; end: number } | null {
  const re = cueRegex(cue);
  if (!re) return null;
  re.lastIndex = Math.max(0, from);
  const m = re.exec(script);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Where the search for beat 1's cue starts: after the script's first word (the first words are beat 0, arriving at the story). */
export const cueSearchStart = (script: string): number => Math.max(1, script.match(/^\s*\S+/)?.[0].length ?? 1);

/**
 * Each cue's position in `script`, in order (cue i leads to story beat i+1).
 * Forward only: cue i is searched after cue i−1. The story stage (story.ts)
 * already reconciled its cues against the script with this same search, so
 * every cue of a built story is found and the marks == the beats.
 */
export function findCues(script: string, cues: string[]): CueSpan[] {
  const out: CueSpan[] = [];
  let from = cueSearchStart(script);
  cues.forEach((cue, i) => {
    const m = placeCue(script, cue, from);
    if (!m) return;
    out.push({ start: m.start, end: m.end, beat: i + 1 });
    from = m.end;
  });
  return out;
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
