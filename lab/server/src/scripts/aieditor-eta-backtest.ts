/**
 * Backtest the Auto Editor's ETA model on the jobs on disk (leave-one-out per job), old vs new.
 * Reads only: AIEDITOR_WORK/jobs/<id>/{request,source,edl,status,runner}.json, events.jsonl,
 * log.txt, and AIEDITOR_WORK/factory-history.jsonl. Prints the median absolute % error per stage
 * and overall, before (the old per-source-minute median) and after (./aieditor/eta.ts).
 * Run:
 *   cd lab/server && AIEDITOR_WORK=/opt/aieditor-work npx tsx src/scripts/aieditor-eta-backtest.ts [--json]
 */
import { mergeHistories, parseJob, readJobFiles } from "../aieditor/eta.js";
import { backtest, formatBacktest } from "../aieditor/etaBacktest.js";

async function main() {
  const root = process.env.AIEDITOR_WORK || "/aieditor-work";
  const files = await readJobFiles(root);
  const h = mergeHistories(files.map((f) => parseJob(f)));
  const r = backtest(h);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const machines = new Map<string, number>();
  for (const s of h.samples) machines.set(s.machine.label, (machines.get(s.machine.label) ?? 0) + 1);
  console.log(`${files.length} jobs · ${h.samples.length} stage runs · ${h.segments.length} run segments · ${h.overhead.length} factory overhead samples`);
  console.log(`stage runs per machine: ${[...machines].map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  console.log(formatBacktest(r));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
