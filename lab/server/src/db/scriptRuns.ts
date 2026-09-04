/**
 * Typed CRUD over the `script_runs` table (defined in db/index.ts) for the Jake
 * Dawson Script Generator. Mirrors db/keywordResearch.ts: plain better-sqlite3
 * prepared statements, nanoid() ids, Date.now() timestamps, and JSON columns
 * hydrated back into the ScriptRunResult contract.
 *
 * Object columns (input/setup/stage0/stages) are stored as JSON strings and
 * re-parsed on read; a missing/corrupt stages blob hydrates to an empty
 * ScriptStages so callers never see undefined fields.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";
import type {
  ScriptInput,
  ScriptSetup,
  Stage0Result,
  ScriptStages,
  ScriptRunResult,
  ScriptRunListItem,
  ScriptRunStatus,
  ScriptMode,
  RefineMessage,
  VideoType,
} from "../scriptgen/types.js";

const now = () => Date.now();

/** A fully-defaulted, empty ScriptStages (used to seed + hydrate). */
export function emptyStages(): ScriptStages {
  return {
    research: null,
    sources: [],
    factSheet: null,
    outline: null,
    briefCoverage: null,
    hooks: null,
    sponsorSegment: null,
    sections: [],
    outro: null,
    hooksWithCta: null,
    ctaScript: null,
    ctaNotes: [],
    briefCheck: null,
    reviewNotes: [],
    reviewChecklist: null,
    quality: null,
    claimAudit: null,
    claimFix: null,
  };
}

interface ScriptRunRow {
  id: string;
  title: string;
  video_type: string | null;
  status: string;
  input_json: string;
  setup_json: string | null;
  stage0_json: string | null;
  stages_json: string | null;
  final_document: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  generation_ms: number;
  refine_chat_json: string | null;
}

/** Parse the persisted refine thread, dropping anything malformed. */
function hydrateRefineChat(json: string | null): RefineMessage[] {
  const parsed = safeParse<unknown>(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (m): m is RefineMessage =>
      !!m &&
      typeof m === "object" &&
      ((m as RefineMessage).role === "user" || (m as RefineMessage).role === "assistant") &&
      typeof (m as RefineMessage).content === "string",
  );
}

function safeParse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Merge a parsed (possibly partial) stages blob onto the empty default. */
function hydrateStages(parsed: Partial<ScriptStages> | null): ScriptStages {
  const base = emptyStages();
  if (!parsed) return base;
  // SPREAD, never a field-by-field list. This function used to name each field,
  // and `videoWorkflows`/`videoSources` were added to ScriptStages long after it
  // was written — so every read-modify-write through getRun + updateRun silently
  // DELETED stage 1.6's workflow sheet and its video list. It also defeated the
  // resume fix, which copies generically from a stages blob that had already
  // been through here. A field added to ScriptStages is now carried by default;
  // the explicit entries below are only the ones needing a shape guarantee.
  //
  // Runs that predate a given stage simply have none of it; the stages blob is a
  // JSON column, so an added field needs no migration.
  return {
    ...base,
    ...parsed,
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    ctaNotes: Array.isArray(parsed.ctaNotes) ? parsed.ctaNotes : [],
    reviewNotes: Array.isArray(parsed.reviewNotes) ? parsed.reviewNotes : [],
  };
}

/**
 * The job registry lives in memory, so a restart orphans any run that was
 * mid-flight: the row stays 'running' forever and the frontend's polled jobId
 * 404s with no explanation. Called once at boot — mark them failed so they're
 * visibly dead rather than eternally in progress.
 */
export function failOrphanedRuns(): number {
  const res = db
    .prepare(
      `UPDATE script_runs SET status = 'failed', error = ?, updated_at = ?
       WHERE status IN ('running','classifying')`,
    )
    .run("Server restarted while this script was generating.", now());
  return res.changes;
}

