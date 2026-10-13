/**
 * TOOL REACTION — the AI News Stream's third show (Jake 2026-10-13):
 *
 *   "It will start with a short presentation in the style of the attached image
 *    … where we kind of set what is the tool/feature/product we're going to
 *    react to … and after the short presentation for the hook we'll dive right
 *    into the tool (it will still have a script and notes based on research of
 *    the UX scout that will be done in the preparation step of this segment)
 *    and the narrator will go through the tool testing the new features that
 *    are the most interesting and what they mean for the people watching — the
 *    same rules as the other presentations — it should keep watchers hooked."
 *
 * Jake's rulings (same day): during the tool part the show is HIS LIVE SCREEN
 * (OBS) — the Lab gives him the script and, per step, what to do with the
 * Scout's screenshot of it (also on the stage, as a backup view); the hook
 * slides leave a camera frame that OBS fills (`RX_CAMERA_FRAME`).
 *
 * Stored as a v2 Deep Dive with show_kind = "reaction", so the editor,
 * presenter, teleprompter, stage, follower link, live sync and ✎ Edit script
 * all work unchanged. The run:
 *   1. research the tool (the Deep Dive's researchers, cached 12 h)
 *   2. the UX SCOUT in REACTION MODE tests its newest/most interesting
 *      features signed in (runId `rx:<diveId>`; the run waits for it — a done
 *      run from the last 24 h is reused)
 *   3. outline: rx_hook (camera + the tool) → rx_coming ("coming up:" bullets)
 *      → one `demo` chapter per feature, built from the Scout's key moments,
 *      each step carrying "do this now" for Jake → `takeaways` (the verdict)
 *   4. script in Jake's voice with [next] per beat, the spoken + engagement rules
 */
import { db } from "../db/index.js";
import { stories } from "./db.js";
import { callNewsModel } from "./ai.js";
import { JAKE_STYLE_GUIDE } from "./deck.js";
import { fitMarkers } from "./deepDiveBeats.js";
import { beatCountOf } from "./deepDiveV2.js";
import { deepDives, deepDiveSections, sectionsOf, setGenerating, isGenerating, research, parseJsonReply, splitScripts, type ResearchPack } from "./deepDive.js";
import { toolFor, copyShot, boxAround, CLICK_RE, SHOT_SIZE } from "./deepDiveDemo.js";
import { createJob, getJob, listJobs, listEvents, type ScoutJob } from "../scout/store.js";
import { enforceSpokenRules, ENGAGEMENT_BLOCK } from "../scriptgen/spokenRules.js";

export const REACTION_CONTEXT_PREFIX = "REACTION MODE —";
/** Where OBS puts Jake's camera on the hook slides — % of the 16:9 frame (Jake's reference image, 1920×1080: 113,82 → 929,1000). */
export const RX_CAMERA_FRAME = { left: 5.9, top: 7.6, width: 42.5, height: 85, radius: 2.1 };
const MAX_SCOUT_WAIT_MS = 150 * 60_000;
const REUSE_SCOUT_MS = 24 * 3600_000;

const s = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const hostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isReaction = (id: string): boolean => deepDives.get(id)?.showKind === "reaction";
export const latestReactionJob = (diveId: string): ScoutJob | null => listJobs({ runId: `rx:${diveId}`, limit: 1 })[0] ?? null;

function scoutGoal(topic: string, angle: string): string {
  return `React to "${topic}" for a live show: find and really use its NEWEST and MOST INTERESTING features, the way an everyday person would — each one done for real, start to finish, with a result.${angle ? ` Jake's notes: ${angle}` : ""}`;
}

function scoutContext(topic: string): string {
  return `${REACTION_CONTEXT_PREFIX} Tool Reaction live show about ${topic}. Test 3-6 of the most interesting features (newest first). Keep 8-14 key screenshots: for each feature, the screen where it starts, the key click, and its result. Caption each key shot with what it shows. In notes, say what each feature means for an everyday viewer, and every bit of friction. The report: per feature — the exact path and labels, timing, the wow moment, the catch.`;
}

