/**
 * Deep Dive v2 — the DEMO AGENT (Jake, 2026-10-02: "a real agent that shows a
 * live demo, with a toggle on or off"; when it runs: "Both" — recorded while
 * building, and runnable live from the stage).
 *
 * It is a UX Scout job in DEMO MODE (see ~/.claude/skills/ux-scout/SKILL.md):
 * Claude Code on the host drives the Lab's server browser through the real
 * product, keeps 3-6 captioned key moments, and finishes. runId tells the
 * Scout's finish hook where the run belongs:
 *   dd:<diveId>      recorded while building → becomes the dive's agent chapter
 *   ddlive:<diveId>  run live from the stage → only watched, never attached
 *
 * A recorded run → DemoTab steps: for each key moment, the screen just BEFORE
 * the click that led to it, with the cursor at that click; the last moment is
 * the result screen itself. Shots are copied into the dive's asset dir so the
 * show never depends on the Scout's job folder.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "../db/index.js";
import { callNewsModel } from "./ai.js";
import { deepDives, deepDiveSections, sectionsOf } from "./deepDive.js";
import { assetDir } from "./deepDiveVisuals.js";
import { listTools, addTool, createJob, getJob, listJobs, listEvents, jobDir, type ScoutJob } from "../scout/store.js";

export const DEMO_CONTEXT_PREFIX = "DEMO MODE —";
const SHOT_W = 1280, SHOT_H = 900; // the Scout browser's viewport

const hostOf = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

/** The Scout tool for this product: matched by host, created if new. */
function toolFor(url: string, name: string): string {
  const host = hostOf(url);
  if (!host) throw new Error("Give the demo agent the product's URL (e.g. https://chatgpt.com).");
  const hit = listTools().find((t) => hostOf(t.homeUrl) === host);
  if (hit) return hit.slug;
  return addTool({ name: name || host, homeUrl: url, note: "Added by Deep Dive's demo agent" }).slug;
}

function demoGoal(topic: string, angle: string): string {
  return `Show the audience "${topic}" really working: do one real, impressive task with it, start to finish, the way a regular person would.${angle ? ` Jake's angle: ${angle}` : ""}`;
}

function demoContext(topic: string): string {
  return `${DEMO_CONTEXT_PREFIX} Deep Dive live show. Topic: ${topic}. Record a short, clean demonstration (3-6 captioned key moments) — not a UX report.`;
}

/** Queue a demo run for a dive. `live` = run from the stage, watched, never attached. */
export function startDemoJob(diveId: string, live = false): ScoutJob {
  const d = deepDives.get(diveId);
  if (!d) throw Object.assign(new Error("Deep dive not found."), { status: 404 });
  const url = (d.demoUrl || "").trim();
  const slug = toolFor(url, "");
  return createJob({ toolSlug: slug, goal: demoGoal(d.topic ?? "", d.angle ?? ""), context: demoContext(d.topic ?? ""), runId: `${live ? "ddlive" : "dd"}:${diveId}` });
}

/** The newest recorded demo run of a dive (any status). */
export function latestDemoJob(diveId: string): ScoutJob | null {
  return listJobs({ runId: `dd:${diveId}`, limit: 1 })[0] ?? null;
}

/* ── recording → steps ────────────────────────────────────────────────────── */

const CLICK_RE = /\bat (\d{1,4}),\s?(\d{1,4})\b/;

interface Step { image: string; w: number; h: number; box: [number, number, number, number] | null; click: [number, number] | null; caption: string; label: string }

function copyShot(diveId: string, jobId: string, file: string): string | null {
  const src = path.join(jobDir(jobId), file);
  if (!fs.existsSync(src)) return null;
  const name = `${crypto.createHash("sha1").update(`${jobId}/${file}`).digest("hex").slice(0, 16)}.jpg`;
  const dir = assetDir(diveId);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, name);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  return name;
}

/** A spotlight box around a click: about a third of the screen, kept inside it. */
function boxAround(x: number, y: number): [number, number, number, number] {
  const w = SHOT_W * 0.36, h = SHOT_H * 0.34;
  const bx = Math.max(0, Math.min(SHOT_W - w, x - w / 2));
  const by = Math.max(0, Math.min(SHOT_H - h, y - h / 2));
  return [Math.round(bx), Math.round(by), Math.round(w), Math.round(h)];
}

export function stepsFromJob(diveId: string, job: ScoutJob): Step[] {
  const events = listEvents(job.id, 0, 2000);
  const steps: Step[] = [];
  const keys = events.filter((e) => e.kind === "key_shot" && e.file);
  keys.forEach((k, n) => {
    const before = events.filter((e) => e.seq < k.seq);
    // The click that led here (after the previous key moment) and the screen it was made on.
    const prevKeySeq = n > 0 ? keys[n - 1].seq : 0;
    const click = [...before].reverse().find((e) => e.seq > prevKeySeq && e.kind === "action" && /^Click/.test(e.text) && CLICK_RE.test(e.text));
    const isLast = n === keys.length - 1;
    if (click && !isLast) {
      const pre = [...before].reverse().find((e) => e.seq < click.seq && e.kind === "shot" && e.file);
      const m = CLICK_RE.exec(click.text)!;
      const x = Number(m[1]), y = Number(m[2]);
      const img = pre?.file ? copyShot(diveId, job.id, pre.file) : null;
      if (img) { steps.push({ image: img, w: SHOT_W, h: SHOT_H, box: boxAround(x, y), click: [x, y], caption: k.text.slice(0, 300), label: "AI agent" }); return; }
    }
    const img = copyShot(diveId, job.id, k.file!);
    if (img) steps.push({ image: img, w: SHOT_W, h: SHOT_H, box: null, click: null, caption: k.text.slice(0, 300), label: isLast ? "Result" : "AI agent" });
  });
  return steps.slice(0, 8);
}

