/**
 * AI News Stream — the on-screen STAGE of a Daily Show story.
 *
 * Every story runs SOURCE → INFO: the source article full screen (sourceShot.ts;
 * Jake scrolls it himself), then the info slides designed here. The story's
 * video is NOT a beat: Shift shows it full screen over any beat. The Deep Dive
 * stays the special, rich format at the end of the show; these slides are
 * drawn in the AI News templates (web daily/stage/newsTemplates.ts).
 *
 * v3 (Jake, 2026-10-07: "I would like the presentation slides to be maybe 2
 * or 3 slides per story (I can skim past them a little bit quicker) and they
 * should be designed really great including animations — just different from
 * the deep dive"): 2–3 slides per story, each ONE idea in ONE beat — the whole
 * slide arrives on one → press with its own entrance animation (web
 * StoryShow.tsx / story.css). So a story is 3–4 presses: source + its slides.
 *
 * Stored on the slide as `stage_json`, v3:
 *   { v: 3, cover, scenes: [{ kind, eyebrow, heading, data, cue }] }
 * — ONE cue per slide (= per beat), checked here against the script with the
 * presenter's own forward search (web cues.tsx `placeCue`); a cue that isn't in
 * the script, in order, is stored as '' and the web re-makes it from the
 * script or drops the slide (web story.ts `reconcile`), so beats == cues.
 * v2 (1–2 slides, one item per beat) and v1 stages still render on the web.
 */
import { callNewsModel } from "./ai.js";
import { L, SHORT_WORDS, clip, clipList, spec } from "./textLimits.js";

export const STAGE_KINDS = ["number", "quote", "meaning", "compare", "timeline", "facts", "picture"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export interface StageScene {
  kind: StageKind;
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  data: Record<string, unknown>;
  /** The script words where Jake presses → for this slide; '' = not found (the web re-makes it). */
  cue: string;
}

export interface StoryStage {
  v: 3;
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
    case "number": {
      const value = num(d?.value);
      const out = { value, display: value === null ? clip(d?.display, L.statDisplay) : "", prefix: s(d?.prefix, 4), suffix: s(d?.suffix, 8), label: clip(d?.label, L.numLabel), context: clip(d?.context, L.numContext) };
      return out.label && (out.value !== null || out.display) ? out : null;
    }
    case "quote": {
      const quote = clip(d?.quote, L.quote, true);
      return quote ? { quote, who: clip(d?.who, L.who), role: clip(d?.role, L.role) } : null;
    }
    case "meaning":
      return { text: clip(d?.text, L.meaningText) };
    case "compare": {
      const sides = arr(d?.sides ?? d?.options).slice(0, 2).map((o) => ({ name: clip(o?.name, L.vsName), big: clip(o?.big, L.cmpBig), line: clip(o?.line, L.cmpLine) })).filter((o) => o.name && (o.big || o.line));
      return sides.length === 2 ? { sides } : null;
    }
    case "timeline": {
      const events = arr(d?.events).slice(0, 4).map((e) => ({ date: clip(e?.date, L.tlDate), label: clip(e?.label, L.tlLabel), soon: e?.soon === true })).filter((e) => e.date && e.label);
      return events.length >= 2 ? { events } : null;
    }
    case "facts": {
      const items = clipList(d?.items, L.fact, 3);
      return items.length >= 2 ? { items } : null;
    }
    case "picture":
      return { caption: clip(d?.caption, L.picCaption) };
  }
}

/** Beats in one scene — v3: always ONE (the slide arrives whole). Mirrors the web's `sceneItems` (daily/stage/story.ts). */
export const sceneBeats = (_sc: { kind: string; data: Record<string, unknown> }): number => 1;

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
  const used = new Set<string>();
  for (const x of arr(r.scenes ?? r.slides).slice(0, 5)) {
    if (scenes.length >= 3) break;
    const kind = x?.kind as StageKind;
    if (!(STAGE_KINDS as readonly string[]).includes(kind)) continue;
    // Every slide a different kind (two "meaning" slides in a row read as one slide twice).
    if (used.has(kind)) continue;
    const data = sceneData(kind, x?.data);
    if (!data) continue;
    // A "what it means" slide's heading IS the statement — longer than a heading.
    const heading = oneAccent(clip(x?.heading, kind === "meaning" ? L.meaning : L.heading).replace(/\.\s*$/, ""));
    // The number / quote slides can stand without one (the number or the quote is the idea).
    if (!heading && kind !== "number" && kind !== "quote") continue;
    used.add(kind);
    scenes.push({ kind, eyebrow: clip(x?.eyebrow, L.eyebrow), heading, data, cue: s(x?.cue ?? arr(x?.cues)[0], 80) });
  }
  if (!scenes.length) return null;
  const coverHeading = oneAccent(clip(r.cover?.heading, L.coverHeading).replace(/\.\s*$/, ""));
  // One pass over every cue in show order.
  const all = checkCues(script, scenes.map((sc) => sc.cue));
  scenes.forEach((sc, i) => { sc.cue = all[i]; });
  return {
    v: 3,
    cover: { eyebrow: clip(r.cover?.eyebrow, L.eyebrow), heading: coverHeading, lede: clip(r.cover?.lede, L.coverLede) },
    scenes,
  };
}

