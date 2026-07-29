/**
 * The Video Planner orchestrator.
 *
 *   ingest → beat map → research → plan (generate / measure / repair)
 *
 * The repair loop exists because a single generation has high run-to-run
 * variance: the same prompt produced 71% screencast on one run and 58% on the
 * next. Rather than tuning prose against that noise, we measure each round
 * against the corpus and hand the model its own deviations. The best-scoring
 * round wins, so a repair that makes things worse can never be what ships.
 */
import { nanoid } from "nanoid";
import { ingestNarration } from "./ingest.js";
import { buildBeatMap } from "./narration.js";
import { researchProducts } from "./research.js";
import { anthropicStream, PLANNER_MODEL } from "./client.js";
import { PLANNER_SYSTEM, buildPlannerUser, buildRepairUser, renderBeats } from "./prompt.js";
import { parsePlan, measurePlan, planDeviations, planPenalty } from "./planlib.js";
import { createRun, updateRun, getRun } from "../db/planRuns.js";
import type { PlanInput, PlanJobSnapshot, PlanRunResult } from "./types.js";

const MAX_ROUNDS = 3;

/** In-memory progress for runs currently in flight. */
const live = new Map<string, PlanJobSnapshot>();

export function planJobStatus(runId: string): PlanJobSnapshot | null {
  const l = live.get(runId);
  if (l) return l;
  const run = getRun(runId);
  if (!run) return null;
  return {
    runId,
    status: run.status,
    stage: run.status === "completed" ? "Done" : run.status === "failed" ? "Failed" : "",
    progress: run.status === "completed" ? 1 : 0,
    error: run.error,
  };
}

function setStage(runId: string, status: PlanRunResult["status"], stage: string, progress: number) {
  live.set(runId, { runId, status, stage, progress, error: null });
}

/** Start a run and return immediately; the work continues in the background. */
export function startPlan(input: PlanInput): { runId: string } {
  const runId = nanoid();
  createRun(runId, input);
  setStage(runId, "ingesting", "Starting", 0.01);

  void (async () => {
    let costUsd = 0;
    try {
      // ── ingest ────────────────────────────────────────────────────────────
      const ing = await ingestNarration({
        runId,
        source: input.source,
        sourceKind: input.sourceKind,
        onStage: (label, p) => setStage(runId, "ingesting", label, p),
      });
      updateRun(runId, { status: "transcribing", durationSec: ing.durationSec });

      // ── beat map ──────────────────────────────────────────────────────────
      setStage(runId, "transcribing", "Measuring pauses and emphasis", 0.45);
      const bm = buildBeatMap(ing.audioPath, ing.words);
      const narration = renderBeats(bm.beats, bm.strongGap, bm.medGap);
      updateRun(runId, { beats: bm.beats });

      // ── research ──────────────────────────────────────────────────────────
      let research: string | null = null;
      if (!input.skipResearch) {
        setStage(runId, "researching", "Verifying the products' real UI", 0.5);
        updateRun(runId, { status: "researching" });
        try {
          const r = await researchProducts({ narration, productUrls: input.productUrls });
          research = r.markdown || null;
          costUsd += r.costUsd;
          updateRun(runId, { research });
        } catch (err: any) {
          // Research failing should degrade the plan, not kill the run — the
          // screencasts will simply be ungrounded, which we surface in the UI.
          research = null;
          updateRun(runId, { research: null });
          console.warn(`[planner] research failed for ${runId}: ${err?.message}`);
        }
      }

      // ── plan, with repair ─────────────────────────────────────────────────
      updateRun(runId, { status: "planning" });
      const user = buildPlannerUser({
        durationSec: ing.durationSec,
        narration,
        hasBeats: true,
        research,
      });
      const messages: any[] = [{ role: "user", content: user }];
      let best: { text: string; penalty: number; round: number; measure: any } | null = null;
      const rounds: PlanRunResult["rounds"] = [];

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        setStage(runId, "planning", `Planning — round ${round}`, 0.6 + round * 0.1);

        const res = await anthropicStream({
          body: {
            model: PLANNER_MODEL,
            // Thinking is billed as output and spent before any text — a 32000
            // budget once went entirely on thinking and truncated the plan.
            max_tokens: 96000,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            system: [{ type: "text", text: PLANNER_SYSTEM, cache_control: { type: "ephemeral" } }],
            messages,
          },
        });
        costUsd += res.costUsd;

        const parsed = parsePlan(res.text);
        const measure = measurePlan(parsed, ing.durationSec, res.text);
        const deviations = planDeviations(measure);
        const penalty = planPenalty(measure);
        rounds.push({ round, penalty, measure, deviations });

        if (!best || penalty < best.penalty) best = { text: res.text, penalty, round, measure };
        if (!deviations.length) break;
        if (round === MAX_ROUNDS) break;

        messages.push({ role: "assistant", content: res.text });
        messages.push({ role: "user", content: buildRepairUser(deviations, ing.durationSec) });
      }

      if (!best) throw new Error("planner produced no output");

      updateRun(runId, {
        status: "completed",
        plan: best.text,
        parsed: parsePlan(best.text).all,
        measure: best.measure,
        rounds,
        costUsd,
      });
      live.delete(runId);
    } catch (err: any) {
      const message = err?.message || String(err);
      updateRun(runId, { status: "failed", error: message, costUsd });
      live.set(runId, { runId, status: "failed", stage: "Failed", progress: 1, error: message });
    }
  })();

  return { runId };
}
