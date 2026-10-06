/**
 * Deep Dive TEMPLATES (Jake, 2026-10-06: "a template picker with at least 10
 * visually attractive templates; each shows a visual preview; picking one
 * builds the presentation in that template").
 *
 * A template is DESIGN ONLY — colours, type, backgrounds, corner radius and
 * the light/dark rhythm of the chapters. It never changes the content, the
 * beats or the motion, so switching it re-skins a finished dive instantly and
 * a rebuild keeps it (it is stored on the dive: `news_deep_dives.template`).
 *
 * One token set drives BOTH formats: `templateStyle(t, 'v2')` sets the
 * variables show.css reads (`.dd2`), `templateStyle(t, 'v1')` the ones
 * deepdive.css reads (`.dd-stage`). The default is Jake's brand
 * (clipmagic-deep-dive-v2-reference: black/paper, Inter 800-900, ONE
 * Fraunces-italic accent with a yellow underline, yellow only for emphasis);
 * a classic dive with no template keeps its original aurora look.
 */
import type { CSSProperties } from 'react';
import './templates.css';

/* Pattern cell sizes live in templates.css, keyed by `data-deco` on the root:
   a var() inside a custom property resolves where it is DECLARED (the root,
   which has no --u yet), so a size in --u cannot travel in the variable. */

export type TemplateId =
  | 'jake' | 'aurora' | 'editorial' | 'midnight' | 'neon' | 'terminal'
  | 'sunset' | 'mint' | 'swiss' | 'royal' | 'ocean' | 'mono';

export type Surfaces = 'alternate' | 'dark' | 'light';
export type Deco = 'none' | 'dots' | 'grid' | 'lines' | 'glow' | 'aurora' | 'scan' | 'waves' | 'sun';

export interface DeckTemplate {
  id: TemplateId;
  name: string;
  blurb: string;
  /** Dark surface + the text on it. */
  ink: string; fg: string; card: string; card2: string; line: string; mute: string; faint: string;
  /** Light surface + the text on it. */
  paper: string; paperInk: string; paperCard: string; paperLine: string; paperMute: string;
  /** Emphasis colour, the text that sits ON it, and the darker shade used on light surfaces. */
  accent: string; accentInk: string; accentOnPaper: string;
  /** Second/third colours for gradients and classic-slide glows. */
  accent2: string; accent3: string;
  red: string;
  sans: string; display: string; accentFont: string; mono: string;
  headWeight: number; headTrack: string; headCase: 'none' | 'uppercase';
  accentStyle: 'italic' | 'normal';
  /** Corner radius multiplier (1 = the brand's). */
  radius: number;
  surfaces: Surfaces;
  deco: Deco;
}

const INTER = '"Inter", "Helvetica Neue", Arial, sans-serif';
const FRAUNCES = '"Fraunces", Georgia, "Times New Roman", serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
const PLAYFAIR = '"Playfair Display", Georgia, serif';
const DMSERIF = '"DM Serif Display", Georgia, serif';
const SORA = '"Sora", "Inter", Arial, sans-serif';

const JAKE: DeckTemplate = {
  id: 'jake', name: 'Jake Dawson', blurb: 'Your brand: black + paper, yellow emphasis, serif-italic accent',
  ink: '#000000', fg: '#f5f5f2', card: '#161618', card2: '#1e1e21', line: '#2a2a2e', mute: '#9b9b95', faint: '#66665f',
  paper: '#f5f5f2', paperInk: '#111111', paperCard: '#ffffff', paperLine: '#d9d9d2', paperMute: '#77776f',
  accent: '#ffd21e', accentInk: '#000000', accentOnPaper: '#8a7400', accent2: '#ffda45', accent3: '#f5f5f2', red: '#ff5a4e',
  sans: INTER, display: INTER, accentFont: FRAUNCES, mono: MONO,
  headWeight: 800, headTrack: '-.045em', headCase: 'none', accentStyle: 'italic', radius: 1, surfaces: 'alternate', deco: 'none',
};

