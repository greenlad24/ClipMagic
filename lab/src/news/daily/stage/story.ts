/**
 * Daily Show — a story as a Deep Dive-style presentation (Jake, 2026-10-06).
 *
 * A story on the audience screen is a COVER (headline, source, one-line lede)
 * followed by 1–2 SCENES. A scene IS a Deep Dive v2 chapter (same kinds, same
 * data, drawn by the Deep Dive's own ChapterView), so the beat model is the
 * Deep Dive's: → steps to the next beat (micro-interaction), and past the last
 * beat to the next story; ← steps back the same way.
 *
 * Beat numbers are per story: 0 = the cover, then each scene's beats in order.
 * The live sync carries (slide index, beat) — the slide index keeps meaning
 * "which story", so the teleprompter, the follower and the session row are
 * unchanged; the beat travels on its own socket event (see liveSync.ts).
 *
 * The scenes come from the deck build (server stage.ts, `slide.stageJson`). A
 * slide built before that has none, and gets a fallback made from its presenter
 * notes so every existing deck still presents.
 */
import type { Slide } from '../../api';
import { beatCount, type Chapter, type ChapterKind, type Island } from '../../deepdive/v2/types';

export interface StoryCover {
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  lede: string;
  source: string;
  host: string;
  outlets: number;
}

export interface StoryStage {
  cover: StoryCover;
  scenes: Chapter[];
  /** Script words at which to press → for each beat after the cover (may be short or empty). */
  cues: string[];
  /** True when drawn from the notes because the slide has no built stage. */
  fallback: boolean;
}

/** Where a story beat lands: screen 0 = the cover, screen k = scene k−1 at `sceneBeat`. */
export interface BeatSpot { screen: number; sceneBeat: number }

const KINDS: ChapterKind[] = ['reveal', 'stats', 'versus', 'flow', 'timeline', 'list', 'quote'];

const hostOf = (url?: string): string => {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

export function parseKeyPoints(raw?: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch { return []; }
}

/** First sentence, trimmed to a lede. */
const lede = (text?: string): string => {
  const t = (text || '').trim();
  if (!t) return '';
  const m = t.match(/^.+?[.!?](\s|$)/);
  const first = (m ? m[0] : t).trim();
  return first.length > 180 ? `${first.slice(0, 177).trimEnd()}…` : first;
};

function parseStage(json?: string): { cover?: Partial<StoryCover>; scenes?: any[]; cues?: unknown[] } | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/** The story's stage: the built one when there is one, else made from the notes. */
export function storyStage(slide: Slide | null | undefined): StoryStage {
  const s = slide ?? ({ id: '' } as Slide);
  const raw = parseStage(s.stageJson);
  const base: StoryCover = {
    eyebrow: '',
    heading: s.topicLabel || '',
    lede: lede(s.whyItMatters),
    source: s.bestSourceName || '',
    host: hostOf(s.bestSourceUrl),
    outlets: typeof s.sourcesCount === 'number' ? s.sourcesCount : 0,
  };

  const scenes: Chapter[] = [];
  for (const [i, x] of (raw?.scenes ?? []).entries()) {
    if (!x || !KINDS.includes(x.kind)) continue;
    const island: Island | null = x.island && x.island.q && x.island.a ? { q: String(x.island.q), a: String(x.island.a) } : null;
    scenes.push({
      id: `${s.id}:${i}`,
      position: i + 1,
      kind: x.kind,
      eyebrow: String(x.eyebrow || ''),
      heading: String(x.heading || ''),
      island,
      data: x.data && typeof x.data === 'object' ? x.data : {},
      script: '',
    });
  }

  if (raw && scenes.length) {
    return {
      cover: {
        ...base,
        eyebrow: String(raw.cover?.eyebrow || ''),
        heading: String(raw.cover?.heading || '') || base.heading,
        lede: String(raw.cover?.lede || '') || base.lede,
      },
      scenes,
      cues: (raw.cues ?? []).map(String).filter(Boolean),
      fallback: false,
    };
  }

  // ── Fallback (decks built before stages): the key points, one per beat.
  const points = parseKeyPoints(s.keyPoints).slice(0, 5);
  if (points.length) {
    scenes.push({
      id: `${s.id}:notes`,
      position: 1,
      kind: 'list',
      eyebrow: 'The short version',
      heading: points.length === 1 ? 'What *happened*' : `${points.length} things to *know*`,
      island: null,
      data: { items: points },
      script: '',
    });
  }
  return { cover: base, scenes, cues: [], fallback: true };
}

/** → presses in this story, counting the cover as beat 0. */
export const storyBeats = (st: StoryStage): number => 1 + st.scenes.reduce((a, c) => a + beatCount(c), 0);

/** Which screen (and which beat of it) a story beat is. */
export function locateBeat(st: StoryStage, beat: number): BeatSpot {
  let b = Math.max(0, Math.min(storyBeats(st) - 1, Math.round(beat || 0)));
  if (b === 0) return { screen: 0, sceneBeat: 0 };
  b -= 1;
  for (let i = 0; i < st.scenes.length; i++) {
    const n = beatCount(st.scenes[i]);
    if (b < n) return { screen: i + 1, sceneBeat: b };
    b -= n;
  }
  const last = st.scenes.length;
  return { screen: last, sceneBeat: last ? beatCount(st.scenes[last - 1]) - 1 : 0 };
}

/** The story beat of scene `scene` (0-based) at its beat `b`. */
export function beatOfScene(st: StoryStage, scene: number, b: number): number {
  let n = 1;
  for (let i = 0; i < scene && i < st.scenes.length; i++) n += beatCount(st.scenes[i]);
  return n + Math.max(0, b);
}

/** A short label for what beat `beat` shows — for the presenter's "next" line. */
export function beatLabel(st: StoryStage, beat: number): string {
  const { screen, sceneBeat } = locateBeat(st, beat);
  if (screen === 0) return 'Cover';
  const c = st.scenes[screen - 1];
  const d = c.data || {};
  const pick = (): string => {
    switch (c.kind) {
      case 'reveal': return d.cards?.[sceneBeat]?.name ?? 'Who can get it';
      case 'stats': { const x = d.stats?.[sceneBeat]; return x ? `${x.value ?? x.display ?? ''} ${x.label}`.trim() : ''; }
      case 'versus': return d.options?.[sceneBeat]?.name ?? '';
      case 'flow': return d.steps?.[sceneBeat]?.label ?? '';
      case 'timeline': return d.events?.[sceneBeat]?.label ?? '';
      case 'list': return d.items?.[sceneBeat] ?? '';
      case 'quote': return d.who ? `Quote · ${d.who}` : 'Quote';
      default: return '';
    }
  };
  return pick() || c.heading.replace(/\*/g, '');
}
