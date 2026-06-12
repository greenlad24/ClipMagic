/**
 * Script-guided screencast planner.
 *
 * Reads the narrator's word-timed transcript and decides up to N moments where
 * the narration references a concrete website / source / product / article worth
 * SHOWING (e.g. "a recent MIT study", "this tool", "their pricing page"). For
 * each, the model proposes the most likely REAL canonical URL; we then VALIDATE
 * every URL server-side (HTTP < 400, HTML content-type). On failure we try ONE
 * model-suggested alternate, else DROP the moment — the user explicitly chose NO
 * AI/stock fallback, so a moment with no working page is skipped and the narrator
 * stays on screen.
 *
 * The planner is PURE/injectable: the AI call (`askModel`) and URL validator
 * (`validateUrl`) are passed in, so the shaping logic — word-timing alignment,
 * overlap avoidance, clip-length clamping, drop-on-invalid-URL — is unit-tested
 * with zero network.
 */

// ── Public contract ───────────────────────────────────────────────────────────

export interface PlannerWord {
  text: string;
  start: number;
  end: number;
}

/** An existing shot the planner must not overlap (only non-TalkingHead matter). */
export interface ExistingShot {
  shotType?: string;
  startTime?: number;
  endTime?: number;
}

export interface PlanScreencastsInput {
  transcript: string;
  words: PlannerWord[];
  durationSeconds: number;
  shots: ExistingShot[];
  /** Max planned moments (default 3). */
  maxMoments?: number;
  /** Injected AI call — returns the raw model JSON string. */
  askModel: (prompt: PlannerPrompt) => Promise<string>;
  /** Injected URL validator — true when the URL serves HTML with status < 400. */
  validateUrl: (url: string) => Promise<boolean>;
}

/** What the model is asked (so a caller can build the real Claude call). */
export interface PlannerPrompt {
  system: string;
  user: string;
}

/** One model-proposed moment before validation. */
export interface RawMoment {
  startSec: number;
  endSec: number;
  url: string;
  altUrl?: string;
  query: string;
  reason: string;
  confidence: number;
}

/** One planned, URL-validated moment ready to capture. */
export interface PlannedMoment {
  startSec: number;
  endSec: number;
  url: string;
  query: string;
  reason: string;
  confidence: number;
  /** Transcript text spanned by [startSec, endSec], for the shot's snippet. */
  transcriptSnippet: string;
}

export interface PlanResult {
  planned: PlannedMoment[];
  /** Moments dropped, with a human reason (invalid URL, overlap, etc.). */
  skipped: Array<{ reason: string; url?: string; startSec?: number }>;
}

// ── Tunables ──────────────────────────────────────────────────────────────────
export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 8;
export const HEAD_BUFFER = 1.0; // don't plant a screencast over the hook
export const TAIL_BUFFER = 1.5; // leave the CTA clean

export const PLANNER_SYSTEM = `You are a short-form video editor deciding when to cut to a REAL WEBSITE SCREENCAST over a vertical (9:16) talking-head video.

You are given the narrator's transcript. Identify the moments where the narration references a CONCRETE, SHOWABLE web destination — a named website, product, tool, company, article, study, or source the viewer would benefit from SEEING on screen (e.g. "a 2023 MIT study", "check out Linear", "their pricing page", "this GitHub repo").

For EACH such moment return:
- "startSec"/"endSec": when the reference is spoken (you'll be given word timings to align to).
- "url": the single MOST LIKELY real, canonical, publicly-reachable URL for it (prefer the official homepage or the specific page named). Use https. Never invent a URL you aren't reasonably confident resolves.
- "altUrl": an OPTIONAL second-best real URL to try if the first fails (omit if none).
- "query": 2-5 words naming the thing (for logging/search).
- "reason": one short sentence quoting what the narrator said.
- "confidence": 0.0-1.0 — your confidence the URL is real and on-topic.

IRON RULES:
- BE SPARING. Only moments with a genuine, nameable web destination. Vague mentions ("the internet", "a website") are NOT showable — skip them.
- Never propose a URL for a generic concept. If you can't name a real page, don't include the moment.
- Prefer official/canonical domains. No tracking/affiliate/shortener links.
- Return AT MOST the requested number of moments, fewer if fewer are motivated. Zero is a fine answer.

Return ONLY JSON: { "moments": [ { "startSec": 8.2, "endSec": 12.0, "url": "https://...", "altUrl": "https://...", "query": "...", "reason": "...", "confidence": 0.8 } ] }`;

