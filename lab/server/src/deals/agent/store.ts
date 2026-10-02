/**
 * Agent storage: runs, per-thread items, Slack questions, learned lessons,
 * and the "handled" ledger (thread + message id) that stops a live run from
 * touching the same inbound email twice.
 */
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import { gmailThreadUrl } from "../integrations/gmail.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_agent_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  preview INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cost_usd REAL,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS deals_agent_runs_started ON deals_agent_runs (started_at);

CREATE TABLE IF NOT EXISTS deals_agent_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  preview INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  subject TEXT,
  from_addr TEXT,
  brand TEXT,
  stage TEXT,
  edge_case TEXT,
  goal TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  fit TEXT,
  draft_text TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  gmail_draft_id TEXT,
  slack_permalink TEXT,
  deal_id TEXT,
  label TEXT,
  board_stage TEXT,
  applied TEXT,
  learned_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_agent_items_run ON deals_agent_items (run_id);
CREATE INDEX IF NOT EXISTS deals_agent_items_thread ON deals_agent_items (thread_id);

CREATE TABLE IF NOT EXISTS deals_agent_questions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  preview INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  item_id TEXT,
  subject TEXT,
  brand TEXT,
  stage TEXT,
  kind TEXT NOT NULL DEFAULT 'question',
  question TEXT NOT NULL,
  proposal TEXT,
  asked_at TEXT NOT NULL,
  slack_channel TEXT,
  slack_ts TEXT,
  slack_permalink TEXT,
  answer TEXT,
  answered_at TEXT,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS deals_agent_questions_thread ON deals_agent_questions (thread_id);

CREATE TABLE IF NOT EXISTS deals_agent_lessons (
  id TEXT PRIMARY KEY,
  brand TEXT,
  stage TEXT,
  lesson TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_agent_handled (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  run_id TEXT,
  item_id TEXT,
  decision TEXT,
  handled_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id)
);

