/**
 * A v2 dive is stored in the same sections table as v1: one row per chapter,
 * with `kind` a v2 ChapterKind and the island inside `data.island`.
 */
import type { Section } from '../api';
import type { Chapter, ChapterData, ChapterKind, Island } from './types';

export function sectionsToChapters(sections: Section[]): Chapter[] {
  return sections.map((s) => {
    const data = (s.data ?? {}) as ChapterData & { island?: Island | null };
    const { island = null, ...rest } = data;
    return {
      id: s.id,
      position: s.position,
      kind: s.kind as unknown as ChapterKind,
      eyebrow: s.eyebrow,
      heading: s.heading,
      island: island && island.q && island.a ? island : null,
      data: rest,
      script: s.script,
    };
  });
}

export const CHAPTER_LABEL: Record<ChapterKind, string> = {
  title: 'Title', demo: 'Live demo', clip: 'Official video', article: 'Official post', reveal: 'Reveal cards',
  stats: 'Numbers', versus: 'Versus', flow: 'Story steps', timeline: 'Timeline', list: 'List', quote: 'Quote', takeaways: 'Takeaways',
};