export const TEMPLATES: DeckTemplate[] = [
  JAKE,
  {
    ...JAKE, id: 'aurora', name: 'Aurora', blurb: 'Deep navy with drifting violet and teal light (the classic look)',
    ink: '#06070b', fg: '#f4f5fa', card: '#10121a', card2: '#171a26', line: '#262a3a', mute: '#9aa0b8', faint: '#5d6380',
    paper: '#eef0fb', paperInk: '#0d1020', paperCard: '#ffffff', paperLine: '#d4d8ee', paperMute: '#6b7090',
    accent: '#8b6cff', accentInk: '#ffffff', accentOnPaper: '#5b3fe0', accent2: '#2ee6d6', accent3: '#ff5fa2', red: '#ff5f7a',
    accentFont: INTER, accentStyle: 'normal', surfaces: 'dark', deco: 'aurora', headWeight: 800,
  },
  {
    ...JAKE, id: 'editorial', name: 'Editorial', blurb: 'Magazine cream, black ink, red rules, Playfair headlines',
    ink: '#1a1714', fg: '#f4efe6', card: '#24201c', card2: '#2e2924', line: '#3d3630', mute: '#a59a8a', faint: '#7a6f61',
    paper: '#f4efe6', paperInk: '#1a1714', paperCard: '#fbf8f2', paperLine: '#ddd3c2', paperMute: '#7d7262',
    accent: '#d7263d', accentInk: '#ffffff', accentOnPaper: '#b81d31', accent2: '#1a1714', accent3: '#d7263d', red: '#d7263d',
    display: PLAYFAIR, accentFont: PLAYFAIR, headWeight: 800, headTrack: '-.02em', radius: 0.3, surfaces: 'light', deco: 'lines',
  },
  {
    ...JAKE, id: 'midnight', name: 'Midnight', blurb: 'Navy night sky, electric blue, a field of stars',
    ink: '#0a0f24', fg: '#eef2ff', card: '#121a38', card2: '#18224a', line: '#26315e', mute: '#8f9bc8', faint: '#5a6699',
    paper: '#e9eeff', paperInk: '#0a0f24', paperCard: '#ffffff', paperLine: '#cdd6f6', paperMute: '#5f6a96',
    accent: '#5b8cff', accentInk: '#ffffff', accentOnPaper: '#2f5fe0', accent2: '#9b7bff', accent3: '#62e0ff', red: '#ff6b81',
    accentFont: FRAUNCES, surfaces: 'dark', deco: 'dots',
  },
  {
    ...JAKE, id: 'neon', name: 'Neon Grid', blurb: 'Black, hot magenta and cyan on a glowing grid, caps headlines',
    ink: '#05010d', fg: '#f6eaff', card: '#110a1e', card2: '#190f2b', line: '#2d1d48', mute: '#a28dc4', faint: '#6a5590',
    paper: '#f7f0ff', paperInk: '#14062a', paperCard: '#ffffff', paperLine: '#e2d2f7', paperMute: '#6f5a92',
    accent: '#ff2bd6', accentInk: '#14062a', accentOnPaper: '#c4119f', accent2: '#22e4ff', accent3: '#ffe93b', red: '#ff4d6d',
    accentFont: MONO, accentStyle: 'normal', headWeight: 900, headTrack: '-.02em', headCase: 'uppercase', radius: 0.6, surfaces: 'dark', deco: 'grid',
  },
  {
    ...JAKE, id: 'terminal', name: 'Terminal', blurb: 'Green phosphor on black, monospace, scanlines',
    ink: '#020a05', fg: '#c9ffd9', card: '#06140b', card2: '#0a1d11', line: '#14361f', mute: '#6fbf88', faint: '#3f7a52',
    paper: '#e8f7ec', paperInk: '#03200f', paperCard: '#f6fff8', paperLine: '#bfe3c9', paperMute: '#3f7a52',
    accent: '#39ff88', accentInk: '#02170a', accentOnPaper: '#0d8a42', accent2: '#00d1ff', accent3: '#39ff88', red: '#ff5f56',
    sans: MONO, display: MONO, accentFont: MONO, accentStyle: 'normal', headWeight: 700, headTrack: '-.03em', radius: 0.25, surfaces: 'dark', deco: 'scan',
  },
  {
    ...JAKE, id: 'sunset', name: 'Sunset', blurb: 'Warm plum dusk with orange-to-pink glow',
    ink: '#1a0a1e', fg: '#fff1ea', card: '#26112b', card2: '#311736', line: '#46243f', mute: '#c49aa8', faint: '#8a6273',
    paper: '#fff1e8', paperInk: '#2a0f22', paperCard: '#ffffff', paperLine: '#f3d6c8', paperMute: '#8f6674',
    accent: '#ff7a45', accentInk: '#2a0f22', accentOnPaper: '#d4511d', accent2: '#ff3d7f', accent3: '#ffc145', red: '#ff3d5a',
    display: SORA, accentFont: FRAUNCES, headWeight: 800, headTrack: '-.04em', radius: 1.3, surfaces: 'dark', deco: 'sun',
  },
  {
    ...JAKE, id: 'mint', name: 'Mint', blurb: 'Fresh light mint, deep green ink, soft rounded cards',
    ink: '#0d2b22', fg: '#eafff6', card: '#123a2e', card2: '#17463a', line: '#22584a', mute: '#8cc7b3', faint: '#5b9a85',
    paper: '#effaf5', paperInk: '#0d2b22', paperCard: '#ffffff', paperLine: '#cdeadf', paperMute: '#4f7f70',
    accent: '#10b981', accentInk: '#ffffff', accentOnPaper: '#0b8a60', accent2: '#34d3c0', accent3: '#a3e635', red: '#f43f5e',
    display: SORA, accentFont: FRAUNCES, headWeight: 700, headTrack: '-.035em', radius: 1.6, surfaces: 'light', deco: 'dots',
  },
  {
    ...JAKE, id: 'swiss', name: 'Swiss', blurb: 'White, heavy black type, one red, square corners',
    ink: '#111111', fg: '#ffffff', card: '#1b1b1b', card2: '#242424', line: '#333333', mute: '#a0a0a0', faint: '#6e6e6e',
    paper: '#ffffff', paperInk: '#111111', paperCard: '#f3f3f3', paperLine: '#dddddd', paperMute: '#6e6e6e',
    accent: '#ff3b30', accentInk: '#ffffff', accentOnPaper: '#e0261c', accent2: '#111111', accent3: '#ff3b30', red: '#ff3b30',
    accentFont: INTER, accentStyle: 'normal', headWeight: 900, headTrack: '-.055em', radius: 0, surfaces: 'light', deco: 'grid',
  },
  {
    ...JAKE, id: 'royal', name: 'Royal', blurb: 'Deep purple and gold, elegant serif headlines',
    ink: '#160c2b', fg: '#f7f0e1', card: '#20143a', card2: '#2a1b49', line: '#3b2a5e', mute: '#b3a3cc', faint: '#7d6a9d',
    paper: '#f7f0e1', paperInk: '#1e1035', paperCard: '#fffaf0', paperLine: '#e6d9bd', paperMute: '#7a6a8f',
    accent: '#e8b84a', accentInk: '#1e1035', accentOnPaper: '#9a7212', accent2: '#c08bff', accent3: '#e8b84a', red: '#ff6b6b',
    display: DMSERIF, accentFont: DMSERIF, headWeight: 400, headTrack: '-.02em', radius: 0.8, surfaces: 'dark', deco: 'glow',
  },
  {
    ...JAKE, id: 'ocean', name: 'Ocean', blurb: 'Deep teal water, aqua and sky-blue light, soft waves',
    ink: '#031b22', fg: '#e8fbff', card: '#082a33', card2: '#0b3540', line: '#134552', mute: '#83b9c4', faint: '#4f8390',
    paper: '#e8f8fb', paperInk: '#03242c', paperCard: '#ffffff', paperLine: '#c6e8ef', paperMute: '#4c7d88',
    accent: '#2dd4bf', accentInk: '#03242c', accentOnPaper: '#0f8f80', accent2: '#38bdf8', accent3: '#a5f3fc', red: '#fb7185',
    display: SORA, headWeight: 800, headTrack: '-.04em', radius: 1.2, surfaces: 'alternate', deco: 'waves',
  },
  {
    ...JAKE, id: 'mono', name: 'Monochrome', blurb: 'Pure black and white, high contrast, no colour at all',
    ink: '#0c0c0c', fg: '#f2f2f0', card: '#171717', card2: '#202020', line: '#2f2f2f', mute: '#9a9a9a', faint: '#666666',
    paper: '#ebebe8', paperInk: '#0c0c0c', paperCard: '#ffffff', paperLine: '#d0d0cc', paperMute: '#6a6a6a',
    accent: '#ffffff', accentInk: '#0c0c0c', accentOnPaper: '#0c0c0c', accent2: '#bdbdbd', accent3: '#ffffff', red: '#ff5a4e',
    surfaces: 'alternate', deco: 'lines',
  },
];