// ── Helpers (pure) ─────────────────────────────────────────────────────────────

/**
 * Only snap to a word boundary when one sits within this many seconds of the
 * target — so a moment is gently aligned to real speech, but a model time that
 * lands in a gap (or sparse word timings) is NOT yanked across the timeline.
 */
export const SNAP_WINDOW = 1.0;

/** Snap a time to the nearest word START boundary within SNAP_WINDOW (else keep). */
function snapToWordStart(t: number, words: PlannerWord[]): number {
  if (!words.length) return t;
  let best = t;
  let bestD = SNAP_WINDOW;
  for (const w of words) {
    const d = Math.abs(w.start - t);
    if (d < bestD) { bestD = d; best = w.start; }
  }
  return best;
}

/** Snap a time to the nearest word END boundary within SNAP_WINDOW (else keep). */
function snapToWordEnd(t: number, words: PlannerWord[]): number {
  if (!words.length) return t;
  let best = t;
  let bestD = SNAP_WINDOW;
  for (const w of words) {
    const d = Math.abs(w.end - t);
    if (d < bestD) { bestD = d; best = w.end; }
  }
  return best;
}

/** The transcript text spanned by [start, end] (words whose center falls inside). */
export function snippetFor(words: PlannerWord[], start: number, end: number): string {
  return words
    .filter((w) => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 <= end)
    .map((w) => w.text)
    .join(" ")
    .trim();
}

/** True when [s,e] overlaps any reserved [start,end] window. */
function overlaps(s: number, e: number, reserved: Array<{ s: number; e: number }>): boolean {
  return reserved.some((r) => s < r.e && e > r.s);
}

/** Parse + coerce the model's raw moments array defensively. */
export function parseRawMoments(rawJson: string): RawMoment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  const arr = Array.isArray((parsed as { moments?: unknown })?.moments)
    ? (parsed as { moments: unknown[] }).moments
    : Array.isArray(parsed)
    ? (parsed as unknown[])
    : [];
  const out: RawMoment[] = [];
  for (const item of arr) {
    const m = item as Partial<RawMoment>;
    const startSec = Number(m.startSec);
    const endSec = Number(m.endSec);
    const url = typeof m.url === "string" ? m.url.trim() : "";
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || !url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      startSec,
      endSec,
      url,
      altUrl: typeof m.altUrl === "string" && /^https?:\/\//i.test(m.altUrl) ? m.altUrl.trim() : undefined,
      query: typeof m.query === "string" ? m.query : url,
      reason: typeof m.reason === "string" ? m.reason : "",
      confidence: Number.isFinite(Number(m.confidence)) ? Number(m.confidence) : 0.5,
    });
  }
  return out;
}

/**
 * Clamp + word-align one raw moment's timing into a tasteful clip window inside
 * the safe [HEAD, duration-TAIL] band. Returns null if it can't fit.
 */
