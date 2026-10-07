/**
 * A beat's SHORT title for the teleprompter's marker line (Jake, 2026-10-07:
 * "'Beat 1 - xxx...' not too many words — maximum 3-4 words in the xxx").
 *
 * New stages carry a generated `title` (server news/stage.ts, ≤ 4 words); every
 * title — generated or derived from an older slide's heading — passes through
 * here, so the rule holds for every deck: at most 4 words and 28 characters,
 * cut at a word, never ending on a little word ("of", "the", "to"…) or on
 * punctuation, and never an "…". Pure: the server bundles it with cueMarks.ts.
 */
export const BEAT_TITLE = { words: 4, chars: 28 } as const;

const TAIL = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'about', 'as',
  'and', 'or', 'but', 'nor', 'so', 'than', 'that', 'this', 'is', 'are', 'was', 'were', 'be', 'its',
  "it's", 'their', 'your', 'our', 'his', 'her', 'my', 'vs', 'via', '—', '–', '-',
  'behind', 'over', 'under', 'after', 'before', 'between', 'through', 'without', 'like', 'has', 'have', 'had',
]);
/** A heading's verb — "Rohit Prasad is Boston Dynamics' new CEO" → "Rohit Prasad". Cut before it from the 3rd word on. */
const AUX = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'may', 'might']);

const clean = (w: string) => w.replace(/^[^\p{L}\p{N}$#]+|[^\p{L}\p{N}%+]+$/gu, '');

export function shortTitle(raw: string | null | undefined): string {
  const raws = String(raw ?? '')
    .replace(/[*“”"]/g, ' ').replace(/[‘’]/g, "'").replace(/…/g, ' ')
    .split(/\s+/).filter(Boolean);
  // A heading's own break (a comma, colon, dash, full stop) inside the first 4 words ends the title there.
  const words: string[] = [];
  const short = raws.map(clean).filter(Boolean).length <= BEAT_TITLE.words;
  for (const r of raws) {
    // Short enough already: keep every word (just cleaned).
    if (short) { const w = clean(r); if (w) words.push(w); continue; }
    if (/^[—–=&+→-]+$/.test(r)) { if (words.length >= 2) break; continue; }
    const w = clean(r);
    if (w) {
      if (words.length >= 2 && AUX.has(w.toLowerCase())) break;
      words.push(w);
    }
    if (words.length >= BEAT_TITLE.words || (words.length >= 2 && /[,:;.!?—–]$/.test(r))) break;
  }
  let out = words;
  const trim = () => { while (out.length > 1 && TAIL.has(out[out.length - 1].toLowerCase())) out = out.slice(0, -1); };
  trim();
  while (out.length > 1 && out.join(' ').length > BEAT_TITLE.chars) { out = out.slice(0, -1); trim(); }
  const t = out.join(' ');
  return t.length > BEAT_TITLE.chars ? t.slice(0, BEAT_TITLE.chars) : t;
}