export const DEFAULT_TEMPLATE: TemplateId = 'jake';
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
export const isTemplateId = (v: unknown): v is TemplateId => typeof v === 'string' && BY_ID.has(v as TemplateId);

/**
 * The template a dive renders in. Unset: a demo show is Jake's brand, a
 * classic dive keeps the aurora look it always had.
 */
export function templateFor(id: string | null | undefined, format: 'v1' | 'v2' = 'v2'): DeckTemplate {
  if (id && BY_ID.has(id as TemplateId)) return BY_ID.get(id as TemplateId)!;
  return format === 'v1' ? BY_ID.get('aurora')! : JAKE;
}

const mix = (c: string, pct: number, with_ = 'transparent') => `color-mix(in srgb, ${c} ${pct}%, ${with_})`;

/** A background pattern for a surface, in --u so it scales with the frame. */
function decoImage(deco: Deco, t: DeckTemplate, light: boolean): string {
  const ink = light ? t.paperInk : t.fg;
  switch (deco) {
    case 'dots': return `radial-gradient(circle, ${mix(ink, light ? 16 : 26)} 6%, transparent 8%)`;
    case 'grid': return `linear-gradient(${mix(light ? t.paperInk : t.accent2, light ? 7 : 14)} 1px, transparent 1px), linear-gradient(90deg, ${mix(light ? t.paperInk : t.accent2, light ? 7 : 14)} 1px, transparent 1px)`;
    case 'lines': return `repeating-linear-gradient(0deg, ${mix(ink, light ? 8 : 7)} 0 1px, transparent 1px 100%)`;
    case 'scan': return `repeating-linear-gradient(0deg, ${mix(t.accent, 6)} 0 1px, transparent 1px 3px), radial-gradient(ellipse at 50% 40%, ${mix(t.accent, 10)}, transparent 70%)`;
    case 'glow': return `radial-gradient(ellipse 70% 60% at 85% 0%, ${mix(t.accent, light ? 18 : 22)}, transparent 70%), radial-gradient(ellipse 60% 50% at 0% 100%, ${mix(t.accent2, light ? 14 : 18)}, transparent 70%)`;
    case 'aurora': return `radial-gradient(ellipse 60% 55% at 10% 0%, ${mix(t.accent, light ? 22 : 34)}, transparent 70%), radial-gradient(ellipse 55% 50% at 95% 100%, ${mix(t.accent2, light ? 18 : 26)}, transparent 70%), radial-gradient(ellipse 35% 35% at 60% 45%, ${mix(t.accent3, light ? 8 : 12)}, transparent 70%)`;
    case 'sun': return `radial-gradient(ellipse 80% 70% at 100% 100%, ${mix(t.accent, light ? 22 : 30)}, transparent 65%), radial-gradient(ellipse 60% 60% at 0% 0%, ${mix(t.accent2, light ? 12 : 18)}, transparent 70%)`;
    case 'waves': return `repeating-radial-gradient(ellipse at 50% 140%, transparent 0 2.6%, ${mix(light ? t.paperInk : t.accent, light ? 8 : 13)} 2.6% 2.8%), radial-gradient(ellipse at 50% 0%, ${mix(t.accent2, light ? 10 : 16)}, transparent 70%)`;
    default: return 'none';
  }
}

