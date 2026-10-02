/**
 * AI News Stream — Deep Dive: ONE topic, researched on the web, turned into an
 * 8–12 section animated presentation that Jake presents live (~10 minutes).
 *
 * Pipeline (streamed as `{ message, percent }` chunks, like the deck build):
 *   1. research  — Claude with server-side web search → a fact pack with sources
 *   2. outline   — the fact pack → 8–12 typed sections (what goes ON SCREEN)
 *   3. script    — one continuous segment in Jake's voice, split per section,
 *                  then the same "14-year-old" review pass the deck uses
 *   4. videos    — the company's own video for each `media` section (video.ts)
 *
 * ⚠️ THE OLD SECTIONS STAY UNTIL THE NEW ONES ARE COMPLETE. A regenerate that
 * fails half-way must not leave Jake with an empty deep dive an hour before the
 * show, so sections are swapped in one transaction at the very end.
 *
 * ⚠️ ON-SCREEN TEXT AND THE SCRIPT ARE DIFFERENT JOBS. The screen carries a few
 * words, a number, a timeline — the script carries the explaining. A section
 * whose screen repeats the script is a teleprompter for the audience.
 *
 * Visuals are pure CSS animation on the client (Jake, 2026-10-01: no AI images).
 */
import { db } from "../db/index.js";
import { makeTable, stories, type StoryRecord } from "./db.js";
import { claudeTextForPurpose } from "../ai/claude.js";
import { callNewsModel } from "./ai.js";
import { JAKE_STYLE_GUIDE } from "./deck.js";
import { findVideoForStory, parseVideoId } from "./video.js";
import { gatherVisuals, type Visual } from "./deepDiveVisuals.js";

db.exec(`
CREATE TABLE IF NOT EXISTS news_deep_dives (
  id TEXT PRIMARY KEY,
  topic TEXT,
  angle TEXT,
  story_id TEXT,
  title TEXT,
  subtitle TEXT,
  status TEXT,
  progress_message TEXT,
  progress_percent REAL,
  error TEXT,
  research_json TEXT,
  sources_json TEXT,
  generated_at TEXT,
  updated_at TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS news_deep_dive_sections (
  id TEXT PRIMARY KEY,
  deep_dive_id TEXT,
  position REAL,
  kind TEXT,
  eyebrow TEXT,
  heading TEXT,
  data_json TEXT,
  script TEXT,
  video_id TEXT,
  video_kind TEXT,
  video_url TEXT,
  video_title TEXT,
  video_channel TEXT,
  video_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_deep_dive_sections_dive ON news_deep_dive_sections (deep_dive_id);
`);

// Visuals (2026-10-01): the dive's pool, and the one each section shows.
const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
if (!hasCol("news_deep_dives", "visuals_json")) db.exec(`ALTER TABLE news_deep_dives ADD COLUMN visuals_json TEXT`);
if (!hasCol("news_deep_dive_sections", "visual_json")) db.exec(`ALTER TABLE news_deep_dive_sections ADD COLUMN visual_json TEXT`);
// v2 (2026-10-02): the chapter show, the demo-agent toggle, and the media
// gathered for it (official video clips, the release post capture).
for (const [c, t] of [["format", "TEXT"], ["demo_agent", "INTEGER"], ["demo_url", "TEXT"], ["media_json", "TEXT"]] as const) {
  if (!hasCol("news_deep_dives", c)) db.exec(`ALTER TABLE news_deep_dives ADD COLUMN ${c} ${t}`);
}

/* ── records ──────────────────────────────────────────────────────────────── */

export type DeepDiveStatus = "draft" | "generating" | "ready" | "error";

export interface DeepDiveRecord {
  id: string;
  topic?: string;
  /** Jake's own notes on the angle to take — optional. */
  angle?: string;
  /** The Daily Show story it was started from, if any. */
  story?: string;
  title?: string;
  subtitle?: string;
  status?: DeepDiveStatus;
  progressMessage?: string;
  progressPercent?: number;
  error?: string;
  researchJson?: string;
  sourcesJson?: string;
  /** The visuals pool (Visual[]) gathered with the research. */
  visualsJson?: string;
  /** "v2" = the chapter show (Jake, 2026-10-02); empty = the v1 slide deck. */
  format?: string;
  /** v2: run the demo agent on the real product while building (1/0). */
  demoAgent?: number;
  demoUrl?: string;
  /** v2: the media catalogue (clip candidates, page capture, demo runs) as JSON. */
  mediaJson?: string;
  generatedAt?: string;
  updatedAt?: string;
  createdAt?: number;
}

export interface DeepDiveSectionRecord {
  id: string;
  deepDive?: string;
  position?: number;
  kind?: SectionKind;
  eyebrow?: string;
  heading?: string;
  /** The kind-specific on-screen content — see `normalizeData`. */
  dataJson?: string;
  script?: string;
  videoId?: string;
  videoKind?: string;
  videoUrl?: string;
  videoTitle?: string;
  videoChannel?: string;
  videoReason?: string;
  /** The visual this section shows (a Visual from the pool), or empty. */
  visualJson?: string;
}

const now = () => Date.now();

export const deepDives = makeTable<DeepDiveRecord>(
  "news_deep_dives",
  {
    topic: ["topic", "text"],
    angle: ["angle", "text"],
    story: ["story_id", "text"],
    title: ["title", "text"],
    subtitle: ["subtitle", "text"],
    status: ["status", "text"],
    progressMessage: ["progress_message", "text"],
    progressPercent: ["progress_percent", "num"],
    error: ["error", "text"],
    researchJson: ["research_json", "text"],
    sourcesJson: ["sources_json", "text"],
    visualsJson: ["visuals_json", "text"],
    format: ["format", "text"],
    demoAgent: ["demo_agent", "num"],
    demoUrl: ["demo_url", "text"],
    mediaJson: ["media_json", "text"],
    generatedAt: ["generated_at", "text"],
    updatedAt: ["updated_at", "text"],
    createdAt: ["created_at", "num"],
  },
  { created_at: now },
);

