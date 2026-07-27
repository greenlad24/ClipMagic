/**
 * Typed CRUD over the `plan_runs` table (defined in db/index.ts) for the Video
 * Planner. Mirrors db/scriptRuns.ts: better-sqlite3 prepared statements, JSON
 * columns hydrated back into the PlanRunResult contract, defensive defaults so
 * callers never see undefined fields.
 */
import { db } from "./index.js";
import type {
  PlanInput,
  PlanRunResult,
  PlanRunListItem,
  PlanRunStatus,
  PlanLine,
  PlanMeasure,
  Beat,
} from "../planner/types.js";

const now = () => Date.now();

interface PlanRunRow {
  id: string;
  title: string;
  status: string;
  input_json: string;
  duration_sec: number | null;
  plan: string | null;
  parsed_json: string | null;
  measure_json: string | null;
  rounds_json: string | null;
  beats_json: string | null;
  research: string | null;
  cost_usd: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function hydrate(row: PlanRunRow): PlanRunResult {
  return {
    runId: row.id,
    status: row.status as PlanRunStatus,
    title: row.title,
    input: parse<PlanInput>(row.input_json, { source: "", sourceKind: "upload" }),
    durationSec: row.duration_sec,
    plan: row.plan,
    parsed: parse<PlanLine[]>(row.parsed_json, []),
    measure: parse<PlanMeasure | null>(row.measure_json, null),
    rounds: parse<PlanRunResult["rounds"]>(row.rounds_json, []),
    beats: parse<Beat[]>(row.beats_json, []),
    research: row.research,
    costUsd: row.cost_usd ?? 0,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRun(id: string, input: PlanInput): void {
  const t = now();
  db.prepare(
    `INSERT INTO plan_runs (id, title, status, input_json, cost_usd, created_at, updated_at)
     VALUES (?, ?, 'ingesting', ?, 0, ?, ?)`
  ).run(id, input.title || "Untitled narration", JSON.stringify(input), t, t);
}

export interface PlanRunPatch {
  status?: PlanRunStatus;
  title?: string;
  durationSec?: number | null;
  plan?: string | null;
  parsed?: PlanLine[];
  measure?: PlanMeasure | null;
  rounds?: PlanRunResult["rounds"];
  beats?: Beat[];
  research?: string | null;
  costUsd?: number;
  error?: string | null;
}

export function updateRun(id: string, patch: PlanRunPatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };

  if (patch.status !== undefined) put("status", patch.status);
  if (patch.title !== undefined) put("title", patch.title);
  if (patch.durationSec !== undefined) put("duration_sec", patch.durationSec);
  if (patch.plan !== undefined) put("plan", patch.plan);
  if (patch.parsed !== undefined) put("parsed_json", JSON.stringify(patch.parsed));
  if (patch.measure !== undefined) put("measure_json", patch.measure ? JSON.stringify(patch.measure) : null);
  if (patch.rounds !== undefined) put("rounds_json", JSON.stringify(patch.rounds));
  if (patch.beats !== undefined) put("beats_json", JSON.stringify(patch.beats));
  if (patch.research !== undefined) put("research", patch.research);
  if (patch.costUsd !== undefined) put("cost_usd", patch.costUsd);
  if (patch.error !== undefined) put("error", patch.error);
  if (!sets.length) return;

  put("updated_at", now());
  db.prepare(`UPDATE plan_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function getRun(id: string): PlanRunResult | null {
  const row = db.prepare(`SELECT * FROM plan_runs WHERE id = ?`).get(id) as PlanRunRow | undefined;
  return row ? hydrate(row) : null;
}

export function listRuns(limit = 50): PlanRunListItem[] {
  const rows = db
    .prepare(
      `SELECT id, title, status, duration_sec, parsed_json, created_at, updated_at
         FROM plan_runs ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as (Pick<PlanRunRow, "id" | "title" | "status" | "duration_sec" | "parsed_json" | "created_at" | "updated_at">)[];
  return rows.map((r) => ({
    runId: r.id,
    title: r.title,
    status: r.status as PlanRunStatus,
    durationSec: r.duration_sec,
    lines: parse<PlanLine[]>(r.parsed_json, []).length,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function deleteRun(id: string): boolean {
  return db.prepare(`DELETE FROM plan_runs WHERE id = ?`).run(id).changes > 0;
}