/* ── attach a finished recording to its dive ──────────────────────────────── */

/** On-screen captions are 4-7 words. A Scout's key-shot notes can be long UX notes — rewrite those. */
async function shortenCaptions(topic: string, steps: Step[]): Promise<void> {
  const long = steps.map((s, i) => ({ i, t: s.caption })).filter((x) => x.t.split(/\s+/).length > 8);
  if (!long.length) return;
  try {
    const text = await callNewsModel(
      `These are notes an AI agent took at key moments while using "${topic}". Rewrite each as an on-screen caption for a live show: 4-7 plain words, present tense, what the viewer SEES happening. Reply with ONLY a JSON array of strings, same order.\n\n${JSON.stringify(long.map((x) => x.t))}`,
      "news-deepdive-script", "fast",
    );
    const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    if (Array.isArray(arr) && arr.length === long.length) long.forEach((x, k) => { if (typeof arr[k] === "string" && arr[k].trim()) steps[x.i].caption = arr[k].trim().slice(0, 70); });
  } catch {
    for (const x of long) steps[x.i].caption = x.t.split(/\s+/).slice(0, 7).join(" ") + "…";
  }
}

async function narrate(topic: string, steps: Step[]): Promise<string> {
  const fallback = steps.map((s) => `${s.caption}.`).join(" [next] ");
  try {
    const text = await callNewsModel(
      `Jake Dawson narrates a live demo on his AI show while an AI agent uses "${topic}" on screen. Write what he says over each step — 1-2 short, casual sentences per step, a normal American talking to friends, plain words, no hype. Talk about what's on screen ("watch — it's typing the request itself"). Exactly ${steps.length} parts separated by the marker [next] on its own. Output only the words.\n\nSTEPS:\n${steps.map((s, i) => `${i + 1}. ${s.caption}`).join("\n")}`,
      "news-deepdive-script",
      "fast",
    );
    const parts = text.split(/\s*\[next\]\s*/i).map((x) => x.trim()).filter(Boolean);
    return parts.length === steps.length ? parts.join(" [next] ") : fallback;
  } catch { return fallback; }
}

export async function attachDemoToDive(diveId: string, jobId: string): Promise<{ attached: boolean; reason?: string }> {
  const d = deepDives.get(diveId);
  const job = getJob(jobId);
  if (!d || !job) return { attached: false, reason: "dive or job missing" };
  if (d.format !== "v2") return { attached: false, reason: "not a v2 dive" };
  const steps = stepsFromJob(diveId, job);
  if (steps.length < 2) return { attached: false, reason: `only ${steps.length} key moments` };
  await shortenCaptions(d.topic ?? "", steps);
  const host = hostOf(d.demoUrl || "") || "the product";
  const tab = { name: "AI agent", job: `Live on ${host}`, color: "#ffd21e", source: "agent", credit: `Recorded by the demo agent on ${host}`, steps, jobId };
  const script = await narrate(d.topic ?? "", steps);

  const secs = sectionsOf(diveId);
  const existing = secs.find((s) => {
    try { return JSON.parse(s.dataJson || "{}").agentDemo === true; } catch { return false; }
  });
  const data = { tabs: [tab], agentDemo: true, island: { q: "Who's clicking?", a: "The AI agent" } };
  db.transaction(() => {
    if (existing) {
      deepDiveSections.update(existing.id, { dataJson: JSON.stringify(data), script });
    } else {
      // Right after the title: the agent doing it IS the payoff.
      const titlePos = secs[0]?.position ?? 0;
      deepDiveSections.insert({
        deepDive: diveId, position: titlePos + 0.5, kind: "demo" as any,
        eyebrow: "Live demo · AI agent", heading: "Watch the AI *do it live*",
        dataJson: JSON.stringify(data), script, visualJson: "",
      });
      sectionsOf(diveId).forEach((s, i) => deepDiveSections.update(s.id, { position: i + 1 }));
    }
  })();
  deepDives.update(diveId, { updatedAt: new Date().toISOString() });
  return { attached: true };
}

/** Called by the Scout's finish hook for runIds that belong to Deep Dive. */
export function onScoutFinished(job: ScoutJob): boolean {
  const m = /^dd:([0-9a-f-]{36})$/i.exec(job.runId ?? "");
  if (/^ddlive:/.test(job.runId ?? "")) return true;
  if (!m) return false;
  void attachDemoToDive(m[1], job.id).then((r) => {
    if (!r.attached) console.warn(`[news-deepdive-demo] demo run ${job.id} not attached: ${r.reason}`);
  }).catch((err) => console.warn("[news-deepdive-demo] attach failed:", err));
  return true;
}

/* ── live view (the stage's "Run live") ───────────────────────────────────── */

export function liveDemoState(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error("Demo run not found."), { status: 404 });
  const events = listEvents(job.id, 0, 2000);
  const shot = [...events].reverse().find((e) => e.kind === "shot" && e.file);
  const lastClick = [...events].reverse().find((e) => e.kind === "action" && CLICK_RE.test(e.text));
  const m = lastClick ? CLICK_RE.exec(lastClick.text) : null;
  const note = [...events].reverse().find((e) => e.kind === "note" || e.kind === "key_shot");
  return {
    status: job.status,
    error: job.error,
    shot: shot?.file ? `/api/scout/jobs/${job.id}/files/${shot.file}` : null,
    click: m && lastClick && shot && lastClick.seq < shot.seq + 2 ? [Number(m[1]), Number(m[2])] : null,
    caption: note?.text?.slice(0, 120) ?? "",
    w: SHOT_W, h: SHOT_H,
    steps: events.filter((e) => e.kind === "action").length,
  };
}