export const deepDiveSections = makeTable<DeepDiveSectionRecord>(
  "news_deep_dive_sections",
  {
    deepDive: ["deep_dive_id", "text"],
    position: ["position", "num"],
    kind: ["kind", "text"],
    eyebrow: ["eyebrow", "text"],
    heading: ["heading", "text"],
    dataJson: ["data_json", "text"],
    script: ["script", "text"],
    videoId: ["video_id", "text"],
    videoKind: ["video_kind", "text"],
    videoUrl: ["video_url", "text"],
    videoTitle: ["video_title", "text"],
    videoChannel: ["video_channel", "text"],
    videoReason: ["video_reason", "text"],
    visualJson: ["visual_json", "text"],
  },
  { created_at: now },
);

export const sectionsOf = (deepDiveId: string): DeepDiveSectionRecord[] =>
  deepDiveSections.where("deep_dive_id = ? ORDER BY position ASC", deepDiveId);

/**
 * Generations running in THIS process. A row that says "generating" but is not
 * in here was cut off by a restart — `reconcile` turns it into an error the
 * page can show, instead of a spinner that never ends.
 */
const generating = new Set<string>();
export const isGenerating = (id: string): boolean => generating.has(id);
/** v2's run claims the same lock (deepDiveV2.ts). */
export function setGenerating(id: string, on: boolean): void { if (on) generating.add(id); else generating.delete(id); }

export function reconcile(d: DeepDiveRecord | undefined): DeepDiveRecord | undefined {
  if (d && d.status === "generating" && !generating.has(d.id)) {
    const patch = { status: "error" as const, error: "Generation was interrupted (the server restarted). Press Generate to run it again." };
    deepDives.update(d.id, patch);
    return { ...d, ...patch };
  }
  return d;
}

/* ── section kinds + their on-screen data ─────────────────────────────────── */

export const SECTION_KINDS = [
  "title", "statement", "stats", "bullets", "timeline", "compare", "bars", "quote", "media", "takeaways",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const s = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?[\d,]*\.?\d+$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return null;
};

/**
 * Coerce whatever the model (or the editor) sent into the exact shape the
 * renderer expects for that kind. Anything missing becomes empty, never
 * undefined, so a half-formed section still renders instead of throwing on air.
 */
export function normalizeData(kind: SectionKind, raw: unknown): Record<string, unknown> {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  switch (kind) {
    case "title":
      return { subtitle: s(d.subtitle, 200), kicker: s(d.kicker, 80) };
    case "statement":
      return { text: s(d.text, 220), highlight: arr(d.highlight).map((h) => s(h, 60)).filter(Boolean).slice(0, 3) };
    case "stats":
      return {
        stats: arr(d.stats).slice(0, 4).map((x: any) => ({
          value: numOrNull(x?.value),
          display: s(x?.display, 24),
          prefix: s(x?.prefix, 6),
          suffix: s(x?.suffix, 12),
          decimals: Math.max(0, Math.min(2, Math.round(Number(x?.decimals) || 0))),
          label: s(x?.label, 90),
        })).filter((x) => x.label || x.value !== null || x.display),
      };
    case "bullets":
    case "takeaways":
      return { points: arr(d.points).map((p) => s(p, 140)).filter(Boolean).slice(0, 5) };
    case "timeline":
      return {
        events: arr(d.events).slice(0, 7).map((e: any) => ({ date: s(e?.date, 30), label: s(e?.label, 90), detail: s(e?.detail, 140) }))
          .filter((e) => e.date || e.label),
      };
    case "compare": {
      const columns = arr(d.columns).map((c) => s(c, 40)).filter(Boolean).slice(0, 3);
      return {
        columns,
        rows: arr(d.rows).slice(0, 6).map((r: any) => ({
          label: s(r?.label, 50),
          values: columns.map((_, i) => s(arr(r?.values)[i], 70)),
        })).filter((r) => r.label),
        winner: numOrNull(d.winner),
      };
    }
    case "bars":
      return {
        unit: s(d.unit, 20),
        bars: arr(d.bars).slice(0, 7).map((b: any) => ({ label: s(b?.label, 40), value: numOrNull(b?.value) ?? 0, display: s(b?.display, 24) }))
          .filter((b) => b.label),
        highlight: numOrNull(d.highlight),
      };
    case "quote":
      return { quote: s(d.quote, 320), who: s(d.who, 60), role: s(d.role, 80) };
    case "media":
      return {
        caption: s(d.caption, 160),
        videoQuery: s(d.videoQuery, 140),
        source: d.source && typeof d.source === "object"
          ? { outlet: s(d.source.outlet, 60), title: s(d.source.title, 200), url: s(d.source.url, 500) }
          : { outlet: "", title: "", url: "" },
      };
  }
}

/** Kinds whose layout has no room for a visual beside it. */
export const NO_VISUAL = new Set<SectionKind>(["title", "takeaways", "media", "compare", "timeline"]);

const isKind = (k: unknown): k is SectionKind => typeof k === "string" && (SECTION_KINDS as readonly string[]).includes(k);

/** A section row as the pages see it — data parsed. */
export const V2_KINDS = ["title", "demo", "clip", "article", "reveal", "stats", "versus", "flow", "timeline", "list", "quote", "takeaways"] as const;

