/**
 * Typed CRUD over the script edit loop: `script_versions`, `script_edit_reviews`
 * and `script_lessons` (tables defined in db/index.ts).
 *
 * Same shape as db/scriptRuns.ts — plain better-sqlite3 prepared statements,
 * nanoid() ids, Date.now() timestamps, JSON columns hydrated on read.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";
import type {
  ScriptVersion,
  ScriptLesson,
  ScriptLessonEvidence,
  ScriptEditReview,
  ScriptEditStats,
} from "../scriptgen/types.js";

const now = (): number => Date.now();

function readJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const countWords = (t: string): number => t.split(/\s+/).filter(Boolean).length;

/* ────────────────────────── versions ────────────────────────── */

interface VersionRow {
  id: string;
  run_id: string;
  version_no: number;
  source: string;
  text: string;
  note: string;
  created_at: number;
}

const toVersion = (r: VersionRow): ScriptVersion => ({
  id: r.id,
  runId: r.run_id,
  versionNo: r.version_no,
  source: r.source === "generated" || r.source === "rules" ? r.source : "edit",
  text: r.text ?? "",
  note: r.note ?? "",
  createdAt: r.created_at,
  chars: (r.text ?? "").length,
  words: countWords(r.text ?? ""),
});

export function listVersions(runId: string): ScriptVersion[] {
  return (
    db
      .prepare("SELECT * FROM script_versions WHERE run_id = ? ORDER BY version_no ASC")
      .all(runId) as VersionRow[]
  ).map(toVersion);
}

export function getVersion(id: string): ScriptVersion | null {
  const r = db.prepare("SELECT * FROM script_versions WHERE id = ?").get(id) as VersionRow | undefined;
  return r ? toVersion(r) : null;
}

/** The most recent snapshot, whatever its source. */
export function latestVersion(runId: string): ScriptVersion | null {
  const r = db
    .prepare("SELECT * FROM script_versions WHERE run_id = ? ORDER BY version_no DESC LIMIT 1")
    .get(runId) as VersionRow | undefined;
  return r ? toVersion(r) : null;
}

/**
 * Snapshot a version.
 *
 * ⚠️ IDENTICAL TEXT IS NOT A NEW VERSION. "Done" clicked twice with nothing
 * changed in between is one point in time, and a history full of duplicates is
 * a history nobody reads. The existing row is returned instead.
 */
