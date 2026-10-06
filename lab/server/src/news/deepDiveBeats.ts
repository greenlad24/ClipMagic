/**
 * Deep Dive BEATS on the server — the [next] marks in a script and how many a
 * section needs. Shared by both formats (no import cycle: deepDive.ts and
 * deepDiveV2.ts both import from here).
 *
 * Classic (v1) slides got beats on 2026-10-06 (Jake: "add beats and
 * micro-interactions to classic slides, working exactly the way they do in
 * demo slides"): each item on a slide builds in on its own → press, and the
 * script carries one [next] mark per press so the teleprompter lines up.
 * `sectionBeatCountOf` mirrors the web's src/news/deepdive/beats.ts.
 */

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** How many → presses a classic slide takes (always ≥ 1). Mirror of the web's `sectionBeatCount`. */
export function sectionBeatCountOf(kind: string, data: any): number {
  const n = (() => {
    switch (kind) {
      case "statement": return arr(data?.highlight).length ? 2 : 1;
      case "stats": return arr(data?.stats).length;
      case "bullets": case "takeaways": return arr(data?.points).length;
      case "timeline": return arr(data?.events).length;
      case "compare": return arr(data?.rows).length;
      case "bars": return arr(data?.bars).length;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

/** Make a script carry exactly beats−1 [next] marks (merge extras, split at sentences when short). */
export function fitMarkers(text: string, beats: number): string {
  let parts = text.split(/\s*\[next\]\s*/i).map((x) => x.trim()).filter(Boolean);
  if (beats <= 1) return parts.join(" ");
  if (parts.length > beats) parts = [...parts.slice(0, beats - 1), parts.slice(beats - 1).join(" ")];
  while (parts.length < beats) {
    // Split the longest part at the sentence boundary nearest its middle.
    let li = 0;
    parts.forEach((p, i) => { if (p.length > parts[li].length) li = i; });
    const p = parts[li];
    const sentences = p.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [p];
    if (sentences.length < 2) { parts.splice(li + 1, 0, ""); continue; }
    const half = Math.ceil(sentences.length / 2);
    parts.splice(li, 1, sentences.slice(0, half).join("").trim(), sentences.slice(half).join("").trim());
  }
  return parts.join(" [next] ");
}