export function sectionOut(r: DeepDiveSectionRecord, v2 = false) {
  let data: unknown = {};
  try { data = JSON.parse(r.dataJson || "{}"); } catch { /* keep {} */ }
  // v2 chapters carry their own data shape (deepDiveV2.ts) — passed through as stored.
  if (v2) {
    return {
      id: r.id, position: r.position ?? 0, kind: r.kind ?? "list", eyebrow: r.eyebrow ?? "", heading: r.heading ?? "",
      data, script: r.script ?? "", videoId: null, videoKind: null, videoUrl: null, videoTitle: "", videoChannel: "", videoReason: "", visual: null,
    };
  }
  const kind: SectionKind = isKind(r.kind) ? r.kind : "statement";
  let visual: Visual | null = null;
  try { visual = r.visualJson ? (JSON.parse(r.visualJson) as Visual) : null; } catch { /* none */ }
  return {
    id: r.id,
    position: r.position ?? 0,
    kind,
    eyebrow: r.eyebrow ?? "",
    heading: r.heading ?? "",
    data: normalizeData(kind, data),
    script: r.script ?? "",
    videoId: r.videoId ?? null,
    videoKind: r.videoKind ?? null,
    videoUrl: r.videoUrl ?? null,
    videoTitle: r.videoTitle ?? "",
    videoChannel: r.videoChannel ?? "",
    videoReason: r.videoReason ?? "",
    visual: visualOut(r.deepDive, visual),
  };
}

export function deepDiveOut(d: DeepDiveRecord) {
  let sources: unknown[] = [];
  try { sources = JSON.parse(d.sourcesJson || "[]"); } catch { /* keep [] */ }
  let visuals: Visual[] = [];
  try { visuals = JSON.parse(d.visualsJson || "[]"); } catch { /* keep [] */ }
  return {
    id: d.id,
    topic: d.topic ?? "",
    angle: d.angle ?? "",
    storyId: d.story ?? null,
    title: d.title ?? "",
    subtitle: d.subtitle ?? "",
    status: (d.status ?? "draft") as DeepDiveStatus,
    progressMessage: d.progressMessage ?? "",
    progressPercent: d.progressPercent ?? 0,
    error: d.error ?? "",
    sources,
    visuals: visuals.map((v) => visualOut(d.id, v)),
    format: d.format === "v2" ? "v2" : "v1",
    demoAgent: !!d.demoAgent,
    demoUrl: d.demoUrl ?? "",
    generatedAt: d.generatedAt ?? null,
    updatedAt: d.updatedAt ?? null,
    createdAt: d.createdAt ?? 0,
  };
}

/** A pool visual as the pages use it: with the URL its stored file is served at. */
export const visualOut = (diveId: string | undefined, v: Visual | null) =>
  v ? { ...v, src: v.file && diveId ? `/api/news/dd-asset/${diveId}/${v.file}` : "" } : null;

/* ── JSON out of a model reply ────────────────────────────────────────────── */

/**
 * ⚠️ A LONG JSON REPLY IS NOT ALWAYS VALID JSON, AND ONE COMMA MUST NOT COST
 * THE RUN. The first live outline died on "Expected double-quoted property
 * name at position 3507" — a trailing comma — after fifteen minutes of paid
 * research. So: strip trailing commas locally, and if it still won't parse,
 * one cheap fast-tier call fixes the syntax (and only the syntax).
 */
