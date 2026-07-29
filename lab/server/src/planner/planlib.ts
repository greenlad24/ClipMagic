/**
 * Parsing and measurement for generated plans — pure, no I/O, unit-testable.
 *
 * Every constant here was MEASURED from four published Jake Dawson videos
 * (53 minutes, 277 shots) rather than chosen by taste. See the tuning notes:
 * a plan that sits inside these bands matches how he actually edits.
 */
import type { PlanElement, PlanLine, PlanMeasure } from "./types.js";

/** Acceptable band + the measured centre, per metric. */
export const CORPUS = {
  screencastPct: [65, 76, 70.6] as const,
  talkingHeadPct: [22, 34, 28.6] as const,
  stockPct: [0, 2.5, 0.8] as const,
  // Per-video, not pooled: 0.97 / 1.77 / 1.48 / 1.11 confirmed titles per
  // minute, so the floor is ref1's 0.97 exactly. It was 0.8 — BELOW every real
  // video — so a plan could sink to 0.83/min and nothing flagged it, which is
  // what happened. Same ceiling-versus-floor error as
  // shotsPerMin, in the other direction: bound the band to the corpus extreme,
  // never to a round number outside it. These counts are a LOWER bound, since
  // the overlay detector cannot confirm text over bright screencasts (29 such
  // events); including them the range is 1.70–2.22, so the ceiling stays at
  // 1.8 rather than being raised — the planner has never over-titled.
  titlesPerMin: [0.97, 1.8, 1.3] as const,
  // 77 is the POOLED figure across all four videos; per-video it ranges 47–90
  // (ref1 47, ref2 87, ref3 88, ref4 90). A [70,85] band flagged every real
  // video and pushed the planner to cut more to satisfy it — which is part of
  // what caused it to over-cut. Alternation genuinely varies by video, so this
  // is a weak constraint that only catches extremes.
  altPct: [45, 92, 77] as const,
  // A third of every video sits in a few demonstrations he lets RUN: per video
  // 5-9 screencasts past 25s carrying 29 / 49 / 26 / 34% of runtime. The first
  // plan to match his pace still put only 12% into three, because it hit the
  // median hold with many medium shots instead of a few long ones and a lot of
  // short ones. Median hold cannot see this; nothing else here could either.
  // Floor and ceiling are the corpus MIN and MAX exactly (ref3 26.1, ref2 49.2),
  // not rounded outward: rounding the ceiling to 50 would licence a plan that
  // parks a half-hour of screen time in two shots, and rounding the floor to 25
  // would pass ref3 only by luck. Both approved extremes must sit inside.
  longDemoPct: [26.1, 49.2, 34] as const,
  // Cut RATE and hold LENGTH, added after a plan matched the element mix almost
  // exactly yet still over-cut badly: 100 cuts where the editor made 60, and 62
  // screencast shots where he used 30. Mix alone does not catch that — a plan
  // can hit 70/30 while chopping every demonstration in half.
  // Ceilings are the corpus MAXIMUM, not a round number above it. They were
  // [7.5] and [6.5]; every generated plan parked just under those bars and
  // stopped — the planner optimises to the ceiling, so a ceiling looser than
  // anything Jake has made licences an edit he would never cut.
  //
  // Re-derived once the plan stopped writing talking-head lines, since these
  // are measured on the RECONSTRUCTED timeline: total 4.14 / 5.06 / 5.20 /
  // 6.66, body 3.86 / 4.69 / 4.76 / 5.76. (ref1 measures 6.66 rather than its
  // true 7.05 because a cut between two consecutive talking-head shots cannot
  // be expressed in this format — see withImpliedNarrator.)
  shotsPerMin: [4.0, 6.7, 5.2] as const,
  // Jake cuts the retention-critical opening ~1.9x faster than the body, in all
  // four videos (opening 6.7–12.7/min, body 3.9–6.1/min). A uniform rate across
  // the whole video is a real mismatch with how he actually edits.
  openingShotsPerMin: [6.0, 14.0, 9.0] as const,
  bodyShotsPerMin: [3.5, 5.8, 4.7] as const,
  // Jake's rule stated as a ratio, which is how he thinks about it: the hook
  // runs ~1.9x the body's pace and the body is regular pace. Per-video the
  // measured ratio is ref1 2.08, ref2 1.73, ref3 1.68, ref4 1.85 — so the band
  // sits just outside that range. This catches what the two rate bands cannot:
  // a plan can sit inside both and still be flat (hook 9.3 / body 6.4 = 1.45x).
  hookBodyRatio: [1.5, 2.4, 1.9] as const,
  screencastHold: [7.0, 15.0, 10.3] as const, // p25 5.0, median 10.3, p75 20.2
  talkingHeadHold: [3.0, 9.0, 5.5] as const, // p25 3.2, median 5.5, p75 11.5
};

