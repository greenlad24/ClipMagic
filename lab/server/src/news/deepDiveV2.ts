/**
 * Deep Dive v2 — the chapter show (Jake, 2026-10-02).
 *
 * Jake's rulings that shape this run:
 *  - "Way less text and more demonstration": every dive is built AROUND real
 *    material — the official video cut into muted clips, the official release
 *    post captured and scrolled with highlights, and real screenshots walked
 *    through step by step (zoom + spotlight + cursor). Text-only chapters are
 *    the exception.
 *  - "These resources, the cutting and all of these sources should be part of
 *    the process": the run finds, downloads, cuts and captures them itself.
 *  - Each chapter is one full screen with ←/→ BEATS; the script carries a
 *    [next] mark wherever Jake presses → (types.ts in the web app).
 *  - A demo agent can run the real product (toggle) — see `demoAgent` below.
 *
 * The run: research (shared with v1, cached 12h) → official video → download,
 * scene-split, vision-label (deepDiveMedia) → official post capture → the
 * screenshot pool (deepDiveVisuals) → outline over that catalogue → resolve
 * (cut the chosen clips, locate the click targets) → script with [next] marks.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { stories } from "./db.js";
import { callNewsModel } from "./ai.js";
import { claudeTextForPurpose } from "../ai/claude.js";
import { JAKE_STYLE_GUIDE } from "./deck.js";
import {
  deepDives, deepDiveSections, sectionsOf, setGenerating, isGenerating,
  research, parseJsonReply, findSectionVideo, splitScripts,
  type DeepDiveRecord, type ResearchPack, type VideoFields,
} from "./deepDive.js";
import { gatherVisuals, assetDir, type Visual } from "./deepDiveVisuals.js";
import {
  ensureVideoFile, analyzeVideo, cutClip, capturePage, locateRegions,
  type ClipCandidate, type PageAsset,
} from "./deepDiveMedia.js";
import { startDemoJob, latestDemoJob, attachDemoToDive } from "./deepDiveDemo.js";

/* ── shapes (mirror src/news/deepdive/v2/types.ts) ────────────────────────── */

type Box = [number, number, number, number];
interface DemoStep { image: string; w: number; h: number; box: Box | null; click: [number, number] | null; caption: string; label: string }
interface DemoTab { name: string; job: string; color: string; source: "agent" | "screenshots"; credit: string; steps: DemoStep[] }
interface ClipItem { file: string; poster: string; w: number; h: number; caption: string; label: string; credit: string }
interface ArticleData { url: string; title: string; site: string; width: number; height: number; tiles: { file: string; y: number; h: number }[]; highlights: { x: number; y: number; w: number; h: number; caption: string }[] }

export const V2_KIND_LIST = ["title", "demo", "clip", "article", "reveal", "stats", "versus", "flow", "timeline", "list", "quote", "takeaways"] as const;
type Kind = (typeof V2_KIND_LIST)[number];
const isV2Kind = (k: unknown): k is Kind => typeof k === "string" && (V2_KIND_LIST as readonly string[]).includes(k);

/** What the media steps found — kept on the dive so a regenerate reuses it. */
export interface MediaCatalog {
  key: string;
  video: (VideoFields & { candidates: ClipCandidate[]; width: number; height: number }) | null;
  page: PageAsset | null;
  pageSource: { url: string; outlet: string } | null;
}

const s = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?[\d,]*\.?\d+$/.test(v.trim())) return Number(v.replace(/,/g, ""));
  return null;
};
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
const DOT_COLORS = ["#a8d84a", "#4a8cff", "#ff7eb6", "#e86ad8", "#ffd21e", "#ff8a3d"];

/* ── beats (mirror of the web's beatCount) ────────────────────────────────── */

export function beatCountOf(kind: string, data: any): number {
  const n = (() => {
    switch (kind) {
      case "demo": return arr(data?.tabs).reduce((a, t) => a + arr(t?.steps).length, 0);
      case "clip": return arr(data?.clips).length;
      case "article": return arr(data?.article?.highlights).length;
      case "reveal": return arr(data?.cards).length + (arr(data?.good).length || arr(data?.bad).length ? 1 : 0);
      case "stats": return arr(data?.stats).length;
      case "versus": return arr(data?.options).length;
      case "flow": return arr(data?.steps).length;
      case "timeline": return arr(data?.events).length;
      case "list": return arr(data?.items).length;
      case "takeaways": return arr(data?.points).length;
      default: return 1;
    }
  })();
  return Math.max(1, n);
}

/* ── the catalogue the outline chooses from ───────────────────────────────── */

/** Blocks of the captured post worth pointing at (no nav, no footer, real text). */
function postBlocks(page: PageAsset): PageAsset["blocks"] {
  const cutoff = page.height * 0.9;
  return page.blocks
    .filter((b) => /^(h1|h2|h3|p|li|blockquote)$/i.test(b.tag) && b.text.length >= 20 && b.y > 60 && b.y < cutoff)
    .slice(0, 80);
}