CREATE TABLE IF NOT EXISTS deals_agent_fit_cache (
  domain TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
`);

/*
 * Slack answer watcher state (slackWatcher.ts; additive 2026-10-01). Never dropped or renamed.
 *   watch_state     NULL (watcher never touched it) | 'waiting' | 'acting' | 'idle' | 'asked'
 *   watch_seen      newest human activity (Slack ts, seconds; reply ts or edited.ts) already acknowledged
 *   watch_acted     newest human activity already acted on
 *   watch_act_at    ISO instant the pending burst will be acted on (NULL = nothing pending)
 *   watch_acted_at  ISO instant of the last action
 *   watch_owned     1 = the watcher recorded this answer and handles it; the scheduled run must not reprocess it
 *   watch_hold_msg  Gmail message id the watcher asked about again ('asked'): the run leaves the thread alone until a newer email arrives
 */
{
  const have = new Set((db.prepare(`PRAGMA table_info(deals_agent_questions)`).all() as Array<{ name: string }>).map((c) => c.name));
  const add: Array<[string, string]> = [
    ["watch_state", "TEXT"], ["watch_seen", "REAL"], ["watch_acted", "REAL"], ["watch_act_at", "TEXT"],
    ["watch_acted_at", "TEXT"], ["watch_owned", "INTEGER NOT NULL DEFAULT 0"], ["watch_hold_msg", "TEXT"],
  ];
  for (const [c, t] of add) if (!have.has(c)) db.exec(`ALTER TABLE deals_agent_questions ADD COLUMN ${c} ${t}`);
}

const now = () => new Date().toISOString();
const j = (s: string | null | undefined, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/* ── API shapes (the frontend is built against these) ─────────────────────── */

export type Decision = "draft" | "skip" | "spam" | "flag" | "ask";
export interface Counts {
  threads: number; drafted: number; skipped: number; spam: number; flagged: number; asked: number;
  /** Additive (followups.ts): follow-up drafts and auto-closed deals in this run (also counted in drafted / skipped). */
  followUps?: number; closed?: number;
}
export interface RunSummary {
  id: string;
  /** "slack" = one thread re-processed by the Slack answer watcher (slackWatcher.ts). */
  trigger: "schedule" | "manual" | "slack";
  preview: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  counts: Counts;
  error: string | null;
}
export interface Check { name: string; ok: boolean; detail: string }
export interface Fit { verdict: "fit" | "partial" | "none"; angle: string | null; notes: string }
export interface AgentItem {
  id: string;
  threadId: string;
  gmailUrl: string;
  subject: string;
  from: string;
  brand: string | null;
  stage: string;
  edgeCase: string | null;
  decision: Decision;
  reason: string;
  fit: Fit | null;
  draftText: string | null;
  checks: Check[];
  gmailDraftId: string | null;
  slackPermalink: string | null;
  dealId: string | null;
  createdAt: string;
}

export const emptyCounts = (): Counts => ({ threads: 0, drafted: 0, skipped: 0, spam: 0, flagged: 0, asked: 0 });

/* ── runs ─────────────────────────────────────────────────────────────────── */

function toRun(r: any): RunSummary {
  return {
    id: r.id,
    trigger: r.trigger,
    preview: r.preview === 1,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    counts: { ...emptyCounts(), ...j(r.counts, {}) },
    error: r.error ?? null,
  };
}

export function createRun(trigger: "schedule" | "manual" | "slack", preview: boolean): RunSummary {
  const id = randomUUID();
  db.prepare(`INSERT INTO deals_agent_runs (id, trigger, preview, started_at, status, counts) VALUES (?, ?, ?, ?, 'running', ?)`)
    .run(id, trigger, preview ? 1 : 0, now(), JSON.stringify(emptyCounts()));
  return getRun(id)!;
}

export function updateRun(id: string, patch: { counts?: Counts; status?: string; error?: string | null; finished?: boolean; costUsd?: number; log?: string[] }): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.counts) { sets.push("counts = ?"); vals.push(JSON.stringify(patch.counts)); }
  if (patch.status) { sets.push("status = ?"); vals.push(patch.status); }
  if (patch.error !== undefined) { sets.push("error = ?"); vals.push(patch.error); }
  if (patch.finished) { sets.push("finished_at = ?"); vals.push(now()); }
  if (patch.costUsd !== undefined) { sets.push("cost_usd = ?"); vals.push(patch.costUsd); }
  if (patch.log) { sets.push("log = ?"); vals.push(JSON.stringify(patch.log.slice(-500))); }
  if (!sets.length) return;
  db.prepare(`UPDATE deals_agent_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function getRun(id: string): RunSummary | null {
  const r = db.prepare(`SELECT * FROM deals_agent_runs WHERE id = ?`).get(id);
  return r ? toRun(r) : null;
}

export function getRunExtra(id: string): { costUsd: number | null; log: string[] } {
  const r = db.prepare(`SELECT cost_usd, log FROM deals_agent_runs WHERE id = ?`).get(id) as any;
  return { costUsd: r?.cost_usd ?? null, log: j(r?.log, []) };
}

export function listRuns(limit = 20): RunSummary[] {
  return (db.prepare(`SELECT * FROM deals_agent_runs ORDER BY started_at DESC LIMIT ?`).all(limit) as any[]).map(toRun);
}

export function lastRun(filter?: { preview?: boolean; trigger?: string }): RunSummary | null {
  const conds = ["status != 'running'", "trigger != 'slack'"]; // a one-thread Slack action never moves the inbox window
  const vals: any[] = [];
  if (filter?.preview !== undefined) { conds.push("preview = ?"); vals.push(filter.preview ? 1 : 0); }
  if (filter?.trigger) { conds.push("trigger = ?"); vals.push(filter.trigger); }
  const r = db.prepare(`SELECT * FROM deals_agent_runs WHERE ${conds.join(" AND ")} ORDER BY started_at DESC LIMIT 1`).get(...vals);
  return r ? toRun(r) : null;
}

/** A run left "running" by a crash/restart is closed as failed on boot of the next run. */
export function closeStaleRuns(): void {
  db.prepare(`UPDATE deals_agent_runs SET status = 'failed', error = COALESCE(error, 'interrupted (server restarted mid-run)'), finished_at = ? WHERE status = 'running' AND trigger != 'slack'`).run(now());
}

/* ── items ────────────────────────────────────────────────────────────────── */

export interface ItemRow {
  runId: string;
  preview: boolean;
  threadId: string;
  messageId: string | null;
  subject: string;
  from: string;
  brand: string | null;
  stage: string;
  edgeCase: string | null;
  goal: string | null;
  decision: Decision;
  reason: string;
  fit: Fit | null;
  draftText: string | null;
  checks: Check[];
  gmailDraftId: string | null;
  slackPermalink: string | null;
  dealId: string | null;
  label: string | null;
  boardStage: string | null;
  applied: string[];
}

export function insertItem(i: ItemRow): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO deals_agent_items (id, run_id, preview, thread_id, message_id, subject, from_addr, brand, stage, edge_case, goal, decision, reason, fit, draft_text, checks, gmail_draft_id, slack_permalink, deal_id, label, board_stage, applied, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, i.runId, i.preview ? 1 : 0, i.threadId, i.messageId, i.subject, i.from, i.brand, i.stage, i.edgeCase, i.goal, i.decision, i.reason,
    i.fit ? JSON.stringify(i.fit) : null, i.draftText, JSON.stringify(i.checks), i.gmailDraftId, i.slackPermalink, i.dealId, i.label, i.boardStage,
    JSON.stringify(i.applied), now(),
  );
  return id;
}