export async function parseJsonReply<T>(text: string, what: string): Promise<T> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`The ${what} step returned no JSON.`);
  const raw = text.slice(start, end + 1);
  const attempts = [raw, raw.replace(/,\s*([}\]])/g, "$1")];
  let lastErr: unknown;
  for (const a of attempts) {
    try { return JSON.parse(a) as T; } catch (err) { lastErr = err; }
  }
  console.warn(`[news-deepdive] ${what} JSON did not parse (${lastErr instanceof Error ? lastErr.message : lastErr}); asking for a syntax repair`);
  try {
    const fixed = await callNewsModel(
      `The JSON below is invalid. Return it as VALID JSON with exactly the same content — fix only the syntax (quotes, commas, brackets, escaping). Output only the JSON.\n\n${raw}`,
      "news-deepdive-outline",
      "fast",
    );
    const fs = fixed.indexOf("{");
    const fe = fixed.lastIndexOf("}");
    return JSON.parse(fixed.slice(fs, fe + 1)) as T;
  } catch (err) {
    throw new Error(`The ${what} step returned JSON that could not be read, even after a repair (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/* ── 1. research ──────────────────────────────────────────────────────────── */

export interface ResearchSource { title: string; url: string; outlet: string; official?: boolean }
export interface ResearchPack {
  summary?: string;
  company?: string;
  facts?: { fact: string; source?: string }[];
  numbers?: { value: string; label: string; source?: string }[];
  timeline?: { date: string; event: string; source?: string }[];
  players?: { name: string; role: string }[];
  comparisons?: { subject: string; points: string[] }[];
  quotes?: { quote: string; who: string; role?: string; source?: string }[];
  everydayImpact?: string[];
  caveats?: string[];
  openQuestions?: string[];
  sources?: ResearchSource[];
}

function seedFromStory(story: StoryRecord | undefined): string {
  if (!story) return "";
  const lines: string[] = [`HEADLINE: ${story.headline ?? ""}`];
  if (story.summary) lines.push(`SUMMARY: ${story.summary}`);
  try {
    for (const b of JSON.parse(story.blogSources || "[]")) lines.push(`${b.isOfficial ? "[OFFICIAL]" : "[BLOG]"} ${b.company}: ${b.title} — ${b.url}`);
  } catch { /* none */ }
  try {
    for (const a of JSON.parse(story.articleSources || "[]").slice(0, 12)) lines.push(`[ARTICLE] ${a.outlet}: ${a.title} — ${a.url}`);
  } catch { /* none */ }
  return lines.join("\n");
}

export async function research(d: DeepDiveRecord, story: StoryRecord | undefined): Promise<ResearchPack> {
  const today = new Date().toISOString().slice(0, 10);
  const seed = seedFromStory(story);
  const prompt = `You are the researcher for a ~10-minute live segment on Jake Dawson's AI show. The segment goes deep on ONE topic for regular people who are curious about AI tools (not engineers).

TOPIC: ${d.topic}
${d.angle ? `JAKE'S NOTES ON THE ANGLE: ${d.angle}\n` : ""}TODAY: ${today}
${seed ? `\nSTARTING POINT — the story on today's news wire and the sources that covered it:\n${seed}\n` : ""}
Search the web and gather what a great 10-minute explainer needs:
- What happened (or what this is), and the background that makes it make sense.
- The key numbers (prices, dates, sizes, user counts, scores) — exactly as the sources state them.
- A timeline of how we got here (dated events).
- Who the players are and what each one wants.
- Comparisons that help: versus the previous version, versus rivals, before vs after.
- What it means for a regular person using AI tools — concrete, everyday.
- Caveats, criticism, what's unconfirmed, what we don't know yet.
- One or two strong quotes from the people involved, word for word.
- ALWAYS include the company's own announcement / blog post among the sources (on the company's own website), marked "official": true.
- Prefer the company's own announcement and tech press (The Verge, TechCrunch, Wired, Ars Technica, MIT Technology Review…) over financial press.

ACCURACY: only report what a source you actually read says. Never invent a number, date, quote or name. If sources disagree, say so in the fact. Mark rumors as rumors.

Reply with ONLY this JSON (no markdown):
{"summary":"3-4 plain sentences","company":"the main company involved, or empty","facts":[{"fact":"...","source":"url"}],"numbers":[{"value":"$20","label":"per month for the Plus plan","source":"url"}],"timeline":[{"date":"Mar 2025","event":"...","source":"url"}],"players":[{"name":"...","role":"..."}],"comparisons":[{"subject":"X vs Y","points":["..."]}],"quotes":[{"quote":"exact words","who":"name","role":"title","source":"url"}],"everydayImpact":["..."],"caveats":["..."],"openQuestions":["..."],"sources":[{"title":"...","url":"...","outlet":"The Verge","official":false}]}
Aim for 12-25 facts, every number you can find, 4-8 timeline events and 6-15 sources.`;

  // ⚠️ RESEARCH RUNS ON THE RESEARCH TIER WITH 5 SEARCHES, NOT OPUS WITH 8.
  // The first live run (Opus, max 8) took FIFTEEN MINUTES: the search tool's
  // dynamic filtering issued 25 searches under that cap, each round re-sending
  // the whole conversation. Gathering facts is not the judgement step — the
  // outline and the script (Opus) are — and a deep dive has to be makeable
  // shortly before a show.
  const text = await claudeTextForPurpose({
    tier: "research",
    purpose: "news-deepdive-research",
    system: "You are the research engine behind a live AI news show. Use web search, then answer in exactly the requested JSON format.",
    messages: [{ role: "user", content: prompt }],
    webSearch: true,
    searchMaxUses: 5,
    maxTokens: 10000,
  });
  const pack = await parseJsonReply<ResearchPack>(text, "research");
  pack.sources = arr(pack.sources)
    .map((x: any) => ({ title: s(x?.title, 200), url: s(x?.url, 600), outlet: s(x?.outlet, 80), official: x?.official === true }))
    .filter((x) => /^https?:\/\//.test(x.url));
  return pack;
}

/* ── 2. outline ───────────────────────────────────────────────────────────── */

interface OutlineSection { kind: string; eyebrow?: string; heading?: string; data?: unknown; beats?: string[]; visual?: string }
interface Outline { title?: string; subtitle?: string; sections?: OutlineSection[] }

const KIND_SPEC = `SECTION KINDS — each section is one full screen. Pick the kind that SHOWS the point best:
- "title": the opener. heading = the deep dive's title (max 8 words). data: {"subtitle":"one line, max 14 words","kicker":"2-4 word label, e.g. 'AI Deep Dive'"}
- "statement": one big idea in a sentence. data: {"text":"max 18 words","highlight":["1-3 exact words or short phrases from text to color"]}
- "stats": 1-4 big numbers. data: {"stats":[{"value":20,"prefix":"$","suffix":"/mo","decimals":0,"label":"max 10 words"}]} — value MUST be a plain number that counts up on screen. If a figure can't be a number (e.g. "Q3 2026"), set "value":null and put it in "display".
- "bullets": a heading + 3-5 short points. data: {"points":["max 10 words each"]}
- "timeline": how we got here. data: {"events":[{"date":"Mar 2025","label":"max 8 words","detail":"optional, max 14 words"}]} — 3-7 events, oldest first.
- "compare": a versus table. data: {"columns":["Old way","New way"],"rows":[{"label":"Price","values":["$20","Free"]}],"winner":null} — 2-3 columns, 3-6 rows, each cell max 6 words. "winner" = index of the column to highlight, or null.
- "bars": a simple bar chart of comparable numbers. data: {"unit":"%","bars":[{"label":"Model A","value":72}],"highlight":0} — 2-7 bars, same unit, from the research only.
- "quote": a real quote from the research, word for word. data: {"quote":"...","who":"Name","role":"Title, Company"}
- "media": the company's own video plays full screen (we search YouTube for it). data: {"caption":"max 12 words","videoQuery":"what the video would be called, e.g. 'OpenAI Sora 2 launch'","source":{"outlet":"...","title":"headline of the best article","url":"..."}} — the source is shown instead when no video exists.
- "takeaways": the closer. heading max 6 words. data: {"points":["3-4 things to remember, max 10 words each"]}`;

/**
 * THE STRUCTURE IS JAKE'S VIDEO STRUCTURE (2026-10-01): payoff first — the
 * product/feature actually working — then "why should you care", then how to
 * use it / how it compares. Not a news timeline that makes the audience sit
 * through background before seeing the thing. The first draft opened on
 * "what happened → how we got here" and put the launch video at section 10.
 */
const STRUCTURE = `STRUCTURE — the same way Jake's videos are built. Payoff first, context later:
1. "title" — the hook. The heading is the most impressive or surprising thing this does, not a news-style label.
2. THE PAYOFF — show it working, right away. If a company video is available (see below), this section is "media" with that video. If not, show the single most impressive concrete thing it does, as a real example ("statement", "stats" or "bullets" with a before → after).
3. WHY YOU SHOULD CARE — what this changes for a regular person using AI tools, with an everyday example. One clear reason, not a list of features.
4+. HOW TO USE IT (where to get it, what it costs, what you'd actually do with it) and/or HOW IT WORKS (simply) and HOW IT COMPARES (vs the old way, vs rivals). Numbers go where they make a point land.
Late: THE CATCH (limits, price, what's unconfirmed, criticism) and WHAT HAPPENS NEXT. Background / "how we got here" only if it is genuinely surprising, and never before the payoff and the why.
Last: "takeaways".

KEEP IT INTERESTING THE WHOLE WAY THROUGH (this is a live show — nobody can skip ahead):
- Every section must reveal something NEW: a number, a result, a twist, a comparison. A section that only restates or sets up context gets cut or merged.
- Re-hook every 2-3 sections: a beat that opens a question the next sections answer ("and the price is where it gets weird — we'll get there").
- Alternate the energy: no two text-heavy sections ("bullets", "statement") back to back; follow a list with something visual ("stats", "compare", "bars", "timeline", "media", "quote").
- Put the strongest material early and save one good surprise for the second half so it doesn't sag.`;

function visualsList(pool: Visual[]): string {
  if (!pool.length) return "VISUALS: none were found — sections stand on their own design.";
  const kindName: Record<string, string> = { image: "screenshot/photo", gif: "GIF", video: "video clip", clip: "moment from the company's video" };
  return `VISUALS POOL — real screenshots, GIFs and demo clips gathered in research (each was checked by eye):
${pool.map((v) => `${v.id}: [${kindName[v.kind] ?? v.kind}] ${v.description} (${v.credit})`).join("\n")}

VISUAL RULES (Jake: "the presentation should always include screenshots or GIFs or video parts of the demonstrations you're talking about"):
- Give EVERY section a "visual" (an id above) that shows what that section is talking about — except "title", "takeaways", "media", "compare" and "timeline", which use "".
- Match by content: a section about how it works shows the UI/demo doing that; a "why you care" section shows the result. Never attach a visual that shows something different from what the section says.
- Use each visual once. If nothing in the pool matches a section, use "" rather than a wrong one.
- Prefer moving visuals (GIF, video clip, moment from the company's video) for demos; screenshots for specific UI details.`;
}

async function outline(d: DeepDiveRecord, pack: ResearchPack, payoff: VideoFields | null, pool: Visual[]): Promise<Outline> {
  const video = payoff && (payoff.videoId || payoff.videoUrl)
    ? `COMPANY VIDEO AVAILABLE for the payoff section (section 2, kind "media"): "${payoff.videoTitle}" by ${payoff.videoChannel || "the company"}. Write that section's caption and beats around what this video shows.`
    : `NO COMPANY VIDEO was found — section 2 shows the payoff with a concrete example instead of "media". Use "media" later only if the research clearly points to another official video.`;
  const prompt = `You are the producer of a ~10-minute live deep-dive segment on Jake Dawson's AI show. Jake presents it; the audience sees an animated, full-screen presentation that steps one section at a time. Design what goes ON SCREEN for each section.

TOPIC: ${d.topic}
${d.angle ? `JAKE'S NOTES ON THE ANGLE: ${d.angle}\n` : ""}
RESEARCH (the only facts you may use):
${JSON.stringify(pack).slice(0, 24000)}

${KIND_SPEC}

${STRUCTURE}

${video}

${visualsList(pool)}

RULES:
1. 8 to 12 sections. The first is "title", the last is "takeaways".
2. Follow the STRUCTURE above. Merge or skip beats the research can't support.
3. Variety: NEVER the same kind twice in a row (check the list before answering — "bullets" then "bullets" is wrong; turn one into a statement, stats, compare or quote). Use at least one "stats", and at least one of "compare" / "bars" / "timeline". Use "quote" only with a real quote from the research.
4. The SCREEN IS NOT THE SCRIPT. On-screen text is short and punchy — a 14-year-old gets it at a glance. Jake does the explaining out loud.
5. Every number, date, name and quote must come from the research. Nothing invented. Rumors get "Rumor:" or "Unconfirmed" in the eyebrow.
6. "eyebrow" = a 1-3 word label above the heading (e.g. "The numbers", "How we got here"). "heading" = max 9 words (for "statement" and "quote" the heading is a short label; the big text is in data).
7. "beats" = 2-4 notes for the scriptwriter: what Jake should say on this section, with the specific facts to use.
8. Plain words. No jargon unless it's the official name the story is about.

Reply with ONLY this JSON (no markdown):
{"title":"max 8 words","subtitle":"max 14 words","sections":[{"kind":"title","eyebrow":"","heading":"","data":{},"beats":["..."],"visual":""}]}`;

  const text = await callNewsModel(prompt, "news-deepdive-outline", "director");
  return await parseJsonReply<Outline>(text, "outline");
}

/* ── 3. script ────────────────────────────────────────────────────────────── */

const SECTION_MARK = /^###\s*SECTION\s+(\d+)\s*$/gim;

export function splitScripts(text: string, count: number): string[] {
  const out: string[] = Array(count).fill("");
  const marks = [...text.matchAll(SECTION_MARK)];
  marks.forEach((m, i) => {
    const n = Number(m[1]) - 1;
    const from = (m.index ?? 0) + m[0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index ?? text.length : text.length;
    if (n >= 0 && n < count) out[n] = text.slice(from, to).trim();
  });
  return out;
}

/**
 * Words per section so the whole segment lands near 1,450 (~10 min at 150 wpm).
 *
 * ⚠️ A TOTAL ALONE IS NOT ENOUGH. The first live run was asked for 1,300–1,600
 * words and came back at 1,006 (~7 min): eleven sections each "about right"
 * sum short. An explicit number per section is what the model actually hits.
 */
export function wordTargets(kinds: SectionKind[]): number[] {
  const TOTAL = 1450;
  const fixed = (k: SectionKind, i: number) =>
    i === 0 && k === "title" ? 80 : i === kinds.length - 1 && k === "takeaways" ? 110 : k === "media" ? 90 : 0;
  const fixedSum = kinds.reduce((a, k, i) => a + fixed(k, i), 0);
  const flexible = kinds.filter((k, i) => fixed(k, i) === 0).length;
  const each = flexible ? Math.max(100, Math.min(200, Math.round((TOTAL - fixedSum) / flexible))) : 0;
  return kinds.map((k, i) => fixed(k, i) || each);
}

function sectionBrief(sections: { kind: SectionKind; eyebrow: string; heading: string; data: unknown; beats: string[]; visual?: Visual | null }[]): string {
  const targets = wordTargets(sections.map((x) => x.kind));
  return sections.map((x, i) =>
    `### SECTION ${i + 1} — ${x.kind.toUpperCase()}${x.eyebrow ? ` · ${x.eyebrow}` : ""} — about ${targets[i]} words\nON SCREEN: ${x.heading}\n${JSON.stringify(x.data)}${x.visual ? `\nVISUAL ON SCREEN NEXT TO IT: ${x.visual.description}` : ""}\nSAY: ${x.beats.join(" | ")}`,
  ).join("\n\n");
}

const DEEP_DIVE_RULES = `THIS IS A DEEP-DIVE SEGMENT, NOT A NEWS SEGMENT:
- One topic, about 10 minutes out loud: 1,350 to 1,600 words in total. Each section below says about how many words it gets — hit those numbers (within ~15%). Running short is the usual failure: ten minutes is long, so explain more, use the research's details and a second everyday example rather than ending sections early.
- The opener (section 1) is a hook that makes a regular person want the next ten minutes: lead with the payoff — the most impressive thing this does. No "welcome back", no "today we're going to", no subscribe/like asks.
- Section 2 is the payoff: show it working. If it's a video, talk over what's on screen ("watch what happens when…") instead of explaining the background. Section 3 answers "why should you care" with an everyday example. Background and history come later, and only if they're interesting.
- Keep it interesting the whole way: every section opens with something new (a result, a number, a twist), and every 2-3 sections a line opens a question the next part answers ("and the price is where this gets weird — we'll get to that"). No section is just setup.
- The closer (last section) lands the takeaways. End with ONE concrete thought, not a summary of everything. No sign-off, no "that's it for today" — the show continues after this.
- It is ONE continuous talk. Each section picks up where the last one left off, with a natural bridge ("So how did we get here?", "Now, here's the catch."). Never restart or re-introduce the topic.
- The audience is looking at the screen. Where a section has a VISUAL ON SCREEN (a real screenshot, GIF or demo clip), talk about what it shows — walk them through it ("see that panel on the right? that's the dot's own browser") the way Jake narrates a demo. Never read on-screen text out word for word — add to it.
- Use 5-9 phrases from the conversational phrase menu across the whole segment, never two in a row, never the same one twice.
- Endings within sections vary. The banned endings and the ban on opening an opinion with "My take" apply to every section.`;

async function writeScripts(d: DeepDiveRecord, pack: ResearchPack, brief: string, count: number): Promise<string[]> {
  const facts = JSON.stringify(pack).slice(0, 20000);
  const prompt = `${JAKE_STYLE_GUIDE}

---

${DEEP_DIVE_RULES}

Write the teleprompter script for this deep-dive segment, section by section. Jake reads it live while the screen shows each section.

TOPIC: ${d.topic}
${d.angle ? `JAKE'S NOTES ON THE ANGLE: ${d.angle}\n` : ""}
THE SECTIONS (what's on screen, and what to say):
${brief}

RESEARCH (the only facts you may use):
${facts}

OUTPUT FORMAT — exactly ${count} sections, each starting with its marker line on its own, then only the words Jake says:
### SECTION 1
(words)
### SECTION 2
(words)
…and so on to ### SECTION ${count}. No other headings, labels, markdown or stage directions.`;

  const draft = await callNewsModel(prompt, "news-deepdive-script", "director");
  const parts = splitScripts(draft, count);
  if (parts.filter(Boolean).length < Math.ceil(count / 2)) throw new Error("The script step did not return the section markers.");

  // The deck's "review while generating" pass, over the whole segment at once
  // so the bridges between sections survive. Falls back to the draft.
  const review = `${JAKE_STYLE_GUIDE}

---

${DEEP_DIVE_RULES}

You are reviewing the teleprompter script for a live deep-dive segment. Rewrite anything that's unclear, stiff, or uses complex language. Aim for a 14-year-old's reading level and a normal American talking to a friend — not a news anchor, not an article being read.

Check every sentence:
1. A word a 14-year-old wouldn't know? Swap it for what the thing does, or cut it. Keep an official term the story is about and explain it right after.
2. A technical detail the viewer doesn't need? Cut the detail and its explanation.
3. An example about running a business or agency? Swap it for an everyday situation.
4. Does each section bridge naturally from the one before? Is anything repeated across sections? Cut repeats.
5. Is any ending a banned ending, or any opinion opened with "My take"? Rewrite it.
6. Total length 1,350-1,600 words, each section near the word count in its brief. If it's SHORT, expand the thinnest sections with more explanation, details from the research or a second everyday example — never with padding or repetition. If it's long, trim padding first.

THE SECTION BRIEF (with each section's word target):
${brief}

Do NOT change: the facts, attributions, rumor labels, the order, or the section markers. Do not add facts that aren't in the research.

RESEARCH (for fact-checking only):
${facts}

SCRIPT TO REVIEW:
${draft}

Output ONLY the final script with the same ### SECTION n marker lines — nothing else.`;
  try {
    const reviewed = await callNewsModel(review, "news-deepdive-script", "director");
    const r = splitScripts(reviewed, count);
    if (r.filter(Boolean).length === parts.filter(Boolean).length) return r.map((t, i) => t || parts[i]);
  } catch (err) {
    console.warn("[news-deepdive] review pass failed, keeping the draft:", err);
  }
  return parts;
}

/* ── 4. videos ────────────────────────────────────────────────────────────── */

export type VideoFields = Pick<DeepDiveSectionRecord, "videoId" | "videoKind" | "videoUrl" | "videoTitle" | "videoChannel" | "videoReason">;

export async function findSectionVideo(query: string, pack: ResearchPack, story: StoryRecord | undefined, useStory: boolean, taken: Set<string>): Promise<VideoFields> {
  const sources = pack.sources ?? [];
  const company = pack.company || "";
  // The first media section of a dive started from a story uses THAT story's
  // pick (cached, and possibly hand-picked by Jake on the Daily Show).
  const record: StoryRecord = useStory && story
    ? story
    : {
        id: "",
        headline: query,
        blogSources: JSON.stringify(sources.filter((x) => x.official).map((x) => ({ company: company || x.outlet, url: x.url, title: x.title, isOfficial: true }))),
        articleSources: JSON.stringify(sources.filter((x) => !x.official).map((x) => ({ outlet: x.outlet, url: x.url, title: x.title }))),
      };
  const r = await findVideoForStory(record).catch((err) => ({ videoId: null, reason: `Lookup failed: ${err instanceof Error ? err.message : String(err)}`, checked: false } as any));
  const key = r.videoId || r.url || "";
  // A proxied file is served by slide id only (/api/news/video-file/<slide>),
  // and a repeat of an earlier section's video is no new information.
  if (!key || r.proxy) return { videoReason: r.proxy ? "Only a file that needs the slide proxy was found — skipped." : r.reason || "No company video found." };
  if (taken.has(key)) return { videoReason: "Same video as an earlier section — skipped." };
  taken.add(key);
  return {
    videoId: r.videoId ?? undefined,
    videoKind: r.kind ?? "youtube",
    videoUrl: r.kind && r.kind !== "youtube" ? r.url : undefined,
    videoTitle: r.title ?? "",
    videoChannel: r.channel ?? "",
    videoReason: r.reason ?? "",
  };
}

/* ── the run ──────────────────────────────────────────────────────────────── */

export async function generateDeepDive(
  write: (chunk: string) => void | Promise<void>,
  input: { id?: string; fresh?: boolean },
): Promise<{ success: boolean; sections: number; message: string }> {
  const id = typeof input?.id === "string" ? input.id : "";
  const d = id ? deepDives.get(id) : undefined;
  if (!d) throw Object.assign(new Error("Deep dive not found."), { status: 404 });
  if (generating.has(id)) throw new Error("This deep dive is already generating.");
  generating.add(id);

  const prog = async (message: string, percent: number) => {
    deepDives.update(id, { progressMessage: message, progressPercent: percent });
    await write(JSON.stringify({ message, percent }));
  };

  deepDives.update(id, { status: "generating", error: null as unknown as string, updatedAt: new Date().toISOString() });
  try {
    const story = d.story ? stories.get(d.story) : undefined;

    // Research is the slow, paid part. A retry or a regenerate of the SAME
    // topic + angle within 12 hours reuses it; "fresh" forces a new search.
    const key = `${d.topic ?? ""}\n${d.angle ?? ""}`;
    let pack: ResearchPack | null = null;
    let pool: Visual[] | null = null;
    if (!input?.fresh && d.researchJson) {
      try {
        const saved = JSON.parse(d.researchJson) as { key?: string; at?: number; pack?: ResearchPack };
        if (saved.key === key && saved.pack && Date.now() - (saved.at ?? 0) < 12 * 3600_000) {
          pack = saved.pack;
          // Visuals belong to the research: reuse them too, if they were gathered.
          if (d.visualsJson) pool = JSON.parse(d.visualsJson) as Visual[];
        }
      } catch { /* old format or corrupt: research again */ }
    }
    if (pack) {
      await prog(`Reusing this topic's research from earlier (${pack.facts?.length ?? 0} facts, ${pack.sources?.length ?? 0} sources).`, 35);
    } else {
      await prog(`Researching "${d.topic}" on the web (takes a few minutes)…`, 5);
      pack = await research(d, story);
      deepDives.update(id, { researchJson: JSON.stringify({ key, at: Date.now(), pack }), sourcesJson: JSON.stringify(pack.sources ?? []) });
      await prog(`Research done: ${pack.facts?.length ?? 0} facts, ${pack.numbers?.length ?? 0} numbers, ${pack.sources?.length ?? 0} sources.`, 35);
    }

    // The payoff video is looked for BEFORE the outline: the outline has to know
    // whether section 2 can be the company's own demo or must be an example.
    await prog("Looking for the company's own demo video for the payoff…", 37);
    const taken = new Set<string>();
    const payoffQuery = [pack.company, d.title || d.topic].filter(Boolean).join(" ");
    const payoff = await findSectionVideo(payoffQuery, pack, story, !!story, taken);
    const hasPayoff = !!(payoff.videoId || payoff.videoUrl);
    await prog(hasPayoff ? `Payoff video: "${payoff.videoTitle}" (${payoff.videoChannel}).` : `No company demo video (${payoff.videoReason || "none found"}) — the payoff will be an example instead.`, 40);

    await prog("Designing the sections…", 42);
    if (!pool) {
      pool = await gatherVisuals(id, d.topic ?? "", pack.sources ?? [], hasPayoff && payoff.videoId ? payoff.videoId : null, (m) => prog(m, 41));
      deepDives.update(id, { visualsJson: JSON.stringify(pool) });
    } else {
      await prog(`Reusing the ${pool.length} visuals gathered with the research.`, 41);
    }
    const byId = new Map(pool.map((v) => [v.id, v]));

    const o = await outline(d, pack, hasPayoff ? payoff : null, pool);
    const planned = arr(o.sections)
      .filter((x: any) => isKind(x?.kind))
      .slice(0, 12)
      .map((x: any) => {
        const kind = x.kind as SectionKind;
        const visual = NO_VISUAL.has(kind) ? null : byId.get(s(x.visual, 10)) ?? null;
        return { kind, eyebrow: s(x.eyebrow, 40), heading: s(x.heading, 120), data: normalizeData(kind, x.data), beats: arr(x.beats).map((b) => s(b, 400)).filter(Boolean), visual };
      });
    if (planned.length < 4) throw new Error(`The outline came back with ${planned.length} usable sections — too few to present.`);
    const repeats = planned.filter((p, i) => i > 0 && planned[i - 1].kind === p.kind).length;
    if (repeats) console.warn(`[news-deepdive] outline has ${repeats} back-to-back repeat(s) of a section kind`);
    // Payoff first, whatever the outline did: with a video, the first media
    // section moves to position 2 (or one is added there).
    if (hasPayoff && planned.length > 1) {
      const at = planned.findIndex((p, i) => i > 0 && p.kind === "media");
      if (at > 1) planned.splice(1, 0, planned.splice(at, 1)[0]);
      else if (at < 0) {
        planned.splice(1, 0, {
          kind: "media", eyebrow: "See it work", heading: payoff.videoTitle || d.title || d.topic || "",
          data: normalizeData("media", { caption: payoff.videoTitle, videoQuery: payoffQuery }),
          beats: ["Talk over the company's own video: what it shows the product doing, in plain words."],
          visual: null,
        });
      }
    }
    await prog(`Outline: ${planned.length} sections (${planned.map((p) => p.kind).join(" · ")}), ${planned.filter((p) => p.visual).length} with a screenshot/GIF/clip.`, 52);

    await prog("Writing the script in Jake's voice, then reviewing it…", 55);
    const scripts = await writeScripts(d, pack, sectionBrief(planned), planned.length);
    const words = scripts.join(" ").split(/\s+/).filter(Boolean).length;
    await prog(`Script: ${words} words, about ${Math.round(words / 150)} minutes out loud.`, 85);

    const media = planned.map((p, i) => (p.kind === "media" ? i : -1)).filter((i) => i >= 0);
    const videos: Record<number, VideoFields> = {};
    if (hasPayoff && planned[1]?.kind === "media") videos[1] = payoff;
    const rest = media.filter((i) => !videos[i]);
    if (rest.length) {
      await prog(`Finding the company's own video for ${rest.length} more section${rest.length === 1 ? "" : "s"}…`, 87);
      // Sequential: each must know what the earlier ones took.
      for (const i of rest) {
        const q = String((planned[i].data as any).videoQuery || planned[i].heading || d.topic);
        videos[i] = await findSectionVideo(q, pack, story, false, taken);
      }
    }
    if (media.length) {
      const found = Object.values(videos).filter((v) => v.videoId || v.videoUrl).length;
      await prog(`Videos: ${found} of ${media.length} found.`, 96);
    }

    // Swap the sections in one go — the old ones stay until now.
    db.transaction(() => {
      for (const old of sectionsOf(id)) deepDiveSections.remove(old.id);
      planned.forEach((p, i) => {
        deepDiveSections.insert({
          deepDive: id,
          position: i + 1,
          kind: p.kind,
          eyebrow: p.eyebrow,
          heading: p.heading,
          dataJson: JSON.stringify(p.data),
          script: scripts[i] ?? "",
          visualJson: p.visual ? JSON.stringify(p.visual) : "",
          ...(videos[i] ?? {}),
        });
      });
    })();

    const nowIso = new Date().toISOString();
    deepDives.update(id, {
      status: "ready",
      title: s(o.title, 120) || d.topic,
      subtitle: s(o.subtitle, 200),
      generatedAt: nowIso,
      updatedAt: nowIso,
    });
    await prog(`Done — ${planned.length} sections, ~${Math.round(words / 150)} min.`, 100);
    return { success: true, sections: planned.length, message: `Created ${planned.length} sections` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deepDives.update(id, { status: "error", error: message, updatedAt: new Date().toISOString() });
    throw err;
  } finally {
    generating.delete(id);
  }
}

/* ── manual video override ────────────────────────────────────────────────── */

/** Jake pastes a YouTube link/id for a section, or clears it (null). */
export function setSectionVideo(sectionId: string, input: string | null): DeepDiveSectionRecord | undefined {
  const sec = deepDiveSections.get(sectionId);
  if (!sec) throw Object.assign(new Error("Section not found."), { status: 404 });
  if (input === null || !input.trim()) {
    deepDiveSections.update(sectionId, { videoId: null, videoKind: null, videoUrl: null, videoTitle: null, videoChannel: null, videoReason: "Removed by hand." } as any);
  } else {
    const vid = parseVideoId(input);
    if (!vid) throw Object.assign(new Error("That isn't a YouTube link or video id."), { status: 400 });
    deepDiveSections.update(sectionId, { videoId: vid, videoKind: "youtube", videoUrl: null, videoTitle: "Picked by hand", videoChannel: "", videoReason: "Picked by hand." } as any);
  }
  return deepDiveSections.get(sectionId);
}
