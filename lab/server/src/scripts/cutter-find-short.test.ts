/**
 * "FIND THE SHORT" (Stage 4) — auto-detect the coherent short in a long, messy,
 * multi-take recording. These tests MOCK Claude (no network, no key) over a
 * SYNTHETIC multi-take transcript fixture and assert the hard contract:
 *
 *   - the coherent FINAL run-through is selected (the cleanest complete take of
 *     each line, commonly the last);
 *   - restarts / earlier repeats, false starts, and off-topic chatter are
 *     EXCLUDED, each tagged with the right reason;
 *   - the kept short is ORDERED by source time and contains NO DUPLICATE TEXT,
 *     even when the model misbehaves (keeps two copies of a line);
 *   - only real big-block CANDIDATES are eligible (a model id that isn't a
 *     candidate is ignored; a faint/short take is never pulled in);
 *   - the short is NEVER empty (an empty model selection falls back);
 *   - with NO key, selection falls back to the deterministic keep-last heuristic;
 *   - the result flows through the SAME shared core (applyDefaults /
 *     computeKeepSegments) so preview ↔ render parity holds and render duration
 *     == previewDuration.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-find-short.test.ts
 * Pure/deterministic — Claude is mocked, no ffmpeg network calls (buildCutArgs
 * only writes a local filter file).
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  applyDefaults, computeKeepSegments, previewDuration, takeId,
  SHORT_EARLIER_REASON, SHORT_CHATTER_REASON, SHORT_FALSE_START_REASON,
  isShortReason, DEFAULT_SETTINGS as DEFAULTS,
  type Take, type Envelope,
} from "../cutter/segments.js";
import { defaultsFromShort, selectCoherentShort, enforceFinalRun } from "../cutter/findShort.js";
import { buildCutArgs, type CutSpec } from "../render/cut.js";

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      pending.push(
        (r as Promise<void>).then(
          () => { passed++; console.log(`  ok  ${name}`); },
          (e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; },
        ),
      );
      return;
    }
    passed++; console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1;
  }
}

function take(start: number, end: number, text: string): Take {
  return { id: takeId(start), start, end, text, enabled: true };
}

/**
 * A SYNTHETIC ~6-minute messy multi-take recording. The intended SHORT is the
 * 3-line script "Hook / Tip / CTA". It is recorded TWICE (a flubbed early run and
 * a clean final run), interleaved with chatter and a false start. In recording
 * order:
 *   0  chatter      "okay is this thing even recording my tablet died earlier"
 *   1  hook take 1  "Here's the one trick that changed how I edit videos."   (earlier)
 *   2  false start  "Here's the one— ugh let me start over"                  (false start)
 *   3  tip  take 1  "Batch everything: record all your takes back to back."  (earlier)
 *   4  chatter      "all right all right hold on"                            (chatter)
 *   5  hook take 2  "Here's the one trick that changed how I edit videos."   (KEEP — final hook)
 *   6  tip  take 2  "Batch everything: record all your takes back to back."  (KEEP — final tip)
 *   7  cta  (once)  "Follow for more editing tips like this one."            (KEEP — only run)
 */
const FIXTURE: Take[] = [
  take(0, 6, "Okay is this thing even recording my tablet died earlier."),
  take(8, 13, "Here's the one trick that changed how I edit videos."),
  take(15, 17, "Here's the one— ugh let me start over."),
  take(19, 24, "Batch everything record all your takes back to back."),
  take(26, 28, "All right all right hold on."),
  take(40, 45, "Here's the one trick that changed how I edit videos."),
  take(47, 52, "Batch everything record all your takes back to back."),
  take(54, 59, "Follow for more editing tips like this one."),
];
const ID = FIXTURE.map((t) => t.id);

/** A well-behaved model: keeps the final run (5,6,7), classifies the rest. */
function goodModel(): string {
  return JSON.stringify({
    keep: [ID[5], ID[6], ID[7]],
    excluded: [
      { takeId: ID[0], reason: "chatter" },
      { takeId: ID[1], reason: "earlier" },
      { takeId: ID[2], reason: "false-start" },
      { takeId: ID[3], reason: "earlier" },
      { takeId: ID[4], reason: "chatter" },
    ],
    rationale: "Final clean run of the 3-line script; earlier attempts + chatter dropped.",
  });
}

