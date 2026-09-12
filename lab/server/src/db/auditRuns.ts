/**
 * Typed CRUD over the `audit_runs` table (defined in db/index.ts).
 *
 * Mirrors db/planRuns.ts: prepared statements, JSON columns hydrated back into
 * the AuditRunResult contract, defensive defaults so callers never meet an
 * undefined field. Writes are partial — a run is updated stage by stage, and a
 * failure late on must not erase what earlier stages already computed.
 */
import { db } from "./index.js";
import type {
  AuditChannel,
  AuditCallUsage,
  AuditGap,
  AuditGuestChannel,
  AuditStage,
  AuditFindings,
  AuditInput,
  AuditReportSection,
  AuditRunListItem,
  AuditRunResult,
  AuditStatus,
  AuditVideo,
  MarketProposal,
  AuditChatMessage,
  AuditFocus,
} from "../audit/types.js";

const now = () => Date.now();

interface AuditRunRow {
  id: string;
  title: string;
  status: string;
  input_json: string;
  subject_json: string | null;
  proposal_json: string | null;
  approved_json: string | null;
  competitors_json: string | null;
  videos_json: string | null;
  market_json: string | null;
  findings_json: string | null;
  chat_json: string | null;
  focus_json: string | null;
  base_findings_json: string | null;
  gaps_json: string | null;
  guests_json: string | null;
  failed_stage: string | null;
  sections_json: string | null;
  calls_json: string | null;
  cost_usd: number;
  quota_units: number;
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

function hydrate(row: AuditRunRow): AuditRunResult {
  return {
    runId: row.id,
    status: row.status as AuditStatus,
    title: row.title,
    input: parse<AuditInput>(row.input_json, { channel: "", mode: "own" }),
    subject: parse<AuditChannel | null>(row.subject_json, null),
    proposal: parse<MarketProposal | null>(row.proposal_json, null),
    approved: parse<MarketProposal | null>(row.approved_json, null),
    competitors: parse<AuditChannel[]>(row.competitors_json, []),
    videos: parse<AuditVideo[]>(row.videos_json, []),
    marketVideos: parse<AuditVideo[]>(row.market_json, []),
    findings: parse<AuditFindings | null>(row.findings_json, null),
    gaps: parse<AuditGap[]>(row.gaps_json, []),
    guests: parse<AuditGuestChannel[]>(row.guests_json, []),
    failedStage: (row.failed_stage as AuditStage | null) || null,
    focus: parse<AuditFocus | null>(row.focus_json, null),
    baseFindings: parse<AuditFindings | null>(row.base_findings_json, null),
    chat: parse<AuditChatMessage[]>(row.chat_json, []),
    sections: parse<AuditReportSection[]>(row.sections_json, []),
    calls: parse<AuditCallUsage[]>(row.calls_json, []),
    costUsd: row.cost_usd ?? 0,
    quotaUnits: row.quota_units ?? 0,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Mark audits that were mid-flight when the process stopped as failed.
 *
 * An audit's progress lives in memory (audit/run.ts keeps a `live` map), so a
 * restart leaves the row in a working status with nothing working on it: the
 * page spins for ever and no button can rescue it, because every recovery path
 * starts from "failed". This makes the restart legible — and a failed run is
 * exactly the state that can be carried on with one press of Skip, reusing the
 * thumbnails and titles it had already paid for.
 *
 * Returns how many were marked.
 */
export function failInterruptedRuns(): number {
  return db
    .prepare(
      `UPDATE audit_runs
          SET status = 'failed',
              error = 'The server restarted while this audit was running. Everything it had already gathered is kept — carry on from here to finish the report.',
              updated_at = ?
        WHERE status IN ('ingesting', 'proposing', 'scanning', 'analysing', 'renaming')`,
    )
    .run(now()).changes;
}

export function createRun(id: string, input: AuditInput): void {
  const t = now();
  db.prepare(
    `INSERT INTO audit_runs (id, title, status, input_json, created_at, updated_at)
     VALUES (?, ?, 'ingesting', ?, ?, ?)`,
  ).run(id, input.title || "", JSON.stringify(input), t, t);
}

export interface AuditRunPatch {
  status?: AuditStatus;
  title?: string;
  subject?: AuditChannel | null;
  proposal?: MarketProposal | null;
  approved?: MarketProposal | null;
  competitors?: AuditChannel[];
  videos?: AuditVideo[];
  marketVideos?: AuditVideo[];
  findings?: AuditFindings | null;
  gaps?: AuditGap[];
  guests?: AuditGuestChannel[];
  failedStage?: AuditStage | null;
  focus?: AuditFocus | null;
  baseFindings?: AuditFindings | null;
  chat?: AuditChatMessage[];
  sections?: AuditReportSection[];
  calls?: AuditCallUsage[];
  costUsd?: number;
  quotaUnits?: number;
  error?: string | null;
}

export function updateRun(id: string, patch: AuditRunPatch): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  const json = (col: string, v: unknown) => put(col, v === null ? null : JSON.stringify(v));

  if (patch.status !== undefined) put("status", patch.status);
  if (patch.title !== undefined) put("title", patch.title);
  if (patch.subject !== undefined) json("subject_json", patch.subject);
  if (patch.proposal !== undefined) json("proposal_json", patch.proposal);
  if (patch.approved !== undefined) json("approved_json", patch.approved);
  if (patch.competitors !== undefined) json("competitors_json", patch.competitors);
  if (patch.videos !== undefined) json("videos_json", patch.videos);
  if (patch.marketVideos !== undefined) json("market_json", patch.marketVideos);
  if (patch.findings !== undefined) json("findings_json", patch.findings);
  if (patch.gaps !== undefined) json("gaps_json", patch.gaps);
  if (patch.guests !== undefined) json("guests_json", patch.guests);
  if (patch.failedStage !== undefined) put("failed_stage", patch.failedStage);
  if (patch.focus !== undefined) json("focus_json", patch.focus);
  if (patch.baseFindings !== undefined) json("base_findings_json", patch.baseFindings);
  if (patch.chat !== undefined) json("chat_json", patch.chat);
  if (patch.sections !== undefined) json("sections_json", patch.sections);
  if (patch.calls !== undefined) json("calls_json", patch.calls);
  if (patch.costUsd !== undefined) put("cost_usd", patch.costUsd);
  if (patch.quotaUnits !== undefined) put("quota_units", patch.quotaUnits);
  if (patch.error !== undefined) put("error", patch.error);
  if (!sets.length) return;

  put("updated_at", now());
  db.prepare(`UPDATE audit_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function getRun(id: string): AuditRunResult | null {
  const row = db.prepare(`SELECT * FROM audit_runs WHERE id = ?`).get(id) as AuditRunRow | undefined;
  return row ? hydrate(row) : null;
}

export function listRuns(limit = 50): AuditRunListItem[] {
  const rows = db
    .prepare(
      `SELECT id, title, status, subject_json, videos_json, created_at, updated_at
         FROM audit_runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Pick<AuditRunRow, "id" | "title" | "status" | "subject_json" | "videos_json" | "created_at" | "updated_at">>;

  return rows.map((r) => {
    const subject = parse<AuditChannel | null>(r.subject_json, null);
    // Counting through a parse of the whole array is wasteful but honest, and
    // the history sidebar shows at most 50 rows.
    const videos = parse<AuditVideo[]>(r.videos_json, []);
    return {
      runId: r.id,
      title: r.title || subject?.title || "Untitled audit",
      status: r.status as AuditStatus,
      channelTitle: subject?.title ?? null,
      videoCount: videos.length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function deleteRun(id: string): boolean {
  return db.prepare(`DELETE FROM audit_runs WHERE id = ?`).run(id).changes > 0;
}