/* ── generation ───────────────────────────────────────────────────────────── */

// The word/character limits come from textLimits.ts — the same numbers the normaliser trims to.
const KINDS = `SLIDE KINDS — each slide is ONE full screen with ONE idea, and it arrives WHOLE on one → press (one slide = one beat). Text on screen is SHORT — Jake explains out loud; the screen shows the one thing to remember. Every text field has a HARD limit (words AND characters); anything longer is cut off, so write to fit.
- "number": ONE real number, huge. heading = a short label for Jake's notes (may be ""). data {"value":4000,"display":"","prefix":"$","suffix":"+","label":"what the number is — ${spec(L.numLabel)}","context":"optional, one line that makes it hit home — ${spec(L.numContext)}"} — value null + display (e.g. "2×", "#1", ${spec(L.statDisplay)}) when it isn't a plain number. A big number in its SHORT form: value 12 + suffix "B" (not 12000000000), value 4.5 + suffix "M".
- "quote": a REAL quote from the source material, word for word (never invent one). heading may be "". data {"quote":"${spec(L.quote)} — the strongest part","who":"Name","role":"Title, Company"}
- "meaning": WHAT IT MEANS for a regular person. heading = the statement itself, ${spec(L.meaning)}, plain words, one *accent*. data {"text":"one line under it — ${spec(L.meaningText)}"}
- "compare": two things side by side (old vs new, free vs paid, them vs a rival). The SECOND side is highlighted: put the new one / the story's one second. data {"sides":[{"name":"${spec(L.vsName)}","big":"the key value, ${spec(L.cmpBig)} (e.g. \"Free\", \"$20/mo\", \"2×\")","line":"${spec(L.cmpLine)}"},{...}]} — exactly 2 sides.
- "timeline": 2-4 dated moments. data {"events":[{"date":"Sep 29","label":"${spec(L.tlLabel)}","soon":false}]} — soon=true for a date still ahead.
- "facts": 2-3 key facts that belong together. data {"items":["${spec(L.fact)}"]}
- "picture": the source page's own main picture (its photo, product shot or screenshot — you don't need to see it), big, with the heading beside it. USE IT as the FIRST slide whenever the story is about something you can see: a robot, a device, an app or product launch, a new feature, a named person (a hire, a CEO). data {"caption":"${spec(L.picCaption)}"}`;

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
  const prompt = `You design the on-screen slides for ONE story of Jake Dawson's live AI news show. The audience is regular people curious about AI tools (a 14-year-old must get every screen at a glance).

Each story on screen runs in this order, and Jake presses → to move on:
  beat 0 — the source article, full screen (automatic; nothing to design)
  then   — 2 or 3 SLIDES, one → press each. Bold, editorial, news-style: each slide is ONE strong idea Jake can skim past quickly. Never a slide that needs reading.
Jake reads the script below from a teleprompter; the slides must follow the ORDER of the script, so each slide appears as he starts talking about its idea.

${KINDS}

RULES:
1. Facts only from the source material and the script. Never invent numbers, prices, dates, names or quotes. No real number → no "number" slide; no real quote → no "quote" slide.
2. 2 slides for a small story, 3 for a big one. Every slide a DIFFERENT kind (never two of the same). A good arc: what happened (number / picture / timeline / facts) → the detail (compare / quote / facts) → "meaning" last (what it means for a regular person).
3. Headings: ${spec(L.heading)} (a "meaning" statement: ${spec(L.meaning)}), plain words, may mark ONE key word or short phrase with *asterisks* (it is set in the template's accent colour). No period at the end.
4. eyebrow: ${spec(L.eyebrow)}, a label ("WHAT HAPPENED", "BY THE NUMBERS", "IN THEIR WORDS", "WHAT IT MEANS", "THE CATCH").
5. cover (used for the presenter's labels and when the source page can't be shown): heading = the story in everyday words, ${spec(L.coverHeading)}, one *accent*; lede = one sentence, ${spec(L.coverLede)}, why a regular person should care; eyebrow = ${spec(L.eyebrow)} (e.g. "Model release", "Rumor", "Robotics").
6. CUES — where Jake presses →. Each slide has ONE "cue": 3-6 words copied EXACTLY, letter for letter, from the script (no paraphrase, no added or dropped words) — the words where that slide's idea starts being said. The cues are in script order: slide 1's, then slide 2's, then slide 3's. Never use words of the first sentence (that is the source beat).
7. ${SHORT_WORDS}
8. No banned hype words: game-changer, revolutionary, groundbreaking, unleash, supercharge, seamless.

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
{"cover":{"eyebrow":"...","heading":"...","lede":"..."},"scenes":[{"kind":"number","eyebrow":"...","heading":"...","data":{...},"cue":"exact script words"}]}`;

  try {
    const t = await callNewsModel(prompt, "news-notes", "research");
    const json = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1).replace(/,\s*([}\]])/g, "$1");
    return normalizeStage(JSON.parse(json), input.script);
  } catch {
    return null;
  }
}