function catalogText(media: MediaCatalog, pool: Visual[]): string {
  const out: string[] = [];
  const v = media.video;
  if (v && v.candidates.length) {
    out.push(`OFFICIAL VIDEO "${v.videoTitle}" by ${v.videoChannel} — its moments (muted on screen, so only what you can SEE counts):`);
    v.candidates.forEach((c, i) => out.push(`c${i + 1}: ${mmss(c.start)}-${mmss(c.end)} [${c.kind}, fit ${c.score.toFixed(1)}] ${c.description}`));
  } else out.push("OFFICIAL VIDEO: none found.");
  if (media.page) {
    out.push(`\nOFFICIAL POST "${media.page.title}" (${media.pageSource?.outlet || media.page.site}) — its blocks, in page order:`);
    postBlocks(media.page).forEach((b) => out.push(`b${b.i}: [${b.tag}] ${b.text.slice(0, 180)}`));
  } else out.push("\nOFFICIAL POST: could not be captured.");
  const shots = pool.filter((p) => p.kind === "image" || p.kind === "gif");
  if (shots.length) {
    out.push(`\nSCREENSHOTS (real, checked by eye):`);
    shots.forEach((p) => out.push(`${p.id}: [${p.width ?? "?"}×${p.height ?? "?"}] ${p.description} (${p.credit})`));
  } else out.push("\nSCREENSHOTS: none.");
  return out.join("\n");
}

/* ── outline ──────────────────────────────────────────────────────────────── */

const KINDS_SPEC = `CHAPTER KINDS — each chapter is ONE full screen with a small header and one big interactive stage. Jake presses → to step through its BEATS.
DEMONSTRATION KINDS (use these as much as the material allows):
- "demo": a step-by-step walkthrough of real SCREENSHOTS — the camera zooms to each step, a yellow spotlight and a cursor click on it. data {"tabs":[{"name":"short name of who/what is doing it","job":"1-3 words","steps":[{"shot":"v4","point":"PRECISE visual description of the exact spot on that screenshot to zoom to (e.g. 'the green chat bubble that asks to draft an email')","caption":"max 7 words","label":"1-2 words"}]}]} — 1-4 tabs, 2-5 steps each (one beat per step). Only screenshots of the product's UI. A step's point must be something visible in that shot's description.
- "clip": moments of the OFFICIAL VIDEO, played muted, one per beat. data {"clips":[{"clip":"c3","caption":"max 7 words — what you SEE","label":"1-2 words"}]} — 2-5 clips. Only moments that show the product, its UI or a striking product shot — never a person talking to camera.
- "article": the OFFICIAL POST shown in a browser, scrolling to a highlighted line per beat. data {"highlights":[{"block":12,"caption":"max 8 words — what this line means"}]} — 2-5 highlights, in page order, using the b-numbers.
OTHER KINDS (keep text tiny — a 14-year-old gets it at a glance; Jake explains out loud):
- "title": the opener. heading = max 6 words. data {"lede":"max 22 words","agenda":["3 items, max 4 words each"],"heroClip":"c1 or empty — a moment that loops softly behind the title"}
- "reveal": 2-3 cards revealed one per beat (prices, plans, verdicts, who wins). data {"cards":[{"name":"...","tag":"1-3 words","big":"$100 or max 4 words","countTo":100,"prefix":"$","suffix":"/mo","small":"optional, max 8 words","note":"optional, max 8 words","tone":"dark|light|brand|blue"}],"good":["optional: who CAN get it, 1-3 words each"],"bad":["optional: who can't"]} — countTo is a plain number when big is a number, else null.
- "stats": 1-3 numbers, one per beat, each fills the screen. data {"stats":[{"value":4000,"display":"","prefix":"","suffix":"+","label":"max 8 words"}]} — value null + display when it isn't a number.
- "versus": 2-3 options side by side, one highlighted per beat. data {"options":[{"name":"...","line":"max 12 words","points":["max 3, max 6 words each"]}]}
- "flow": a little story in 3-4 steps. data {"steps":[{"label":"1-2 words","text":"max 7 words"}]}
- "timeline": 3-5 dated events. data {"events":[{"date":"Sep 29","label":"max 4 words","detail":"max 7 words","soon":false}]}
- "list": 3-5 short items, one lights up per beat, optionally beside a screenshot. data {"items":["max 8 words"],"image":"v8 or empty"}
- "quote": a real quote from the research, word for word. data {"quote":"max 30 words","who":"Name","role":"Title, Company"}
- "takeaways": the closer, 3-4 cards. data {"points":["max 10 words"]}`;

const STRUCTURE_V2 = `STRUCTURE — Jake's video structure, payoff first:
1. "title" — the hook: the most impressive thing this does, not a news label.
2. THE PAYOFF, shown working: a "clip" or "demo" chapter (whichever material is stronger).
3. WHY YOU SHOULD CARE — one everyday reason ("flow" or "versus" work well).
4+. What they actually announced (the "article" chapter with the official post, if captured), how it works / how to use it (another "demo" or "clip" if there is material), the numbers, how it compares, what it costs ("reveal").
Late: THE CATCH (limits, criticism, unconfirmed) and WHAT'S NEXT ("timeline").
Last: "takeaways".
LESS TEXT, MORE DEMONSTRATION (Jake): use every demonstration kind the material supports — aim for at least 3 of demo/clip/article in a dive. Never two text-only chapters in a row. Re-hook every 2-3 chapters. Save one good surprise for the second half.`;

interface OutChapter { kind: Kind; eyebrow: string; heading: string; island: { q: string; a: string } | null; data: any; notes: string[] }

