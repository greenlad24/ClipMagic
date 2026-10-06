/**
 * AI News Stream — the on-screen STAGE of a Daily Show story (Jake, 2026-10-06:
 * "make AI News presentations look and feel more like Deep Dives: beats,
 * micro-interactions and a real presentation style for each story, rather than
 * something that looks like a website").
 *
 * A story is shown as a COVER (headline, source, one-line lede) followed by
 * 1–2 SCENES. Each scene is a Deep Dive v2 chapter (same kinds, same data
 * shapes — see src/news/deepdive/v2/types.ts and server deepDiveV2.ts), so the
 * web draws it with the Deep Dive's own ChapterView. Jake steps through the
 * beats with →; the teleprompter never moves on a beat.
 *
 * Only the kinds that need no captured media are used here (a Daily Show
 * build does not download or cut anything): reveal, stats, versus, flow,
 * timeline, list, quote. The story's official video stays where it was — its
 * own full-screen layer, opened with Shift.
 *
 * Stored on the slide as `stage_json`. A slide without one (decks built before
 * this) is drawn from its presenter notes by the web's fallback.
 */
import { callNewsModel } from "./ai.js";

export const STAGE_KINDS = ["reveal", "stats", "versus", "flow", "timeline", "list", "quote"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export interface StageScene {
  kind: StageKind;
  eyebrow: string;
  /** May mark ONE accent phrase with *asterisks*. */
  heading: string;
  island: { q: string; a: string } | null;
  data: Record<string, unknown>;
}

export interface StoryStage {
  v: 1;
  cover: { eyebrow: string; heading: string; lede: string };
  scenes: StageScene[];
  /**
   * For each → after the cover: the few words of the script at which Jake
   * presses it. Length = total beats − 1 (may be shorter; the presenter shows
   * what there is).
   */
  cues: string[];
}

/* ── normalisation (never trust the model's JSON shape) ───────────────────── */

const s = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?[\d,]*\.?\d+$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return null;
};
const TONES = new Set(["dark", "light", "brand", "blue"]);

/** One accent at most: keep the first *pair*, drop any other asterisks. */
function oneAccent(text: string): string {
  const m = text.match(/\*([^*]+)\*/);
  const plain = text.replace(/\*/g, "");
  if (!m) return plain;
  const i = plain.indexOf(m[1]);
  return i < 0 ? plain : `${plain.slice(0, i)}*${m[1]}*${plain.slice(i + m[1].length)}`;
}

function sceneData(kind: StageKind, d: any): Record<string, unknown> | null {
  switch (kind) {
    case "reveal": {
      const cards = arr(d?.cards).slice(0, 3).map((c) => {
        const countTo = num(c?.countTo);
        return {
          name: s(c?.name, 40), tag: s(c?.tag, 24), big: s(c?.big, 40) || (countTo !== null ? String(countTo) : ""),
          countTo, prefix: s(c?.prefix, 6), suffix: s(c?.suffix, 10), small: s(c?.small, 80), note: s(c?.note, 80),
          tone: TONES.has(c?.tone) ? c.tone : "dark",
        };
      }).filter((c) => c.name && c.big);
      if (cards.length < 2) return null;
      return { cards, good: arr(d?.good).map((x) => s(x, 30)).filter(Boolean).slice(0, 4), bad: arr(d?.bad).map((x) => s(x, 30)).filter(Boolean).slice(0, 4) };
    }
    case "stats": {
      const stats = arr(d?.stats).slice(0, 3).map((x) => {
        const value = num(x?.value);
        return { value, display: value === null ? s(x?.display, 16) : "", prefix: s(x?.prefix, 6), suffix: s(x?.suffix, 10), label: s(x?.label, 60) };
      }).filter((x) => x.label && (x.value !== null || x.display));
      return stats.length ? { stats } : null;
    }
    case "versus": {
      const options = arr(d?.options).slice(0, 3).map((o) => ({ name: s(o?.name, 30), line: s(o?.line, 90), points: arr(o?.points).map((p) => s(p, 50)).filter(Boolean).slice(0, 3) })).filter((o) => o.name && o.line);
      return options.length >= 2 ? { options } : null;
    }
    case "flow": {
      const steps = arr(d?.steps).slice(0, 4).map((x) => ({ label: s(x?.label, 20), text: s(x?.text, 60) })).filter((x) => x.label && x.text);
      return steps.length >= 2 ? { steps } : null;
    }
    case "timeline": {
      const events = arr(d?.events).slice(0, 5).map((e) => ({ date: s(e?.date, 16), label: s(e?.label, 36), detail: s(e?.detail, 60), soon: e?.soon === true })).filter((e) => e.date && e.label);
      return events.length >= 2 ? { events } : null;
    }
    case "list": {
      const items = arr(d?.items).map((x) => s(x, 70)).filter(Boolean).slice(0, 5);
      return items.length >= 2 ? { items } : null;
    }
    case "quote": {
      const quote = s(d?.quote, 240);
      return quote ? { quote, who: s(d?.who, 40), role: s(d?.role, 60) } : null;
    }
  }
}

