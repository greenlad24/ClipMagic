/**
 * Where to press → in the script — the SEARCH half of the cue marks, with no
 * React in it (split out of cues.tsx on 2026-10-07). story.ts, cueMarks.ts and
 * the presenter all use it, and the server bundles cueMarks.ts (with this) for
 * the public follower page — so the presenter and the follower find the very
 * same words. See cues.tsx for why marking may not touch the layout.
 */
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