export function gmailUrl(threadId: string): string {
  return gmailThreadUrl(threadId);
}

export function toItem(r: any): AgentItem {
  return {
    id: r.id,
    threadId: r.thread_id,
    gmailUrl: gmailUrl(r.thread_id),
    subject: r.subject ?? "",
    from: r.from_addr ?? "",
    brand: r.brand ?? null,
    stage: r.stage ?? "",
    edgeCase: r.edge_case ?? null,
    decision: r.decision,
    reason: r.reason ?? "",
    fit: j(r.fit, null),
    draftText: r.draft_text ?? null,
    checks: j(r.checks, []),
    gmailDraftId: r.gmail_draft_id ?? null,
    slackPermalink: r.slack_permalink ?? null,
    dealId: r.deal_id ?? null,
    createdAt: r.created_at,
  };
}

export function itemsForRun(runId: string): AgentItem[] {
  return (db.prepare(`SELECT * FROM deals_agent_items WHERE run_id = ? ORDER BY created_at, rowid`).all(runId) as any[]).map(toItem);
}

export function itemRowsForRun(runId: string): any[] {
  return db.prepare(`SELECT * FROM deals_agent_items WHERE run_id = ? ORDER BY created_at, rowid`).all(runId) as any[];
}

/** Live items with a saved Gmail draft that haven't been compared with what Jake sent. */
export function itemsAwaitingLearning(limit = 15): any[] {
  return db.prepare(`SELECT * FROM deals_agent_items WHERE preview = 0 AND gmail_draft_id IS NOT NULL AND learned_at IS NULL ORDER BY created_at LIMIT ?`).all(limit) as any[];
}

export function markLearned(itemId: string, note: string): void {
  db.prepare(`UPDATE deals_agent_items SET learned_at = ? WHERE id = ?`).run(`${now()} ${note}`.slice(0, 200), itemId);
}

/* ── handled ledger (live runs only) ──────────────────────────────────────── */

