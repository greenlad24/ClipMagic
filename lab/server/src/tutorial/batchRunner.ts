/**
 * Background work for Tutorial Studio batches.
 *
 * Writing 30 scripts is 30 Qwen calls — minutes of wall clock, far past any
 * sensible HTTP timeout. So the endpoint starts this and returns; the batch row
 * carries the status and each item lands in the database the moment it is
 * written. The page polls and fills in.
 *
 * Nothing here spends video money. Scripts are cheap text; the paid render only
 * starts when the operator approves and asks for it.
 */
import * as batches from "../db/tutorialBatches.js";
import { generateScript, generateLooks, ApimartError } from "./apimart.js";

/** Batch ids currently being scripted, so a double-click cannot double-spend. */
const scripting = new Set<string>();

export function isScripting(batchId: string): boolean {
  return scripting.has(batchId);
}

/**
 * Write a script for every picked item that hasn't got one yet.
 *
 * Deliberately serial: these run against the same apimart account as the
 * renders, and a burst of 30 parallel calls is the kind of thing that gets an
 * account rate-limited mid-batch.
 */
export function startScripting(batchId: string): void {
  if (scripting.has(batchId)) return;
  scripting.add(batchId);
  batches.updateBatch(batchId, { status: "scripting", error: "" });

  void (async () => {
    let failures = 0;
    try {
      const todo = batches
        .listItems(batchId)
        .filter((i) => i.picked && !i.script);
      for (const item of todo) {
        // The operator may have deleted the batch while this was running.
        if (!batches.getBatch(batchId)) return;
        try {
          const script = await generateScript(item.topic);
          batches.updateItem(item.id, { script, status: "scripted", error: "" });
        } catch (err) {
          failures++;
          batches.updateItem(item.id, {
            status: "failed",
            error: err instanceof Error ? err.message : "script generation failed",
          });
          // A rejected key fails every remaining item the same way — stop
          // rather than burn through 29 more identical errors.
          if (err instanceof ApimartError && /401|rejected|No apimart/i.test(err.message)) {
            batches.updateBatch(batchId, { status: "review", error: err.message });
            return;
          }
        }
      }
      batches.updateBatch(batchId, {
        status: "review",
        error: failures ? `${failures} script${failures === 1 ? "" : "s"} failed — retry them.` : "",
      });
    } finally {
      scripting.delete(batchId);
    }
  })();
}

/**
 * Give every approved item its own outfit and its own corner of the batch's
 * room. One Qwen call for the whole batch, so the looks are varied against each
 * other rather than 30 independent guesses that collide.
 *
 * Falls back to leaving the fields blank, which makes the pipeline use its own
 * defaults — a batch should not fail to render because the styling call did.
 */
export async function assignLooks(batchId: string): Promise<void> {
  const batch = batches.getBatch(batchId);
  if (!batch) return;
  const items = batches.listItems(batchId).filter((i) => i.approved && !i.jobId);
  if (!items.length) return;
  let looks: Array<{ outfit: string; scene: string }> = [];
  try {
    looks = await generateLooks(batch.environment, items.length);
  } catch {
    return; // pipeline defaults are a fine fallback
  }
  items.forEach((item, i) => {
    const look = looks[i % looks.length];
    if (look) batches.updateItem(item.id, { outfit: look.outfit, scene: look.scene });
  });
}
