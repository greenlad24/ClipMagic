/**
 * Unit-level verification of the Optimization Report math.
 *
 * The lab has NO live API keys in this container, so we can't exercise real
 * model calls here. Instead we feed KNOWN token counts into the same accounting
 * + pricing code the live pipeline uses and assert the dollar figures by hand —
 * proving the cost, baseline, and saved numbers are computed correctly (not
 * fabricated). Run: `tsx src/scripts/verify-report-math.ts`.
 */
import {
  tokenCost,
  transcriptionCost,
  ANTHROPIC_RATES,
  OPENAI_RATES,
  OPENAI_WHISPER_PER_MINUTE,
  GROQ_WHISPER_PER_MINUTE,
} from "../ai/pricing.js";
import {
  beginRun,
  setRunFlags,
  recordAnthropicUsage,
  recordGroqTranscription,
  buildReport,
  finishRun,
} from "../ai/runAccounting.js";

let failures = 0;
function assertClose(label: string, got: number, want: number, eps = 1e-9) {
  const ok = Math.abs(got - want) <= eps;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, want ${want}`);
}
function assert(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// ── 1. Raw pricing helpers ───────────────────────────────────────────────────
// Opus 4.8: $5 in / $25 out. 10k in + 2k out = 0.05 + 0.05 = $0.10.
assertClose(
  "Opus 10k in / 2k out",
  tokenCost(ANTHROPIC_RATES["claude-opus-4-8"], 10_000, 2_000),
  0.05 + 0.05,
);
// gpt-4o: $2.50 in / $10 out. 10k in + 2k out = 0.025 + 0.02 = $0.045.
assertClose("gpt-4o 10k in / 2k out", tokenCost(OPENAI_RATES["gpt-4o"], 10_000, 2_000), 0.045);
// gpt-4o-mini: $0.15 in / $0.60 out. 1k in + 100 out = 0.00015 + 0.00006 = 0.00021.
assertClose(
  "gpt-4o-mini 1k in / 100 out",
  tokenCost(OPENAI_RATES["gpt-4o-mini"], 1_000, 100),
  0.00021,
);
// Transcription: 2 min on Groq ($0.04/hr) vs OpenAI ($0.006/min).
assertClose("Groq 2 min", transcriptionCost(2, GROQ_WHISPER_PER_MINUTE), (0.04 / 60) * 2);
assertClose("OpenAI Whisper 2 min", transcriptionCost(2, OPENAI_WHISPER_PER_MINUTE), 0.012);

// ── 2. End-to-end report with known usage (fold FIRED) ────────────────────────
const PID = "verify-1";
beginRun(PID);
// Transcription: 120s = 2 min audio.
recordGroqTranscription({ model: "whisper-large-v3-turbo", audioSeconds: 120, ms: 100 });
// URL research (Sonnet) — real usage 8k in / 1k out.
recordAnthropicUsage({
  model: "claude-sonnet-4-6",
  purpose: "url-research",
  usage: { input_tokens: 8_000, output_tokens: 1_000 },
  ms: 100,
});
// Director (Opus) — 12k in / 3k out, no cache hit.
recordAnthropicUsage({
  model: "claude-opus-4-8",
  purpose: "director",
  usage: { input_tokens: 12_000, output_tokens: 3_000 },
  ms: 100,
});
// Review (Sonnet) — 6k in / 800 out.
recordAnthropicUsage({
  model: "claude-sonnet-4-6",
  purpose: "review",
  usage: { input_tokens: 6_000, output_tokens: 800 },
  ms: 100,
});
// The fold fired: director returned emphasis, no fallback call. Provide a word
// list of 100 short words so the eliminated-call estimate is deterministic-ish.
const words = Array.from({ length: 100 }, (_, i) => "word");
const wordList = words.map((w, i) => `${i}:${w}`).join(" ");
setRunFlags(PID, {
  directorReturnedEmphasis: true,
  emphasisFallbackUsed: false,
  transcriptWordList: wordList,
  transcriptWordCount: words.length,
});

const report = buildReport(PID)!;
assert("report built", !!report);

// Per-line lab vs baseline checks.
const li = Object.fromEntries(report.cost.lineItems.map((x) => [x.label.split(" ·")[0], x]));

// Transcription line.
const trLab = (0.04 / 60) * 2;
const trBase = 0.006 * 2;
assertClose("transcription lab", li["Transcription"].labUsd, round6(trLab));
assertClose("transcription baseline", li["Transcription"].baselineUsd, round6(trBase));
assertClose("transcription saved", li["Transcription"].savedUsd, round6(trBase - trLab));

// Director line: lab Opus vs baseline gpt-4o on SAME 12k/3k tokens.
const dirLab = tokenCost(ANTHROPIC_RATES["claude-opus-4-8"], 12_000, 3_000); // 0.06 + 0.075 = 0.135
const dirBase = tokenCost(OPENAI_RATES["gpt-4o"], 12_000, 3_000); // 0.03 + 0.03 = 0.06
assertClose("director lab", li["AI director (semantic beat planner)"].labUsd, round6(dirLab));
assertClose("director baseline", li["AI director (semantic beat planner)"].baselineUsd, round6(dirBase));
// NOTE: here the lab (Opus) is MORE expensive than gpt-4o for the director — a
// deliberate quality trade. The report must show a NEGATIVE saving on this line
// (honest), not hide it.
assert("director saved is negative (Opus costs more than gpt-4o)", li["AI director (semantic beat planner)"].savedUsd < 0);

// Folded emphasis call: labUsd must be exactly 0, baseline > 0, flagged assumption.
const fold = report.cost.lineItems.find((x) => x.label.includes("Folded-away"))!;
assert("fold line present", !!fold);
assertClose("fold lab cost is 0", fold.labUsd, 0);
assert("fold baseline > 0", fold.baselineUsd > 0);
assert("fold flagged as assumption", fold.assumption === true);

// Totals: labTotal/baselineTotal = sum of line items. netDelta = baseline - lab
// across ALL lines. savedUsd = like-for-like (saving lines only), EXCLUDING the
// Opus quality investment.
const labSum = report.cost.lineItems.reduce((s, x) => s + x.labUsd, 0);
const baseSum = report.cost.lineItems.reduce((s, x) => s + x.baselineUsd, 0);
assertClose("labTotal == sum", report.cost.labTotalUsd, round6(labSum));
assertClose("baselineTotal == sum", report.cost.baselineTotalUsd, round6(baseSum));
assertClose("netDelta == baseline - lab", report.cost.netDeltaUsd, round6(baseSum - labSum));

// Like-for-like saved = sum of saving lines' savedUsd (director excluded).
const savingLines = report.cost.lineItems.filter((x) => x.kind === "saving");
const savingSum = savingLines.reduce((s, x) => s + x.savedUsd, 0);
assertClose("savedUsd == sum(saving lines)", report.cost.savedUsd, round6(savingSum));
assert("director excluded from savings (it's a quality investment)", li["AI director (semantic beat planner)"].kind === "quality-investment");
assert("like-for-like saved is POSITIVE", report.cost.savedUsd > 0);
assert("net delta is negative this run (bought Opus directing)", report.cost.netDeltaUsd < 0);
assert("quality investment > 0", report.cost.qualityInvestmentUsd > 0);

// Sections present.
assert("whatWasOptimized non-empty", report.whatWasOptimized.length > 0);
assert("qualityImprovements non-empty", report.qualityImprovements.length > 0);
assert("assumptions documented", report.cost.assumptions.length > 0);

finishRun(PID);

// ── 3. Fold did NOT fire (fallback ran) → NO emphasis-fold saving claimed ─────
const PID2 = "verify-2";
beginRun(PID2);
recordAnthropicUsage({
  model: "claude-opus-4-8",
  purpose: "director",
  usage: { input_tokens: 10_000, output_tokens: 2_000 },
  ms: 50,
});
// Fallback Haiku call actually ran this run.
recordAnthropicUsage({
  model: "claude-haiku-4-5",
  purpose: "emphasis-fallback",
  usage: { input_tokens: 1_500, output_tokens: 120 },
  ms: 50,
});
setRunFlags(PID2, {
  directorReturnedEmphasis: false,
  emphasisFallbackUsed: true,
  transcriptWordList: "0:word 1:word",
  transcriptWordCount: 2,
});
const report2 = buildReport(PID2)!;
assert(
  "no folded-away line when fallback ran",
  !report2.cost.lineItems.some((x) => x.label.includes("Folded-away")),
);
assert(
  "honest note that fold did not apply",
  report2.whatWasOptimized.some((s) => /did NOT apply/.test(s)),
);
finishRun(PID2);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
