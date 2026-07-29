/**
 * Saved markets, and applied renames.
 *
 * A MARKET is a named set of competitors. It is deliberately not a property of
 * a channel: the same channel audited against "AI automation" and against "AI
 * tool reviews" is two different questions with two different answers, and
 * being able to switch between them is the point. Reusing one also skips the
 * discovery search — about 600 quota units — and makes runs comparable, because
 * the comparison set did not move underneath them.
 *
 * An APPLIED RENAME records a proposal the operator actually used, with the
 * view count at that moment. That baseline is what makes a later check mean
 * anything; it is also why the feature cannot work retroactively.
 */
import { db } from "./index.js";
import type { AppliedRename, ProposedCompetitor, SavedMarket } from "../audit/types.js";

const now = () => Date.now();

interface MarketRow {
  id: string;
  name: string;
  niche: string;
  niche_desc: string | null;
  audience: string | null;
  competitors_json: string;
  discovered_from: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(r: MarketRow): SavedMarket {
  let competitors: ProposedCompetitor[] = [];
  try {
    competitors = JSON.parse(r.competitors_json);
  } catch {
    competitors = [];
  }
  return {
    id: r.id,
    name: r.name,
    niche: r.niche,
    nicheDescription: r.niche_desc ?? undefined,
    audience: r.audience ?? undefined,
    competitors,
    discoveredFrom: r.discovered_from,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function saveMarket(m: {
  id: string;
  name: string;
  niche: string;
  nicheDescription?: string;
  audience?: string;
  competitors: ProposedCompetitor[];
  discoveredFrom?: string | null;
}): SavedMarket {
  const t = now();
  db.prepare(
    `INSERT INTO audit_markets (id, name, niche, niche_desc, audience, competitors_json, discovered_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, niche = excluded.niche, niche_desc = excluded.niche_desc,
       audience = excluded.audience, competitors_json = excluded.competitors_json,
       updated_at = excluded.updated_at`,
  ).run(
    m.id,
    m.name,
    m.niche,
    m.nicheDescription ?? null,
    m.audience ?? null,
    JSON.stringify(m.competitors),
    m.discoveredFrom ?? null,
    t,
    t,
  );
  return getMarket(m.id)!;
}

export function getMarket(id: string): SavedMarket | null {
  const r = db.prepare(`SELECT * FROM audit_markets WHERE id = ?`).get(id) as MarketRow | undefined;
  return r ? hydrate(r) : null;
}

export function listMarkets(): SavedMarket[] {
  const rows = db.prepare(`SELECT * FROM audit_markets ORDER BY updated_at DESC`).all() as MarketRow[];
  return rows.map(hydrate);
}

export function deleteMarket(id: string): boolean {
  return db.prepare(`DELETE FROM audit_markets WHERE id = ?`).run(id).changes > 0;
}

// ── applied renames ─────────────────────────────────────────────────────────

export function recordApplied(r: AppliedRename): void {
  db.prepare(
    `INSERT INTO audit_applied_renames
       (run_id, video_id, original_title, proposed_title, applied_at, views_at_apply, era_median_at_apply)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, video_id) DO UPDATE SET
       proposed_title = excluded.proposed_title,
       applied_at = excluded.applied_at,
       views_at_apply = excluded.views_at_apply,
       era_median_at_apply = excluded.era_median_at_apply,
       checked_at = NULL, views_at_check = NULL`,
  ).run(
    r.runId,
    r.videoId,
    r.originalTitle,
    r.proposedTitle,
    r.appliedAt,
    Math.round(r.viewsAtApply),
    Math.round(r.eraMedianAtApply),
  );
}

export function unrecordApplied(runId: string, videoId: string): boolean {
  return db.prepare(`DELETE FROM audit_applied_renames WHERE run_id = ? AND video_id = ?`).run(runId, videoId).changes > 0;
}

export function listApplied(runId?: string): AppliedRename[] {
  const rows = (
    runId
      ? db.prepare(`SELECT * FROM audit_applied_renames WHERE run_id = ? ORDER BY applied_at DESC`).all(runId)
      : db.prepare(`SELECT * FROM audit_applied_renames ORDER BY applied_at DESC`).all()
  ) as any[];
  return rows.map((r) => ({
    runId: r.run_id,
    videoId: r.video_id,
    originalTitle: r.original_title,
    proposedTitle: r.proposed_title,
    appliedAt: r.applied_at,
    viewsAtApply: r.views_at_apply,
    eraMedianAtApply: r.era_median_at_apply,
    checkedAt: r.checked_at,
    viewsAtCheck: r.views_at_check,
  }));
}

export function recordCheck(runId: string, videoId: string, views: number): void {
  db.prepare(
    `UPDATE audit_applied_renames SET checked_at = ?, views_at_check = ? WHERE run_id = ? AND video_id = ?`,
  ).run(now(), Math.round(views), runId, videoId);
}
