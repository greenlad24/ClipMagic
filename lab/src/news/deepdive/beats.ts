/**
 * Beats for CLASSIC (v1) slides — Jake, 2026-10-06: "classic slides don't have
 * beats; add beats and micro-interactions working exactly the way they do in
 * demo slides". A slide's items build in one per → press (bullets, numbers,
 * timeline events, comparison rows, bars); the stepping, the flat sync index,
 * the teleprompter's [next] parts and the "same slide keeps the script still"
 * rule are the v2 code itself (v2/types.ts + v2/beatSync.ts), fed BeatUnits.
 *
 * Mirrored on the server in server/src/news/deepDiveBeats.ts
 * (`sectionBeatCountOf`) so the script gets the right number of [next] marks.
 */
import type { Section } from './api';
import type { BeatUnit } from './v2/types';

/** How many → presses a classic slide takes (always ≥ 1). */
export function sectionBeatCount(s: Section): number {
  const x = s.data || {};
  const n = (() => {
    switch (s.kind) {
      case 'statement': return x.highlight?.length ? 2 : 1;
      case 'stats': return x.stats?.length ?? 0;
      case 'bullets': case 'takeaways': return x.points?.length ?? 0;
      case 'timeline': return x.events?.length ?? 0;
      case 'compare': return x.rows?.length ?? 0;
      case 'bars': return x.bars?.length ?? 0;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

export const sectionsToUnits = (sections: Section[]): BeatUnit[] =>
  sections.map((s) => ({ id: s.id, script: s.script, beats: sectionBeatCount(s) }));