// 1 ─ The coherent FINAL run is selected; restarts/false-starts/chatter excluded.
check("selects the coherent final run; drops repeats, false starts, chatter", async () => {
  const { defaults, usedAI } = await selectCoherentShort(FIXTURE, { hasKey: true, claudeFn: async () => goodModel() });
  assert.ok(usedAI, "the AI path was taken");
  const resolved = applyDefaults(FIXTURE, defaults, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled, [ID[5], ID[6], ID[7]], "kept = the final hook, tip, CTA in order");

  // Reasons are classified for the UI.
  const reasonById = new Map(resolved.map((t) => [t.id, t.reason]));
  assert.equal(reasonById.get(ID[0]), SHORT_CHATTER_REASON, "intro is chatter");
  assert.equal(reasonById.get(ID[2]), SHORT_FALSE_START_REASON, "the trailing-off attempt is a false start");
  assert.equal(reasonById.get(ID[1]), SHORT_EARLIER_REASON, "earlier hook is an earlier take");
  assert.equal(reasonById.get(ID[4]), SHORT_CHATTER_REASON, "the 'all right' aside is chatter");
  // Every excluded take is tagged with a short-reason (so the UI can explain it).
  for (const t of resolved.filter((x) => !x.enabled)) {
    assert.ok(isShortReason(t.reason), `excluded take ${t.id} has a short reason (${t.reason})`);
  }
});

// 2 ─ ORDER preserved: kept short plays in recording order regardless of the
//     order the model listed the keep ids.
check("kept short is ordered by source time even if the model scrambles keep[]", () => {
  const scrambled = JSON.stringify({ keep: [ID[7], ID[5], ID[6]], excluded: [] });
  const defaults = defaultsFromShort(FIXTURE, JSON.parse(scrambled))!;
  const enabled = applyDefaults(FIXTURE, defaults, []).filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled, [ID[5], ID[6], ID[7]], "kept set is in time order");
});

// 2b ─ enforceFinalRun: only the LAST time-contiguous run survives — an earlier
//      pass take that slipped into the kept set is dropped as "earlier".
check("enforceFinalRun keeps only the last contiguous run (drops earlier passes)", () => {
  // Earlier pass at 10–18s, final run at 100–108s (same two lines).
  const cands: Take[] = [
    take(10, 14, "line one"),   // earlier pass
    take(14, 18, "line two"),   // earlier pass
    take(100, 104, "line one"), // FINAL run
    take(104, 108, "line two"), // FINAL run
  ];
  // Pretend the selection kept an earlier-pass take (0) plus the whole final run
  // (2,3): only take 1 is currently disabled.
  const out = enforceFinalRun(cands, [{ id: cands[1].id, reason: SHORT_EARLIER_REASON }]);
  const disabled = new Set(out.map((d) => d.id));
  assert.ok(disabled.has(cands[0].id), "earlier-pass take @10s dropped");
  assert.ok(!disabled.has(cands[2].id) && !disabled.has(cands[3].id), "final run @100s kept");
});

// 3 ─ NO DUPLICATE TEXT: a misbehaving model that keeps BOTH copies of the hook
//     only yields the LAST; the earlier copy becomes an "earlier take".
check("no duplicate text — model keeping both hook takes keeps only the LAST", () => {
  const dupModel = JSON.stringify({ keep: [ID[1], ID[5], ID[6], ID[7]], excluded: [] });
  const defaults = defaultsFromShort(FIXTURE, JSON.parse(dupModel))!;
  const resolved = applyDefaults(FIXTURE, defaults, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled, [ID[5], ID[6], ID[7]], "only the LATER hook survives — no repeated line");
  const earlierHook = resolved.find((t) => t.id === ID[1])!;
  assert.equal(earlierHook.reason, SHORT_EARLIER_REASON, "the earlier hook dup is tagged earlier take");
});

// 4 ─ Candidate-only: a model id that isn't a real candidate is ignored, and a
//     faint/short take (Stage-1-disabled) can never be pulled into the short.
check("only real candidates are eligible; bogus or non-candidate ids ignored", async () => {
  // Add a Stage-1-DISABLED faint take to the list; selectCoherentShort filters to
  // enabled candidates, so the model never even sees it, and can't keep it.
  const withFaint: Take[] = [
    ...FIXTURE,
    { ...take(61, 70, "faint mumbling between takes"), enabled: false, reason: "low/scattered" },
  ];
  const claudeFn = async () => JSON.stringify({
    keep: [ID[5], ID[6], ID[7], "tBOGUS", takeId(61)], // bogus + the faint id
    excluded: [],
  });
  const { defaults } = await selectCoherentShort(withFaint, { hasKey: true, claudeFn });
  const resolved = applyDefaults(withFaint, defaults, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled, [ID[5], ID[6], ID[7]], "bogus id + the faint take are not in the short");
  // The faint take keeps its own Stage-1 reason (untouched by the short selector).
  const faint = resolved.find((t) => t.id === takeId(61))!;
  assert.equal(faint.reason, "low/scattered", "the faint take is left with its Stage-1 reason");
});

// 5 ─ NEVER empty: an empty/garbage model selection falls back to keep-last.
check("empty model selection → fallback (short is never empty)", async () => {
  const emptyModel = async () => JSON.stringify({ keep: [], excluded: [] });
  const { defaults, usedAI } = await selectCoherentShort(FIXTURE, { hasKey: true, claudeFn: emptyModel });
  assert.ok(!usedAI, "an empty selection is treated as unusable → heuristic fallback");
  const enabled = applyDefaults(FIXTURE, defaults, []).filter((t) => t.enabled);
  assert.ok(enabled.length >= 1, "the short is never empty");
});

