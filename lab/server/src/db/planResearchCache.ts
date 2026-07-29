/**
 * The Video Planner's research fact sheet, keyed by the narration it describes.
 *
 * Research is the one stage whose output depends on nothing but the narration
 * (and the product URLs given with it), so re-planning the same video should
 * not pay to search the web for the same products again. Re-running one
 * narration twice in a day cost the research pass twice for an identical
 * result.
 *
 * Entries are kept indefinitely on purpose: the fact sheet describes a product
 * as it was at the time, and a stale sheet is caught by the planner's
 * `[CHECK ON SCREEN: ...]` notes rather than by silently expiring here. Clear a
 * row by hand if a product's UI has genuinely moved on.
 */
import { db } from "./index.js";

export function getCachedResearch(narrationHash: string): string | null {
  const row = db
    .prepare(`SELECT markdown FROM plan_research_cache WHERE narration_hash = ?`)
    .get(narrationHash) as { markdown: string } | undefined;
  return row?.markdown ?? null;
}

export function putCachedResearch(narrationHash: string, markdown: string): void {
  db.prepare(
    `INSERT INTO plan_research_cache (narration_hash, markdown, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(narration_hash) DO UPDATE SET markdown = excluded.markdown`
  ).run(narrationHash, markdown, Date.now());
}
