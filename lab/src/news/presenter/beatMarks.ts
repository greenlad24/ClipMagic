/**
 * The Deep Dive teleprompter's BEAT MARKER LINES, written exactly like the AI
 * News ones (Jake, 2026-10-07: "the UX should be basically the same so there's
 * no confusion for the presenter"): "▶ BEAT n · TITLE", " · LAST" on the
 * section's last beat — the one after which → needs a double press, as on a
 * story's last beat. n counts the PRESSES inside the section (the part the
 * n-th → brings in), the AI News numbering; the title is the item that press
 * reveals (presenterNotes.ts beatItems) held to ≤ 4 words (beatTitle.ts).
 *
 * Pure (no React, no DOM): the server bundles it with cueMarks.ts so the
 * public follower page shows the same lines (routes.ts followerRouter).
 */
import type { Section } from '../deepdive/api';
import { beatItems } from '../deepdive/presenterNotes';
import { shortTitle } from '../daily/stage/beatTitle';

/** One marker line per beat of the section: [0] is '' (the opening part has none). */
export function ddBeatMarks(sec: Section, v2: boolean, beats: number): string[] {
  const items = beatItems(sec, v2);
  const out: string[] = [''];
  for (let b = 1; b < beats; b++) {
    const title = shortTitle(items[b] || '');
    const last = b === beats - 1;
    out.push(`▶ BEAT ${b}${title ? ` · ${title}` : ''}${last ? ' · LAST' : ''}`.toUpperCase());
  }
  return out;
}
