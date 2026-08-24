/**
 * Background plan builder for the Bulk Scheduler.
 *
 * Preview used to run inside its HTTP request. On 2026-08-24 a 227-video plan
 * took 31 minutes, during which the connection carried no bytes at all; the
 * socket was dropped somewhere in the path, and the finished 2.5MB plan — and
 * every AI call behind it — was lost with nothing to reconnect to.
 *
 * Now the endpoint starts a run and returns its id immediately. The work
 * continues here, writing progress and finally the plan into bulk_preview_runs,
 * so the page can be reloaded, reopened, or left to sleep and still pick the
 * result up. Captions are cached as they are written (see db/bulkPreview), so
 * even a failed run leaves the money it spent on disk.
 */
import * as runs from "../db/bulkPreview.js";
import { preview, type PreviewInput } from "./bulkScheduler.js";

/** Run ids with a live worker in this process. */
const live = new Set<string>();

export function isRunning(id: string): boolean {
  return live.has(id);
}

/** Start a plan build. Returns the run row; the work continues in the background. */
export function startPreview(input: PreviewInput): runs.PreviewRun {
  const run = runs.createRun(input, input.files?.length ?? 0);
  live.add(run.id);

  void (async () => {
    try {
      const result = await preview(input, {
        onProgress: (p) => {
          // A cancelled run stops being updated, but the underlying work is
          // already in flight — we simply stop recording it.
          if (runs.getRun(run.id)?.status !== "running") return;
          runs.updateRun(run.id, {
            stage: p.stage,
            doneCount: p.done,
            totalCount: p.total,
            cachedCount: p.cached,
          });
        },
      });
      if (runs.getRun(run.id)?.status === "running") {
        runs.updateRun(run.id, { status: "done", stage: "ready", result, error: "" });
      }
    } catch (err) {
      runs.updateRun(run.id, {
        status: "failed",
        stage: "failed",
        error: err instanceof Error ? err.message : "Building the plan failed.",
      });
    } finally {
      live.delete(run.id);
    }
  })();

  return runs.getRun(run.id)!;
}

/**
 * Mark a run cancelled. The in-flight AI calls are not aborted — they are
 * already paid for and their captions are still cached — but the run stops
 * being updated and the page stops waiting on it.
 */
export function cancelPreview(id: string): boolean {
  const run = runs.getRun(id);
  if (!run || run.status !== "running") return false;
  runs.updateRun(id, { status: "cancelled", stage: "cancelled" });
  return true;
}
