/**
 * AI NEWS TEMPLATES (Jake, 2026-10-07): "The Deep Dive ... should be kept
 * special ... If all of the news stories have a similar presentation style as
 * the deep dive at the end then it doesn't look special or differentiated ...
 * the AI news presentation templates should have different templates —
 * minimalistic, beautiful but different templates from the deep dives."
 *
 * So the daily deck has its OWN set, and its own layouts (story.css): flat
 * colour fields, a broadcast "story strip" header, plain rules and rows — no
 * Deep Dive chapter chrome, dot field, serif-italic accent or yellow underline,
 * and none of the Deep Dive's fonts (Inter display / Fraunces / Playfair / DM
 * Serif / Sora). The server validates the ids (server news/newsTemplates.ts —
 * keep the two lists in step). A deck still holding a Deep Dive template id
 * (picked before this) is drawn in the default, Studio.
 */
import type { CSSProperties } from 'react';

export type NewsTemplateId =
  | 'studio' | 'wire' | 'bulletin' | 'nightdesk' | 'lilac'
  | 'evergreen' | 'sandstone' | 'signal' | 'glacier' | 'ember';

/** A quiet background detail — never in the top-right corner (Jake's rule). */
export type NewsDeco = 'none' | 'glow' | 'rule' | 'band' | 'frame';

export interface NewsTemplate {
  id: NewsTemplateId;
  name: string;
  blurb: string;
  bg: string; ink: string; mute: string; line: string; card: string;
  accent: string; accentInk: string;
  head: string; body: string; label: string;
  headWeight: number; headTrack: string; headCase: 'none' | 'uppercase';
  /** Accent words: in the accent colour, or set on an accent block. */
  mark: 'color' | 'block';
  /** Corner radius multiplier. */
  radius: number;
  deco: NewsDeco;
  dark: boolean;
}

const ARCHIVO = '"Archivo", "Helvetica Neue", Arial, sans-serif';
const NARROW = '"Archivo Narrow", "Arial Narrow", Arial, sans-serif';
const PLEX = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif';
const PLEXMONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace';
const NEWSREADER = '"Newsreader", Georgia, "Times New Roman", serif';
const GROTESK = '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
const MANROPE = '"Manrope", "Helvetica Neue", Arial, sans-serif';
const OUTFIT = '"Outfit", "Helvetica Neue", Arial, sans-serif';
const BRICOLAGE = '"Bricolage Grotesque", "Helvetica Neue", Arial, sans-serif';
const INSTRUMENT = '"Instrument Serif", Georgia, serif';

