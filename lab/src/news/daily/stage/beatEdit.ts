/**
 * ✎ Edit script for a Daily Show story, BEAT BY BEAT (Jake 2026-10-13: "Edits
 * should not affect the script's beats. If needed or it helps, a beat can have
 * a separate editable field within the controller script slide").
 *
 * `beatParts` cuts the story's script where each beat starts (the same cut the
 * teleprompter's ▶ BEAT markers show); the presenter edits each part in its own
 * box; `joinBeatParts` puts the script back together and LOCKS each beat on the
 * first words of its box (story.ts `beatCues`) — so whatever is added or cut,
 * every beat still starts exactly where its box starts. It then rebuilds the
 * stage from the new script and refuses the save if any beat moved, merged or
 * dropped. Pure: no React, no DOM.
 */
import type { Slide } from '../../api';
import { storyStage, cueAt } from './story';
import { cueMarks } from './cueMarks';
import { findCues, placeCue, cueSearchStart } from './cueFind';

export interface BeatPart {
  /** 0 = the source beat (before the first marker). */
  beat: number;
  /** The marker line, e.g. "▶ BEAT 2 · WHAT FOUNDERS GET · LAST"; beat 0: "SOURCE". */
  mark: string;
  text: string;
}

/** The whitespace each part ended with, so an unedited join gives back the very same script. */
const tailOf = (t: string) => t.match(/\s*$/)![0];

export function beatParts(slide: Slide): BeatPart[] {
  const script = slide.teleprompterScript || '';
  const marks = cueMarks(slide).filter((m) => m.start > 0 && m.start < script.length);
  const out: BeatPart[] = [];
  let from = 0;
  let mark: (typeof marks)[number] | null = null;
  for (const m of [...marks, null]) {
    // a cue's match starts at its first letter: an opening quote/bracket just before it belongs to that beat's box
    let to = m ? m.start : script.length;
    if (m) while (to > from && /["“‘'(\[]/.test(script[to - 1]) && (to - 1 === 0 || /\s/.test(script[to - 2]))) to--;
    out.push({ beat: mark ? mark.beat : 0, mark: mark ? mark.mark : '▶ SOURCE', text: script.slice(from, to) });
    if (m) { from = to; mark = m; }
  }
  return out;
}

/** The new script + the locked cues — or why it can't be saved without moving a beat. */
export function joinBeatParts(slide: Slide, parts: BeatPart[], texts: string[]): { script: string; beatCues: string[] } | { error: string } {
  const before = storyStage(slide);
  const empty = texts.findIndex((t, k) => k > 0 && !/[\p{L}\p{N}]/u.test(t));
  if (empty > 0) return { error: `Beat ${parts[empty].beat} is empty — every beat needs at least a few words (its slide comes in on them).` };

  // Join, keeping the original gap after each part (a space when the edit removed it).
  let script = '';
  const starts: number[] = [];
  texts.forEach((t, k) => {
    const body = k === 0 ? t.trimEnd() : t.trim();
    starts.push(script.length);
    script += body;
    // (an unchanged box keeps its exact join, even with no space before the next one)
    if (k < texts.length - 1) script += tailOf(parts[k].text) || (t.trimEnd() === parts[k].text.trimEnd() ? '' : ' ');
  });

  // Each beat's cue = the first words of its box, as the presenter's forward search finds them.
  // one entry per stage item, merged ones included ('' = no cue of its own)
  const lock = new Array<string>(before.items).fill('');
  let from = 0;
  for (let k = 1; k < parts.length; k++) {
    const beat = before.beats[parts[k].beat];
    if (!beat || beat.item < 0) return { error: 'This story changed while you were editing — close and open the editor again.' };
    // the cue starts at the box's first letter/number (a leading quote mark stays with the words)
    const lead = script.slice(starts[k]).search(/[\p{L}\p{N}$]/u);
    const p = starts[k] + Math.max(0, lead);
    const search = beat.item === 0 ? cueSearchStart(script) : from;
    const made = cueAt(script, p, search, script.length, [4, 5, 6, 8, 3, 10, 14, 2, 1]);
    if (!made) return { error: `Beat ${parts[k].beat}'s first words also appear earlier in the script — start that beat a little differently.` };
    lock[beat.item] = made.cue;
    from = made.end;
  }

  // Prove it: the stage rebuilt from the new script has the same beats, each starting at its box.
  const after = storyStage({ ...slide, teleprompterScript: script, beatCues: JSON.stringify(lock) });
  const same = after.beats.length === before.beats.length && after.beats.every((b, i) => b.label === before.beats[i].label && b.screen === before.beats[i].screen && b.upTo === before.beats[i].upTo);
  const spans = findCues(script, after.cues);
  const placed = spans.length === parts.length - 1 && spans.every((sp, i) => placeCue(script, after.cues[i], sp.start)?.start === sp.start && sp.start >= starts[i + 1] && sp.start < (starts[i + 2] ?? script.length + 1));
  if (!same || !placed) return { error: 'Saving this would move a beat. Make sure each box still starts with its own words, then try again.' };
  return { script, beatCues: lock };
}
