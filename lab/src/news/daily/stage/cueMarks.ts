/**
 * The cue marks of one story's teleprompter script and the BEAT MARKER LINES
 * between its parts (Jake, 2026-10-07):
 *   · "beat titles should be included in the teleprompter view (on the main
 *     /notes one and on the follower screens)"
 *   · "The beat titles should be written and placed exactly as the deep dive
 *     presentation. 'Beat 1 - xxx...' not too many words — maximum 3-4 words"
 *   · the story's LAST beat in its own colour — "it can be in purple and not
 *     alarming". Visual only: the software does not decide what Jake does
 *     there (stall, or Shift for the video).
 *
 * PLACED LIKE THE DEEP DIVE (DeepDivePresenterPage): the script is split at
 * each cue's first word into PARTS (`scriptParts`); part 0 is the source beat,
 * and every later part opens with a one-line marker "▶ BEAT n · TITLE" in the
 * Deep Dive's marker style. The marker IS part of the layout, so both screens
 * draw the same blocks with the same fixed sizes (NotesPage + followerPage.ts
 * `.beat-mark.news`) and break the script's lines identically; the marker is
 * one line ALWAYS (nowrap + ellipsis), so a long title can never wrap on one
 * screen and not the other.
 *
 * ONE function, two renderers: the presenter (NotesPage) imports it, and the
 * server bundles THIS FILE (scripts/build-pipeline.mjs → dist/news/cue-marks.js)
 * and hands its marks to the public follower page with the scripts. Keep it
 * pure: no React, no DOM.
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
  /** That beat's short title (≤ 4 words, beatTitle.ts). */
  title: string;
  /** The story's last beat — the press after it goes to the next story. */
  last: boolean;
  /** The marker line's text, e.g. "▶ BEAT 2 · WHAT FOUNDERS GET · LAST". */
  mark: string;
}

/** The next cue's colour (unchanged) and the LAST beat's — a calm violet, never an alarm. */
export const CUE_COLOR = { next: '#ffd21e', last: '#b69cff', lastLater: 'rgba(182,156,255,0.6)' } as const;

/** `slide`'s cue marks. (`_nextTitle` kept for the call sites; the one-line marker has no room for it.) */
export function cueMarks(slide: Slide | null | undefined, _nextTitle?: string | null): CueMark[] {
  if (!slide) return [];
  const stage = storyStage(slide);
  const spans = findCues(slide.teleprompterScript || '', stage.cues);
  const lastBeat = stage.beats.length - 1;
  return spans.map((s) => {
    const title = stage.beats[s.beat]?.short || '';
    const last = s.beat === lastBeat;
    const mark = `▶ BEAT ${s.beat}${title ? ` · ${title}` : ''}${last ? ' · LAST' : ''}`.toUpperCase();
    return { start: s.start, end: s.end, beat: s.beat, title, last, mark };
  });
}

/**
 * The script's paragraphs and where each starts in the whole script — the ONE
 * split both renderers use (the follower page's PARA_SPLIT is this regex).
 */
export const PARA_SPLIT = /\n\s*\n/;
export function scriptParas(script: string, base = 0): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let off = 0;
  for (const raw of script.split(PARA_SPLIT)) {
    const at = script.indexOf(raw, off);
    off = at + raw.length;
    const text = raw.trim();
    if (text) out.push({ text, start: base + at + (raw.length - raw.trimStart().length) });
  }
  return out;
}

export interface ScriptPart {
  /** The beat this part is spoken in (0 = the source beat). */
  beat: number;
  /** The marker that opens it (none for part 0). */
  mark: CueMark | null;
  paras: { text: string; start: number }[];
}

/**
 * The script cut at each cue's first word: part 0 (the source beat), then one
 * part per cue, opened by that cue's marker. The follower page does exactly
 * this (followerPage.ts `scriptParts`).
 */
export function scriptParts(script: string, marks: CueMark[]): ScriptPart[] {
  const cuts = marks.filter((m) => m.start > 0 && m.start < script.length);
  const out: ScriptPart[] = [];
  let from = 0;
  let mark: CueMark | null = null;
  for (const m of [...cuts, null]) {
    const to = m ? m.start : script.length;
    out.push({ beat: mark ? mark.beat : 0, mark, paras: scriptParas(script.slice(from, to), from) });
    if (m) { from = m.start; mark = m; }
  }
  return out;
}