export function shapeTiming(
  m: RawMoment,
  words: PlannerWord[],
  durationSeconds: number,
): { startSec: number; endSec: number } | null {
  let start = snapToWordStart(Math.max(HEAD_BUFFER, m.startSec), words);
  let end = snapToWordEnd(Math.max(start + MIN_CLIP_SEC, m.endSec), words);

  // Enforce clip length bounds.
  if (end - start < MIN_CLIP_SEC) end = start + MIN_CLIP_SEC;
  if (end - start > MAX_CLIP_SEC) end = start + MAX_CLIP_SEC;

  // Keep inside the safe band.
  const latestEnd = durationSeconds - TAIL_BUFFER;
  if (end > latestEnd) {
    end = latestEnd;
    start = Math.max(HEAD_BUFFER, end - MAX_CLIP_SEC);
  }
  if (end - start < MIN_CLIP_SEC) return null; // no room
  if (start < HEAD_BUFFER) return null;

  return { startSec: Number(start.toFixed(3)), endSec: Number(end.toFixed(3)) };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export function buildPlannerPrompt(input: {
  transcript: string;
  words: PlannerWord[];
  durationSeconds: number;
  maxMoments: number;
}): PlannerPrompt {
  // A compact word-timing line so the model can align to real boundaries without
  // blowing the prompt up on long scripts.
  const timingLine = input.words.length
    ? "WORD TIMINGS (start-end : word):\n" +
      input.words
        .map((w) => `${w.start.toFixed(1)}-${w.end.toFixed(1)}:${w.text}`)
        .join(" ")
    : "";
  const user =
    `Video duration: ${input.durationSeconds.toFixed(1)}s. ` +
    `Return at most ${input.maxMoments} screencast moment(s), fewer if fewer are motivated.\n\n` +
    `TRANSCRIPT:\n${input.transcript}\n\n${timingLine}\n\nReturn the moments JSON now.`;
  return { system: PLANNER_SYSTEM, user };
}

/**
 * Plan screencast moments. AI call + URL validator are injected. Existing
 * non-TalkingHead shots are reserved up front so planned moments never overlap
 * them (or each other).
 */
export async function planScreencasts(input: PlanScreencastsInput): Promise<PlanResult> {
  const maxMoments = input.maxMoments ?? 3;
  const skipped: PlanResult["skipped"] = [];

  // Reserve windows: every existing shot that already carries a visual (anything
  // that isn't a plain Talking Head). Planned moments must not collide with them.
  const reserved: Array<{ s: number; e: number }> = input.shots
    .filter((s) => s.shotType && s.shotType !== "Talking Head")
    .filter((s) => typeof s.startTime === "number" && typeof s.endTime === "number")
    .map((s) => ({ s: s.startTime as number, e: s.endTime as number }));

  const prompt = buildPlannerPrompt({
    transcript: input.transcript,
    words: input.words,
    durationSeconds: input.durationSeconds,
    maxMoments,
  });

  let raw: RawMoment[] = [];
  try {
    raw = parseRawMoments(await input.askModel(prompt));
  } catch (e) {
    skipped.push({ reason: `planner model call failed: ${e instanceof Error ? e.message : String(e)}` });
    return { planned: [], skipped };
  }

  // Highest confidence first, so when we hit the cap we keep the best.
  raw.sort((a, b) => b.confidence - a.confidence);

  const planned: PlannedMoment[] = [];
  for (const m of raw) {
    if (planned.length >= maxMoments) {
      skipped.push({ reason: "exceeded max moments", url: m.url, startSec: m.startSec });
      continue;
    }
    const timing = shapeTiming(m, input.words, input.durationSeconds);
    if (!timing) {
      skipped.push({ reason: "no room in timeline for clip", url: m.url, startSec: m.startSec });
      continue;
    }
    if (overlaps(timing.startSec, timing.endSec, reserved)) {
      skipped.push({ reason: "overlaps an existing shot", url: m.url, startSec: timing.startSec });
      continue;
    }

    // Validate the primary URL; fall back to ONE alternate; else DROP.
    let workingUrl: string | null = null;
    if (await safeValidate(input.validateUrl, m.url)) {
      workingUrl = m.url;
    } else if (m.altUrl && (await safeValidate(input.validateUrl, m.altUrl))) {
      workingUrl = m.altUrl;
    }
    if (!workingUrl) {
      skipped.push({ reason: "no working page (URL failed validation)", url: m.url, startSec: timing.startSec });
      continue;
    }

    planned.push({
      startSec: timing.startSec,
      endSec: timing.endSec,
      url: workingUrl,
      query: m.query,
      reason: m.reason,
      confidence: m.confidence,
      transcriptSnippet: snippetFor(input.words, timing.startSec, timing.endSec),
    });
    reserved.push({ s: timing.startSec, e: timing.endSec }); // block subsequent overlaps
  }

  return { planned, skipped };
}

/** Validation must never throw — a thrown validator is treated as "invalid". */
async function safeValidate(fn: (u: string) => Promise<boolean>, url: string): Promise<boolean> {
  try {
    return await fn(url);
  } catch {
    return false;
  }
}