/**
 * A plan line, read leniently.
 *
 * The canonical form is `[0:04 to 0:12] - Screencast: …` and the prompt asks
 * for exactly that. But a generation that comes back in a near-miss format is
 * a total loss under a strict reader: one round of this model emitted 6,268
 * characters that matched ZERO lines, so the whole round — thinking included,
 * which is most of its cost — was paid for and thrown away.
 *
 * So each part is optional or alternated where a model plausibly varies it:
 *   - a leading bullet or markdown bold/heading decoration
 *   - the brackets themselves
 *   - `to` written as an en/em dash or arrow
 *   - the separator before the instruction written as a colon
 *   - H:MM:SS timestamps, which the old reader rejected outright (it would
 *     have failed every video over an hour)
 *
 * It stays anchored to the start of the line so prose that merely mentions a
 * time is not mistaken for a shot.
 */
const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const LINE = new RegExp(
  String.raw`^(?:[-*+•]\s*)?(?:[*_#\s]*)?` + // optional bullet / markdown decoration
    String.raw`\[?\s*(${TS})\s*(?:to|[-–—→]{1,2}|until)\s*(${TS})\s*\]?` + // the range
    String.raw`[*_\s]*(?:[-–—:]\s*)+(.+)$`, // separator, then the instruction
  "i"
);

const toSec = (s: string): number => {
  const parts = s.split(":").map(Number);
  // H:MM:SS or M:SS — a plan for an hour-long video uses the former.
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
};

/** Markdown a model wraps around the instruction, which is not part of it. */
const stripMarkup = (s: string): string =>
  s
    .replace(/\*\*/g, "")
    .replace(/^`+|`+$/g, "")
    .trim();

const isTitle = (k: PlanElement) => k === "text_gradient" || k === "text_whiteboard";

export interface ParsedPlan {
  base: PlanLine[];
  titles: PlanLine[];
  unknown: PlanLine[];
  all: PlanLine[];
}