/** Beats in one scene — mirrors the web's v2 `beatCount` for these kinds. */
export function sceneBeats(sc: StageScene): number {
  const d = sc.data as any;
  const n = (() => {
    switch (sc.kind) {
      case "reveal": return arr(d.cards).length + (arr(d.good).length || arr(d.bad).length ? 1 : 0);
      case "stats": return arr(d.stats).length;
      case "versus": return arr(d.options).length;
      case "flow": return arr(d.steps).length;
      case "timeline": return arr(d.events).length;
      case "list": return arr(d.items).length;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

/** Total → presses for a story = the cover + every scene's beats. */
export const stageBeats = (st: StoryStage): number => 1 + st.scenes.reduce((a, sc) => a + sceneBeats(sc), 0);

/** Clean whatever the model returned into a StoryStage, or null when nothing usable is left. */
export function normalizeStage(raw: unknown): StoryStage | null {
  const r = (raw ?? {}) as any;
  const scenes: StageScene[] = [];
  for (const x of arr(r.scenes).slice(0, 4)) {
    if (scenes.length >= 2) break;
    const kind = x?.kind as StageKind;
    if (!(STAGE_KINDS as readonly string[]).includes(kind)) continue;
    const data = sceneData(kind, x?.data);
    if (!data) continue;
    const heading = oneAccent(s(x?.heading, 70));
    if (!heading) continue;
    const q = s(x?.island?.q, 40), a = s(x?.island?.a, 30);
    scenes.push({ kind, eyebrow: s(x?.eyebrow, 40), heading, island: q && a ? { q, a } : null, data });
  }
  if (!scenes.length) return null;
  const coverHeading = oneAccent(s(r.cover?.heading, 80));
  const st: StoryStage = {
    v: 1,
    cover: { eyebrow: s(r.cover?.eyebrow, 50), heading: coverHeading, lede: s(r.cover?.lede, 180) },
    scenes,
    cues: [],
  };
  st.cues = arr(r.cues).map((c) => s(c, 80)).slice(0, stageBeats(st) - 1);
  return st;
}

/* ── generation ───────────────────────────────────────────────────────────── */

const KINDS = `SCENE KINDS — each scene is ONE full screen: a small header (eyebrow, heading, optional question→answer "island" chip) above one big stage that steps through BEATS as Jake presses →. Text on screen is TINY — Jake explains out loud; the screen shows the one thing to look at.
- "flow": what happened, as a 2-4 step mini story. data {"steps":[{"label":"1-2 words","text":"max 6 words — readable in one second"}]} — one step per beat.
- "reveal": 2-3 cards revealed one per beat (price, who gets it, what's new, the catch, the verdict). data {"cards":[{"name":"max 3 words","tag":"1-2 words or empty","big":"$20 or max 4 words","countTo":20,"prefix":"$","suffix":"/mo","small":"optional, max 8 words","note":"","tone":"dark|light|brand|blue"}],"good":["optional: who CAN use it, 1-3 words each"],"bad":["optional: who can't"]} — countTo is a plain number ONLY when big is that number, else null.
- "stats": 1-3 numbers, one per beat, each fills the screen with a count-up. data {"stats":[{"value":4000,"display":"","prefix":"","suffix":"+","label":"max 8 words"}]} — value null + display (e.g. "2×") when it isn't a plain number.
- "versus": 2-3 things compared, one highlighted per beat. data {"options":[{"name":"max 3 words","line":"max 12 words","points":["max 3, max 6 words each"]}]}
- "timeline": 2-5 dated events. data {"events":[{"date":"Sep 29","label":"max 4 words","detail":"max 7 words","soon":false}]} — soon=true for a date still ahead.
- "list": 2-5 short items, one lights up per beat. data {"items":["max 8 words"]}
- "quote": a REAL quote from the source material, word for word (never invent one). data {"quote":"max 30 words","who":"Name","role":"Title, Company"}`;

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
  const prompt = `You design the on-screen visuals for ONE story of Jake Dawson's live AI news show. The audience is regular people curious about AI tools (a 14-year-old must get every screen at a glance). The look is Jake's Deep Dive style: minimal, bold, one idea per screen, a few words per beat, numbers that count up, cards that reveal one at a time.

The story is shown as a COVER, then 1-2 SCENES. Jake reads the script below from a teleprompter and presses → to reveal the next beat. The beats must follow the ORDER of the script, so what appears matches what he is saying at that moment.

${KINDS}

RULES:
1. Facts only from the source material and the script. Never invent numbers, prices, dates, names or quotes. If the story has no real numbers, don't use "stats"; if no real quote, don't use "quote".
2. 1 scene for a small story, 2 for a big one. Pick the kinds that SHOW this story best; don't default to "list". Different scenes use different kinds.
3. Total beats after the cover: 3-7.
4. Headings: max 6 words, plain words, may mark ONE accent word or short phrase with *asterisks* (it renders in italic serif with a yellow underline). No period at the end.
5. island (optional): a tiny question → answer chip, e.g. {"q":"Free?","a":"Not yet"} — max 4 words each side. Null if nothing fits.
6. eyebrow: 1-4 words, like a label ("WHAT HAPPENED", "WHO GETS IT", "THE CATCH").
7. cover.heading: the story in max 8 everyday words with one *accent* — not the news headline copied. cover.lede: one sentence, max 18 words, why a regular person should care. cover.eyebrow: 1-4 words (e.g. "Model release", "Rumor", "Robotics").
8. cues: for each → after the cover, in order, copy 3-6 words EXACTLY from the script where Jake should press it (the moment that beat's content starts being said). One cue per beat.
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
{"cover":{"eyebrow":"...","heading":"...","lede":"..."},"scenes":[{"kind":"flow","eyebrow":"...","heading":"...","island":null,"data":{...}}],"cues":["...","..."]}`;

  try {
    const t = await callNewsModel(prompt, "news-notes", "research");
    const json = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1).replace(/,\s*([}\]])/g, "$1");
    return normalizeStage(JSON.parse(json));
  } catch {
    return null;
  }
}
