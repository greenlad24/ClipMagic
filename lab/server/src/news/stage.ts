/**
 * AI News Stream — the on-screen STAGE of a Daily Show story.
 *
 * 2026-10-07 (Jake): every story runs SOURCE → INFO — the source article
 * scrolling full screen (sourceShot.ts, not designed here), then "some info on
 * slides": 1–2 simple info slides revealed one item per → press. The story's
 * video is NOT a beat: Shift shows it full screen over any beat. The Deep Dive stays the special,
 * rich format at the end of the show; these slides are deliberately plainer
 * and are drawn in the AI News templates (web daily/stage/newsTemplates.ts).
 *
 * Stored on the slide as `stage_json`, v2:
 *   { v: 2, cover, scenes: [{ kind, eyebrow, heading, data, cues[] }] }
 * (Stages built earlier on 2026-10-07 may also carry a `videoCue` — the web ignores it.)
 * — ONE cue per beat, attached to the beat it starts (so a cue can't go
 * missing the way v1's single flat list did: the model wrote 4–6 cues for
 * 6–8 beats). Every cue is checked against the script here with the same
 * forward search the presenter uses (web cues.tsx `placeCue`); a cue that
 * isn't in the script, in order, is stored as '' and the web re-makes it from
 * the script or merges the beat (web story.ts `reconcile`). v1 stages (cover +
 * scenes + flat cues) still render.
 */
import { callNewsModel } from "./ai.js";
import { L, SHORT_WORDS, clip, clipList, spec } from "./textLimits.js";

export const STAGE_KINDS = ["list", "stats", "versus", "flow", "timeline", "quote"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export interface StageScene {
  kind: StageKind;
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  data: Record<string, unknown>;
  /** One per beat (item) of the scene: the script words where Jake presses → for it; '' = not found (the web re-makes it). */
  cues: string[];
}

export interface StoryStage {
  v: 2;
  /** The title card (shown when the source page could not be captured) + the presenter's labels. */
  cover: { eyebrow: string; heading: string; lede: string };
  scenes: StageScene[];
}

/* ── normalisation (never trust the model's JSON shape) ───────────────────── */

const s = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?[\d,]*\.?\d+$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return null;
};

/** One accent at most: keep the first *pair*, drop any other asterisks. */
function oneAccent(text: string): string {
  const m = text.match(/\*([^*]+)\*/);
  const plain = text.replace(/\*/g, "");
  if (!m) return plain;
  const i = plain.indexOf(m[1]);
  return i < 0 ? plain : `${plain.slice(0, i)}*${m[1]}*${plain.slice(i + m[1].length)}`;
}

// Every on-screen string is trimmed to its limit (textLimits.ts) at a word boundary.
function sceneData(kind: StageKind, d: any): Record<string, unknown> | null {
  switch (kind) {
    case "stats": {
      const stats = arr(d?.stats).slice(0, 3).map((x) => {
        const value = num(x?.value);
        return { value, display: value === null ? clip(x?.display, L.statDisplay) : "", prefix: s(x?.prefix, 4), suffix: s(x?.suffix, 8), label: clip(x?.label, L.statLabel) };
      }).filter((x) => x.label && (x.value !== null || x.display));
      return stats.length ? { stats } : null;
    }
    case "versus": {
      const options = arr(d?.options).slice(0, 3).map((o) => ({ name: clip(o?.name, L.vsName), line: clip(o?.line, L.vsLine), points: clipList(o?.points, L.vsPoint, 3) })).filter((o) => o.name && o.line);
      return options.length >= 2 ? { options } : null;
    }
    case "flow": {
      const steps = arr(d?.steps).slice(0, 4).map((x) => ({ label: clip(x?.label, L.flowLabel), text: clip(x?.text, L.flowText) })).filter((x) => x.label && x.text);
      return steps.length >= 2 ? { steps } : null;
    }
    case "timeline": {
      const events = arr(d?.events).slice(0, 5).map((e) => ({ date: clip(e?.date, L.tlDate), label: clip(e?.label, L.tlLabel), detail: clip(e?.detail, L.tlDetail), soon: e?.soon === true })).filter((e) => e.date && e.label);
      return events.length >= 2 ? { events } : null;
    }
    case "list": {
      const items = clipList(d?.items, L.listItem, 5);
      return items.length >= 2 ? { items } : null;
    }
    case "quote": {
      const quote = clip(d?.quote, L.quote, true);
      return quote ? { quote, who: clip(d?.who, L.who), role: clip(d?.role, L.role) } : null;
    }
  }
}