export function isHandled(threadId: string, messageId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM deals_agent_handled WHERE thread_id = ? AND message_id = ?`).get(threadId, messageId));
}

export function markHandled(threadId: string, messageId: string, runId: string, itemId: string | null, decision: string): void {
  db.prepare(`INSERT OR REPLACE INTO deals_agent_handled (thread_id, message_id, run_id, item_id, decision, handled_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(threadId, messageId, runId, itemId, decision, now());
}

/* ── questions ────────────────────────────────────────────────────────────── */

export interface QuestionRow {
  id: string; runId: string | null; preview: boolean; threadId: string; messageId: string | null; itemId: string | null;
  subject: string; brand: string | null; stage: string | null; kind: "question" | "flag";
  question: string; proposal: string | null; askedAt: string;
  slackChannel: string | null; slackTs: string | null; slackPermalink: string | null;
  answer: string | null; answeredAt: string | null; usedAt: string | null;
}

export function toQ(r: any): QuestionRow {
  return {
    id: r.id, runId: r.run_id, preview: r.preview === 1, threadId: r.thread_id, messageId: r.message_id, itemId: r.item_id,
    subject: r.subject ?? "", brand: r.brand, stage: r.stage, kind: r.kind, question: r.question, proposal: r.proposal, askedAt: r.asked_at,
    slackChannel: r.slack_channel, slackTs: r.slack_ts, slackPermalink: r.slack_permalink,
    answer: r.answer, answeredAt: r.answered_at, usedAt: r.used_at,
  };
}

export function insertQuestion(q: Omit<QuestionRow, "id" | "askedAt" | "answer" | "answeredAt" | "usedAt">): QuestionRow {
  const id = randomUUID();
  db.prepare(`INSERT INTO deals_agent_questions (id, run_id, preview, thread_id, message_id, item_id, subject, brand, stage, kind, question, proposal, asked_at, slack_channel, slack_ts, slack_permalink)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, q.runId, q.preview ? 1 : 0, q.threadId, q.messageId, q.itemId, q.subject, q.brand, q.stage, q.kind, q.question, q.proposal, now(),
    q.slackChannel, q.slackTs, q.slackPermalink,
  );
  return toQ(db.prepare(`SELECT * FROM deals_agent_questions WHERE id = ?`).get(id));
}

export function setQuestionItem(id: string, itemId: string): void {
  db.prepare(`UPDATE deals_agent_questions SET item_id = ? WHERE id = ?`).run(itemId, id);
}

/** Live questions posted to Slack and still waiting for Jake. */
export function openLiveQuestions(): QuestionRow[] {
  return (db.prepare(`SELECT * FROM deals_agent_questions WHERE preview = 0 AND kind = 'question' AND answer IS NULL AND slack_ts IS NOT NULL AND watch_state IS NULL ORDER BY asked_at`).all() as any[]).map(toQ);
}

/** Answered, not yet turned into a draft. */
export function answeredUnused(preview: boolean): QuestionRow[] {
  return (db.prepare(`SELECT * FROM deals_agent_questions WHERE preview = ? AND answer IS NOT NULL AND used_at IS NULL AND watch_owned = 0 ORDER BY answered_at`).all(preview ? 1 : 0) as any[]).map(toQ);
}

export function answerQuestion(id: string, answer: string): void {
  db.prepare(`UPDATE deals_agent_questions SET answer = ?, answered_at = ? WHERE id = ?`).run(answer, now(), id);
}

export function markQuestionUsed(id: string): void {
  db.prepare(`UPDATE deals_agent_questions SET used_at = ? WHERE id = ?`).run(now(), id);
}

/** Every answer Jake gave about this thread (newest last). */
export function answersForThread(threadId: string): QuestionRow[] {
  return (db.prepare(`SELECT * FROM deals_agent_questions WHERE thread_id = ? AND answer IS NOT NULL ORDER BY answered_at`).all(threadId) as any[]).map(toQ);
}

/** A live question about this thread + message is already waiting — don't ask twice. */
export function pendingQuestionFor(threadId: string): QuestionRow | null {
  const r = db.prepare(`SELECT * FROM deals_agent_questions WHERE thread_id = ? AND preview = 0 AND kind = 'question' AND answer IS NULL ORDER BY asked_at DESC LIMIT 1`).get(threadId);
  return r ? toQ(r) : null;
}

/**
 * The Slack watcher holds this thread: an answer is inside its 10-minute wait or being acted on, or the
 * watcher asked Jake again about exactly this email. The scheduled run leaves such a thread alone.
 */
export function watcherHoldsThread(threadId: string, latestMessageId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM deals_agent_questions WHERE thread_id = ? AND preview = 0
       AND (watch_state IN ('waiting', 'acting') OR (watch_state = 'asked' AND watch_hold_msg = ?)) LIMIT 1`,
  ).get(threadId, latestMessageId));
}

