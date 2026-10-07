/**
 * Daily Show — one story on the show screens (Jake, 2026-10-07).
 *
 * EVERY STORY RUNS THE SAME TWO PARTS, IN THIS ORDER (Jake's correction,
 * 2026-10-07: "Source (with a slow scroll down effect) as the first slide of
 * each story; clicking shift — to change it to the video at any slide of the
 * story; clicking forward after the first slide would be the rest of the
 * slides"):
 *   1. SOURCE — the story's best source article, full screen, scrolling slowly
 *      (a server-side capture of the real page: server news/sourceShot.ts). It
 *      tells the audience "next story" and breaks up the look. A story whose
 *      page could not be captured opens on a title card instead.
 *   2. INFO   — 1–2 simple info slides (a few facts, numbers, a comparison…),
 *      revealed one item per beat as the script reaches them.
 * The story's video is NOT a beat: Shift toggles it full screen over ANY beat
 * of the story (media-view), and toggling back returns to that same beat.
 * The Deep Dive keeps its own look; these are the AI News templates
 * (newsTemplates.ts), not the Deep Dive's.
 *
 * BEATS == CUES (Jake, 2026-10-07: "some of the beats aren't highlighted in
 * the script, leaving left-over beats at the end"). The cause: the stage model
 * wrote 4–6 cues for 6–8 beats (it never counted a reveal's extra "who can
 * get it" beat, and the normaliser accepted short cue lists), so the last
 * beats of a story had no mark and Jake pressed → blind. Now every beat after
 * the first is built WITH its cue, and `reconcile()` checks each cue against
 * the script with the presenter's own search (cues.tsx `placeCue`):
 *   - a cue not found in order is re-made from the script itself — the start
 *     of a sentence (else a clause) between its neighbours' cues;
 *   - a beat that still has no place is MERGED (an item appears together with
 *     the item before it; a slide's first item waits for its second) or, if a
 *     whole slide has no place, DROPPED.
 * So `beats.length - 1 === cues.length`, every cue is found, in order.
 *
 * The live sync is unchanged: slide index = story, beat = index into `beats`.
 */
import type { Slide } from '../../api';
import { cueSearchStart, placeCue } from './cues';

export interface StoryCover {
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  lede: string;
  source: string;
  host: string;
  outlets: number;
}

/** The captured source page (server sourceShot.ts). */
export interface SourceShot {
  /** Authed image URL. */
  src: string;
  url: string;
  name: string;
  host: string;
  /** Image size in px (the page is captured 1.5× at 1280 CSS px wide). */
  w: number;
  h: number;
}

export type SceneKind = 'list' | 'stats' | 'versus' | 'flow' | 'timeline' | 'quote' | 'reveal';

export interface NewsScene {
  id: string;
  kind: SceneKind;
  eyebrow: string;
  heading: string;
  data: Record<string, any>;
}

/** A screen of the story, in order. (No video screen — Shift shows the video over any beat.) */
export type Screen = { kind: 'open' } | { kind: 'scene'; scene: number };

export interface StoryBeat {
  /** Index into `screens`. */
  screen: number;
  /** Scene beats: how many of the slide's items are showing. */
  upTo: number;
  /** The script words at which → lands on this beat ('' for beat 0 — arriving at the story). */
  cue: string;
  label: string;
}

export interface StoryStage {
  cover: StoryCover;
  shot: SourceShot | null;
  scenes: NewsScene[];
  screens: Screen[];
  beats: StoryBeat[];
  /** Script words at which to press → for each beat after the first — always `beats.length - 1`, all found in the script. */
  cues: string[];
  /** True when drawn from the notes because the slide has no built stage. */
  fallback: boolean;
  /** What reconcile() had to repair (diagnostics / tests). */
  repaired: { kept: number; remade: number; merged: number; dropped: number };
}

const KINDS: SceneKind[] = ['list', 'stats', 'versus', 'flow', 'timeline', 'quote', 'reveal'];

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

const parse = (json?: string): any => {
  if (!json) return null;
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : null; } catch { return null; }
};

export function sourceShotOf(slide: Slide | null | undefined): SourceShot | null {
  const v = parse((slide as any)?.sourceShot);
  if (!v || typeof v.file !== 'string' || !/^[a-z0-9]+\.jpg$/i.test(v.file) || !(v.w > 0) || !(v.h > 0)) return null;
  return { src: `/api/news/source-shot/${v.file}`, url: String(v.url || ''), name: String(v.name || ''), host: hostOf(v.url), w: Number(v.w), h: Number(v.h) };
}