export function addVersion(input: {
  runId: string;
  source: "generated" | "edit" | "rules";
  text: string;
  note?: string;
}): ScriptVersion {
  const last = latestVersion(input.runId);
  if (last && last.text.trim() === input.text.trim()) return last;
  const row: VersionRow = {
    id: nanoid(),
    run_id: input.runId,
    version_no: (last?.versionNo ?? 0) + 1,
    source: input.source,
    text: input.text,
    note: input.note ?? "",
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO script_versions (id, run_id, version_no, source, text, note, created_at)
     VALUES (@id, @run_id, @version_no, @source, @text, @note, @created_at)`,
  ).run(row);
  return toVersion(row);
}

/**
 * The most recent version the MACHINE wrote — what a diff must be taken against.
 *
 * See the `source` note on ScriptVersion: after a rules pass the baseline moves
 * forward, or the next "Done" learns lessons from the generator's own rewrite.
 */
export function latestBaseline(runId: string): ScriptVersion | null {
  const r = db
    .prepare(
      `SELECT * FROM script_versions WHERE run_id = ? AND source IN ('generated','rules')
       ORDER BY version_no DESC LIMIT 1`,
    )
    .get(runId) as VersionRow | undefined;
  return r ? toVersion(r) : null;
}

/** Whether this run already has a snapshot of that kind. */
export function hasVersionOfSource(runId: string, source: ScriptVersion["source"]): boolean {
  const r = db
    .prepare("SELECT 1 AS n FROM script_versions WHERE run_id = ? AND source = ? LIMIT 1")
    .get(runId, source) as { n: number } | undefined;
  return Boolean(r);
}

export function deleteVersionsForRun(runId: string): void {
  db.prepare("DELETE FROM script_versions WHERE run_id = ?").run(runId);
}

/* ────────────────────────── reviews ────────────────────────── */

interface ReviewRow {
  id: string;
  run_id: string;
  version_id: string;
  stats_json: string;
  changes_json: string;
  status: string;
  error: string | null;
  cost_usd: number;
  created_at: number;
}

const EMPTY_STATS: ScriptEditStats = {
  generatedParagraphs: 0,
  editedParagraphs: 0,
  kept: 0,
  rewritten: 0,
  cut: 0,
  added: 0,
  generatedWords: 0,
  editedWords: 0,
  keptRatio: 0,
  thirds: [0, 0, 0],
};

const toReview = (r: ReviewRow, lessons: ScriptLesson[]): ScriptEditReview => ({
  id: r.id,
  runId: r.run_id,
  versionId: r.version_id,
  stats: readJson<ScriptEditStats>(r.stats_json, EMPTY_STATS),
  status: r.status === "ready" ? "ready" : "failed",
  error: r.error,
  costUsd: Number(r.cost_usd ?? 0),
  createdAt: r.created_at,
  lessons,
});

export function insertReview(input: {
  runId: string;
  versionId: string;
  stats: ScriptEditStats;
  changes: unknown;
  status: "ready" | "failed";
  error?: string | null;
  costUsd?: number;
}): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO script_edit_reviews (id, run_id, version_id, stats_json, changes_json, status, error, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.runId,
    input.versionId,
    JSON.stringify(input.stats),
    JSON.stringify(input.changes ?? []),
    input.status,
    input.error ?? null,
    input.costUsd ?? 0,
    now(),
  );
  return id;
}

export function getReview(id: string): ScriptEditReview | null {
  const r = db.prepare("SELECT * FROM script_edit_reviews WHERE id = ?").get(id) as ReviewRow | undefined;
  return r ? toReview(r, lessonsForReview(r.id)) : null;
}

/** The most recent review for a run — what the panel shows when it reopens. */
export function latestReview(runId: string): ScriptEditReview | null {
  const r = db
    .prepare("SELECT * FROM script_edit_reviews WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(runId) as ReviewRow | undefined;
  return r ? toReview(r, lessonsForReview(r.id)) : null;
}

/* ────────────────────────── lessons ────────────────────────── */

interface LessonRow {
  id: string;
  run_id: string;
  review_id: string;
  rule: string;
  rationale: string;
  evidence_json: string;
  scope: string;
  state: string;
  created_at: number;
  decided_at: number | null;
  run_title?: string;
}

const SCOPES = ["voice", "structure", "format", "facts"] as const;
const STATES = ["pending", "approved", "rejected", "retired"] as const;

const toLesson = (r: LessonRow): ScriptLesson => ({
  id: r.id,
  runId: r.run_id,
  reviewId: r.review_id,
  rule: r.rule,
  rationale: r.rationale ?? "",
  evidence: readJson<ScriptLessonEvidence[]>(r.evidence_json, []),
  scope: (SCOPES as readonly string[]).includes(r.scope) ? (r.scope as ScriptLesson["scope"]) : "voice",
  state: (STATES as readonly string[]).includes(r.state) ? (r.state as ScriptLesson["state"]) : "pending",
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  runTitle: r.run_title,
});

export function insertLesson(input: {
  runId: string;
  reviewId: string;
  rule: string;
  rationale: string;
  evidence: ScriptLessonEvidence[];
  scope: ScriptLesson["scope"];
}): ScriptLesson {
  const row: LessonRow = {
    id: nanoid(),
    run_id: input.runId,
    review_id: input.reviewId,
    rule: input.rule,
    rationale: input.rationale,
    evidence_json: JSON.stringify(input.evidence ?? []),
    scope: input.scope,
    state: "pending",
    created_at: now(),
    decided_at: null,
  };
  db.prepare(
    `INSERT INTO script_lessons (id, run_id, review_id, rule, rationale, evidence_json, scope, state, created_at, decided_at)
     VALUES (@id, @run_id, @review_id, @rule, @rationale, @evidence_json, @scope, @state, @created_at, @decided_at)`,
  ).run(row);
  return toLesson(row);
}

export function lessonsForReview(reviewId: string): ScriptLesson[] {
  return (
    db
      .prepare("SELECT * FROM script_lessons WHERE review_id = ? ORDER BY created_at ASC")
      .all(reviewId) as LessonRow[]
  ).map(toLesson);
}

/**
 * Every lesson, newest first, with the title of the script it came from.
 *
 * The join is what makes the panel readable: "no dated product-history
 * paragraph" means one thing on its own and another when it says which script
 * taught it.
 */
export function listLessons(state?: ScriptLesson["state"]): ScriptLesson[] {
  const sql =
    `SELECT l.*, r.title AS run_title FROM script_lessons l
     LEFT JOIN script_runs r ON r.id = l.run_id` +
    (state ? " WHERE l.state = ?" : "") +
    " ORDER BY l.created_at DESC";
  const rows = (state ? db.prepare(sql).all(state) : db.prepare(sql).all()) as LessonRow[];
  return rows.map(toLesson);
}

/**
 * The approved rules, oldest first — the order they were learned in.
 *
 * ⚠️ THIS IS THE ONE READ THAT REACHES A LIVE GENERATION, and it is the only
 * place `state` is filtered to 'approved'. Everything else here is UI.
 */
export function approvedLessons(): ScriptLesson[] {
  return (
    db
      .prepare("SELECT * FROM script_lessons WHERE state = 'approved' ORDER BY created_at ASC")
      .all() as LessonRow[]
  ).map(toLesson);
}

export function setLessonState(id: string, state: ScriptLesson["state"]): ScriptLesson | null {
  db.prepare("UPDATE script_lessons SET state = ?, decided_at = ? WHERE id = ?").run(state, now(), id);
  const r = db.prepare("SELECT * FROM script_lessons WHERE id = ?").get(id) as LessonRow | undefined;
  return r ? toLesson(r) : null;
}

/** Edit an approved rule's wording without losing what it was learned from. */
export function updateLessonRule(id: string, rule: string): ScriptLesson | null {
  db.prepare("UPDATE script_lessons SET rule = ? WHERE id = ?").run(rule, id);
  const r = db.prepare("SELECT * FROM script_lessons WHERE id = ?").get(id) as LessonRow | undefined;
  return r ? toLesson(r) : null;
}

export function deleteLesson(id: string): void {
  db.prepare("DELETE FROM script_lessons WHERE id = ?").run(id);
}

/** Clean-up when a run is deleted, so nothing dangles. */
export function deleteEditTrailForRun(runId: string): void {
  db.prepare("DELETE FROM script_lessons WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM script_edit_reviews WHERE run_id = ?").run(runId);
  deleteVersionsForRun(runId);
}