export function parsePlan(raw: string): ParsedPlan {
  const rows: PlanLine[] = [];
  for (const line of raw.split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const instruction = stripMarkup(m[3]);
    const h = instruction.toLowerCase();
    let kind: PlanElement = "unknown";
    if (/^text\s*\(gradient\)/.test(h)) kind = "text_gradient";
    else if (/^text\s*\(whiteboard\)/.test(h)) kind = "text_whiteboard";
    else if (/^screencast/.test(h)) kind = "screencast";
    else if (/^talking head/.test(h)) kind = "talking_head";
    else if (/^stock/.test(h)) kind = "stock_footage";
    rows.push({ start: toSec(m[1]), end: toSec(m[2]), kind, instruction });
  }
  return {
    base: rows.filter((r) => !isTitle(r.kind)).sort((a, b) => a.start - b.start),
    titles: rows.filter((r) => isTitle(r.kind)),
    unknown: rows.filter((r) => r.kind === "unknown"),
    all: rows,
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** The retention-critical window Jake cuts faster. */
const OPENING_SEC = 90;

/** Where a screencast stops being a shot and becomes a demonstration. */
const LONG_DEMO_SEC = 25;

/**
 * The plan is delivered by pasting it into Slack, which truncates a message at
 * 40,000 characters. We grade against a slightly lower ceiling so a plan that
 * passes here still has room for whatever the operator types around it.
 */
export const SLACK_MESSAGE_LIMIT = 40_000;
export const PLAN_CHAR_BUDGET = 38_000;

/** The plan exactly as it will be pasted — used when the raw text isn't to hand. */
function renderPlan(parsed: ParsedPlan): string {
  const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return parsed.all.map((r) => `[${stamp(r.start)} to ${stamp(r.end)}] - ${r.instruction}`).join("\n");
}

/**
 * Anything shorter than this between two written shots is rounding, not a
 * deliberate return to camera.
 */
const MIN_NARRATOR_GAP = 1.0;

/**
 * The plan only writes screencasts, stock and titles — every uncovered stretch
 * is Jake full screen, and the editor takes it from there. To grade the edit we
 * have to put those implied shots back, because they are real shots in the
 * finished video and every band (cut rate, holds, alternation, hook pace) is
 * measured against a complete timeline.
 */
export function withImpliedNarrator(base: PlanLine[], durationSec: number): PlanLine[] {
  const out: PlanLine[] = [];
  let t = 0;
  for (const s of base) {
    if (s.start - t >= MIN_NARRATOR_GAP)
      out.push({ start: t, end: s.start, kind: "talking_head", instruction: "(talking head — editor's shot)" });
    out.push(s);
    t = Math.max(t, s.end);
  }
  if (durationSec - t >= MIN_NARRATOR_GAP)
    out.push({ start: t, end: durationSec, kind: "talking_head", instruction: "(talking head — editor's shot)" });
  return out;
}

export function measurePlan(parsed: ParsedPlan, durationSec: number, rawText?: string): PlanMeasure {
  const { titles, unknown } = parsed;
  const written = parsed.base;
  const base = withImpliedNarrator(written, durationSec);
  // Below ~3 minutes the split has too few shots on either side to mean anything.
  const splitOk = durationSec > 180;
  const span = (rs: PlanLine[]) => rs.reduce((a, r) => a + (r.end - r.start), 0);
  const total = durationSec || 1;

  // A hole in the WRITTEN plan is a talking-head shot, not an error, so `gaps`
  // is only ever non-empty if the reconstruction failed. Overlaps are still
  // errors: two visuals cannot occupy the same second.
  const gaps: { at: number; len: number }[] = [];
  const overlaps: { at: number; len: number }[] = [];
  for (let i = 1; i < base.length; i++) {
    const d = +(base[i].start - base[i - 1].end).toFixed(2);
    if (d > 0.05) gaps.push({ at: base[i - 1].end, len: d });
  }
  for (let i = 1; i < written.length; i++) {
    const d = +(written[i].start - written[i - 1].end).toFixed(2);
    if (d < -0.05) overlaps.push({ at: written[i].start, len: -d });
  }

  const share = (k: PlanElement) => (span(base.filter((r) => r.kind === k)) / total) * 100;
  const hold = (k: PlanElement) => median(base.filter((r) => r.kind === k).map((r) => r.end - r.start));

  const trans: Record<string, number> = {};
  for (let i = 1; i < base.length; i++) {
    const k = `${base[i - 1].kind}->${base[i].kind}`;
    trans[k] = (trans[k] || 0) + 1;
  }
  const tTot = Object.values(trans).reduce((a, b) => a + b, 0) || 1;
  const altPct =
    (((trans["screencast->talking_head"] || 0) + (trans["talking_head->screencast"] || 0)) / tTot) * 100;

  const runs: number[] = [];
  let cur = 0;
  for (const s of base) {
    if (s.kind === "screencast") cur++;
    else {
      if (cur) runs.push(cur);
      cur = 0;
    }
  }
  if (cur) runs.push(cur);

  // Measured on the WRITTEN screencasts: a long demonstration is something the
  // planner has to decide to write, not something the reconstruction implies.
  const longDemo = written.filter((r) => r.kind === "screencast" && r.end - r.start >= LONG_DEMO_SEC);

  const hookRate = (base.filter((r) => r.start < OPENING_SEC).length / OPENING_SEC) * 60;
  const bodyRate = (base.filter((r) => r.start >= OPENING_SEC).length / (durationSec - OPENING_SEC)) * 60;

  const quoted = (r: PlanLine) => (r.instruction.match(/"([^"]+)"/) || [])[1] || "";

  return {
    lines: parsed.all.length,
    coverStart: written[0]?.start ?? null,
    coverEnd: written[written.length - 1]?.end ?? null,
    duration: durationSec,
    gaps,
    overlaps,
    unknown: unknown.length,
    screencastPct: +share("screencast").toFixed(1),
    talkingHeadPct: +share("talking_head").toFixed(1),
    stockPct: +share("stock_footage").toFixed(1),
    screencastHold: +hold("screencast").toFixed(1),
    talkingHeadHold: +hold("talking_head").toFixed(1),
    shots: base.length,
    shotsPerMin: +(base.length / (durationSec / 60)).toFixed(2),
    openingShotsPerMin: splitOk ? +(base.filter((r) => r.start < OPENING_SEC).length / (OPENING_SEC / 60)).toFixed(2) : null,
    bodyShotsPerMin: splitOk ? +(base.filter((r) => r.start >= OPENING_SEC).length / ((durationSec - OPENING_SEC) / 60)).toFixed(2) : null,
    hookBodyRatio: splitOk && bodyRate > 0 ? +(hookRate / bodyRate).toFixed(2) : null,
    titles: titles.length,
    titlesPerMin: +(titles.length / (durationSec / 60)).toFixed(2),
    longDemos: longDemo.length,
    longDemoPct: +((span(longDemo) / total) * 100).toFixed(1),
    altPct: +altPct.toFixed(0),
    maxScreencastRun: runs.length ? Math.max(...runs) : 0,
    longGradient: titles.filter((r) => r.kind === "text_gradient" && quoted(r).length > 42).map(quoted),
    gradientFullStop: titles.filter(
      (r) => r.kind === "text_gradient" && /["'][^"']*\.\s*["']/.test(r.instruction)
    ).length,
    chars: (rawText ?? renderPlan(parsed)).trim().length,
  };
}

/**
 * Concrete corrections for a plan. Empty when it is acceptable.
 *
 * Each entry is phrased as something the model can act on — "mix is off" leads
 * to vague revisions, "screencast share is 58, target 70, lengthen screencasts
 * and shorten the returns" does not.
 */
export function planDeviations(m: PlanMeasure): string[] {
  const d: string[] = [];
  const band = (
    v: number,
    [lo, hi, tgt]: readonly [number, number, number],
    label: string,
    up: string,
    down: string
  ) => {
    if (v < lo) d.push(`${label} is ${v} — too LOW. Target ~${tgt} (acceptable ${lo}–${hi}). ${up}`);
    else if (v > hi) d.push(`${label} is ${v} — too HIGH. Target ~${tgt} (acceptable ${lo}–${hi}). ${down}`);
  };


  // Nothing parsed at all. Every band below would then report on an empty plan
  // ("screencast share is 0 — too LOW", "cuts per minute is 0.07") and send the
  // model off fixing a distribution when the real problem is that it did not
  // write the format. Say the one thing that matters instead.
  if (m.lines === 0) {
    return [
      `NOTHING IN YOUR ANSWER WAS A PLAN LINE. Every line must start with a timestamp range and an element, exactly like this:\n` +
        `[0:04 to 0:12] - Screencast: Google Sheet — scroll the tab bar.\n` +
        `[0:13 to 0:15] - Text (gradient): "Where do I look?"\n` +
        `[1:34 to 1:41] - Stock footage: developer working late\n` +
        `Write the whole plan again in that form, one line per shot, and nothing else — no preamble, no headings, no commentary. ` +
        `Do not write lines for the talking head: leave those stretches uncovered.`,
    ];
  }

  if (m.overlaps.length)
    d.push(
      `${m.overlaps.length} OVERLAP(S) — two visuals cannot occupy the same second. First: ${m.overlaps[0].len}s at ${m.overlaps[0].at}s.`
    );
  // The plan may legitimately stop before the video does — a trailing talking
  // head needs no line. But a plan that stops MINUTES early was truncated.
  if (m.coverEnd !== null && m.duration - m.coverEnd > 90)
    d.push(
      `Your last visual is at ${Math.round(m.coverEnd)}s but the video runs to ${Math.round(m.duration)}s — ${Math.round(m.duration - m.coverEnd)}s with nothing planned. A short talking-head tail is fine; this is too long to be one. Plan the rest of the video.`
    );
  if (m.unknown)
    d.push(
      `${m.unknown} line(s) do not start with a recognised element. Each must begin with "Screencast:", "Stock footage:", "Text (gradient):" or "Text (whiteboard):". Do not write lines for the talking head — leave those stretches uncovered.`
    );

  band(
    m.screencastPct,
    CORPUS.screencastPct,
    "Screencast share of runtime (%)",
    "Extend screencasts and shorten the talking-head returns between them — do not delete the returns, make them briefer.",
    "Trim screencasts or add short talking-head returns."
  );
  band(
    m.talkingHeadPct,
    CORPUS.talkingHeadPct,
    "Talking-head share of runtime (%)",
    "Add brief talking-head returns between screencasts.",
    "Your face returns run too long. Keep them as brief punctuation (median ~5.5s) and give the reclaimed time to the screencasts."
  );
  band(
    m.stockPct,
    CORPUS.stockPct,
    "Stock-footage share of runtime (%)",
    "Add stock only where truly nothing can be screencast.",
    "Replace stock footage with a screencast or a talking-head hold."
  );
  band(
    m.titlesPerMin,
    CORPUS.titlesPerMin,
    "Titles per minute",
    "Add a few titles on the strongest emphasised lines.",
    "Cut the weakest titles — keep only genuine key concepts and section markers."
  );
  band(
    m.altPct,
    CORPUS.altPct,
    "Screencast↔talking-head share of all cuts (%)",
    "You are chaining too many screencasts. Break long screen runs with brief returns to camera.",
    "You are alternating on almost every beat. Let continuous flows (a signup, a build, a multi-step configuration) run across several screencasts without returning to camera."
  );

  band(
    m.shotsPerMin,
    CORPUS.shotsPerMin,
    "Cuts per minute",
    "You are holding shots too long — the edit will feel static. Add cuts where the narration moves to a new idea.",
    "You are OVER-CUTTING. This is the most common failure and the element mix will not reveal it: a plan can hit the right 70/30 split while chopping every demonstration into pieces. Merge adjacent shots — especially consecutive screencasts of the same flow — and delete face returns that interrupt a demonstration mid-way."
  );
  if (m.openingShotsPerMin !== null) {
    band(
      m.openingShotsPerMin,
      CORPUS.openingShotsPerMin,
      `Cuts per minute in the OPENING (first ${OPENING_SEC}s)`,
      "The opening is where viewers decide to stay. Jake cuts it roughly twice as fast as the rest of the video — tighten the first 90 seconds with more, shorter shots.",
      "Even the opening is over-cut. Merge the shortest shots in the first 90 seconds."
    );
  }
  if (m.bodyShotsPerMin !== null) {
    band(
      m.bodyShotsPerMin,
      CORPUS.bodyShotsPerMin,
      `Cuts per minute AFTER the first ${OPENING_SEC}s`,
      "The body is too static — add cuts where the narration moves to a new idea.",
      "The body is over-cut. After the opening, Jake slows down and lets demonstrations run — merge adjacent shots covering one continuous flow."
    );
  }
  if (m.hookBodyRatio !== null) {
    band(
      m.hookBodyRatio,
      CORPUS.hookBodyRatio,
      `Hook pace ÷ body pace (hook = first ${OPENING_SEC}s)`,
      `The plan is too FLAT — the hook is only ${m.hookBodyRatio}x the body's pace. Jake cuts the hook about 1.9x faster and then lets the body run at a regular pace. Fix this by SLOWING THE BODY, not by adding cuts to the hook: merge adjacent shots after the first ${OPENING_SEC}s, especially consecutive screencasts covering one continuous flow.`,
      `The hook is ${m.hookBodyRatio}x the body's pace — too steep. Either the hook is chopped too fine or the body has gone static. Aim for about 1.9x.`
    );
  }

  band(
    m.screencastHold,
    CORPUS.screencastHold,
    "Median screencast hold (s)",
    "Your screencasts are too short. Let a screen breathe — a demonstration the viewer is trying to follow should not be cut every few seconds. Merge consecutive screencasts that show one continuous flow.",
    "Your screencasts run long. Break the longest ones where the narration moves on."
  );
  band(
    m.longDemoPct,
    CORPUS.longDemoPct,
    `Runtime inside screencasts longer than ${LONG_DEMO_SEC}s (%)`,
    `Only ${m.longDemos} screencast(s) run past ${LONG_DEMO_SEC}s. Jake gives about a THIRD of every video to five to nine demonstrations he lets run — one of them 50s — and the median hold cannot show you this: you can match his median with many medium shots and still never let a screen breathe. Do NOT add screencasts to fix this; you almost certainly have too many already. Pick the two or three most important flows (a build, a setup, an end-to-end walkthrough) and let each run as ONE shot: merge the consecutive screencasts covering it and delete the face return in the middle.`,
    `Too much of the video sits in a few very long screencasts. Break the longest ones where the narration moves to a new idea.`
  );
  band(
    m.talkingHeadHold,
    CORPUS.talkingHeadHold,
    "Median talking-head hold (s)",
    "Face returns are too brief to register — give them a beat.",
    "Face returns run too long. Keep them as punctuation and give the time back to the screencasts."
  );
  if (m.gradientFullStop)
    d.push(
      `${m.gradientFullStop} gradient title(s) end in a full stop. Gradient titles never take terminal punctuation (whiteboard titles may).`
    );
  if (m.longGradient.length)
    d.push(
      `${m.longGradient.length} gradient title(s) are too long for one line: ${m.longGradient
        .slice(0, 3)
        .map((s) => `"${s}"`)
        .join(", ")}. Keep them under ~40 characters.`
    );

  if (m.chars > PLAN_CHAR_BUDGET)
    d.push(
      `The plan is ${m.chars} characters — too LONG. It has to paste into a single Slack message, which cuts off at ${SLACK_MESSAGE_LIMIT}; the budget is ${PLAN_CHAR_BUDGET}, so cut about ${m.chars - PLAN_CHAR_BUDGET} characters. Take them out of the WORDING, never the coverage: drop trigger quotes, drop any explanation of why a shot is there, and shorten screencast instructions to the screen and the action. Do not delete lines, merge shots, or leave any second uncovered.`
    );

  return d;
}

/** How far outside the corpus bands a plan sits. Lower is better; 0 is inside. */
export function planPenalty(m: PlanMeasure): number {
  const out = (v: number, [lo, hi]: readonly [number, number, number]) =>
    v < lo ? lo - v : v > hi ? v - hi : 0;
  return +(
    out(m.screencastPct, CORPUS.screencastPct) * 1.0 +
    out(m.talkingHeadPct, CORPUS.talkingHeadPct) * 1.0 +
    out(m.stockPct, CORPUS.stockPct) * 2.0 +
    out(m.titlesPerMin, CORPUS.titlesPerMin) * 8.0 +
    out(m.altPct, CORPUS.altPct) * 0.4 +
    out(m.shotsPerMin, CORPUS.shotsPerMin) * 6.0 +
    (m.openingShotsPerMin !== null ? out(m.openingShotsPerMin, CORPUS.openingShotsPerMin) * 2.0 : 0) +
    (m.bodyShotsPerMin !== null ? out(m.bodyShotsPerMin, CORPUS.bodyShotsPerMin) * 4.0 : 0) +
    // Weighted per 0.1x of ratio, so a plan half a turn too flat costs ~10.
    (m.hookBodyRatio !== null ? out(m.hookBodyRatio, CORPUS.hookBodyRatio) * 20.0 : 0) +
    out(m.screencastHold, CORPUS.screencastHold) * 2.0 +
    out(m.longDemoPct, CORPUS.longDemoPct) * 1.0 +
    out(m.talkingHeadHold, CORPUS.talkingHeadHold) * 2.0 +
    // Gaps are talking-head shots now, not errors; only overlaps are wrong.
    m.overlaps.length * 25 +
    m.unknown * 5 +
    m.gradientFullStop * 3 +
    m.longGradient.length * 2 +
    // Over the Slack limit the plan cannot be delivered at all, so this is
    // weighted to dominate any stylistic gain a longer plan might buy.
    Math.max(0, m.chars - PLAN_CHAR_BUDGET) * 0.01
  ).toFixed(1);
}