// 5b ─ A thrown model error also falls back gracefully (no crash).
check("model error → graceful keep-last fallback", async () => {
  const boom = async () => { throw new Error("overloaded"); };
  const { defaults, usedAI } = await selectCoherentShort(FIXTURE, { hasKey: true, claudeFn: boom });
  assert.ok(!usedAI, "an error falls back to the heuristic");
  const enabled = applyDefaults(FIXTURE, defaults, []).filter((t) => t.enabled);
  assert.ok(enabled.length >= 1, "still a non-empty result after a model failure");
});

// 6 ─ NO KEY: falls back to the deterministic keep-last heuristic (which still
//     dedups the two repeated lines by keeping the last).
check("no Anthropic key → keep-last heuristic fallback (usedAI false)", async () => {
  const { defaults, usedAI } = await selectCoherentShort(FIXTURE, { hasKey: false });
  assert.ok(!usedAI, "without a key the AI path is skipped");
  const resolved = applyDefaults(FIXTURE, defaults, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  // The heuristic keeps the LAST of each repeated line (hook take 2, tip take 2),
  // and every unique line (chatter, false start, CTA are unique text → kept too).
  assert.ok(enabled.includes(ID[5]) && enabled.includes(ID[6]) && enabled.includes(ID[7]),
    "the final run is kept by the heuristic");
  assert.ok(!enabled.includes(ID[1]) && !enabled.includes(ID[3]),
    "the earlier hook + tip repeats are dropped by keep-last");
});

// 7 ─ User OVERRIDE: after the short is set, a manual toggle re-enables an excluded
//     take (e.g. the user wants the intro chatter back) — toggles win over defaults.
check("user can override the short — a toggle re-enables an excluded take", async () => {
  const { defaults } = await selectCoherentShort(FIXTURE, { hasKey: true, claudeFn: async () => goodModel() });
  // Re-enable the chatter intro (ID[0]) the short dropped.
  const resolved = applyDefaults(FIXTURE, defaults, [ID[0]]);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.ok(enabled.includes(ID[0]), "the toggled-on intro is now kept (override wins)");
  assert.deepEqual(enabled, [ID[0], ID[5], ID[6], ID[7]], "override merges into the short, in order");
});

// 8 ─ PARITY: the short flows through computeKeepSegments; render duration ==
//     previewDuration. Build a real envelope matching the fixture's spans so the
//     same big blocks segment out, apply the short defaults, and check the link.
check("parity — short keep == render segments, render duration == previewDuration", () => {
  // Build a 60s envelope loud exactly over the fixture's take spans.
  const hop = 0.02, duration = 60.0, n = Math.round(duration / hop);
  const loud = (t: number) => FIXTURE.some((tk) => t >= tk.start && t < tk.end);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  // Keep only the final run (the three latest spans) as the short.
  const keepIds = [ID[5], ID[6], ID[7]];
  // Re-segment from the envelope (no transcript needed for geometry), then map the
  // short onto the segmented take ids by start time. The segmenter keys ids to
  // padded starts, so derive defaults by EXCLUDING every detected take that is
  // not one of the final three blocks (start ≥ 40).
  const detected = computeKeepSegments(env, [], { ...DEFAULTS, minTake: 3.0 }).takes;
  const finalThree = detected.filter((t) => t.start >= 39.5);
  assert.ok(finalThree.length === 3, `expected the 3 final blocks, got ${finalThree.length}`);
  const defaults = detected
    .filter((t) => t.start < 39.5)
    .map((t) => ({ id: t.id, reason: SHORT_CHATTER_REASON }));
  const plan = computeKeepSegments(env, [], { ...DEFAULTS, minTake: 3.0 }, defaults, []);
  assert.equal(plan.keep.length, 3, "the short renders exactly the three final blocks");
  assert.ok(plan.keep[0].start >= 39.5, "the kept short is the final run (starts ≥ 40s)");

  const spec: CutSpec = { source: "/dev/null", segments: plan.keep, hasAudio: true, gap: plan.gap };
  const tmp = path.join(process.env.TMPDIR || "/tmp", `findshort_${Date.now()}.mp4`);
  const { totalDuration } = buildCutArgs(spec, tmp);
  try { fs.rmSync(`${tmp}.filter.txt`, { force: true }); } catch { /* */ }
  const preview = previewDuration(plan.keep, plan.gap);
  assert.ok(Math.abs(totalDuration - preview) < 1e-6, `render ${totalDuration} != preview ${preview}`);
  void keepIds;
});

await Promise.all(pending);
console.log(`\n${passed} find-short checks passed.`);
