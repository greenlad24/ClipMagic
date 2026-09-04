/**
 * The motion-graphics stage of a finished plan: sample a style, approve one,
 * then generate every full-screen card against it.
 *
 * WHY IT IS TWO STARTS AND NOT ONE. A plan carries roughly twenty generatable
 * cards, and every one of them costs credits. Generating all twenty against an
 * unapproved look risks paying twenty times for a world Jake rejects on sight,
 * so the sample round generates STILLS ONLY of a single card, he picks the one
 * that is right, and that hosted still becomes the `input_images` reference for
 * everything after it. Consistency across twenty cards is the whole problem
 * here, and a reference image is the only lever that actually holds it — the
 * same adjectives produce twenty different worlds.
 *
 * WHY PROGRESS IS PERSISTED PER CARD, not at the end. Each card is a paid
 * generation and the full set is 30+ minutes of remote work. A crash, a restart
 * or a rate limit at card fifteen must not throw away the fourteen already
 * paid for, so every finished card is written to the run row as it lands and
 * the phase only moves once the loop is done.
 *
 * A card that fails does NOT fail the run. One bad generation out of twenty is
 * a retry (`regenerateGraphic`), not a reason to bin the other nineteen — the
 * failures are counted and named, and the stage still completes.
 */
import { getRun, updateRun } from "../db/planRuns.js";
import {
  SAMPLE_COUNT,
  fitToSlot,
  generateGraphic,
  graphicSlots,
  motionDir,
  pickSampleSlot,
} from "./motion.js";
import { higgsfieldConfigured } from "./higgsfield.js";
import path from "node:path";
import type {
  GraphicSlot,
  MotionGraphicAsset,
  MotionJobSnapshot,
  MotionPhase,
  PlanMotion,
} from "./types.js";

/**
 * How many cards are generated at once. Two, not one, because each card is
 * ~3 minutes of waiting on a remote render and twenty of them serially is over
 * an hour; and not more than two because the rate limits on the account are
 * undocumented and a 429 mid-run costs more than the time it saves.
 */
const GENERATE_CONCURRENCY = 2;

/** In-memory progress for a stage currently in flight. */
const live = new Map<string, MotionJobSnapshot>();

/** The state a plan run starts in: slots discovered, nothing generated. */
export function emptyMotion(slots: GraphicSlot[]): PlanMotion {
  return {
    phase: "idle",
    slots,
    samples: [],
    styleStillUrl: null,
    styleExtra: null,
    graphics: [],
    stillsGenerated: 0,
    clipsGenerated: 0,
    error: null,
    updatedAt: Date.now(),
  };
}

/**
 * Read the stage's state for a run, discovering the slots from the plan the
 * first time. Slots are re-read from the plan on every call so an edited or
 * re-measured plan cannot leave a stale slot list behind — but anything already
 * generated is kept.
 */
export function motionStateFor(runId: string): { motion: PlanMotion; durationSec: number | null } | null {
  const run = getRun(runId);
  if (!run) return null;
  const slots = graphicSlots(run.parsed);
  const motion = run.motion ? { ...run.motion, slots } : emptyMotion(slots);
  return { motion, durationSec: run.durationSec };
}

function save(runId: string, motion: PlanMotion): PlanMotion {
  const next = { ...motion, updatedAt: Date.now() };
  updateRun(runId, { motion: next });
  return next;
}

/** `error` defaults to null: most progress ticks have nothing to report. */
function setLive(
  runId: string,
  snap: Omit<MotionJobSnapshot, "runId" | "error"> & { error?: string | null },
): void {
  live.set(runId, { runId, error: null, ...snap });
}

/**
 * Live progress, falling back to the persisted phase once the job is over.
 * The UI polls this on one endpoint for both the sample round and the full run.
 */
export function motionJobStatus(runId: string): MotionJobSnapshot | null {
  const l = live.get(runId);
  if (l) return l;
  const state = motionStateFor(runId);
  if (!state) return null;
  const { motion } = state;
  const total = motion.slots.length;
  const done = motion.graphics.length;
  return {
    runId,
    phase: motion.phase,
    stage: stageLabel(motion.phase),
    progress: motion.phase === "completed" ? 1 : total ? done / total : 0,
    done,
    total,
    error: motion.error,
  };
}

function stageLabel(phase: MotionPhase): string {
  switch (phase) {
    case "sampling": return "Generating style samples";
    case "awaiting-approval": return "Pick the look";
    case "ready": return "Style approved";
    case "generating": return "Generating cards";
    case "completed": return "Done";
    case "failed": return "Failed";
    default: return "";
  }
}

