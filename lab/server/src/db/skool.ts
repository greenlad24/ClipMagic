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
  /** The creator's YouTube channel — where missing lessons come from. */
  channelUrl: string;
  /** Tracks the spine MUST contain, with optional guidance for each. */
  requiredTracks: { title: string; note: string }[];
  /**
   * The welcome message every new member already receives, verbatim.
   *
   * ⚠️ TWO JOBS, AND THE SECOND IS THE ONE NOTHING ELSE CAN DO. It is the voice
   * the ask post's greeting should sound like — but it is also a question that
   * has ALREADY been put to exactly the people that post is about to @mention.
   * Nothing in this system can see a Skool auto-DM, so without it stored here
   * the same five members are asked the same thing twice in one week and the
   * agent has no way of knowing.
   *
   * Stored verbatim, placeholder token and all. It is a reference for a writer,
   * not a template this code fills in.
   */
  welcomeMessageMd: string;
  updatedAt: number;
}

interface Row {
  community_url: string;
  roadmap_md: string;
  channel_url: string;
  required_tracks_json: string;
  welcome_message_md: string;
  updated_at: number;
}

/** Tolerant: a malformed list means "none required", never a crashed planner. */
function parseRequired(raw: string | undefined): { title: string; note: string }[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((t: any) => ({ title: String(t?.title ?? "").trim(), note: String(t?.note ?? "").trim() }))
      .filter((t) => t.title);
  } catch {
    return [];
  }
}

export function getSkoolSettings(): SkoolSettings {
  const row = db.prepare(`SELECT * FROM skool_settings WHERE id = 1`).get() as Row | undefined;
  return {
    communityUrl: row?.community_url ?? "",
    roadmapMd: row?.roadmap_md ?? "",
    channelUrl: row?.channel_url ?? "",
    requiredTracks: parseRequired(row?.required_tracks_json),
    welcomeMessageMd: (row as any)?.welcome_message_md ?? "",
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
export function saveSkoolSettings(
  patch: Partial<
    Pick<SkoolSettings, "communityUrl" | "roadmapMd" | "channelUrl" | "requiredTracks" | "welcomeMessageMd">
  >,
): SkoolSettings {
  const current = getSkoolSettings();
  const next = {
    communityUrl: patch.communityUrl ?? current.communityUrl,
    roadmapMd: patch.roadmapMd ?? current.roadmapMd,
    channelUrl: patch.channelUrl ?? current.channelUrl,
    requiredTracks: patch.requiredTracks ?? current.requiredTracks,
    welcomeMessageMd: patch.welcomeMessageMd ?? current.welcomeMessageMd,
  };
  db.prepare(
    `UPDATE skool_settings
        SET community_url = ?, roadmap_md = ?, channel_url = ?, required_tracks_json = ?,
            welcome_message_md = ?, updated_at = ?
      WHERE id = 1`,
  ).run(
    next.communityUrl,
    next.roadmapMd,
    next.channelUrl,
    JSON.stringify(next.requiredTracks),
    next.welcomeMessageMd,
    Date.now(),
  );
  return getSkoolSettings();
}

/* ── Plans ──────────────────────────────────────────────────────────────── */

export interface SkoolPlanRow {
  id: number;
  /** The snapshot this was planned against — the write path must re-check it. */
  inventoryId: number;
  status: "running" | "done" | "failed";
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Page-writing progress: "" | running | done | failed. */
  lessonsStatus: string;
  lessonsDone: number;
  lessonsTotal: number;
  data: any;
}

function toPlan(row: any): SkoolPlanRow | null {
  if (!row) return null;
  let data: any = {};
  try {
    data = JSON.parse(row.data_json || "{}");
  } catch {
    data = {};
  }
  return {
    id: row.id,
    inventoryId: row.inventory_id,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
    error: row.error ?? null,
    lessonsStatus: row.lessons_status ?? "",
    lessonsDone: row.lessons_done ?? 0,
    lessonsTotal: row.lessons_total ?? 0,
    data,
  };
}

export function startPlan(inventoryId: number): number {
  const info = db
    .prepare(`INSERT INTO skool_plans (inventory_id, status, created_at) VALUES (?, 'running', ?)`)
    .run(inventoryId, Date.now());
  return Number(info.lastInsertRowid);
}

export function finishPlan(id: number, data: any, error: string | null): void {
  db.prepare(
    `UPDATE skool_plans SET status = ?, finished_at = ?, error = ?, data_json = ? WHERE id = ?`,
  ).run(error ? "failed" : "done", Date.now(), error, JSON.stringify(data ?? {}), id);
}

export function setLessonProgress(id: number, status: string, done: number, total: number): void {
  db.prepare(`UPDATE skool_plans SET lessons_status = ?, lessons_done = ?, lessons_total = ? WHERE id = ?`).run(
    status,
    done,
    total,
    id,
  );
}

/** Store the plan back after its pages have been written into it. */
export function updatePlanData(id: number, data: any): void {
  db.prepare(`UPDATE skool_plans SET data_json = ? WHERE id = ?`).run(JSON.stringify(data ?? {}), id);
}

export function getPlan(id: number): SkoolPlanRow | null {
  return toPlan(db.prepare(`SELECT * FROM skool_plans WHERE id = ?`).get(id));
}

export function latestPlan(): SkoolPlanRow | null {
  return toPlan(db.prepare(`SELECT * FROM skool_plans ORDER BY created_at DESC LIMIT 1`).get());
}