export const NEWS_TEMPLATES: NewsTemplate[] = [
  {
    id: 'studio', name: 'Studio', blurb: 'Broadcast navy, crisp white type, one cyan signal colour',
    bg: '#0b1324', ink: '#f2f5fb', mute: '#8d99b3', line: 'rgba(242,245,251,.13)', card: '#111c34', accent: '#39d0ff', accentInk: '#03131d',
    head: ARCHIVO, body: ARCHIVO, label: PLEXMONO, headWeight: 800, headTrack: '-.025em', headCase: 'none', mark: 'color', radius: 1, deco: 'glow', dark: true,
  },
  {
    id: 'wire', name: 'Wire', blurb: 'Newsprint cream, serif headlines, a red rule like a front page',
    bg: '#f3efe6', ink: '#161512', mute: '#6f695e', line: '#d5cebf', card: '#ebe5d7', accent: '#c8211b', accentInk: '#ffffff',
    head: NEWSREADER, body: PLEX, label: PLEXMONO, headWeight: 600, headTrack: '-.02em', headCase: 'none', mark: 'color', radius: 0, deco: 'rule', dark: false,
  },
  {
    id: 'bulletin', name: 'Bulletin', blurb: 'Clean white, bold grotesk, key words on an orange block',
    bg: '#ffffff', ink: '#0d0d0d', mute: '#6a6a6a', line: '#e3e3e3', card: '#f4f4f2', accent: '#ff5a1f', accentInk: '#ffffff',
    head: GROTESK, body: GROTESK, label: GROTESK, headWeight: 700, headTrack: '-.035em', headCase: 'none', mark: 'block', radius: 0.4, deco: 'band', dark: false,
  },
  {
    id: 'nightdesk', name: 'Night Desk', blurb: 'Late-edition charcoal, amber highlights, typewriter labels',
    bg: '#141416', ink: '#ecebe7', mute: '#8e8d88', line: '#2c2c30', card: '#1c1c20', accent: '#ffb224', accentInk: '#1a1200',
    head: MANROPE, body: MANROPE, label: PLEXMONO, headWeight: 800, headTrack: '-.03em', headCase: 'none', mark: 'color', radius: 0.6, deco: 'frame', dark: true,
  },
  {
    id: 'lilac', name: 'Lilac', blurb: 'Soft lavender, deep violet ink, round friendly shapes',
    bg: '#f1edff', ink: '#1e1646', mute: '#6b62a2', line: '#d8d0fa', card: '#ffffff', accent: '#6c47ff', accentInk: '#ffffff',
    head: OUTFIT, body: OUTFIT, label: OUTFIT, headWeight: 700, headTrack: '-.02em', headCase: 'none', mark: 'color', radius: 2.2, deco: 'glow', dark: false,
  },
  {
    id: 'evergreen', name: 'Evergreen', blurb: 'Deep forest green, warm off-white, a lime signal',
    bg: '#0f2a22', ink: '#eef3e6', mute: '#94ac9d', line: 'rgba(238,243,230,.14)', card: '#143429', accent: '#b9f45a', accentInk: '#0b1f12',
    head: BRICOLAGE, body: BRICOLAGE, label: PLEXMONO, headWeight: 800, headTrack: '-.03em', headCase: 'none', mark: 'color', radius: 1, deco: 'rule', dark: true,
  },
  {
    id: 'sandstone', name: 'Sandstone', blurb: 'Warm sand, elegant serif headlines, a rust accent',
    bg: '#ede4d6', ink: '#2a1c13', mute: '#7a6555', line: '#d6c7b1', card: '#f6efe4', accent: '#bd4f2e', accentInk: '#ffffff',
    head: INSTRUMENT, body: MANROPE, label: MANROPE, headWeight: 400, headTrack: '-.01em', headCase: 'none', mark: 'color', radius: 0.8, deco: 'none', dark: false,
  },
  {
    id: 'signal', name: 'Signal', blurb: 'Pure black, tall condensed capitals, electric green',
    bg: '#050505', ink: '#ffffff', mute: '#9b9b9b', line: '#262626', card: '#111111', accent: '#2ff28c', accentInk: '#001b0c',
    head: NARROW, body: ARCHIVO, label: PLEXMONO, headWeight: 700, headTrack: '-.005em', headCase: 'uppercase', mark: 'color', radius: 0, deco: 'band', dark: true,
  },
  {
    id: 'glacier', name: 'Glacier', blurb: 'Icy blue-white, navy type, a clear blue line',
    bg: '#eef4f8', ink: '#0d2233', mute: '#5d7486', line: '#d2dfe9', card: '#ffffff', accent: '#1f6fe0', accentInk: '#ffffff',
    head: MANROPE, body: MANROPE, label: PLEXMONO, headWeight: 800, headTrack: '-.035em', headCase: 'none', mark: 'color', radius: 1.2, deco: 'frame', dark: false,
  },
  {
    id: 'ember', name: 'Ember', blurb: 'Dark plum, cream type, a warm coral glow',
    bg: '#1c1015', ink: '#f8ece4', mute: '#b49b93', line: 'rgba(248,236,228,.14)', card: '#28171e', accent: '#ff7a59', accentInk: '#2a0d05',
    head: BRICOLAGE, body: MANROPE, label: MANROPE, headWeight: 700, headTrack: '-.03em', headCase: 'none', mark: 'color', radius: 1.4, deco: 'glow', dark: true,
  },
];

export const DEFAULT_NEWS_TEMPLATE: NewsTemplateId = 'studio';
const BY_ID = new Map(NEWS_TEMPLATES.map((t) => [t.id, t]));

export const isNewsTemplateId = (v: unknown): v is NewsTemplateId => typeof v === 'string' && BY_ID.has(v as NewsTemplateId);

/** The deck's template — anything unknown (unset, or a Deep Dive id stored before 2026-10-07) is the default. */
export function newsTemplateFor(id: string | null | undefined): NewsTemplate {
  return BY_ID.get(id as NewsTemplateId) ?? BY_ID.get(DEFAULT_NEWS_TEMPLATE)!;
}

/** The CSS variables story.css reads, on the story root. */
export function newsTemplateStyle(t: NewsTemplate): CSSProperties {
  return {
    '--n-bg': t.bg, '--n-ink': t.ink, '--n-mute': t.mute, '--n-line': t.line, '--n-card': t.card,
    '--n-accent': t.accent, '--n-accent-ink': t.accentInk,
    '--n-head': t.head, '--n-body': t.body, '--n-label': t.label,
    '--n-head-w': String(t.headWeight), '--n-head-track': t.headTrack, '--n-head-case': t.headCase,
    '--n-r': String(t.radius),
    background: t.bg, color: t.ink,
  } as CSSProperties;
}