/** Queue the Scout for this reaction (or reuse a recent / running one). */
export function ensureReactionScout(diveId: string): ScoutJob {
  const d = deepDives.get(diveId);
  if (!d) throw Object.assign(new Error("Tool reaction not found."), { status: 404 });
  const last = latestReactionJob(diveId);
  if (last && ["queued", "running"].includes(last.status)) return last;
  if (last && last.status === "done" && Date.now() - Date.parse(last.finishedAt ?? last.createdAt) < REUSE_SCOUT_MS) return last;
  const slug = toolFor((d.demoUrl || "").trim(), d.topic ?? "");
  return createJob({ toolSlug: slug, goal: scoutGoal(d.topic ?? "", d.angle ?? ""), context: scoutContext(d.topic ?? ""), runId: `rx:${diveId}` });
}

/* ── the Scout's run → numbered key moments ───────────────────────────────── */

interface Step { image: string; w: number; h: number; box: [number, number, number, number] | null; click: [number, number] | null; caption: string; label: string }
interface Moment { step: Step; caption: string; notes: string[] }

/** Every key moment, in order: the screen just before the click that led to it (cursor on the click), else the shot itself; plus the Scout's notes around it. */
function momentsOf(diveId: string, job: ScoutJob): Moment[] {
  const events = listEvents(job.id, 0, 4000);
  const keys = events.filter((e) => e.kind === "key_shot" && e.file);
  const out: Moment[] = [];
  keys.forEach((k, n) => {
    const prevKeySeq = n > 0 ? keys[n - 1].seq : 0;
    const nextKeySeq = n < keys.length - 1 ? keys[n + 1].seq : Infinity;
    const notes = events.filter((e) => e.kind === "note" && e.seq > prevKeySeq && e.seq < nextKeySeq).map((e) => e.text.slice(0, 400)).slice(-3);
    const click = [...events].reverse().find((e) => e.seq < k.seq && e.seq > prevKeySeq && e.kind === "action" && /^Click/.test(e.text) && CLICK_RE.test(e.text));
    let step: Step | null = null;
    if (click) {
      const pre = [...events].reverse().find((e) => e.seq < click.seq && e.kind === "shot" && e.file);
      const m = CLICK_RE.exec(click.text)!;
      const x = Number(m[1]), y = Number(m[2]);
      const img = pre?.file ? copyShot(diveId, job.id, pre.file) : null;
      if (img) step = { image: img, w: SHOT_SIZE.w, h: SHOT_SIZE.h, box: boxAround(x, y), click: [x, y], caption: "", label: "Click" };
    }
    if (!step) {
      const img = copyShot(diveId, job.id, k.file!);
      if (img) step = { image: img, w: SHOT_SIZE.w, h: SHOT_SIZE.h, box: null, click: null, caption: "", label: "Result" };
    }
    if (step) out.push({ step, caption: k.text.slice(0, 300), notes });
  });
  return out.slice(0, 16);
}

/* ── outline ──────────────────────────────────────────────────────────────── */

interface Outline {
  title: string;
  subtitle: string;
  hook: { heading: string; lede: string };
  coming: { heading: string; items: string[] };
  features: Array<{ eyebrow: string; heading: string; island: { q: string; a: string } | null; moments: number[]; captions: string[]; todo: string[]; meaning: string; notes: string[] }>;
  verdict: { heading: string; points: string[] };
}

