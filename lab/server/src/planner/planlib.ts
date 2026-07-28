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
  titlesPerMin: [0.8, 1.8, 1.3] as const,
  // 77 is the POOLED figure across all four videos; per-video it ranges 47–90
  // (ref1 47, ref2 87, ref3 88, ref4 90). A [70,85] band flagged every real
  // video and pushed the planner to cut more to satisfy it — which is part of
  // what caused it to over-cut. Alternation genuinely varies by video, so this
  // is a weak constraint that only catches extremes.
  altPct: [45, 92, 77] as const,
  // Cut RATE and hold LENGTH, added after a plan matched the element mix almost
  // exactly yet still over-cut badly: 100 cuts where the editor made 60, and 62
  // screencast shots where he used 30. Mix alone does not catch that — a plan
  // can hit 70/30 while chopping every demonstration in half.
  shotsPerMin: [4.0, 7.5, 5.2] as const, // per-video corpus range 4.1–7.0
  // Jake cuts the retention-critical opening ~1.9x faster than the body, in all
  // four videos (opening 6.7–12.7/min, body 3.9–6.1/min). A uniform rate across
  // the whole video is a real mismatch with how he actually edits.
  openingShotsPerMin: [6.0, 14.0, 9.0] as const,
  bodyShotsPerMin: [3.5, 6.5, 4.7] as const,
  // Jake's rule stated as a ratio, which is how he thinks about it: the hook
  // runs ~1.9x the body's pace and the body is regular pace. Per-video the
  // measured ratio is ref1 2.08, ref2 1.73, ref3 1.68, ref4 1.85 — so the band
  // sits just outside that range. This catches what the two rate bands cannot:
  // a plan can sit inside both and still be flat (hook 9.3 / body 6.4 = 1.45x).
  hookBodyRatio: [1.5, 2.4, 1.9] as const,
  screencastHold: [7.0, 15.0, 10.3] as const, // p25 5.0, median 10.3, p75 20.2
  talkingHeadHold: [3.0, 9.0, 5.5] as const, // p25 3.2, median 5.5, p75 11.5
};

const LINE = /^\[(\d+:\d{2})\s+to\s+(\d+:\d{2})\]\s*[-–]\s*(.+)$/;
const toSec = (s: string): number => {
  const [m, sec] = s.split(":").map(Number);
  return m * 60 + sec;
};

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
    const instruction = m[3].trim();
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

export function measurePlan(parsed: ParsedPlan, durationSec: number, rawText?: string): PlanMeasure {
  const { base, titles, unknown } = parsed;
  // Below ~3 minutes the split has too few shots on either side to mean anything.
  const splitOk = durationSec > 180;
  const span = (rs: PlanLine[]) => rs.reduce((a, r) => a + (r.end - r.start), 0);
  const total = span(base) || 1;

  const gaps: { at: number; len: number }[] = [];
  const overlaps: { at: number; len: number }[] = [];
  for (let i = 1; i < base.length; i++) {
    const d = +(base[i].start - base[i - 1].end).toFixed(2);
    if (d > 0.05) gaps.push({ at: base[i - 1].end, len: d });
    if (d < -0.05) overlaps.push({ at: base[i].start, len: -d });
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

  const hookRate = (base.filter((r) => r.start < OPENING_SEC).length / OPENING_SEC) * 60;
  const bodyRate = (base.filter((r) => r.start >= OPENING_SEC).length / (durationSec - OPENING_SEC)) * 60;

  const quoted = (r: PlanLine) => (r.instruction.match(/"([^"]+)"/) || [])[1] || "";

  return {
    lines: parsed.all.length,
    coverStart: base[0]?.start ?? null,
    coverEnd: base[base.length - 1]?.end ?? null,
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

  if (m.gaps.length)
    d.push(
      `The base visual has ${m.gaps.length} GAP(S) — every second must be covered. First: ${m.gaps[0].len}s at ${m.gaps[0].at}s.`
    );
  if (m.overlaps.length)
    d.push(
      `The base visual has ${m.overlaps.length} OVERLAP(S) — shots must not overlap. First: ${m.overlaps[0].len}s at ${m.overlaps[0].at}s.`
    );
  if (m.coverEnd !== null && Math.abs(m.coverEnd - m.duration) > 2)
    d.push(`The plan ends at ${m.coverEnd}s but the video is ${Math.round(m.duration)}s. Cover the whole runtime.`);
  if (m.unknown)
    d.push(
      `${m.unknown} line(s) do not start with a recognised element. Each must begin with "Screencast:", "Talking head:", "Stock footage:", "Text (gradient):" or "Text (whiteboard):".`
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
    out(m.talkingHeadHold, CORPUS.talkingHeadHold) * 2.0 +
    (m.gaps.length + m.overlaps.length) * 25 +
    m.unknown * 5 +
    m.gradientFullStop * 3 +
    m.longGradient.length * 2 +
    // Over the Slack limit the plan cannot be delivered at all, so this is
    // weighted to dominate any stylistic gain a longer plan might buy.
    Math.max(0, m.chars - PLAN_CHAR_BUDGET) * 0.01
  ).toFixed(1);
}
