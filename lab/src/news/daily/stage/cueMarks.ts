/**
 * The cue marks of one story's teleprompter script, WITH their beat titles
 * (Jake, 2026-10-07: "beat titles should be included in the teleprompter view
 * (on the main /notes one and on the follower screens). Last beat of this
 * story should be highlighted in a different color so I know I need to stall
 * time before the next story").
 *
 * ONE function, two renderers: the presenter (NotesPage) imports it, and the
 * server bundles THIS FILE (scripts/build-pipeline.mjs → dist/news/cue-marks.js)
 * and hands its result to the public follower page with the scripts — so the
 * two screens mark the same words with the same titles, from the same code.
 * Keep it pure: no React, no DOM, nothing the server cannot run.
 *
 * ⚠️ THE TITLE IS NOT TEXT IN THE SCRIPT. Each screen draws it as an
 * absolutely positioned tag inside the cue's span, sitting in the gap above
 * the cue's line — out of flow, so it cannot move a single line break. The
 * scroll sync is a FRACTION of the script's height; a title that took space
 * would put different words at the same fraction on the two screens.
 *
 * The LAST cue (it leads to the story's last beat; the next → goes to the next
 * story) is `last: true` and drawn in its own colour. Visual only — the
 * software does not decide what Jake does there (stall, or Shift for the video).
 */
import type { Slide } from '../../api';
import { storyStage } from './story';
import { findCues } from './cueFind';

export interface CueMark {
  /** Where the cue's words are in the whole script. */
  start: number;
  end: number;
  /** The beat → lands on at this cue (1 = the first slide after the source). */
  beat: number;
  /** That beat's title (the same text as the presenter's "next ‹label›"). */
  label: string;
  /** The story's last beat — the press after it goes to the next story. */
  last: boolean;
  /** What the tag above the cue reads. */
  tag: string;
}

/** The next cue colour (unchanged) and the LAST cue's colour — they must never be confused. */
export const CUE_COLOR = { next: '#ffd21e', last: '#ff5a4e' } as const;

const short = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** `slide`'s cue marks. `nextTitle` = the next story's headline (null on the last story). */
export function cueMarks(slide: Slide | null | undefined, nextTitle: string | null): CueMark[] {
  if (!slide) return [];
  const stage = storyStage(slide);
  const spans = findCues(slide.teleprompterScript || '', stage.cues);
  const lastBeat = stage.beats.length - 1;
  return spans.map((s) => {
    const label = short(stage.beats[s.beat]?.label || '', 60);
    const last = s.beat === lastBeat;
    const tag = last
      ? `■ Last beat · ${label} · ${nextTitle ? `next story: ${short(nextTitle, 48)}` : 'end of the show'}`
      : `▸ ${label}`;
    return { start: s.start, end: s.end, beat: s.beat, label, last, tag };
  });
}

/**
 * The script's paragraphs and where each starts in the whole script — the ONE
 * split both renderers use (the follower page's PARA_SPLIT is this regex), so
 * the paragraphs, and therefore the line breaks, are the same on both.
 */
export const PARA_SPLIT = /\n\s*\n/;
export function scriptParas(script: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let off = 0;
  for (const raw of script.split(PARA_SPLIT)) {
    const at = script.indexOf(raw, off);
    off = at + raw.length;
    const text = raw.trim();
    if (text) out.push({ text, start: at + (raw.length - raw.trimStart().length) });
  }
  return out;
}