async function outline(topic: string, angle: string, url: string, pack: ResearchPack, job: ScoutJob, moments: Moment[]): Promise<Outline> {
  const list = moments.map((m, i) => `K${i}: ${m.caption}${m.step.click ? " (the screen just before the click)" : " (the result)"}${m.notes.length ? `\n    the tester's notes: ${m.notes.join(" / ")}` : ""}`).join("\n");
  const prompt = `You are the producer of a TOOL REACTION segment on Jake Dawson's live AI show ("Use AI like the pros — no code, no BS"). Jake's viewers are everyday, non-technical people (small-business owners, curious professionals). The segment:
1. A SHORT hook presentation (two slides, about 45 seconds): slide 1 names the tool and why it matters right now; slide 2 is "coming up:" — 2 to 4 bullets that promise what the viewer will see. Jake's camera sits in a frame on the left of both slides.
2. Then Jake goes LIVE into the tool on his own screen and tests its most interesting features one by one, reacting and saying what each means for the viewer.
3. A short verdict.

TOOL: ${topic} (${url})
${angle ? `JAKE'S NOTES: ${angle}\n` : ""}
WHAT A TESTER FOUND, SIGNED IN, TODAY (the highest authority on how the tool works — every click, label, timing and result comes from here):
${(job.report ?? "").slice(0, 14000)}

THE TESTER'S KEY MOMENTS (use them by id, each at most once; they are the steps Jake does live, and the backup screenshots on stage):
${list}

RESEARCH (the background facts you may use — what's new, when, who it's for):
${JSON.stringify(pack).slice(0, 9000)}

BUILD:
- "hook": "heading" = the tool or feature name with ONE accent word in *asterisks*, max 6 words (e.g. "Grok *Bots*", "Claude's *Chrome* extension"); "lede" = one line, max 14 words, why anyone should care right now.
- "coming": "heading" = "coming up:"; "items" = 2 to 4 bullets, max 6 words and 32 characters each (each must fit ONE line), each one a concrete promise of something the viewer will SEE later in the segment, the first 1-3 words wrapped in *asterisks* (they get underlined), e.g. "*1 thing* clients will pay for", "*4 ways* to put it on camera". Only promise what the features below deliver.
- "features": 3 to 6, the most interesting first-but-one: open with a strong one, keep the best for second-to-last, end on a real result. Each:
  - "eyebrow": "Feature n · <2-4 words>"; "heading": max 8 words, ONE *accent* phrase; "island": {"q":"max 3 words?","a":"max 3 words"};
  - "moments": the key-moment ids (numbers, in order) Jake walks through for it (1 to 4);
  - "captions": one per moment, 4-7 plain words, what the viewer sees;
  - "todo": one per moment — what Jake DOES live, for his notes: the exact clicks/labels/what to type, from the tester's report, max 35 words, and what to expect or watch out for;
  - "notes": one per moment — what Jake says and reacts to there, with the specific facts;
  - "meaning": one sentence — what this feature means for the people watching.
- "verdict": "heading" with one *accent* phrase; "points": 3 short takeaways (max 9 words each) — honest, including the catch.
- "title": max 8 words; "subtitle": max 14 words.
- Plain words on screen. Nothing invented: every claim from the tester's report or the research.

Reply with ONLY this JSON (no markdown):
{"title":"","subtitle":"","hook":{"heading":"","lede":""},"coming":{"heading":"coming up:","items":[""]},"features":[{"eyebrow":"","heading":"","island":{"q":"","a":""},"moments":[0],"captions":[""],"todo":[""],"notes":[""],"meaning":""}],"verdict":{"heading":"","points":[""]}}`;
  const text = await callNewsModel(prompt, "news-deepdive-outline", "director");
  const o = await parseJsonReply<any>(text, "tool reaction outline");
  const used = new Set<number>();
  const features = arr(o?.features).map((f) => {
    const ids = arr(f?.moments).map((x) => Number(String(x).replace(/^K/i, ""))).filter((k) => Number.isInteger(k) && k >= 0 && k < moments.length && !used.has(k));
    ids.forEach((k) => used.add(k));
    const per = (v: unknown, max: number) => ids.map((_, i) => s(arr(v)[i], max));
    return {
      eyebrow: s(f?.eyebrow, 60), heading: s(f?.heading, 90).replace(/\.\s*$/, ""),
      island: f?.island && s(f.island.q, 30) && s(f.island.a, 30) ? { q: s(f.island.q, 30), a: s(f.island.a, 30) } : null,
      moments: ids, captions: per(f?.captions, 70), todo: per(f?.todo, 300), notes: per(f?.notes, 500), meaning: s(f?.meaning, 240),
    };
  }).filter((f) => f.moments.length > 0).slice(0, 6);
  return {
    title: s(o?.title, 120) || topic, subtitle: s(o?.subtitle, 200),
    hook: { heading: s(o?.hook?.heading, 80) || topic, lede: s(o?.hook?.lede, 160) },
    coming: { heading: s(o?.coming?.heading, 30) || "coming up:", items: arr(o?.coming?.items).map((x) => s(x, 70)).filter(Boolean).slice(0, 4) },
    features,
    verdict: { heading: s(o?.verdict?.heading, 80) || "My *verdict*", points: arr(o?.verdict?.points).map((x) => s(x, 90)).filter(Boolean).slice(0, 4) },
  };
}

/* ── script ───────────────────────────────────────────────────────────────── */

const REACTION_RULES = `TOOL REACTION — how this segment talks (Jake, 2026-10-13: "it should keep watchers hooked to watch more"):
- CHAPTERS 1-2 ARE THE HOOK, about 45 seconds together. Chapter 1 opens on the most surprising thing the viewer is about to see — no "welcome back", no "today we're going to", no subscribe asks. Chapter 2 sells the "coming up" bullets as promises, one beat each, in a sentence or two.
- FROM CHAPTER 3 JAKE IS LIVE IN THE TOOL ON HIS OWN SCREEN. First person, present tense, reacting as he goes: "okay, let's click Create", "wait — look at this", "huh, that's not what I expected". Each beat = one step: say what he's doing in everyday words, his honest reaction, and what it means for the person watching.
- End each feature with a line that pulls into the next ("but the next one is the reason I wanted to show you this"). Keep an open loop running: the best feature is teased early and paid off late.
- Honest about friction and limits — the viewer trusts a reaction that admits the catch.
- The verdict is short: who it's for, the catch, would Jake use it.
- 1,100-1,500 words in total.`;

async function writeScripts(topic: string, angle: string, pack: ResearchPack, job: ScoutJob, chapters: Array<{ kind: string; heading: string; eyebrow: string; data: any; notes: string[] }>): Promise<string[]> {
  const beats = chapters.map((c) => beatCountOf(c.kind, c.data));
  const brief = chapters.map((c, i) => {
    const words = c.kind === "rx_hook" ? 60 : c.kind === "rx_coming" ? 30 * beats[i] : c.kind === "takeaways" ? 90 : 75 * beats[i];
    const screen = c.kind === "demo"
      ? `LIVE IN THE TOOL — steps: ${arr(c.data.tabs?.[0]?.steps).map((st: any, k: number) => `(${k + 1}) ${st.caption}`).join(" ")} · what it means: ${c.data.meaning ?? ""}`
      : JSON.stringify(c.data).slice(0, 600);
    return `### CHAPTER ${i + 1} — ${c.kind === "rx_hook" ? "HOOK: THE TOOL" : c.kind === "rx_coming" ? "HOOK: COMING UP" : c.kind === "takeaways" ? "VERDICT" : "LIVE FEATURE"} — ${beats[i]} beat${beats[i] === 1 ? "" : "s"} (${beats[i] - 1} [next] markers) — about ${words} words
ON SCREEN: ${c.eyebrow ? `${c.eyebrow} / ` : ""}${c.heading.replace(/\*/g, "")}
${screen}
SAY, BEAT BY BEAT: ${c.notes.map((n, k) => `(${k + 1}) ${n}`).join(" ")}`;
  }).join("\n\n");
  const prompt = `${JAKE_STYLE_GUIDE}

---

${ENGAGEMENT_BLOCK}

---

${REACTION_RULES}

Write Jake's teleprompter script for this tool reaction, chapter by chapter.

TOOL: ${topic}
${angle ? `JAKE'S NOTES: ${angle}\n` : ""}
THE CHAPTERS:
${brief}

THE TESTER'S REPORT (how it really works — the only source for clicks, labels, timings, results):
${(job.report ?? "").slice(0, 10000)}

RESEARCH (background facts):
${JSON.stringify(pack).slice(0, 6000)}

OUTPUT FORMAT — exactly ${chapters.length} chapters, each starting with its marker line on its own, then only the words Jake says, with [next] between beats:
### SECTION 1
(words) [next] (words)
### SECTION 2
…to ### SECTION ${chapters.length}. No other headings, labels or stage directions.`;
  const draft = await callNewsModel(prompt, "news-deepdive-script", "director");
  const parts = splitScripts(draft, chapters.length);
  if (parts.filter(Boolean).length < Math.ceil(chapters.length / 2)) throw new Error("The script step did not return the chapter markers.");
  const enforced = await Promise.all(parts.map(async (t, i) => (t ? (await enforceSpokenRules(t,
    (q) => callNewsModel(q, "news-deepdive-script", "director"),
    (m) => console.log(`[tool-reaction] section ${i + 1}: ${m}`))).script : t)));
  return enforced.map((p, i) => fitMarkers(p, beats[i]));
}

/* ── the run ──────────────────────────────────────────────────────────────── */

export async function generateToolReaction(
  write: (chunk: string) => void | Promise<void>,
  input: { id?: string; fresh?: boolean },
): Promise<{ success: boolean; sections: number; message: string }> {
  const id = typeof input?.id === "string" ? input.id : "";
  const d = id ? deepDives.get(id) : undefined;
  if (!d) throw Object.assign(new Error("Tool reaction not found."), { status: 404 });
  if (!(d.demoUrl || "").trim()) throw Object.assign(new Error("Give the tool's web address first (e.g. https://grok.com)."), { status: 400 });
  if (isGenerating(id)) throw new Error("This tool reaction is already preparing.");
  setGenerating(id, true);
  let pct = 0;
  const prog = async (message: string, percent?: number) => {
    if (typeof percent === "number") pct = percent;
    deepDives.update(id, { progressMessage: message, progressPercent: pct });
    try { await write(JSON.stringify({ message, percent: pct })); } catch { /* the page went away — the run goes on */ }
  };
  deepDives.update(id, { status: "generating", error: null as unknown as string, updatedAt: new Date().toISOString() });
  try {
    // 1. the Scout first — it is the long pole; research runs while it works
    let job = ensureReactionScout(id);
    await prog(job.status === "done" ? "UX Scout: reusing its test from earlier today." : `UX Scout queued — it is testing ${d.topic} signed in, in the Lab's browser (job ${job.id.slice(0, 8)}).`, 3);

    const story = d.story ? stories.get(d.story) : undefined;
    const key = `${d.topic ?? ""}\n${d.angle ?? ""}`;
    let pack: ResearchPack | null = null;
    if (!input?.fresh && d.researchJson) {
      try {
        const saved = JSON.parse(d.researchJson) as { key?: string; at?: number; pack?: ResearchPack };
        if (saved.key === key && saved.pack && Date.now() - (saved.at ?? 0) < 12 * 3600_000) pack = saved.pack;
      } catch { /* research again */ }
    }
    if (!pack) {
      await prog(`Researching what's new in ${d.topic}…`, 6);
      pack = await research(d, story);
      deepDives.update(id, { researchJson: JSON.stringify({ key, at: Date.now(), pack }), sourcesJson: JSON.stringify(pack.sources ?? []) });
    }
    await prog(`Research done: ${pack.facts?.length ?? 0} facts. Waiting for the UX Scout…`, 20);

    // 2. wait for the Scout (a restart kills a running one: start it once more)
    const t0 = Date.now();
    let restarts = 0;
    for (;;) {
      job = getJob(job.id) ?? job;
      if (job.status === "done") break;
      if (job.status === "failed" || job.status === "cancelled") {
        if (restarts++ >= 1) throw new Error(`The UX Scout ${job.status}${job.error ? `: ${job.error}` : ""}. Fix it (sign in to the tool in the Scout's console?) and press Prepare again.`);
        job = ensureReactionScout(id);
        await prog(`The UX Scout ${job.status === "queued" ? "stopped — started it again" : job.status}.`, 22);
      }
      if (Date.now() - t0 > MAX_SCOUT_WAIT_MS) throw new Error("The UX Scout took longer than 2½ hours.");
      const steps = listEvents(job.id, 0, 4000).filter((e) => e.kind === "action").length;
      const keys = job.keyShots?.length ?? 0;
      await prog(`UX Scout ${job.status === "queued" ? "is queued" : `is testing the tool — ${steps} actions, ${keys} key moments so far`}…`, Math.min(60, 22 + Math.round(steps / 3)));
      await sleep(15_000);
    }

    // 3. outline from its key moments
    const moments = momentsOf(id, job);
    if (moments.length < 3) throw new Error(`The UX Scout kept only ${moments.length} key moments — too few to walk through. Run it again with a clearer goal.`);
    await prog(`Designing the segment around ${moments.length} key moments from the test…`, 64);
    const o = await outline(d.topic ?? "", d.angle ?? "", d.demoUrl ?? "", pack, job, moments);
    if (o.features.length < 2) throw new Error(`The outline found only ${o.features.length} feature(s) to show.`);

    const host = hostOf(d.demoUrl ?? "") || "the tool";
    const chapters: Array<{ kind: string; eyebrow: string; heading: string; island: { q: string; a: string } | null; data: any; notes: string[] }> = [
      { kind: "rx_hook", eyebrow: "Tool reaction", heading: o.hook.heading, island: null, data: { lede: o.hook.lede, tool: d.topic ?? "", host }, notes: [o.hook.lede] },
      { kind: "rx_coming", eyebrow: "Coming up", heading: o.coming.heading, island: null, data: { items: o.coming.items.length ? o.coming.items : o.features.slice(0, 3).map((f) => f.heading) }, notes: o.coming.items },
      ...o.features.map((f) => {
        const steps = f.moments.map((k, i) => ({ ...moments[k].step, caption: f.captions[i] || moments[k].caption.split(/\s+/).slice(0, 7).join(" "), label: moments[k].step.label === "Result" ? "Result" : `Step ${i + 1}` }));
        return {
          kind: "demo", eyebrow: f.eyebrow, heading: f.heading, island: f.island,
          data: { tabs: [{ name: d.topic ?? host, job: f.eyebrow.replace(/^Feature \d+ · /i, ""), color: "#2f6bff", source: "screenshots", credit: `Screens from ${host}`, steps }], todo: f.todo, meaning: f.meaning, reaction: true },
          notes: f.notes,
        };
      }),
      { kind: "takeaways", eyebrow: "The verdict", heading: o.verdict.heading, island: null, data: { points: o.verdict.points }, notes: o.verdict.points },
    ];

    await prog("Writing the script in Jake's voice — hook, then live in the tool…", 74);
    const scripts = await writeScripts(d.topic ?? "", d.angle ?? "", pack, job, chapters);
    const words = scripts.join(" ").replace(/\[next\]/gi, "").split(/\s+/).filter(Boolean).length;

    db.transaction(() => {
      for (const old of sectionsOf(id)) deepDiveSections.remove(old.id);
      chapters.forEach((c, i) => deepDiveSections.insert({
        deepDive: id, position: i + 1, kind: c.kind as any, eyebrow: c.eyebrow, heading: c.heading,
        dataJson: JSON.stringify({ ...c.data, island: c.island }), script: scripts[i] ?? "", visualJson: "",
      }));
    })();
    const nowIso = new Date().toISOString();
    deepDives.update(id, { status: "ready", title: o.title, subtitle: o.subtitle, generatedAt: nowIso, updatedAt: nowIso });
    await prog(`Done — hook + ${o.features.length} live features + verdict, ~${Math.round(words / 150)} min.`, 100);
    return { success: true, sections: chapters.length, message: `Created ${chapters.length} chapters` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deepDives.update(id, { status: "error", error: message, updatedAt: new Date().toISOString() });
    throw err;
  } finally {
    setGenerating(id, false);
  }
}
