/**
 * Narration Cutter — Phase 2: duplicate-take detection.
 *
 * Raw narration often contains several attempts at the same line (false starts,
 * flubs, "let me try that again"). This module finds those repeated-take groups
 * and keeps only the BEST take, dropping the rest. "Best" combines:
 *   - audio energy  (ffmpeg volumedetect mean volume — louder, more committed)
 *   - on-camera delivery (vision: smiling / eyes-open / looking at camera /
 *     engaged, scored from sampled frames)
 *
 * Everything here is best-effort: if the AI providers or ffmpeg analysis aren't
 * available, it degrades gracefully (returns no drops) so the deterministic
 * silence/filler cut still ships.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { claudeJSONForPurpose, anthropicConfigured } from "../ai/claude.js";
import { claudeVisionJSON } from "../ai/claude.js";
import { groqVisionConfigured } from "../ai/groqVision.js";
import type { PlanWord, Segment } from "./plan.js";

export interface Take {
  start: number;
  end: number;
  text: string;
}
export interface TakeGroup {
  takes: Take[];
}
export interface TakeDecision {
  groupsFound: number;
  takesRemoved: number;
  dropRanges: Segment[];
}

const EMPTY: TakeDecision = { groupsFound: 0, takesRemoved: 0, dropRanges: [] };

function normTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
}

/** Jaccard similarity of two phrases' word sets — guards against bad grouping. */
function similarity(a: string, b: string): number {
  const A = new Set(normTokens(a));
  const B = new Set(normTokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Cheap deterministic pre-filter: does the transcript plausibly contain a
 * repeated take at all? We slide a window over short word-shingles and look for
 * the SAME ~6-word phrase recurring later in the recording. If nothing repeats,
 * there is no point spending an LLM call (and its latency) on grouping — the
 * common case for a clean read. Conservative: a single hit is enough to proceed
 * (the LLM still validates), but zero hits reliably means "no duplicate takes".
 */
function hasLikelyRepeat(words: PlanWord[]): boolean {
  const W = 6;
  if (words.length < W * 2) return false;
  const toks = normTokens(words.map((w) => w.word).join(" "));
  if (toks.length < W * 2) return false;
  const seen = new Set<string>();
  for (let i = 0; i + W <= toks.length; i++) {
    const shingle = toks.slice(i, i + W).join(" ");
    if (seen.has(shingle)) return true;
    seen.add(shingle);
  }
  return false;
}

/** Ask Claude to find groups of repeated takes from the timestamped transcript. */
async function detectTakeGroups(words: PlanWord[], duration: number): Promise<TakeGroup[]> {
  if (!anthropicConfigured() || words.length < 6) return [];
  // Skip the LLM round-trip entirely when no phrase visibly recurs.
  if (!hasLikelyRepeat(words)) return [];

  const ts = words.map((w) => `[${w.start.toFixed(2)}] ${w.word}`).join(" ");
  const system = `You are a meticulous video editor reviewing a RAW, unedited narration recording.
The speaker frequently RE-RECORDS lines: they flub a sentence, stop, and say essentially the SAME sentence again (a "take"). Your job is to find these repeated-take groups so the editor can keep the best one.

Return ONLY JSON: {"groups":[{"takes":[{"start":12.30,"end":16.10,"text":"the line they said"}]}]}

Strict rules:
- A group = 2+ NEAR-CONSECUTIVE attempts at substantially the SAME sentence/phrase.
- start/end MUST align to the provided word timestamps and span each full attempt (first word to last word of that attempt).
- Order takes within a group chronologically.
- Do NOT group sentences that are genuinely different but happen to share a few words.
- Do NOT group a sentence with the next distinct sentence in the script.
- If there are no repeated takes, return {"groups":[]}.`;
  const user = `Recording duration: ${duration.toFixed(1)}s.\nWord-timestamped transcript:\n${ts}`;

  try {
    // Take-grouping is a cheap structured-extraction task — run it on the fast
    // (Haiku) tier and attribute it to its own purpose so the optimization
    // report bills it correctly (it was previously mis-routed to Sonnet and
    // counted as url-research).
    const raw = await claudeJSONForPurpose({
      tier: "fast",
      purpose: "take-detection",
      system,
      messages: [{ role: "user", content: user }],
    });
    const data = JSON.parse(raw);
    const groups: TakeGroup[] = Array.isArray(data?.groups) ? data.groups : [];
    return groups
      .map((g: any) => ({
        takes: (Array.isArray(g?.takes) ? g.takes : [])
          .filter((t: any) => Number.isFinite(t?.start) && Number.isFinite(t?.end) && t.end > t.start)
          .map((t: any) => ({ start: Number(t.start), end: Number(t.end), text: String(t.text ?? "") }))
          .sort((a: Take, b: Take) => a.start - b.start),
      }))
      // Keep only real repeated-take groups: 2+ takes that are actually similar.
      .filter((g: TakeGroup) => {
        if (g.takes.length < 2) return false;
        for (let i = 1; i < g.takes.length; i++) {
          if (similarity(g.takes[0].text, g.takes[i].text) < 0.5) return false;
        }
        return true;
      });
  } catch (e) {
    console.warn("[takes] detection failed (non-fatal):", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Mean audio volume (dB) over [start, start+dur]; null if it can't be measured. */
function meanVolumeDb(srcPath: string, start: number, dur: number): Promise<number | null> {
  if (dur <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn(config.ffmpegPath, [
      "-hide_banner", "-nostats",
      "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", srcPath,
      "-vn", "-af", "volumedetect", "-f", "null", "-",
    ]);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const m = err.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
      resolve(m ? Number.parseFloat(m[1]) : null);
    });
  });
}

/** Extract one downscaled JPEG frame at time `t` (base64), or null on failure. */
function extractFrameAt(srcPath: string, t: number): Promise<string | null> {
  const out = path.join(config.tmpDir, `take_${randomUUID()}.jpg`);
  return new Promise((resolve) => {
    const p = spawn(config.ffmpegPath, [
      "-y", "-ss", t.toFixed(3), "-i", srcPath,
      "-frames:v", "1",
      "-vf", "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'",
      "-q:v", "4", out, "-loglevel", "error",
    ]);
    p.on("error", () => resolve(null));
    p.on("close", () => {
      try {
        resolve(fs.readFileSync(out).toString("base64"));
      } catch {
        resolve(null);
      } finally {
        try { fs.rmSync(out, { force: true }); } catch { /* */ }
      }
    });
  });
}

/** Score each take's on-camera delivery 0..100 from one mid-take frame each. */
async function scoreGroupVision(srcPath: string, takes: Take[]): Promise<number[] | null> {
  if (!(anthropicConfigured() || groqVisionConfigured())) return null;
  // Extract every take's mid-frame in parallel — independent ffmpeg seeks.
  const frames = await Promise.all(
    takes.map((t) => extractFrameAt(srcPath, t.start + (t.end - t.start) * 0.5)),
  );
  if (frames.some((f) => f == null)) return null; // a missing frame makes the comparison unreliable
  const system = `You are reviewing one frame from each of several TAKES of the SAME spoken line in a talking-head video. Rate each take's ON-CAMERA DELIVERY from 0 to 100. Reward: a natural/positive expression or smile, eyes open, looking toward the camera, engaged confident energy, good framing. Penalize: blinking/closed eyes, looking away, flat or awkward expression, bad framing.
Return ONLY JSON: {"scores":[{"take":1,"score":83}, ...]} with one entry per take in order.`;
  const userText = `There are ${takes.length} takes, one frame each, in order (Take 1 … Take ${takes.length}). Score every take.`;
  try {
    const raw = await claudeVisionJSON({ system, userText, frames: frames as string[] });
    const data = JSON.parse(raw);
    const arr: any[] = Array.isArray(data?.scores) ? data.scores : [];
    const scores = takes.map((_, i) => {
      const s = arr.find((x) => Number(x?.take) === i + 1);
      return s && Number.isFinite(Number(s.score)) ? Number(s.score) : null;
    });
    return scores.some((s) => s == null) ? null : (scores as number[]);
  } catch (e) {
    console.warn("[takes] vision scoring failed (non-fatal):", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Pick the index of the best take from audio (dB) + optional vision (0..100). */
function pickWinner(takes: Take[], audioDb: (number | null)[], vision: number[] | null): number {
  const valid = audioDb.filter((x): x is number => x != null);
  const aMin = valid.length ? Math.min(...valid) : 0;
  const aMax = valid.length ? Math.max(...valid) : 0;
  const norm = (x: number) => (aMax > aMin ? (x - aMin) / (aMax - aMin) : 0.5);

  let best = takes.length - 1; // default: the last attempt (usually the keeper)
  let bestScore = -Infinity;
  for (let i = 0; i < takes.length; i++) {
    const aN = audioDb[i] != null ? norm(audioDb[i] as number) : 0.5;
    const vN = vision ? vision[i] / 100 : null;
    const combined = vN != null ? 0.55 * vN + 0.45 * aN : aN;
    if (combined >= bestScore) { bestScore = combined; best = i; } // ties -> later take
  }
  return best;
}

export async function planTakeDecision(
  srcPath: string,
  words: PlanWord[],
  duration: number,
): Promise<TakeDecision> {
  let groups: TakeGroup[];
  try {
    groups = await detectTakeGroups(words, duration);
  } catch {
    return EMPTY;
  }
  if (groups.length === 0) return EMPTY;

  const dropRanges: Segment[] = [];
  let takesRemoved = 0;
  for (const g of groups) {
    // Audio energy (per take) and vision scoring are independent — run the
    // per-take volume probes in parallel, and overlap them with the single
    // vision call, so a group's analysis is bound by its slowest leg, not the
    // sum of all legs.
    const [audio, vision] = await Promise.all([
      Promise.all(g.takes.map((t) => meanVolumeDb(srcPath, t.start, t.end - t.start))),
      scoreGroupVision(srcPath, g.takes),
    ]);
    const winner = pickWinner(g.takes, audio, vision);
    g.takes.forEach((t, i) => {
      if (i === winner) return;
      dropRanges.push({ start: Math.max(0, t.start - 0.05), end: Math.min(duration, t.end + 0.05) });
      takesRemoved++;
    });
    console.log(
      `[takes] group of ${g.takes.length}: kept take ${winner + 1} ` +
        `(audio=${audio.map((a) => (a == null ? "?" : a.toFixed(1))).join("/")}dB` +
        `${vision ? `, vision=${vision.join("/")}` : ", vision=off"})`,
    );
  }
  return { groupsFound: groups.length, takesRemoved, dropRanges };
}