/** Shared guard: a run that can actually have graphics generated for it. */
function loadForGeneration(runId: string): { motion: PlanMotion } {
  if (!higgsfieldConfigured()) {
    throw new Error(
      "Higgsfield is not configured. Add the API key and secret in Settings before generating graphics.",
    );
  }
  const state = motionStateFor(runId);
  if (!state) throw new Error("Plan run not found.");
  if (live.get(runId)?.phase === "sampling" || live.get(runId)?.phase === "generating") {
    throw new Error("This plan is already generating. Wait for it to finish.");
  }
  if (!state.motion.slots.length) {
    throw new Error("This plan has no full-screen text cards, so there is nothing to generate.");
  }
  return { motion: state.motion };
}

/**
 * Generate the sample stills for ONE card and stop. Returns immediately; the
 * work continues in the background and `motionJobStatus` reports it.
 */
export function startMotionSamples(opts: {
  runId: string;
  /** Which slot to sample on. Defaults to the longest card in the plan. */
  slotIndex?: number;
  count?: number;
  styleExtra?: string;
}): { runId: string; slotIndex: number; count: number } {
  const { runId } = opts;
  const { motion } = loadForGeneration(runId);

  const slot =
    (opts.slotIndex !== undefined ? motion.slots.find((s) => s.index === opts.slotIndex) : null) ??
    pickSampleSlot(motion.slots);
  if (!slot) throw new Error("Could not find a card to sample the style on.");
  const count = Math.min(Math.max(opts.count ?? SAMPLE_COUNT, 1), 6);
  const styleExtra = opts.styleExtra?.trim() || motion.styleExtra || null;

  let state = save(runId, {
    ...motion,
    phase: "sampling",
    samples: [],
    styleExtra,
    error: null,
  });
  setLive(runId, { phase: "sampling", stage: stageLabel("sampling"), progress: 0.02, done: 0, total: count });

  void (async () => {
    try {
      for (let i = 0; i < count; i++) {
        const g = await generateGraphic({
          runId,
          slot,
          styleExtra: styleExtra ?? undefined,
          stillOnly: true,
          fileStem: `sample-${Date.now()}-${i + 1}`,
        });
        // Persist each sample as it lands: it is already paid for, and a later
        // one failing must not lose the ones Jake could already choose from.
        state = save(runId, {
          ...state,
          samples: [...state.samples, { slotIndex: slot.index, text: slot.text, stillUrl: g.stillUrl, file: g.file }],
          stillsGenerated: state.stillsGenerated + 1,
        });
        setLive(runId, {
          phase: "sampling",
          stage: stageLabel("sampling"),
          progress: (i + 1) / count,
          done: i + 1,
          total: count,
        });
      }
      state = save(runId, { ...state, phase: state.samples.length ? "awaiting-approval" : "failed" });
      setLive(runId, {
        phase: state.phase,
        stage: stageLabel(state.phase),
        progress: 1,
        done: state.samples.length,
        total: count,
      });
      live.delete(runId);
    } catch (err: any) {
      const message = err?.message || String(err);
      // Samples already generated stay usable — a partial round is still a choice.
      const phase: MotionPhase = state.samples.length ? "awaiting-approval" : "failed";
      save(runId, { ...state, phase, error: message });
      setLive(runId, {
        phase,
        stage: stageLabel(phase),
        progress: 1,
        done: state.samples.length,
        total: count,
        error: message,
      });
    }
  })();

  return { runId, slotIndex: slot.index, count };
}

/**
 * Approve one sample as the style reference.
 *
 * The URL must be one this run generated. Not paranoia about the operator —
 * it is the difference between a reference image we produced and an arbitrary
 * URL being posted to a paid third-party API from our credentials.
 */
export function approveMotionStyle(opts: {
  runId: string;
  stillUrl: string;
  styleExtra?: string;
}): PlanMotion {
  const state = motionStateFor(opts.runId);
  if (!state) throw new Error("Plan run not found.");
  const known = state.motion.samples.some((s) => s.stillUrl === opts.stillUrl);
  if (!known) {
    throw new Error("That still was not generated for this plan — generate samples and pick one of those.");
  }
  return save(opts.runId, {
    ...state.motion,
    phase: "ready",
    styleStillUrl: opts.stillUrl,
    styleExtra: opts.styleExtra?.trim() || state.motion.styleExtra || null,
    error: null,
  });
}

/**
 * Generate one card end to end: still against the approved reference, animate
 * it, then cut the clip to the slot's own length.
 */