/** Items (= beats) in a scene. A reveal's "who can get it" row is not a beat here. */
export function sceneItems(sc: NewsScene): number {
  const d = sc.data || {};
  const n = (() => {
    switch (sc.kind) {
      case 'list': return d.items?.length ?? 0;
      case 'stats': return d.stats?.length ?? 0;
      case 'versus': return d.options?.length ?? 0;
      case 'flow': return d.steps?.length ?? 0;
      case 'timeline': return d.events?.length ?? 0;
      case 'reveal': return d.cards?.length ?? 0;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

/** A short label for item `i` of a scene — the presenter's "next" line. */
function itemLabel(sc: NewsScene, i: number): string {
  const d = sc.data || {};
  const pick = (): string => {
    switch (sc.kind) {
      case 'reveal': return d.cards?.[i]?.name ?? '';
      case 'stats': { const x = d.stats?.[i]; return x ? `${x.value ?? x.display ?? ''} ${x.label ?? ''}`.trim() : ''; }
      case 'versus': return d.options?.[i]?.name ?? '';
      case 'flow': return d.steps?.[i]?.label ?? '';
      case 'timeline': return d.events?.[i]?.label ?? '';
      case 'list': return d.items?.[i] ?? '';
      case 'quote': return d.who ? `Quote · ${d.who}` : 'Quote';
      default: return '';
    }
  };
  return String(pick() || sc.heading.replace(/\*/g, ''));
}

/* ── reconcile: every beat gets a cue that is really in the script ────────── */

interface Want { cue: string; role: 'entry' | 'item'; scene: number; item: number }

/** Sentence starts (and, as a second choice, clause starts) of the script. */
function startsOf(script: string): { sentences: number[]; clauses: number[] } {
  const at = (re: RegExp) => {
    const out: number[] = [];
    for (const m of script.matchAll(re)) {
      const p = (m.index ?? 0) + m[0].length;
      if (p < script.length && /[\p{L}\p{N}"“‘'$]/u.test(script[p])) out.push(p);
    }
    return out;
  };
  return { sentences: at(/(?:[.!?…]["”’)]*\s+|\n\s*)/g), clauses: at(/[,;:—–]\s+/g) };
}

/** A cue made from the script at `p`: the fewest words (≥ 3) that the forward search finds exactly there. */
function cueAt(script: string, p: number, from: number, hi: number): { cue: string; end: number } | null {
  const words = script.slice(p).match(/\S+/g) ?? [];
  for (const n of [4, 5, 6, 8, 3]) {
    if (words.length < Math.min(n, 3)) break;
    const cue = words.slice(0, n).join(' ');
    const m = placeCue(script, cue, from);
    if (m && m.start === p && m.end <= hi) return { cue, end: m.end };
  }
  return null;
}

export function reconcile(script: string, want: Want[]): { cues: (string | null)[]; kept: number; remade: number } {
  const n = want.length;
  const span: ({ start: number; end: number; cue: string } | null)[] = new Array(n).fill(null);
  let from = 0, kept = 0, remade = 0;
  // Beat 1's cue may not sit on the very first words — that is beat 0 (arriving at the story).
  const first = cueSearchStart(script);
  for (let i = 0; i < n; i++) {
    const c = want[i].cue.trim();
    if (!c) continue;
    const m = placeCue(script, c, i === 0 ? first : from);
    if (m) { span[i] = { ...m, cue: c }; from = m.end; kept++; }
  }
  const { sentences, clauses } = startsOf(script);
  for (let i = 0; i < n;) {
    if (span[i]) { i++; continue; }
    let j = i;
    while (j < n && !span[j]) j++;
    const lo = i > 0 ? span[i - 1]!.end : first;
    const hi = j < n ? span[j]!.start : script.length;
    const need = j - i;
    const inGap = (list: number[]) => list.filter((p) => p >= lo && p < hi);
    let cands = inGap(sentences);
    if (cands.length < need) cands = [...new Set([...cands, ...inGap(clauses)])].sort((a, b) => a - b);
    // Spread over the gap: with more places than beats, take them evenly.
    const pickIdx = cands.length >= need
      ? Array.from({ length: need }, (_, t) => Math.min(cands.length - 1, Math.floor(((t + 0.5) * cands.length) / need)))
      : cands.map((_, t) => t);
    let prev = lo;
    pickIdx.forEach((ci, t) => {
      const p = cands[ci];
      if (p < prev) return;
      const made = cueAt(script, p, prev, hi);
      if (!made) return;
      span[i + t] = { start: p, end: made.end, cue: made.cue };
      prev = made.end;
      remade++;
    });
    i = j;
  }
  return { cues: span.map((s) => s?.cue ?? null), kept, remade };
}

/* ── the stage ────────────────────────────────────────────────────────────── */

function readScenes(raw: any, slideId: string): { scenes: NewsScene[]; cues: string[][] } {
  const scenes: NewsScene[] = [];
  const cues: string[][] = [];
  const v2 = raw?.v === 2;
  // Old (v1) stages: one flat cue list over the Deep Dive beats after the cover —
  // a reveal's extra "who can get it" beat included, which is not a beat here.
  const flat: string[] = !v2 && Array.isArray(raw?.cues) ? raw.cues.map((c: unknown) => String(c ?? '')) : [];
  let k = 0;
  for (const [i, x] of (Array.isArray(raw?.scenes) ? raw.scenes : []).entries()) {
    if (!x || !KINDS.includes(x.kind)) continue;
    const sc: NewsScene = { id: `${slideId}:${i}`, kind: x.kind, eyebrow: String(x.eyebrow || ''), heading: String(x.heading || ''), data: x.data && typeof x.data === 'object' ? x.data : {} };
    const items = sceneItems(sc);
    if (v2) {
      cues.push(Array.from({ length: items }, (_, b) => String(Array.isArray(x.cues) ? x.cues[b] ?? '' : '')));
    } else {
      cues.push(flat.slice(k, k + items));
      const gate = x.kind === 'reveal' && ((sc.data.good?.length ?? 0) || (sc.data.bad?.length ?? 0)) ? 1 : 0;
      k += items + gate;
    }
    scenes.push(sc);
  }
  // (A v2 stage built before 2026-10-07 may carry a `videoCue` — ignored: the video is not a beat.)
  return { scenes, cues };
}

/** The story's stage: the built one when there is one, else made from the notes. */
export function storyStage(slide: Slide | null | undefined): StoryStage {
  const s = slide ?? ({ id: '' } as Slide);
  const raw = parse(s.stageJson);
  const base: StoryCover = {
    eyebrow: '',
    heading: s.topicLabel || '',
    lede: lede(s.whyItMatters),
    source: s.bestSourceName || '',
    host: hostOf(s.bestSourceUrl),
    outlets: typeof s.sourcesCount === 'number' ? s.sourcesCount : 0,
  };
  const read = raw ? readScenes(raw, s.id) : { scenes: [], cues: [] };
  let { scenes } = read;
  let sceneCues = read.cues;
  const fallback = !scenes.length;
  const cover: StoryCover = fallback ? base : {
    ...base,
    eyebrow: String(raw.cover?.eyebrow || ''),
    heading: String(raw.cover?.heading || '') || base.heading,
    lede: String(raw.cover?.lede || '') || base.lede,
  };

  // Decks built before stages: the key points, one per beat.
  if (fallback) {
    const points = parseKeyPoints(s.keyPoints).slice(0, 4);
    if (points.length) {
      scenes = [{ id: `${s.id}:notes`, kind: 'list', eyebrow: 'The short version', heading: points.length === 1 ? 'What happened' : `${points.length} things to know`, data: { items: points } }];
      sceneCues = [points.map(() => '')];
    }
  }

  // What each beat after the first wants, then the script decides.
  const want: Want[] = [];
  const script = s.teleprompterScript || '';
  scenes.forEach((sc, i) => {
    for (let b = 0; b < sceneItems(sc); b++) want.push({ cue: sceneCues[i]?.[b] ?? '', role: b === 0 ? 'entry' : 'item', scene: i, item: b });
  });
  const r = reconcile(script, want);
  const got = want.map((w, i) => ({ ...w, cue: r.cues[i] }));

  // Merge / drop what has no place (see the header).
  let merged = 0, dropped = 0;
  const keepScene = scenes.map((_, i) => got.some((g) => g.scene === i && g.cue));
  dropped += keepScene.filter((x) => !x).length;

  const screens: Screen[] = [{ kind: 'open' }];
  const keptScenes: NewsScene[] = [];
  const sceneScreen = new Map<number, number>();
  scenes.forEach((sc, i) => {
    if (!keepScene[i]) return;
    sceneScreen.set(i, screens.length);
    screens.push({ kind: 'scene', scene: keptScenes.length });
    keptScenes.push(sc);
  });

  const shot = sourceShotOf(s);
  const beats: StoryBeat[] = [{ screen: 0, upTo: 0, cue: '', label: shot ? `Source · ${shot.name || shot.host}` : 'Title' }];
  for (const [i, sc] of scenes.entries()) {
    if (!keepScene[i]) continue;
    const mine = got.filter((g) => g.scene === i);
    const screen = sceneScreen.get(i)!;
    let open = false;
    for (const g of mine) {
      if (g.cue) {
        // An entry without a place waits for the first item that has one; that beat shows all before it.
        beats.push({ screen, upTo: g.item + 1, cue: g.cue, label: itemLabel(sc, g.item) });
        open = true;
      } else if (open) {
        // No place of its own: it appears with the item before it.
        beats[beats.length - 1].upTo = g.item + 1;
        merged++;
      } else merged++;
    }
  }

  return {
    cover,
    shot,
    scenes: keptScenes,
    screens,
    beats,
    cues: beats.slice(1).map((b) => b.cue),
    fallback,
    repaired: { kept: r.kept, remade: r.remade, merged, dropped },
  };
}

/** → presses in this story (beat 0 = the source). */
export const storyBeats = (st: StoryStage): number => st.beats.length;

/** The beat clamped into the story. */
export const beatAtIndex = (st: StoryStage, beat: number): StoryBeat =>
  st.beats[Math.max(0, Math.min(st.beats.length - 1, Math.round(beat || 0)))];

/** A short label for what beat `beat` shows — for the presenter's "next" line. */
export const beatLabel = (st: StoryStage, beat: number): string => beatAtIndex(st, beat).label;

/** The first beat that shows screen `screen` with at least `upTo` items (clicks on the stage). */
export function beatFor(st: StoryStage, screen: number, upTo = 0): number {
  const i = st.beats.findIndex((b) => b.screen === screen && b.upTo >= upTo);
  return i < 0 ? 0 : i;
}