/** Gmail draft ids the agent itself saved in this thread (live items), newest first. */
export function agentDraftIdsForThread(threadId: string): string[] {
  return (db.prepare(`SELECT gmail_draft_id FROM deals_agent_items WHERE thread_id = ? AND preview = 0 AND gmail_draft_id IS NOT NULL ORDER BY created_at DESC LIMIT 10`)
    .all(threadId) as Array<{ gmail_draft_id: string }>).map((r) => r.gmail_draft_id);
}

export function listQuestions(status?: "open" | "answered"): QuestionRow[] {
  // Preview questions are only shown for the most recent preview run (they were never posted).
  const lastPreview = db.prepare(`SELECT id FROM deals_agent_runs WHERE preview = 1 ORDER BY started_at DESC LIMIT 1`).get() as { id: string } | undefined;
  const cond = status === "open" ? "answer IS NULL" : status === "answered" ? "answer IS NOT NULL" : "1 = 1";
  return (db.prepare(`SELECT * FROM deals_agent_questions WHERE kind = 'question' AND ${cond} AND (preview = 0 OR run_id = ?) ORDER BY asked_at DESC LIMIT 500`)
    .all(lastPreview?.id ?? "") as any[]).map(toQ);
}

/* ── lessons ──────────────────────────────────────────────────────────────── */

export interface Lesson { id: string; brand: string | null; stage: string | null; lesson: string; source: "edit" | "slack"; createdAt: string }

export function insertLesson(l: { brand: string | null; stage: string | null; lesson: string; source: "edit" | "slack"; ref?: string }): void {
  db.prepare(`INSERT INTO deals_agent_lessons (id, brand, stage, lesson, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), l.brand, l.stage, l.lesson, l.source, l.ref ?? null, now());
}

export function listLessons(limit = 100): Lesson[] {
  return (db.prepare(`SELECT * FROM deals_agent_lessons ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]).map((r) => ({
    id: r.id, brand: r.brand, stage: r.stage, lesson: r.lesson, source: r.source, createdAt: r.created_at,
  }));
}

/** Jake corrects a learned lesson (Lab, Agent page). */
export function updateLessonText(id: string, lesson: string): Lesson | null {
  const text = String(lesson ?? "").trim();
  if (text.length < 8) throw Object.assign(new Error("A lesson needs to be a sentence the agent can follow."), { status: 400 });
  db.prepare(`UPDATE deals_agent_lessons SET lesson = ? WHERE id = ?`).run(text.slice(0, 1200), id);
  const r = db.prepare(`SELECT * FROM deals_agent_lessons WHERE id = ?`).get(id) as any;
  return r ? { id: r.id, brand: r.brand, stage: r.stage, lesson: r.lesson, source: r.source, createdAt: r.created_at } : null;
}

/** Jake removes a wrong lesson. */
export function deleteLesson(id: string): void {
  db.prepare(`DELETE FROM deals_agent_lessons WHERE id = ?`).run(id);
}

/** Lessons for this brand, this stage, and general ones — brand first, newest first. */
export function relevantLessons(brand: string | null, stage: string | null, limit = 12): Lesson[] {
  const all = listLessons(400);
  const b = (brand ?? "").toLowerCase();
  const score = (l: Lesson) => (b && l.brand && l.brand.toLowerCase() === b ? 3 : 0) + (stage && l.stage === stage ? 2 : 0) + (!l.brand && !l.stage ? 1 : 0);
  return all.filter((l) => score(l) > 0).sort((a, c) => score(c) - score(a)).slice(0, limit);
}

/* ── fit cache ────────────────────────────────────────────────────────────── */

export function getFitCache(domain: string, maxAgeDays = 30): any | null {
  const r = db.prepare(`SELECT result, cached_at FROM deals_agent_fit_cache WHERE domain = ?`).get(domain) as any;
  if (!r) return null;
  if (Date.now() - Date.parse(r.cached_at) > maxAgeDays * 86_400_000) return null;
  return j(r.result, null);
}

export function setFitCache(domain: string, result: unknown): void {
  db.prepare(`INSERT OR REPLACE INTO deals_agent_fit_cache (domain, result, cached_at) VALUES (?, ?, ?)`).run(domain, JSON.stringify(result), now());
}