async function buildCard(
  runId: string,
  slot: GraphicSlot,
  styleStillUrl: string,
  styleExtra: string | null,
): Promise<MotionGraphicAsset> {
  const g = await generateGraphic({
    runId,
    slot,
    referenceImages: [styleStillUrl],
    styleExtra: styleExtra ?? undefined,
  });
  // Nothing Kling returns is ever the slot's length — it renders 5s or 10s.
  const dir = motionDir(runId);
  const fitted = g.file.replace(/\.mp4$/, "-fit.mp4");
  await fitToSlot(path.join(dir, g.file), path.join(dir, fitted), slot.durationSec);
  return {
    index: slot.index,
    start: slot.start,
    end: slot.end,
    text: slot.text,
    stillUrl: g.stillUrl,
    videoUrl: g.videoUrl,
    file: fitted,
    rawFile: g.file,
    durationSec: slot.durationSec,
  };
}

/**
 * Generate every card the plan asks for, against the approved style. Returns
 * immediately; poll `motionJobStatus`.
 */
export function startMotionGraphics(opts: { runId: string; redo?: boolean }): { runId: string; total: number } {
  const { runId } = opts;
  const { motion } = loadForGeneration(runId);
  if (!motion.styleStillUrl) {
    throw new Error("Approve a style sample first — the reference still is what keeps the cards consistent.");
  }

  // Already-generated cards are kept unless the operator asks for a redo, so
  // re-running after a partial failure only pays for what is actually missing.
  const keep = opts.redo ? [] : motion.graphics;
  const doneIndexes = new Set(keep.map((g) => g.index));
  const todo = motion.slots.filter((s) => !doneIndexes.has(s.index));
  const total = motion.slots.length;

  let state = save(runId, { ...motion, phase: "generating", graphics: keep, error: null });
  setLive(runId, {
    phase: "generating",
    stage: stageLabel("generating"),
    progress: total ? keep.length / total : 0,
    done: keep.length,
    total,
  });

  void (async () => {
    const failures: string[] = [];
    const queue = [...todo];
    const worker = async () => {
      for (;;) {
        const slot = queue.shift();
        if (!slot) return;
        try {
          const card = await buildCard(runId, slot, state.styleStillUrl!, state.styleExtra);
          state = save(runId, {
            ...state,
            graphics: [...state.graphics, card].sort((a, b) => a.index - b.index),
            stillsGenerated: state.stillsGenerated + 1,
            clipsGenerated: state.clipsGenerated + 1,
          });
        } catch (err: any) {
          // One card failing is a retry, not a dead run.
          failures.push(`${mmss(slot.start)} "${slot.text.slice(0, 40)}": ${err?.message || err}`);
        }
        setLive(runId, {
          phase: "generating",
          stage: stageLabel("generating"),
          progress: total ? state.graphics.length / total : 1,
          done: state.graphics.length,
          total,
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(GENERATE_CONCURRENCY, queue.length || 1) }, worker));

    const phase: MotionPhase = state.graphics.length ? "completed" : "failed";
    const error = failures.length
      ? `${failures.length} of ${total} card(s) failed — retry them individually:\n${failures.join("\n")}`
      : null;
    state = save(runId, { ...state, phase, error });
    setLive(runId, {
      phase,
      stage: stageLabel(phase),
      progress: 1,
      done: state.graphics.length,
      total,
      error,
    });
    live.delete(runId);
  })();

  return { runId, total };
}

/**
 * Redo ONE card. Synchronous-ish (a single card is ~3 minutes) and deliberately
 * the same code path as the full run, so a retry can never produce a card built
 * differently from its neighbours.
 */
export async function regenerateGraphic(opts: { runId: string; index: number }): Promise<PlanMotion> {
  const { motion } = loadForGeneration(opts.runId);
  if (!motion.styleStillUrl) throw new Error("Approve a style sample first.");
  const slot = motion.slots.find((s) => s.index === opts.index);
  if (!slot) throw new Error(`No card at line ${opts.index} in this plan.`);

  const card = await buildCard(opts.runId, slot, motion.styleStillUrl, motion.styleExtra);
  const fresh = motionStateFor(opts.runId)!.motion;
  return save(opts.runId, {
    ...fresh,
    graphics: [...fresh.graphics.filter((g) => g.index !== opts.index), card].sort((a, b) => a.index - b.index),
    stillsGenerated: fresh.stillsGenerated + 1,
    clipsGenerated: fresh.clipsGenerated + 1,
  });
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
