/**
 * UX Scout — storage.
 *
 * The Scout uses an AI tool like a first-time user, toward the video's goal, and
 * writes the UX report the script is built from (Jake 2026-10-02: "the UX
 * analysis and the workflow writing — the same thing we wanted to hire as a
 * person"). The Lab never calls Claude for it: a job queued here is picked up
 * by the runner on the host, which starts Claude Code signed in with Jake's own
 * Max plan, and Claude Code drives the browser through `scout/cli.ts` → the
 * endpoints in routes.ts. This module is the shared state between the two.
 *
 *   scout_tools   one row per AI tool Jake logged into (each has its own
 *                 persistent Chromium profile under DATA_DIR/scout/profiles).
 *   scout_jobs    one Scout run: queued → running → done | failed | cancelled.
 *   scout_events  the live log the Lab shows while it runs (notes, actions,
 *                 screenshots, key screenshots, errors).
 *
 * Files: DATA_DIR/scout/jobs/<jobId>/  NNN.jpg (every screenshot), assets/
 * (files Jake gave it to use, e.g. a product photo).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";

export const DATA_DIR = process.env.DATA_DIR || "/data";
export const SCOUT_DIR = path.join(DATA_DIR, "scout");
export const PROFILES_DIR = path.join(SCOUT_DIR, "profiles");
export const JOBS_DIR = path.join(SCOUT_DIR, "jobs");

db.exec(`
CREATE TABLE IF NOT EXISTS scout_tools (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  home_url TEXT NOT NULL,
  note TEXT,
  logged_in_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scout_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  tool_slug TEXT NOT NULL,
  goal TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  summary TEXT,
  key_shots TEXT,                  -- JSON: [{ file, caption, ref? }]
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  last_event_at TEXT
);
CREATE INDEX IF NOT EXISTS scout_jobs_run ON scout_jobs (run_id, created_at);
CREATE TABLE IF NOT EXISTS scout_events (
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- note | action | shot | key_shot | error | status
  text TEXT NOT NULL,
  file TEXT,
  PRIMARY KEY (job_id, seq)
);
`);

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ScoutTool { slug: string; name: string; homeUrl: string; note: string | null; loggedInAt: string | null; createdAt: string }
export interface KeyShot { file: string; caption: string; ref?: unknown }
export interface ScoutJob {
  id: string; runId: string | null; toolSlug: string; goal: string; context: string | null; status: JobStatus;
  cancelRequested: boolean; report: string | null; summary: string | null; keyShots: KeyShot[]; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; lastEventAt: string | null;
}
export interface ScoutEvent { seq: number; at: string; kind: string; text: string; file: string | null }

const now = () => new Date().toISOString();

/** A runner that died leaves a job "running" forever; past this with no event it is failed on read. */
const STALE_MS = 20 * 60_000;

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tool";
}

export function profileDir(slug: string): string {
  return path.join(PROFILES_DIR, slugify(slug));
}

export function jobDir(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("bad job id");
  return path.join(JOBS_DIR, id);
}

export function assetsDir(id: string): string {
  return path.join(jobDir(id), "assets");
}

/* ── tools ─────────────────────────────────────────────────────────────── */

const toTool = (r: any): ScoutTool => ({ slug: r.slug, name: r.name, homeUrl: r.home_url, note: r.note ?? null, loggedInAt: r.logged_in_at ?? null, createdAt: r.created_at });

export function listTools(): ScoutTool[] {
  return (db.prepare(`SELECT * FROM scout_tools ORDER BY name COLLATE NOCASE`).all() as any[]).map(toTool);
}

export function getTool(slug: string): ScoutTool | null {
  const r = db.prepare(`SELECT * FROM scout_tools WHERE slug = ?`).get(slug);
  return r ? toTool(r) : null;
}

export function normalizeUrl(raw: string): string {
  let u = String(raw ?? "").trim();
  if (!u) throw new Error("A URL is required.");
  if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only http(s) addresses can be opened.");
  return parsed.toString();
}

