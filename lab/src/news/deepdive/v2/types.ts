/**
 * Deep Dive v2 — the chapter format (Jake, 2026-10-02).
 *
 * A v2 dive is a stack of full-screen CHAPTERS. Each chapter has a header
 * (eyebrow, heading with one *accent* word, a question→answer "island") and
 * one interactive STAGE that steps through BEATS with ←/→. The server mirrors
 * these shapes in server/src/news/deepDiveV2.ts.
 *
 * Live sync carries ONE number (the "slide index"). In v2 that number is the
 * FLAT BEAT INDEX across the whole show — see `flatten` — so the presenter and
 * the stage stay in step without any change to the socket protocol.
 */

export type ChapterKind =
  | 'title' | 'demo' | 'clip' | 'article' | 'reveal' | 'stats'
  | 'versus' | 'flow' | 'timeline' | 'list' | 'quote' | 'takeaways';

export interface Island { q: string; a: string }

/** [x, y, w, h] in the image's own pixels. */
export type Box = [number, number, number, number];

export interface DemoStep {
  /** Asset file name (served from the dive's asset dir). */
  image: string;
  w: number;
  h: number;
  /** What to zoom to and spotlight; null = the whole screen. */
  box: Box | null;
  /** Where the cursor clicks, in image pixels; null = no cursor. */
  click: [number, number] | null;
  caption: string;
  /** Small label above the caption ("Gmail", "You decide"). */
  label: string;
}

export interface DemoTab {
  name: string;
  job: string;
  color: string;
  /** 'agent' = recorded by the demo agent using the real product. */
  source: 'agent' | 'screenshots';
  credit: string;
  steps: DemoStep[];
}

export interface ClipItem {
  file: string;
  poster: string;
  w: number;
  h: number;
  caption: string;
  label: string;
  credit: string;
}

export interface PageTile { file: string; y: number; h: number }
export interface ArticleHighlight { x: number; y: number; w: number; h: number; caption: string; /** The post block it marks (for the editor). */ block?: number }
export interface ArticleData {
  url: string;
  title: string;
  site: string;
  /** CSS px of the captured page (1280 wide). */
  width: number;
  height: number;
  tiles: PageTile[];
  highlights: ArticleHighlight[];
}

export interface RevealCard {
  name: string;
  tag?: string;
  /** The big line: "$100", "Learns from feedback". */
  big: string;
  small?: string;
  note?: string;
  tone?: 'dark' | 'light' | 'brand' | 'blue';
  /** When `big` is a number, count up to it. */
  countTo?: number | null;
  prefix?: string;
  suffix?: string;
}

export interface StatItem { value: number | null; display?: string; prefix?: string; suffix?: string; label: string }
export interface VersusOption { name: string; line: string; points?: string[] }
export interface FlowStep { label: string; text: string }
export interface TimelineEvent { date: string; label: string; detail?: string; soon?: boolean }

export interface ChapterData {
  // title
  lede?: string;
  agenda?: string[];
  /** A clip that loops behind the title (muted). */
  heroClip?: ClipItem | null;
  // demo
  tabs?: DemoTab[];
  // clip
  clips?: ClipItem[];
  // article
  article?: ArticleData | null;
  // reveal
  cards?: RevealCard[];
  good?: string[];
  bad?: string[];
  // stats
  stats?: StatItem[];
  // versus
  options?: VersusOption[];
  // flow
  steps?: FlowStep[];
  // timeline
  events?: TimelineEvent[];
  // list
  items?: string[];
  image?: { file: string; w: number; h: number; credit?: string } | null;
  // quote
  quote?: string;
  who?: string;
  role?: string;
  // takeaways
  points?: string[];
  /** Source credit line under the stage. */
  credit?: string;
}

export interface Chapter {
  id: string;
  position: number;
  kind: ChapterKind;
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  island: Island | null;
  data: ChapterData;
  /** What Jake says. "[next]" marks where he presses → to the next beat. */
  script: string;
}

/** How many ←/→ beats a chapter has (always ≥ 1). */
export function beatCount(c: Chapter): number {
  const d = c.data || {};
  const n = (() => {
    switch (c.kind) {
      case 'demo': return (d.tabs ?? []).reduce((a, t) => a + t.steps.length, 0);
      case 'clip': return d.clips?.length ?? 0;
      case 'article': return d.article?.highlights.length ?? 0;
      case 'reveal': return (d.cards?.length ?? 0) + ((d.good?.length || d.bad?.length) ? 1 : 0);
      case 'stats': return d.stats?.length ?? 0;
      case 'versus': return d.options?.length ?? 0;
      case 'flow': return d.steps?.length ?? 0;
      case 'timeline': return d.events?.length ?? 0;
      case 'list': return d.items?.length ?? 0;
      case 'takeaways': return d.points?.length ?? 0;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

export interface FlatBeat { chapter: number; beat: number }

/** Every beat of the show in order; the index into this is the sync index. */
export function flatten(chapters: Chapter[]): FlatBeat[] {
  const out: FlatBeat[] = [];
  chapters.forEach((c, ci) => { for (let b = 0; b < beatCount(c); b++) out.push({ chapter: ci, beat: b }); });
  return out;
}

/** The flat index of a chapter's first beat. */
export function firstBeatOf(chapters: Chapter[], chapter: number): number {
  let n = 0;
  for (let i = 0; i < chapter && i < chapters.length; i++) n += beatCount(chapters[i]);
  return n;
}

/** The script split at its [next] marks: one part per beat (padded/merged to fit). */
export function scriptParts(c: Chapter): string[] {
  const parts = (c.script || '').split(/\s*\[next\]\s*/i);
  const n = beatCount(c);
  if (parts.length > n) return [...parts.slice(0, n - 1), parts.slice(n - 1).join(' ')];
  while (parts.length < n) parts.push('');
  return parts;
}

export const assetUrl = (diveId: string, file: string) =>
  file ? `/api/news/dd-asset/${encodeURIComponent(diveId)}/${encodeURIComponent(file)}` : '';