/** Beats in one scene = its items — mirrors the web's `sceneItems` (daily/stage/story.ts). */
export function sceneBeats(sc: { kind: string; data: Record<string, unknown> }): number {
  const d = sc.data as any;
  const n = (() => {
    switch (sc.kind) {
      case "stats": return arr(d.stats).length;
      case "versus": return arr(d.options).length;
      case "flow": return arr(d.steps).length;
      case "timeline": return arr(d.events).length;
      case "list": return arr(d.items).length;
      case "reveal": return arr(d.cards).length;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

/* ── cues: the presenter's own search (web daily/stage/cues.tsx — keep in step) ── */

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function placeCue(script: string, cue: string, from: number): { start: number; end: number } | null {
  const words = cue.replace(/[“”"]/g, " ").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "")).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map((w) => esc(w).replace(/['’‘]/g, "['’‘]")).join("[^\\p{L}\\p{N}]+"), "giu");
  re.lastIndex = Math.max(0, from);
  const m = re.exec(script);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}
export const cueSearchStart = (script: string): number => Math.max(1, script.match(/^\s*\S+/)?.[0].length ?? 1);

/** Keep each cue only when the script has it after the previous kept one. */
function checkCues(script: string, list: string[]): string[] {
  let from = cueSearchStart(script);
  return list.map((c) => {
    const m = c ? placeCue(script, c, from) : null;
    if (!m) return "";
    from = m.end;
    return c;
  });
}

/** Clean whatever the model returned into a StoryStage, or null when nothing usable is left. `script` checks the cues. */
export function normalizeStage(raw: unknown, script = ""): StoryStage | null {
  const r = (raw ?? {}) as any;
  const scenes: StageScene[] = [];
  for (const x of arr(r.scenes).slice(0, 4)) {
    if (scenes.length >= 2) break;
    const kind = x?.kind as StageKind;
    if (!(STAGE_KINDS as readonly string[]).includes(kind)) continue;
    const data = sceneData(kind, x?.data);
    if (!data) continue;
    const heading = oneAccent(clip(x?.heading, L.heading).replace(/\.\s*$/, ""));
    if (!heading) continue;
    const sc: StageScene = { kind, eyebrow: clip(x?.eyebrow, L.eyebrow), heading, data, cues: [] };
    sc.cues = Array.from({ length: sceneBeats(sc) }, (_, b) => s(arr(x?.cues)[b], 80));
    scenes.push(sc);
  }
  if (!scenes.length) return null;
  const coverHeading = oneAccent(clip(r.cover?.heading, L.coverHeading).replace(/\.\s*$/, ""));
  // One pass over every cue in show order.
  const all = checkCues(script, scenes.flatMap((sc) => sc.cues));
  for (const sc of scenes) sc.cues = all.splice(0, sc.cues.length);
  return {
    v: 2,
    cover: { eyebrow: clip(r.cover?.eyebrow, L.eyebrow), heading: coverHeading, lede: clip(r.cover?.lede, L.coverLede) },
    scenes,
  };
}

/* ── generation ───────────────────────────────────────────────────────────── */

// The word/character limits come from textLimits.ts — the same numbers the normaliser trims to.
const KINDS = `INFO SLIDE KINDS — each is ONE full screen: a small label (eyebrow) and a heading above a few ITEMS that appear one per → press (one item = one beat). Text on screen is TINY — Jake explains out loud; the screen shows the one thing to look at. Every text field has a HARD limit (words AND characters); anything longer is cut off, so write to fit.
- "flow": what happened, as a 2-4 step mini story. data {"steps":[{"label":"${spec(L.flowLabel)}","text":"${spec(L.flowText)} — readable in one second"}]} — one step per beat.
- "stats": 1-3 real numbers, one per beat. data {"stats":[{"value":4000,"display":"","prefix":"","suffix":"+","label":"${spec(L.statLabel)}"}]} — value null + display (e.g. "2×", ${spec(L.statDisplay)}) when it isn't a plain number.
- "versus": 2-3 things compared, one highlighted per beat. data {"options":[{"name":"${spec(L.vsName)}","line":"${spec(L.vsLine)}","points":["max 3 points, ${spec(L.vsPoint)} each"]}]}
- "timeline": 2-5 dated events. data {"events":[{"date":"Sep 29","label":"${spec(L.tlLabel)}","detail":"${spec(L.tlDetail)}","soon":false}]} — soon=true for a date still ahead.
- "list": 2-5 short items, one lights up per beat. data {"items":["${spec(L.listItem)}"]}
- "quote": a REAL quote from the source material, word for word (never invent one). data {"quote":"${spec(L.quote)} — pick the strongest part","who":"Name","role":"Title, Company"}`;

/** Build the stage for one story. Never throws; null = keep the web's fallback. */
export async function generateStageForStory(input: {
  headline: string;
  status: string;
  sourceName: string;
  sourceLines: string;
  script: string;
  keyPoints: string[];
  whyItMatters: string;
}): Promise<StoryStage | null> {
  const prompt = `You design the on-screen info slides for ONE story of Jake Dawson's live AI news show. The audience is regular people curious about AI tools (a 14-year-old must get every screen at a glance).

Each story on screen runs in this order, and Jake presses → to move on:
  beat 0 — the source article, full screen (automatic; nothing to design)
  then   — 1-2 INFO SLIDES: plain, minimal, "some info on slides". A few facts, one item per → press.
These are deliberately SIMPLE (the show's special, rich presentation is the Deep Dive at the end — don't imitate it). Jake reads the script below from a teleprompter; the items must follow the ORDER of the script, so what appears matches what he is saying at that moment.

${KINDS}

RULES:
1. Facts only from the source material and the script. Never invent numbers, prices, dates, names or quotes. If the story has no real numbers, don't use "stats"; if no real quote, don't use "quote".
2. 1 info slide for a small story, 2 for a big one. Pick the kind that shows the facts best; different slides use different kinds.
3. Total items across the info slides: 2-5.
4. Headings: ${spec(L.heading)}, plain words, may mark ONE key word or short phrase with *asterisks* (it is set in the template's accent colour). No period at the end.
5. eyebrow: ${spec(L.eyebrow)}, a label ("WHAT HAPPENED", "WHO GETS IT", "THE CATCH").
6. cover (used for the presenter's labels and when the source page can't be shown): heading = the story in everyday words, ${spec(L.coverHeading)}, one *accent*; lede = one sentence, ${spec(L.coverLede)}, why a regular person should care; eyebrow = ${spec(L.eyebrow)} (e.g. "Model release", "Rumor", "Robotics").
7. CUES — where Jake presses →. Copy 3-6 words EXACTLY, letter for letter, from the script (no paraphrase, no added or dropped words):
   - each info slide has "cues": EXACTLY one per item, in the same order as its items — the words where that item starts being said.
   - All cues together are in script order: slide 1's cues, then slide 2's. Never reuse words of the first sentence (that is the source beat).
8. ${SHORT_WORDS}
9. No banned hype words: game-changer, revolutionary, groundbreaking, unleash, supercharge, seamless.

STORY: "${input.headline}"
STATUS: ${input.status || "unknown"}${/rumou?r|unconfirmed|single/i.test(input.status) ? " — say it's unconfirmed somewhere on screen" : ""}
SOURCE: ${input.sourceName || "unknown"}

KEY POINTS:
${input.keyPoints.map((k) => `- ${k}`).join("\n") || "(none)"}
WHY IT MATTERS: ${input.whyItMatters || "(none)"}

SOURCE MATERIAL:
${input.sourceLines || "(none)"}

SCRIPT JAKE READS:
${input.script || "(no script — follow the key points)"}

Respond ONLY with JSON (no markdown):
{"cover":{"eyebrow":"...","heading":"...","lede":"..."},"scenes":[{"kind":"flow","eyebrow":"...","heading":"...","data":{...},"cues":["one per item","..."]}]}`;

  try {
    const t = await callNewsModel(prompt, "news-notes", "research");
    const json = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1).replace(/,\s*([}\]])/g, "$1");
    return normalizeStage(JSON.parse(json), input.script);
  } catch {
    return null;
  }
}
