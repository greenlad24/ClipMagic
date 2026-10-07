/**
 * What the PUBLIC follower page reads for a Deep Dive live session (Jake,
 * 2026-10-06: the deep dive presenter gets the Daily Show's "Follower link").
 *
 * Same trust model as the Daily Show's follower feed (routes.ts
 * `followerRouter`): the live session's random id is the credential, and this
 * returns ONLY that dive's teleprompter material — per section a one-line
 * label, its beat count and its script split at the [next] marks. Never the
 * research, sources, visuals, media, notes or any other dive.
 *
 * ⚠️ THE SYNC INDEX OF A DEEP DIVE IS A BEAT, NOT A SECTION (web
 * deepdive/v2/types.ts `flatten`). The follower page needs each section's beat
 * count to turn that index back into "section 4, beat 2", so the counts here
 * MUST be the web's: v2 chapters `beatCountOf` (deepDiveV2.ts mirrors
 * `beatCount`), classic slides `sectionBeatCountOf` over the SAME normalised
 * data the web sees (`sectionOut`). A different count puts the phone on a
 * different section from the presenter.
 */
import { deepDives, sectionsOf, sectionOut } from "./deepDive.js";
import { beatCountOf } from "./deepDiveV2.js";
import { sectionBeatCountOf } from "./deepDiveBeats.js";

const V1_LABEL: Record<string, string> = {
  title: "Title", statement: "Big statement", stats: "Numbers", bullets: "Key points", timeline: "Timeline",
  compare: "Comparison", bars: "Bar chart", quote: "Quote", media: "Video", takeaways: "Takeaways",
};
const V2_LABEL: Record<string, string> = {
  title: "Title", demo: "Live demo", clip: "Official video", article: "Official post", reveal: "Reveal cards",
  stats: "Numbers", versus: "Versus", flow: "Story steps", timeline: "Timeline", list: "List", quote: "Quote", takeaways: "Takeaways",
};

export interface FollowerSection {
  id: string;
  /** "Live demo · How it books the flight" — the presenter's label minus the counters. */
  label: string;
  /** "Next → …" line under the script. */
  heading: string;
  beats: number;
  /** One script part per beat (mirror of the web's `scriptParts`). */
  parts: string[];
  /**
   * The marker line opening each part ("▶ BEAT 2 · PRICING · LAST"; [0] = ''),
   * made by the presenter's own code (web presenter/beatMarks.ts, bundled into
   * dist/news/cue-marks.js). Empty when that bundle is missing — the page then
   * writes "▶ BEAT n" itself.
   */
  marks: string[];
}

/** Mirror of the web's v2/types.ts `scriptParts`. */
export function scriptPartsOf(script: string, n: number): string[] {
  const parts = (script || "").split(/\s*\[next\]\s*/i);
  if (parts.length > n) return [...parts.slice(0, n - 1), parts.slice(n - 1).join(" ")];
  while (parts.length < n) parts.push("");
  return parts;
}

/** The follower's view of a deep dive, or null when `id` is not a deep dive. */
export function deepDiveFollowerSlides(
  id: string,
  markLines?: ((sec: unknown, v2: boolean, beats: number) => string[]) | null,
): { title: string; sections: FollowerSection[] } | null {
  const d = deepDives.get(id);
  if (!d) return null;
  const v2 = d.format === "v2";
  const sections = sectionsOf(id).map((r) => {
    const s = sectionOut(r, v2);
    const kind = String(s.kind);
    const beats = v2 ? beatCountOf(kind, s.data) : sectionBeatCountOf(kind, s.data);
    const kindLabel = (v2 ? V2_LABEL[kind] : V1_LABEL[kind]) || kind;
    const heading = (s.heading || "").replace(/\*/g, "");
    return {
      id: s.id,
      label: heading ? `${kindLabel} · ${heading}` : kindLabel,
      heading: heading || kindLabel,
      beats,
      parts: scriptPartsOf(s.script, beats),
      marks: (() => { try { return markLines ? markLines(s, v2, beats) : []; } catch { return []; } })(),
    };
  });
  return { title: d.title || d.topic || "", sections };
}
