/**
 * What the Deep Dive presenter's Notes view and beat bar say about a section:
 * the item each → press brings in (its "beat label"), and the page to open in
 * the Source tab. Both formats: v2 chapters and classic (v1) slides.
 */
import type { DeepDive, Section } from './api';
import type { ChapterData } from './v2/types';

const clean = (t: unknown): string => (typeof t === 'string' ? t.replace(/\*/g, '').trim() : typeof t === 'number' ? String(t) : '');

/** One entry per beat of the section (may be shorter than the beat count; callers fall back to the heading). */
export function beatItems(sec: Section, v2: boolean): string[] {
  if (v2) {
    const d = (sec.data ?? {}) as ChapterData;
    switch (sec.kind as string) {
      case 'demo': return (d.tabs ?? []).flatMap((t) => t.steps.map((s) => clean(s.caption) || clean(s.label) || t.name));
      case 'clip': return (d.clips ?? []).map((c) => clean(c.caption) || clean(c.label));
      case 'article': return (d.article?.highlights ?? []).map((h) => clean(h.caption));
      case 'reveal': return [...(d.cards ?? []).map((c) => clean(c.name) || clean(c.big)), ...((d.good?.length || d.bad?.length) ? ['Good / bad'] : [])];
      case 'stats': return (d.stats ?? []).map((s) => `${clean(s.display) || clean(s.value)} ${clean(s.label)}`.trim());
      case 'versus': return (d.options ?? []).map((o) => clean(o.name));
      case 'flow': return (d.steps ?? []).map((s) => clean(s.label));
      case 'timeline': return (d.events ?? []).map((e) => clean(e.label) || clean(e.date));
      case 'list': return (d.items ?? []).map(clean);
      case 'takeaways': return (d.points ?? []).map(clean);
      case 'quote': return [d.who ? `Quote · ${clean(d.who)}` : 'Quote'];
      default: return [];
    }
  }
  const x = sec.data ?? {};
  switch (sec.kind) {
    case 'statement': return x.highlight?.length ? [clean(x.text) || 'Statement', x.highlight.map(clean).join(' · ')] : [];
    case 'stats': return (x.stats ?? []).map((s) => `${clean(s.display) || clean(s.value)} ${clean(s.label)}`.trim());
    case 'bullets': case 'takeaways': return (x.points ?? []).map(clean);
    case 'timeline': return (x.events ?? []).map((e) => clean(e.label) || clean(e.date));
    case 'compare': return (x.rows ?? []).map((r) => clean(r.label));
    case 'bars': return (x.bars ?? []).map((b) => clean(b.label));
    case 'quote': return [x.who ? `Quote · ${clean(x.who)}` : 'Quote'];
    default: return [];
  }
}

/** The page the Source tab opens for this section: its own source, else the dive's best one. */
export function sectionSourceUrl(sec: Section | undefined, v2: boolean, dive: DeepDive | null): string {
  if (sec) {
    if (v2) {
      const d = (sec.data ?? {}) as ChapterData;
      if (d.article?.url) return d.article.url;
    } else {
      if (sec.data?.source?.url) return sec.data.source.url;
      if (sec.visual?.sourceUrl) return sec.visual.sourceUrl;
    }
  }
  const src = dive?.sources ?? [];
  return (src.find((s) => s.official && s.url) ?? src.find((s) => s.url))?.url ?? '';
}