/** The CSS variables a template sets on a `.dd2` (v2) or `.dd-stage` (v1) root. */
export function templateStyle(t: DeckTemplate, flavor: 'v1' | 'v2', opts: { paper?: boolean } = {}): CSSProperties {
  const v: Record<string, string | number> = {
    '--ink': t.ink, '--fg': t.fg, '--card': t.card, '--card-2': t.card2, '--line': t.line, '--mute': t.mute, '--faint': t.faint,
    '--paper': t.paper, '--paper-ink': t.paperInk, '--paper-card': t.paperCard, '--paper-line': t.paperLine, '--paper-mute': t.paperMute,
    '--yellow': t.accent, '--accent-ink': t.accentInk, '--accent-paper': t.accentOnPaper, '--accent-2': t.accent2, '--red': t.red,
    '--sans': t.sans, '--display': t.display, '--serif': t.accentFont, '--mono': t.mono,
    '--head-w': t.headWeight, '--head-track': t.headTrack, '--head-case': t.headCase, '--it-style': t.accentStyle, '--r': t.radius,
    '--deco-dark': decoImage(t.deco, t, false), '--deco-paper': decoImage(t.deco, t, true),
  };
  if (flavor === 'v1') {
    const light = !!opts.paper;
    Object.assign(v, {
      '--dd-a': t.accent, '--dd-b': t.accent2, '--dd-c': t.accent3, '--dd-d': t.accent,
      '--dd-bg': light ? t.paper : t.ink,
      '--dd-fg': light ? t.paperInk : t.fg,
      '--dd-dim': mix(light ? t.paperInk : t.fg, 64),
      '--dd-faint': mix(light ? t.paperInk : t.fg, 40),
      '--dd-line': mix(light ? t.paperInk : t.fg, 13),
      '--dd-card': light ? mix(t.paperCard, 80) : mix(t.fg, 5),
      '--dd-display': t.display,
      '--dd-sans': t.sans,
      '--dd-head-w': t.headWeight,
      '--dd-deco': t.deco === 'aurora' ? 'none' : decoImage(t.deco, t, light),
    });
  }
  return v as CSSProperties;
}

/** Whether a v2 chapter sits on the light surface, by the template's rhythm. */
export function paperFor(t: DeckTemplate, index: number, isTitle: boolean): boolean {
  if (isTitle) return false;
  if (t.surfaces === 'dark') return false;
  if (t.surfaces === 'light') return true;
  return index % 2 === 0;
}