export function addTool(input: { name: string; homeUrl: string; note?: string }): ScoutTool {
  const name = String(input.name ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Give the tool a name.");
  const homeUrl = normalizeUrl(input.homeUrl);
  let slug = slugify(name);
  if (getTool(slug)) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO scout_tools (slug, name, home_url, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(slug, name, homeUrl, input.note?.trim() || null, now());
  fs.mkdirSync(profileDir(slug), { recursive: true });
  return getTool(slug)!;
}

export function markLoggedIn(slug: string): void {
  db.prepare(`UPDATE scout_tools SET logged_in_at = ? WHERE slug = ?`).run(now(), slug);
}

export function removeTool(slug: string): void {
  db.prepare(`DELETE FROM scout_tools WHERE slug = ?`).run(slug);
  try { fs.rmSync(profileDir(slug), { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ── jobs ──────────────────────────────────────────────────────────────── */

function toJob(r: any): ScoutJob {
  let keyShots: KeyShot[] = [];
  try { keyShots = r.key_shots ? JSON.parse(r.key_shots) : []; } catch { /* keep empty */ }
  return {
    id: r.id, runId: r.run_id ?? null, toolSlug: r.tool_slug, goal: r.goal, context: r.context ?? null, status: r.status,
    cancelRequested: !!r.cancel_requested, report: r.report ?? null, summary: r.summary ?? null, keyShots, error: r.error ?? null,
    createdAt: r.created_at, startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null, lastEventAt: r.last_event_at ?? null,
  };
}

function failStale(r: any): any {
  if (r?.status !== "running") return r;
  const last = Date.parse(r.last_event_at || r.started_at || r.created_at);
  if (Number.isFinite(last) && Date.now() - last > STALE_MS) {
    const msg = "The Scout stopped reporting for 20 minutes — the runner or Claude Code ended without finishing.";
    db.prepare(`UPDATE scout_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(msg, now(), r.id);
    addEvent(r.id, "error", msg);
    return db.prepare(`SELECT * FROM scout_jobs WHERE id = ?`).get(r.id);
  }
  return r;
}

export function getJob(id: string): ScoutJob | null {
  const r = failStale(db.prepare(`SELECT * FROM scout_jobs WHERE id = ?`).get(id));
  return r ? toJob(r) : null;
}

export function listJobs(opts: { runId?: string; limit?: number } = {}): ScoutJob[] {
  const rows = opts.runId
    ? db.prepare(`SELECT * FROM scout_jobs WHERE run_id = ? ORDER BY created_at DESC LIMIT ?`).all(opts.runId, opts.limit ?? 20)
    : db.prepare(`SELECT * FROM scout_jobs ORDER BY created_at DESC LIMIT ?`).all(opts.limit ?? 30);
  return (rows as any[]).map((r) => toJob(failStale(r)));
}

export function createJob(input: { toolSlug: string; goal: string; context?: string; runId?: string }): ScoutJob {
  if (!getTool(input.toolSlug)) throw new Error("Unknown tool — add it and log in first.");
  const goal = String(input.goal ?? "").trim();
  if (goal.length < 8) throw new Error("Describe the goal in a sentence — what should a beginner make with this tool?");
  const id = randomUUID();
  fs.mkdirSync(assetsDir(id), { recursive: true });
  db.prepare(`INSERT INTO scout_jobs (id, run_id, tool_slug, goal, context, status, created_at, last_event_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .run(id, input.runId || null, input.toolSlug, goal.slice(0, 2000), input.context?.slice(0, 20_000) || null, now(), now());
  addEvent(id, "status", "Queued — waiting for the runner to start Claude Code.");
  return getJob(id)!;
}

/** The runner takes the oldest queued job. Only one runs at a time. */
export function claimNextJob(): ScoutJob | null {
  const running = db.prepare(`SELECT * FROM scout_jobs WHERE status = 'running'`).all() as any[];
  for (const r of running) failStale(r);
  if ((db.prepare(`SELECT COUNT(*) n FROM scout_jobs WHERE status = 'running'`).get() as any).n > 0) return null;
  const next = db.prepare(`SELECT id FROM scout_jobs WHERE status = 'queued' AND cancel_requested = 0 ORDER BY created_at LIMIT 1`).get() as any;
  if (!next) return null;
  const t = now();
  const ok = db.prepare(`UPDATE scout_jobs SET status = 'running', started_at = ?, last_event_at = ? WHERE id = ? AND status = 'queued'`).run(t, t, next.id);
  if (!ok.changes) return null;
  addEvent(next.id, "status", "Claude Code started (Max plan).");
  return getJob(next.id);
}

export function requestCancel(id: string): ScoutJob | null {
  const j = getJob(id);
  if (!j) return null;
  if (j.status === "queued") {
    db.prepare(`UPDATE scout_jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ? WHERE id = ?`).run(now(), id);
    addEvent(id, "status", "Cancelled before it started.");
  } else if (j.status === "running") {
    db.prepare(`UPDATE scout_jobs SET cancel_requested = 1 WHERE id = ?`).run(id);
    addEvent(id, "status", "Stop requested — the Scout stops at its next step.");
  }
  return getJob(id);
}

/** Running → cancelled once the runner has actually stopped Claude Code. */
export function markCancelled(id: string): void {
  db.prepare(`UPDATE scout_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'`).run(now(), id);
  addEvent(id, "status", "Stopped.");
}

export function finishJob(id: string, input: { report: string; summary?: string; keyShots: KeyShot[] }): ScoutJob {
  const j = getJob(id);
  if (!j) throw new Error("Unknown job.");
  if (j.status !== "running") throw new Error(`This Scout is ${j.status}, not running.`);
  db.prepare(`UPDATE scout_jobs SET status = 'done', report = ?, summary = ?, key_shots = ?, finished_at = ?, last_event_at = ? WHERE id = ?`)
    .run(input.report, input.summary ?? null, JSON.stringify(input.keyShots), now(), now(), id);
  addEvent(id, "status", "Report written.");
  return getJob(id)!;
}

export function failJob(id: string, error: string): void {
  db.prepare(`UPDATE scout_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('running','queued')`).run(error.slice(0, 2000), now(), id);
  addEvent(id, "error", error.slice(0, 2000));
}

export function setKeyShots(id: string, shots: KeyShot[]): void {
  db.prepare(`UPDATE scout_jobs SET key_shots = ? WHERE id = ?`).run(JSON.stringify(shots), id);
}

/* ── events ────────────────────────────────────────────────────────────── */

export function addEvent(jobId: string, kind: string, text: string, file?: string | null): number {
  const seq = ((db.prepare(`SELECT MAX(seq) m FROM scout_events WHERE job_id = ?`).get(jobId) as any)?.m ?? 0) + 1;
  const at = now();
  db.prepare(`INSERT INTO scout_events (job_id, seq, at, kind, text, file) VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, seq, at, kind, text.slice(0, 4000), file ?? null);
  db.prepare(`UPDATE scout_jobs SET last_event_at = ? WHERE id = ?`).run(at, jobId);
  return seq;
}

export function listEvents(jobId: string, afterSeq = 0, limit = 400): ScoutEvent[] {
  return (db.prepare(`SELECT seq, at, kind, text, file FROM scout_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(jobId, afterSeq, limit) as any[]).map((r) => ({ seq: r.seq, at: r.at, kind: r.kind, text: r.text, file: r.file ?? null }));
}

export function countEvents(jobId: string, kind: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM scout_events WHERE job_id = ? AND kind = ?`).get(jobId, kind) as any).n;
}

/** The newest screenshot file of a job (for the live view). */
export function latestShot(jobId: string): string | null {
  const r = db.prepare(`SELECT file FROM scout_events WHERE job_id = ? AND file IS NOT NULL ORDER BY seq DESC LIMIT 1`).get(jobId) as any;
  return r?.file ?? null;
}
