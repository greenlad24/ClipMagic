/**
 * Skool manager settings — a singleton row.
 *
 * Deliberately small. The classroom is NOT mirrored into this database: it is
 * read live from Skool every time, because a cached copy of a community that
 * Jake (or anyone else with access) can edit in another tab is a copy that is
 * already wrong by the time it is read. What lives here is only what the
 * operator told us and Skool has no idea about — which community to work on,
 * and the roadmap the courses should follow.
 */
import { db } from "./index.js";

export interface SkoolSettings {
  communityUrl: string;
  roadmapMd: string;
  updatedAt: number;
}

interface Row {
  community_url: string;
  roadmap_md: string;
  updated_at: number;
}

export function getSkoolSettings(): SkoolSettings {
  const row = db.prepare(`SELECT * FROM skool_settings WHERE id = 1`).get() as Row | undefined;
  return {
    communityUrl: row?.community_url ?? "",
    roadmapMd: row?.roadmap_md ?? "",
    updatedAt: row?.updated_at ?? 0,
  };
}

/** A stored full-classroom read, in progress or finished. */
export interface SkoolInventoryRow {
  id: number;
  communityUrl: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  coursesTotal: number;
  coursesRead: number;
  community: string | null;
  account: string | null;
  error: string | null;
  /** The `SkoolInventory` payload. Empty object while the read is still running. */
  data: any;
}

function toInventory(row: any): SkoolInventoryRow | null {
  if (!row) return null;
  let data: any = {};
  try {
    data = JSON.parse(row.data_json || "{}");
  } catch {
    data = {};
  }
  return {
    id: row.id,
    communityUrl: row.community_url,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    coursesTotal: row.courses_total,
    coursesRead: row.courses_read,
    community: row.community ?? null,
    account: row.account ?? null,
    error: row.error ?? null,
    data,
  };
}

export function startInventory(communityUrl: string): number {
  const info = db
    .prepare(`INSERT INTO skool_inventory (community_url, status, started_at) VALUES (?, 'running', ?)`)
    .run(communityUrl, Date.now());
  return Number(info.lastInsertRowid);
}

export function setInventoryProgress(id: number, read: number, total: number): void {
  db.prepare(`UPDATE skool_inventory SET courses_read = ?, courses_total = ? WHERE id = ?`).run(read, total, id);
}

export function finishInventory(id: number, data: any, error: string | null): void {
  db.prepare(
    `UPDATE skool_inventory
        SET status = ?, finished_at = ?, community = ?, account = ?, error = ?, data_json = ?
      WHERE id = ?`,
  ).run(
    error ? "failed" : "done",
    Date.now(),
    data?.community ?? null,
    data?.account ?? null,
    error,
    JSON.stringify(data ?? {}),
    id,
  );
}

export function getInventory(id: number): SkoolInventoryRow | null {
  return toInventory(db.prepare(`SELECT * FROM skool_inventory WHERE id = ?`).get(id));
}

/**
 * The newest snapshot, running or finished.
 *
 * Deliberately not "the newest DONE one": a read in progress is the thing the
 * operator is most likely asking about, and hiding it behind an older complete
 * snapshot would make a running job look like nothing was happening.
 */
export function latestInventory(): SkoolInventoryRow | null {
  return toInventory(db.prepare(`SELECT * FROM skool_inventory ORDER BY started_at DESC LIMIT 1`).get());
}

/** The newest snapshot that actually completed — what a planner should read. */
export function latestCompleteInventory(): SkoolInventoryRow | null {
  return toInventory(
    db.prepare(`SELECT * FROM skool_inventory WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`).get(),
  );
}

/** Partial update; an omitted field is left alone rather than blanked. */
export function saveSkoolSettings(patch: Partial<Pick<SkoolSettings, "communityUrl" | "roadmapMd">>): SkoolSettings {
  const current = getSkoolSettings();
  const next = {
    communityUrl: patch.communityUrl ?? current.communityUrl,
    roadmapMd: patch.roadmapMd ?? current.roadmapMd,
  };
  db.prepare(
    `UPDATE skool_settings SET community_url = ?, roadmap_md = ?, updated_at = ? WHERE id = 1`,
  ).run(next.communityUrl, next.roadmapMd, Date.now());
  return getSkoolSettings();
}