async function outlineV2(d: DeepDiveRecord, pack: ResearchPack, media: MediaCatalog, pool: Visual[]): Promise<{ title: string; subtitle: string; chapters: OutChapter[] }> {
  const prompt = `You are the producer of a ~10-minute live deep-dive segment on Jake Dawson's AI show ("Use AI like the pros — no code, no BS"). Jake presents it live; the audience sees a minimal, animated, full-screen show that he clicks through. Design every chapter.

TOPIC: ${d.topic}
${d.angle ? `JAKE'S NOTES ON THE ANGLE: ${d.angle}\n` : ""}
RESEARCH (the only facts you may use):
${JSON.stringify(pack).slice(0, 22000)}

THE MATERIAL GATHERED FOR THIS DIVE (refer to it by id):
${catalogText(media, pool)}

${KINDS_SPEC}

${STRUCTURE_V2}

RULES:
1. 8 to 11 chapters. First "title", last "takeaways". About 32-45 beats in total (each beat ≈ 15-20 seconds of Jake talking).
2. "heading": max 7 words, NO final period, and exactly ONE accent phrase of 1-3 words wrapped in *asterisks* (it is set in italic with a yellow underline) — e.g. "Watch a dot *do the job*".
3. "eyebrow": 2-5 words, e.g. "The payoff · OpenAI's own demo". Rumors say "Unconfirmed".
4. "island": a tiny question → answer chip for the chapter, {"q":"max 3 words, ends with ?","a":"max 3 words"} — e.g. {"q":"Who types?","a":"Mostly the dot"}. null for title and takeaways.
5. "notes": one note per BEAT, in order, for the scriptwriter: what Jake says while that beat is on screen, with the specific facts. The number of notes = the number of beats (demo: total steps; clip: clips; article: highlights; reveal: cards (+1 if good/bad); stats/versus/flow/timeline/list/takeaways: items; title/quote: 1).
6. Every number, date, name and quote comes from the research or the material. Nothing invented.
7. Only use ids that exist above. Do not use the same clip or screenshot twice.
8. Plain words. On-screen text is short; the explaining happens out loud.

Reply with ONLY this JSON (no markdown):
{"title":"max 8 words","subtitle":"max 14 words","chapters":[{"kind":"title","eyebrow":"","heading":"","island":null,"data":{},"notes":["..."]}]}`;

  const text = await callNewsModel(prompt, "news-deepdive-outline", "director");
  const o = await parseJsonReply<any>(text, "outline");
  const chapters: OutChapter[] = arr(o?.chapters)
    .filter((c) => isV2Kind(c?.kind))
    .slice(0, 12)
    .map((c) => ({
      kind: c.kind as Kind,
      eyebrow: s(c.eyebrow, 60),
      heading: s(c.heading, 90).replace(/\.\s*$/, ""),
      island: c.island && s(c.island.q, 30) && s(c.island.a, 30) ? { q: s(c.island.q, 30), a: s(c.island.a, 30) } : null,
      data: c.data && typeof c.data === "object" ? c.data : {},
      notes: arr(c.notes).map((n) => s(n, 500)).filter(Boolean),
    }));
  return { title: s(o?.title, 120), subtitle: s(o?.subtitle, 200), chapters };
}

/* ── resolve: turn ids into real, cut, located assets ─────────────────────── */

async function resolveChapter(
  diveId: string, c: OutChapter, media: MediaCatalog, pool: Visual[], used: Set<string>, log: (m: string) => void,
): Promise<{ kind: Kind; data: any } | null> {
  const d = c.data ?? {};
  const byId = new Map(pool.map((v) => [v.id, v]));
  const video = media.video;
  const clipOf = async (id: string, caption: string, label: string): Promise<ClipItem | null> => {
    const m = /^c(\d+)$/.exec(s(id, 6));
    const cand = m && video ? video.candidates[Number(m[1]) - 1] : undefined;
    if (!cand || !video?.videoId) return null;
    if (used.has(`clip:${id}`)) return null;
    used.add(`clip:${id}`);
    // A muted moment longer than ~10s drags on stage: keep the first 10.
    const end = Math.min(cand.end, cand.start + 10);
    const a = await cutClip(diveId, video.videoId, cand.start, end, cand.description);
    return { file: a.file, poster: a.poster, w: a.width, h: a.height, caption: s(caption, 80), label: s(label, 24), credit: `${video.videoChannel || "Official"} · official video` };
  };

  switch (c.kind) {
    case "title": {
      const hero = d.heroClip ? await clipOf(s(d.heroClip, 6), "", "").catch(() => null) : null;
      return { kind: "title", data: { lede: s(d.lede, 200), agenda: arr(d.agenda).map((x) => s(x, 40)).filter(Boolean).slice(0, 4), heroClip: hero } };
    }
    case "clip": {
      const clips: ClipItem[] = [];
      for (const x of arr(d.clips).slice(0, 6)) {
        const item = await clipOf(s(x?.clip, 6), s(x?.caption, 80), s(x?.label, 24)).catch((err) => { log(`Clip ${x?.clip} failed: ${err instanceof Error ? err.message : err}`); return null; });
        if (item) clips.push(item);
      }
      return clips.length ? { kind: "clip", data: { clips } } : null;
    }
    case "article": {
      const page = media.page;
      if (!page) return null;
      const blocks = new Map(page.blocks.map((b) => [b.i, b]));
      const highlights = arr(d.highlights)
        .map((h) => ({ b: blocks.get(Number(String(h?.block ?? "").replace(/^b/, ""))), caption: s(h?.caption, 90) }))
        .filter((h) => h.b)
        .sort((a, b) => a.b!.y - b.b!.y)
        .slice(0, 6)
        .map((h) => ({ x: h.b!.x, y: h.b!.y, w: h.b!.w, h: h.b!.h, caption: h.caption, block: h.b!.i }));
      if (!highlights.length) return null;
      const article: ArticleData = { url: page.url, title: page.title, site: media.pageSource?.outlet || page.site, width: page.width, height: page.height, tiles: page.tiles, highlights };
      return { kind: "article", data: { article } };
    }
    case "demo": {
      const tabs: DemoTab[] = [];
      for (const [ti, t] of arr(d.tabs).slice(0, 4).entries()) {
        const steps = arr(t?.steps).slice(0, 6);
        // One vision call per screenshot, with every point asked of it at once.
        const byShot = new Map<string, number[]>();
        steps.forEach((st, i) => { const id = s(st?.shot, 10); if (byShot.has(id)) byShot.get(id)!.push(i); else byShot.set(id, [i]); });
        const boxes: (Box | null)[] = steps.map(() => null);
        for (const [shotId, idxs] of byShot) {
          const v = byId.get(shotId);
          if (!v?.file) continue;
          const found = await locateRegions(path.join(assetDir(diveId), v.file), idxs.map((i) => s(steps[i]?.point, 200) || s(steps[i]?.caption, 80))).catch(() => idxs.map(() => null));
          idxs.forEach((i, k) => { boxes[i] = (found[k]?.box as Box | undefined) ?? null; });
        }
        const out: DemoStep[] = [];
        steps.forEach((st, i) => {
          const v = byId.get(s(st?.shot, 10));
          if (!v?.file) return;
          const w = v.width ?? 1920, h = v.height ?? 1080;
          const box = boxes[i];
          out.push({
            image: v.file, w, h, box,
            click: box ? [Math.round(box[0] + box[2] * 0.5), Math.round(box[1] + box[3] * 0.55)] : null,
            caption: s(st?.caption, 80), label: s(st?.label, 24),
          });
        });
        if (out.length) {
          const credits = [...new Set(steps.map((st) => byId.get(s(st?.shot, 10))?.credit).filter(Boolean))];
          tabs.push({ name: s(t?.name, 30) || `Demo ${ti + 1}`, job: s(t?.job, 30), color: DOT_COLORS[ti % DOT_COLORS.length], source: "screenshots", credit: credits.length ? `Screens: ${credits.join(", ")}` : "", steps: out });
        }
      }
      return tabs.length ? { kind: "demo", data: { tabs } } : null;
    }
    case "reveal": {
      const cards = arr(d.cards).slice(0, 3).map((x) => {
        const countTo = num(x?.countTo);
        return {
          name: s(x?.name, 40), tag: s(x?.tag, 24), big: s(x?.big, 40), countTo, prefix: s(x?.prefix, 4), suffix: s(x?.suffix, 8),
          small: s(x?.small, 80), note: s(x?.note, 80), tone: ["dark", "light", "brand", "blue"].includes(x?.tone) ? x.tone : "dark",
        };
      }).filter((x) => x.name && (x.big || x.countTo !== null));
      if (!cards.length) return null;
      return { kind: "reveal", data: { cards, good: arr(d.good).map((x) => s(x, 30)).filter(Boolean).slice(0, 4), bad: arr(d.bad).map((x) => s(x, 30)).filter(Boolean).slice(0, 4) } };
    }
    case "stats": {
      const stats = arr(d.stats).slice(0, 3).map((x) => ({ value: num(x?.value), display: s(x?.display, 20), prefix: s(x?.prefix, 4), suffix: s(x?.suffix, 8), label: s(x?.label, 80) })).filter((x) => x.label && (x.value !== null || x.display));
      return stats.length ? { kind: "stats", data: { stats } } : null;
    }
    case "versus": {
      const options = arr(d.options).slice(0, 3).map((x) => ({ name: s(x?.name, 40), line: s(x?.line, 120), points: arr(x?.points).map((p) => s(p, 60)).filter(Boolean).slice(0, 3) })).filter((x) => x.name);
      return options.length >= 2 ? { kind: "versus", data: { options } } : null;
    }
    case "flow": {
      const steps = arr(d.steps).slice(0, 4).map((x) => ({ label: s(x?.label, 24), text: s(x?.text, 70) })).filter((x) => x.text);
      return steps.length >= 2 ? { kind: "flow", data: { steps } } : null;
    }
    case "timeline": {
      const events = arr(d.events).slice(0, 5).map((x) => ({ date: s(x?.date, 20), label: s(x?.label, 40), detail: s(x?.detail, 80), soon: x?.soon === true })).filter((x) => x.label);
      return events.length >= 2 ? { kind: "timeline", data: { events } } : null;
    }
    case "list": {
      const items = arr(d.items).map((x) => s(x, 80)).filter(Boolean).slice(0, 5);
      if (!items.length) return null;
      const v = d.image ? byId.get(s(d.image, 10)) : undefined;
      const image = v?.file && !used.has(`shot:${v.id}`) ? { file: v.file, w: v.width ?? 0, h: v.height ?? 0, credit: v.credit } : null;
      if (image && v) used.add(`shot:${v.id}`);
      return { kind: "list", data: { items, image, credit: image?.credit ? `Image: ${image.credit}` : "" } };
    }
    case "quote":
      return s(d.quote) ? { kind: "quote", data: { quote: s(d.quote, 300), who: s(d.who, 60), role: s(d.role, 80) } } : null;
    case "takeaways": {
      const points = arr(d.points).map((x) => s(x, 90)).filter(Boolean).slice(0, 4);
      return points.length ? { kind: "takeaways", data: { points } } : null;
    }
  }
  return null;
}

/* ── script ───────────────────────────────────────────────────────────────── */

const V2_SCRIPT_RULES = `THIS IS A LIVE DEEP-DIVE SEGMENT IN CHAPTERS:
- About 10 minutes out loud: 1,450 to 1,700 words in total. Running SHORT is the usual failure — use the research's details and a second everyday example rather than ending a beat early. Each chapter says how many words it gets — hit that within ~15%.
- Each chapter has BEATS: Jake presses → to move the screen to the next beat. Put the marker [next] on its own between beats — EXACTLY (beats − 1) markers per chapter, so what he says lines up with what's on screen. Talk about what THAT beat shows.
- On demo/clip/article chapters the screen is a real demonstration: narrate it ("see that green bubble? that's the request — one message"). Never read the caption word for word — add to it.
- The opener is a hook: lead with the payoff. No "welcome back", no "today we're going to", no subscribe asks.
- One continuous talk with natural bridges between chapters; never re-introduce the topic.
- Every 2-3 chapters, a line opens a question a later chapter answers.
- The closer lands ONE concrete thought. No sign-off — the show continues after this.
- Use 5-9 phrases from the conversational phrase menu across the whole segment, never two in a row.`;

async function writeScriptsV2(d: DeepDiveRecord, pack: ResearchPack, chapters: { kind: Kind; heading: string; eyebrow: string; data: any; notes: string[] }[]): Promise<string[]> {
  const beats = chapters.map((c) => beatCountOf(c.kind, c.data));
  const totalBeats = beats.reduce((a, b) => a + b, 0);
  const per = 1550 / Math.max(1, totalBeats);
  const brief = chapters.map((c, i) => {
    const words = Math.round(Math.max(60, beats[i] * per));
    const screen = JSON.stringify(c.data, (k, v) => (["tiles", "file", "poster", "image", "w", "h", "box", "click", "x", "y"].includes(k) ? undefined : v)).slice(0, 1500);
    return `### CHAPTER ${i + 1} — ${c.kind.toUpperCase()} — ${beats[i]} beat${beats[i] === 1 ? "" : "s"} (${beats[i] - 1} [next] markers) — about ${words} words
ON SCREEN: ${c.eyebrow ? `${c.eyebrow} / ` : ""}${c.heading.replace(/\*/g, "")}
${screen}
SAY, BEAT BY BEAT: ${c.notes.map((n, k) => `(${k + 1}) ${n}`).join(" ")}`;
  }).join("\n\n");
  const facts = JSON.stringify(pack).slice(0, 18000);
  const prompt = `${JAKE_STYLE_GUIDE}

---

${V2_SCRIPT_RULES}

Write Jake's teleprompter script for this deep dive, chapter by chapter.

TOPIC: ${d.topic}
${d.angle ? `JAKE'S NOTES ON THE ANGLE: ${d.angle}\n` : ""}
THE CHAPTERS:
${brief}

RESEARCH (the only facts you may use):
${facts}

OUTPUT FORMAT — exactly ${chapters.length} chapters, each starting with its marker line on its own, then only the words Jake says, with [next] between beats:
### SECTION 1
(words) [next] (words)
### SECTION 2
…to ### SECTION ${chapters.length}. No other headings, labels or stage directions.`;
  const draft = await callNewsModel(prompt, "news-deepdive-script", "director");
  let parts = splitScripts(draft, chapters.length);
  if (parts.filter(Boolean).length < Math.ceil(chapters.length / 2)) throw new Error("The script step did not return the chapter markers.");

  const review = `${JAKE_STYLE_GUIDE}

---

${V2_SCRIPT_RULES}

Review this live deep-dive script. Rewrite anything unclear, stiff or complex: a 14-year-old's reading level, a normal American talking to a friend. Keep an official term the story is about and explain it right after. Cut repeats across chapters. Fix banned endings. Keep the facts, the order, the ### SECTION n lines and EXACTLY the [next] markers each chapter has (their count must not change). Total 1,450-1,700 words; if it is short, expand the thinnest beats with research details, never padding.

THE CHAPTER BRIEF:
${brief}

RESEARCH (fact-checking only):
${facts}

SCRIPT:
${draft}

Output ONLY the final script with the same marker lines.`;
  try {
    const r = splitScripts(await callNewsModel(review, "news-deepdive-script", "director"), chapters.length);
    if (r.filter(Boolean).length === parts.filter(Boolean).length) parts = r.map((t, i) => t || parts[i]);
  } catch (err) {
    console.warn("[news-deepdive-v2] review pass failed, keeping the draft:", err);
  }
  return parts.map((p, i) => fitMarkers(p, beats[i]));
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

/* ── media gathering ──────────────────────────────────────────────────────── */

/**
 * Where the company announced it. ⚠️ THE RESEARCH STEP OFTEN MARKS NOTHING
 * "official" (first v2 run, 2026-10-02: 0 of 15 sources, openai.com among
 * them) — so also: the Daily Show story's official links, any source on the
 * company's own domain, and as a last resort one small web search.
 */
async function officialPosts(d: DeepDiveRecord, pack: ResearchPack): Promise<{ url: string; outlet: string }[]> {
  const out: { url: string; outlet: string }[] = [];
  const add = (url: string, outlet: string) => { if (/^https?:\/\//.test(url) && !out.some((x) => x.url === url)) out.push({ url, outlet }); };
  for (const x of pack.sources ?? []) if (x.official) add(x.url, x.outlet);
  const story = d.story ? stories.get(d.story) : undefined;
  try { for (const b of JSON.parse(story?.blogSources || "[]")) if (b?.isOfficial) add(String(b.url), String(b.company || "")); } catch { /* none */ }
  const slug = (pack.company || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug.length >= 3) {
    for (const x of pack.sources ?? []) {
      let host = "";
      try { host = new URL(x.url).host.toLowerCase().replace(/^www\./, ""); } catch { continue; }
      if (host.replace(/[^a-z0-9.]/g, "").split(".").some((part) => part === slug)) add(x.url, x.outlet || pack.company || host);
    }
  }
  if (!out.length && pack.company) {
    try {
      const text = await claudeTextForPurpose({
        // ⚠️ NOT the fast tier: Haiku can't run the web-search tool here (400 "does not support programmatic tool calling").
        tier: "research", purpose: "news-deepdive-research",
        system: "Find the company's own announcement page. Answer with ONLY the URL, or NONE.",
        messages: [{ role: "user", content: `What is the URL of ${pack.company}'s own official announcement / blog post about: ${d.topic}? It must be on ${pack.company}'s own website.` }],
        webSearch: true, searchMaxUses: 2, maxTokens: 600,
      });
      const m = /https?:\/\/[^\s)"'<>]+/.exec(text);
      if (m) add(m[0].replace(/[.,]$/, ""), pack.company);
    } catch (err) { console.warn("[news-deepdive-v2] official-post search failed:", err); }
  }
  return out;
}

async function gatherMedia(d: DeepDiveRecord, pack: ResearchPack, payoff: VideoFields | null, prog: (m: string) => Promise<void>): Promise<MediaCatalog> {
  const key = `${payoff?.videoId ?? ""}|v2`;
  try {
    const saved = JSON.parse(d.mediaJson || "{}") as MediaCatalog;
    const onDisk = !saved.page || saved.page.tiles.every((t) => fs.existsSync(path.join(assetDir(d.id), t.file)));
    if (saved.key === key && onDisk && saved.page) { await prog("Reusing the official video and post gathered earlier."); return saved; }
    // A saved run that found no post tries the capture again (cheap: the video analysis is cached).
  } catch { /* gather again */ }

  const media: MediaCatalog = { key, video: null, page: null, pageSource: null };

  // 1. The official video → downloaded, split into moments, each looked at.
  if (payoff?.videoId) {
    await prog(`Downloading the official video "${payoff.videoTitle}"…`);
    const file = await ensureVideoFile(payoff.videoId).catch((err) => { console.warn("[news-deepdive-v2] video download failed:", err); return null; });
    if (file) {
      await prog("Cutting the video into moments and checking each one by eye…");
      const candidates = await analyzeVideo(payoff.videoId, { title: payoff.videoTitle ?? "", channel: payoff.videoChannel ?? "" }).catch((err) => { console.warn("[news-deepdive-v2] video analysis failed:", err); return [] as ClipCandidate[]; });
      const keep = candidates.filter((c) => c.kind !== "people" || c.score >= 0.6).slice(0, 40);
      media.video = { ...payoff, candidates: keep, width: file.width, height: file.height };
      await prog(`Official video: ${keep.length} usable moments.`);
    } else await prog("The official video could not be downloaded — the show uses screenshots instead.");
  }

  // 2. The official release post → captured sharp, with every block's position.
  const official = await officialPosts(d, pack);
  for (const src of official.slice(0, 3)) {
    await prog(`Capturing the official post (${src.outlet || new URL(src.url).host})…`);
    const page = await capturePage(d.id, src.url).catch((err) => { console.warn("[news-deepdive-v2] capture failed:", src.url, err); return null; });
    if (page) { media.page = page; media.pageSource = { url: src.url, outlet: src.outlet }; break; }
  }
  if (!media.page) await prog(official.length ? "The official post could not be captured (blocked or empty)." : "No official post among the sources.");

  deepDives.update(d.id, { mediaJson: JSON.stringify(media) });
  return media;
}

/* ── the run ──────────────────────────────────────────────────────────────── */

export async function generateDeepDiveV2(
  write: (chunk: string) => void | Promise<void>,
  input: { id?: string; fresh?: boolean },
): Promise<{ success: boolean; sections: number; message: string }> {
  const id = typeof input?.id === "string" ? input.id : "";
  const d = id ? deepDives.get(id) : undefined;
  if (!d) throw Object.assign(new Error("Deep dive not found."), { status: 404 });
  if (isGenerating(id)) throw new Error("This deep dive is already generating.");
  setGenerating(id, true);

  let pct = 0;
  const prog = async (message: string, percent?: number) => {
    if (typeof percent === "number") pct = percent;
    deepDives.update(id, { progressMessage: message, progressPercent: pct });
    await write(JSON.stringify({ message, percent: pct }));
  };
  deepDives.update(id, { status: "generating", error: null as unknown as string, updatedAt: new Date().toISOString() });
  try {
    const story = d.story ? stories.get(d.story) : undefined;
    const key = `${d.topic ?? ""}\n${d.angle ?? ""}`;

    // The demo agent (toggle) records in parallel with everything else: queue
    // it first. A recording from the last 12h is reused, not redone.
    if (d.demoAgent) {
      const last = latestDemoJob(id);
      const fresh = last && ["queued", "running"].includes(last.status) ? last
        : last && last.status === "done" && Date.now() - Date.parse(last.finishedAt ?? last.createdAt) < 12 * 3600_000 ? last : null;
      if (fresh) await prog(`Demo agent: ${fresh.status === "done" ? "reusing its recording from earlier" : `already ${fresh.status}`}.`, 2);
      else {
        try { const j = startDemoJob(id); await prog(`Demo agent queued — it is using the real product in the Lab's browser while the rest builds (job ${j.id.slice(0, 8)}).`, 2); }
        catch (err) { await prog(`Demo agent not started: ${err instanceof Error ? err.message : String(err)}`, 2); }
      }
    }
    let pack: ResearchPack | null = null;
    let pool: Visual[] | null = null;
    if (!input?.fresh && d.researchJson) {
      try {
        const saved = JSON.parse(d.researchJson) as { key?: string; at?: number; pack?: ResearchPack };
        if (saved.key === key && saved.pack && Date.now() - (saved.at ?? 0) < 12 * 3600_000) {
          pack = saved.pack;
          if (d.visualsJson) pool = JSON.parse(d.visualsJson) as Visual[];
        }
      } catch { /* research again */ }
    }
    if (pack) await prog(`Reusing this topic's research (${pack.facts?.length ?? 0} facts, ${pack.sources?.length ?? 0} sources).`, 25);
    else {
      await prog(`Researching "${d.topic}" on the web (takes a few minutes)…`, 3);
      pack = await research(d, story);
      deepDives.update(id, { researchJson: JSON.stringify({ key, at: Date.now(), pack }), sourcesJson: JSON.stringify(pack.sources ?? []), mediaJson: "" });
      await prog(`Research done: ${pack.facts?.length ?? 0} facts, ${pack.sources?.length ?? 0} sources.`, 25);
    }

    await prog("Looking for the company's own video…", 27);
    const taken = new Set<string>();
    const payoff = await findSectionVideo([pack.company, d.title || d.topic].filter(Boolean).join(" "), pack, story, !!story, taken);
    const hasVideo = !!payoff.videoId;
    await prog(hasVideo ? `Official video: "${payoff.videoTitle}" (${payoff.videoChannel}).` : `No official video (${payoff.videoReason || "none found"}).`, 30);

    // ⚠️ SCREENSHOTS FIRST: gatherVisuals wipes the dive's asset dir and drops
    // every file outside its pool — and the media files share its naming
    // (16 hex chars), so a capture made before it would be deleted.
    await prog("Collecting screenshots of the product…", 32);
    if (!pool) {
      pool = await gatherVisuals(id, d.topic ?? "", pack.sources ?? [], hasVideo ? payoff.videoId ?? null : null, (m) => prog(m));
      deepDives.update(id, { visualsJson: JSON.stringify(pool), mediaJson: "" });
    }
    const media = await gatherMedia(deepDives.get(id)!, pack, hasVideo ? payoff : null, (m) => prog(m));

    await prog(`Designing the chapters around ${media.video?.candidates.length ?? 0} video moments, ${media.page ? "the official post" : "no post"} and ${pool.filter((v) => v.kind === "image").length} screenshots…`, 55);
    const o = await outlineV2(d, pack, media, pool);
    if (o.chapters.length < 4) throw new Error(`The outline came back with ${o.chapters.length} usable chapters — too few to present.`);

    await prog("Cutting the chosen clips and locating every click on the screenshots…", 62);
    const used = new Set<string>();
    const built: { kind: Kind; eyebrow: string; heading: string; island: { q: string; a: string } | null; data: any; notes: string[] }[] = [];
    for (const c of o.chapters) {
      const r = await resolveChapter(id, c, media, pool, used, (m) => console.warn("[news-deepdive-v2]", m)).catch((err) => {
        console.warn(`[news-deepdive-v2] ${c.kind} chapter dropped:`, err);
        return null;
      });
      if (!r) { console.warn(`[news-deepdive-v2] ${c.kind} chapter "${c.heading}" had no usable material — dropped`); continue; }
      // Notes per beat: pad or merge so the script brief matches the screen.
      const n = beatCountOf(r.kind, r.data);
      const notes = c.notes.length > n ? [...c.notes.slice(0, n - 1), c.notes.slice(n - 1).join(" ")] : [...c.notes, ...Array(Math.max(0, n - c.notes.length)).fill("")];
      built.push({ kind: r.kind, eyebrow: c.eyebrow, heading: c.heading || d.topic || "", island: c.kind === "title" || c.kind === "takeaways" ? null : c.island, data: r.data, notes });
    }
    if (built.length < 4) throw new Error(`Only ${built.length} chapters had usable material.`);
    const demoish = built.filter((c) => c.kind === "demo" || c.kind === "clip" || c.kind === "article").length;
    await prog(`Outline: ${built.length} chapters (${built.map((c) => c.kind).join(" · ")}) — ${demoish} demonstrations, ${built.reduce((a, c) => a + beatCountOf(c.kind, c.data), 0)} beats.`, 72);

    await prog("Writing the script in Jake's voice, beat by beat, then reviewing it…", 74);
    const scripts = await writeScriptsV2(d, pack, built);
    const words = scripts.join(" ").replace(/\[next\]/gi, "").split(/\s+/).filter(Boolean).length;

    db.transaction(() => {
      for (const old of sectionsOf(id)) deepDiveSections.remove(old.id);
      built.forEach((c, i) => {
        deepDiveSections.insert({
          deepDive: id, position: i + 1, kind: c.kind as any, eyebrow: c.eyebrow, heading: c.heading,
          dataJson: JSON.stringify({ ...c.data, island: c.island }), script: scripts[i] ?? "", visualJson: "",
        });
      });
    })();

    // The agent's recording, if it already finished, goes in now (the
    // section swap above removed any earlier copy); otherwise the Scout's
    // finish hook adds it the moment it is done.
    let agentNote = "";
    if (d.demoAgent) {
      const job = latestDemoJob(id);
      if (job?.status === "done") {
        const r = await attachDemoToDive(id, job.id).catch((err) => ({ attached: false, reason: String(err) }));
        agentNote = r.attached ? " + the demo agent's recording" : ` (demo agent recording not used: ${r.reason})`;
      } else if (job && ["queued", "running"].includes(job.status)) agentNote = " — the demo agent is still recording; its chapter appears after the title when it finishes";
      else if (job) agentNote = ` (demo agent ${job.status}${job.error ? `: ${job.error}` : ""})`;
    }

    const nowIso = new Date().toISOString();
    deepDives.update(id, { status: "ready", title: s(o.title, 120) || d.topic, subtitle: s(o.subtitle, 200), generatedAt: nowIso, updatedAt: nowIso });
    await prog(`Done — ${built.length} chapters, ${demoish} demonstrations, ~${Math.round(words / 150)} min${agentNote}.`, 100);
    return { success: true, sections: built.length, message: `Created ${built.length} chapters` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deepDives.update(id, { status: "error", error: message, updatedAt: new Date().toISOString() });
    throw err;
  } finally {
    setGenerating(id, false);
  }
}

/* ── editor: change a chapter's material without regenerating ─────────────── */

/** The catalogue the editor's pickers choose from. */
export function mediaChoices(diveId: string) {
  const d = deepDives.get(diveId);
  if (!d) throw Object.assign(new Error("Deep dive not found."), { status: 404 });
  let media: MediaCatalog | null = null;
  try { media = JSON.parse(d.mediaJson || "null"); } catch { /* none */ }
  return {
    video: media?.video ? { title: media.video.videoTitle ?? "", channel: media.video.videoChannel ?? "" } : null,
    clips: (media?.video?.candidates ?? []).map((c, i) => ({ id: `c${i + 1}`, start: c.start, end: c.end, kind: c.kind, score: c.score, description: c.description })),
    blocks: media?.page ? postBlocks(media.page).map((b) => ({ block: b.i, tag: b.tag, text: b.text.slice(0, 200) })) : [],
  };
}

export type ChapterEdit =
  | { op: "caption"; path: string; caption: string }
  | { op: "swapClip"; index: number; clip: string }
  | { op: "highlights"; items: { block: number; caption: string }[] };

/**
 * One edit to a v2 chapter's stored data. `path` for captions:
 * "clips.N" · "tabs.T.steps.S" · "highlights.N" · "cards.N" (the card's note).
 */
export async function editChapter(sectionId: string, edit: ChapterEdit): Promise<void> {
  const sec = deepDiveSections.get(sectionId);
  if (!sec) throw Object.assign(new Error("Chapter not found."), { status: 404 });
  const d = deepDives.get(sec.deepDive ?? "");
  if (!d || d.format !== "v2") throw Object.assign(new Error("Only v2 chapters have editable material."), { status: 400 });
  const data = JSON.parse(sec.dataJson || "{}");
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });

  if (edit.op === "caption") {
    const caption = s(edit.caption, 90);
    const p = String(edit.path).split(".");
    let target: any = null;
    if (p[0] === "clips") target = data.clips?.[Number(p[1])];
    else if (p[0] === "tabs" && p[2] === "steps") target = data.tabs?.[Number(p[1])]?.steps?.[Number(p[3])];
    else if (p[0] === "highlights") target = data.article?.highlights?.[Number(p[1])];
    if (!target) throw bad("Nothing at that place in this chapter.");
    target.caption = caption;
  } else if (edit.op === "swapClip") {
    if ((sec.kind as string) !== "clip" || !data.clips?.[edit.index]) throw bad("That isn't a clip in this chapter.");
    const media: MediaCatalog = JSON.parse(d.mediaJson || "{}");
    const m = /^c(\d+)$/.exec(String(edit.clip));
    const cand = m ? media.video?.candidates[Number(m[1]) - 1] : undefined;
    if (!cand || !media.video?.videoId) throw bad("That moment isn't in this dive's official video.");
    const a = await cutClip(sec.deepDive!, media.video.videoId, cand.start, Math.min(cand.end, cand.start + 10), cand.description);
    const old = data.clips[edit.index];
    data.clips[edit.index] = { ...old, file: a.file, poster: a.poster, w: a.width, h: a.height };
  } else if (edit.op === "highlights") {
    if ((sec.kind as string) !== "article" || !data.article) throw bad("This chapter doesn't show the official post.");
    const media: MediaCatalog = JSON.parse(d.mediaJson || "{}");
    const blocks = new Map((media.page?.blocks ?? []).map((b) => [b.i, b]));
    const items = (edit.items ?? []).map((x) => ({ b: blocks.get(Number(x.block)), caption: s(x.caption, 90) })).filter((x) => x.b).sort((a, b) => a.b!.y - b.b!.y).slice(0, 6);
    if (!items.length) throw bad("Pick at least one line of the post.");
    data.article.highlights = items.map((x) => ({ x: x.b!.x, y: x.b!.y, w: x.b!.w, h: x.b!.h, caption: x.caption, block: x.b!.i }));
    // The script's [next] marks must follow the new beat count.
    deepDiveSections.update(sectionId, { script: fitMarkers(sec.script ?? "", items.length) });
  } else throw bad("Unknown edit.");

  deepDiveSections.update(sectionId, { dataJson: JSON.stringify(data) });
  deepDives.update(d.id, { updatedAt: new Date().toISOString() });
}