/** Create a run row in the 'classifying' state and return its id. */
export function createRun(input: ScriptInput): string {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO script_runs (id, title, video_type, status, input_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, "", null, "classifying" as ScriptRunStatus, JSON.stringify(input), t, t);
  return id;
}

/** Patch a run row. Only the provided fields are written; objects are JSON-encoded. */
export function updateRun(
  id: string,
  patch: {
    title?: string;
    videoType?: VideoType | null;
    status?: ScriptRunStatus;
    setup?: ScriptSetup | null;
    stage0?: Stage0Result | null;
    stages?: ScriptStages;
    finalDocument?: string | null;
    error?: string | null;
    generationMs?: number;
    refineChat?: RefineMessage[];
  },
): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    vals.push(patch.title);
  }
  if (patch.videoType !== undefined) {
    sets.push("video_type = ?");
    vals.push(patch.videoType);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.setup !== undefined) {
    sets.push("setup_json = ?");
    vals.push(patch.setup === null ? null : JSON.stringify(patch.setup));
  }
  if (patch.stage0 !== undefined) {
    sets.push("stage0_json = ?");
    vals.push(patch.stage0 === null ? null : JSON.stringify(patch.stage0));
  }
  if (patch.stages !== undefined) {
    sets.push("stages_json = ?");
    vals.push(JSON.stringify(patch.stages));
  }
  if (patch.finalDocument !== undefined) {
    sets.push("final_document = ?");
    vals.push(patch.finalDocument);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  if (patch.generationMs !== undefined) {
    sets.push("generation_ms = ?");
    vals.push(patch.generationMs);
  }
  if (patch.refineChat !== undefined) {
    sets.push("refine_chat_json = ?");
    vals.push(JSON.stringify(patch.refineChat));
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE script_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

function rowToResult(row: ScriptRunRow): ScriptRunResult {
  const input = safeParse<ScriptInput>(row.input_json) ?? { idea: "" };
  return {
    runId: row.id,
    title: row.title,
    input,
    setup: safeParse<ScriptSetup>(row.setup_json),
    stage0: safeParse<Stage0Result>(row.stage0_json),
    stages: hydrateStages(safeParse<Partial<ScriptStages>>(row.stages_json)),
    finalDocument: row.final_document,
    refineChat: hydrateRefineChat(row.refine_chat_json),
    status: row.status as ScriptRunStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generationMs: row.generation_ms ?? 0,
  };
}

/** Hydrate the full ScriptRunResult (all JSON columns), or null if unknown. */
export function getRun(id: string): ScriptRunResult | null {
  const row = db.prepare("SELECT * FROM script_runs WHERE id = ?").get(id) as ScriptRunRow | undefined;
  return row ? rowToResult(row) : null;
}

/**
 * Saved-scripts history rows, newest first.
 *
 * The mode lives inside setup_json rather than in a column of its own — it is
 * set at the same moment as the rest of the setup, and a JSON field needs no
 * migration. That costs this query the setup blob per row (a few hundred bytes),
 * which is cheaper than a schema change and keeps the two in one place.
 */
export function listRuns(): ScriptRunListItem[] {
  const rows = db
    .prepare(
      "SELECT id, title, video_type, status, created_at, generation_ms, setup_json FROM script_runs ORDER BY created_at DESC",
    )
    .all() as Array<
      Pick<ScriptRunRow, "id" | "title" | "video_type" | "status" | "created_at" | "generation_ms" | "setup_json">
    >;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    videoType: (r.video_type as VideoType | null) ?? null,
    // Runs that predate outline mode carry no mode; they were all full scripts.
    mode: (safeParse<ScriptSetup>(r.setup_json)?.mode as ScriptMode | undefined) ?? "full",
    status: r.status as ScriptRunStatus,
    createdAt: r.created_at,
    generationMs: r.generation_ms ?? 0,
  }));
}

export function deleteRun(id: string): void {
  db.prepare("DELETE FROM script_runs WHERE id = ?").run(id);
}
