/**
 * Typed helpers over the Bulk Scheduler's caption cache and preview-run records
 * (bulk_captions, bulk_preview_runs — defined in db/index.ts).
 *
 * Two problems, one module:
 *
 *  1. CAPTION REUSE. A caption depends on the VIDEO, not on when it is posted,
 *     so regenerating it on every preview burned an AI call and a transcription
 *     per file per run. Cached here, a file that already has captions and tags
 *     costs nothing on the next plan and goes straight through to scheduling.
 *
 *  2. SURVIVING A DROPPED CONNECTION. A preview used to exist only inside its
 *     HTTP request; a 31-minute build died with the socket and took every AI
 *     call with it. The run row is the durable copy.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";
import { CAPTION_VOICE_VERSION } from "../postiz/captionVoice.js";

const now = () => Date.now();

export interface CachedCaption {
  platform: string;
  caption: string;
  hashtags: string[];
  firstLineHook: string;
  transcript: string | null;
}

/** Every cached platform caption for one file, keyed by platform. */
export function getCaptions(fileId: string): Map<string, CachedCaption> {
  const rows = db.prepare("SELECT * FROM bulk_captions WHERE file_id = ?").all(fileId) as any[];
  const out = new Map<string, CachedCaption>();
  for (const r of rows) {
    let hashtags: string[] = [];
    try {
      const parsed = JSON.parse(r.hashtags_json);
      if (Array.isArray(parsed)) hashtags = parsed.map((h: unknown) => String(h));
    } catch {
      /* a corrupt row degrades to "no tags", never breaks the plan */
    }
    out.set(r.platform, {
      platform: r.platform,
      caption: r.caption ?? "",
      hashtags,
      firstLineHook: r.first_line_hook ?? "",
      transcript: r.transcript ?? null,
    });
  }
  return out;
}

export function putCaption(
  fileId: string,
  cap: { platform: string; caption: string; hashtags: string[]; firstLineHook: string },
  transcript: string | null,
): void {
  const t = now();
  db.prepare(
    `INSERT INTO bulk_captions (file_id, platform, caption, hashtags_json, first_line_hook, transcript, voice_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id, platform) DO UPDATE SET
       caption = excluded.caption,
       hashtags_json = excluded.hashtags_json,
       first_line_hook = excluded.first_line_hook,
       transcript = excluded.transcript,
       voice_version = excluded.voice_version,
       updated_at = excluded.updated_at`,
  ).run(
    fileId,
    cap.platform,
    cap.caption,
    JSON.stringify(cap.hashtags ?? []),
    cap.firstLineHook ?? "",
    transcript,
    CAPTION_VOICE_VERSION,
    t,
    t,
  );
}

/** Drop a file's cached captions so the next plan rewrites them. */
export function clearCaptions(fileIds: string[]): number {
  if (!fileIds.length) return 0;
  const stmt = db.prepare("DELETE FROM bulk_captions WHERE file_id = ?");
  let n = 0;
  db.transaction(() => {
    for (const id of fileIds) n += stmt.run(id).changes;
  })();
  return n;
}

// ── preview runs ─────────────────────────────────────────────────────────────

export type PreviewRunStatus = "running" | "done" | "failed" | "cancelled";

export interface PreviewRun {
  id: string;
  status: PreviewRunStatus;
  stage: string;
  doneCount: number;
  totalCount: number;
  cachedCount: number;
  input: unknown;
  result: unknown | null;
  error: string;
  createdAt: number;
  updatedAt: number;
}

function rowToRun(r: any): PreviewRun {
  const parse = (raw: string | null) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  return {
    id: r.id,
    status: r.status,
    stage: r.stage ?? "",
    doneCount: r.done_count ?? 0,
    totalCount: r.total_count ?? 0,
    cachedCount: r.cached_count ?? 0,
    input: parse(r.input_json),
    result: parse(r.result_json),
    error: r.error ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createRun(input: unknown, totalCount: number): PreviewRun {
  const id = nanoid(12);
  const t = now();
  db.prepare(
    `INSERT INTO bulk_preview_runs (id, status, stage, total_count, input_json, created_at, updated_at)
     VALUES (?, 'running', 'starting', ?, ?, ?, ?)`,
  ).run(id, totalCount, JSON.stringify(input ?? null), t, t);
  return getRun(id)!;
}

export function getRun(id: string): PreviewRun | null {
  const r = db.prepare("SELECT * FROM bulk_preview_runs WHERE id = ?").get(id);
  return r ? rowToRun(r) : null;
}

/** The newest run, so a reloaded page can reconnect without knowing its id. */
export function latestRun(): PreviewRun | null {
  const r = db.prepare("SELECT * FROM bulk_preview_runs ORDER BY created_at DESC LIMIT 1").get();
  return r ? rowToRun(r) : null;
}

export function updateRun(
  id: string,
  fields: Partial<{
    status: PreviewRunStatus;
    stage: string;
    doneCount: number;
    totalCount: number;
    cachedCount: number;
    result: unknown;
    error: string;
  }>,
): PreviewRun | null {
  const cur = getRun(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE bulk_preview_runs
        SET status = ?, stage = ?, done_count = ?, total_count = ?, cached_count = ?,
            result_json = ?, error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    fields.status ?? cur.status,
    fields.stage ?? cur.stage,
    fields.doneCount ?? cur.doneCount,
    fields.totalCount ?? cur.totalCount,
    fields.cachedCount ?? cur.cachedCount,
    fields.result === undefined
      ? cur.result
        ? JSON.stringify(cur.result)
        : null
      : JSON.stringify(fields.result),
    fields.error ?? cur.error,
    now(),
    id,
  );
  return getRun(id);
}

/**
 * A run marked `running` with no live worker behind it — the process restarted
 * mid-build. Called at boot so the page never waits on a ghost.
 */
export function failInterruptedRuns(): number {
  return db
    .prepare(
      `UPDATE bulk_preview_runs
          SET status = 'failed', error = 'The server restarted while this plan was building.', updated_at = ?
        WHERE status = 'running'`,
    )
    .run(now()).changes;
}

/**
 * Write captions INTO the saved plan.
 *
 * A rewrite used to update only the browser's copy: the run row kept the
 * original captions, so a reload restored the old ones and asked to fix them
 * again — work already paid for (2026-08-24). The plan is the durable artefact,
 * so anything written for it has to land here too.
 *
 * Returns how many posts were changed.
 */

/**
 * Copy stored transcripts onto the plan's per-file records.
 *
 * The plan carries `files[].transcript` purely so the review step can show what
 * each caption was written from. Re-captioning a video updates its POSTS but
 * left this field at its original null, so a repaired video still displayed
 * "no speech detected — used your brief" while its caption was in fact grounded
 * in the audio. Same repair, same place: whenever captions are written back,
 * the transcripts go with them.
 */
function syncFileTranscripts(result: { files?: any[] } | null): number {
  if (!result?.files?.length) return 0;
  let changed = 0;
  for (const file of result.files) {
    if (file.transcript && String(file.transcript).trim()) continue;
    const cached = getCaptions(file.fileId);
    const tr = Array.from(cached.values())
      .map((c) => c.transcript)
      .find((t) => t && t.trim());
    if (!tr) continue;
    file.transcript = tr;
    changed++;
  }
  return changed;
}

export function patchRunCaptions(
  runId: string,
  captions: Record<string, Record<string, { caption: string; hashtags: string[]; firstLineHook: string }>>,
): number {
  const run = getRun(runId);
  const result = run?.result as { posts?: any[]; files?: any[] } | null;
  if (!result?.posts?.length) return 0;
  let changed = 0;
  for (const post of result.posts) {
    const c = captions[post.fileId]?.[post.platform];
    if (!c || !c.caption?.trim()) continue;
    post.caption = c.caption;
    post.hashtags = c.hashtags ?? [];
    post.firstLineHook = c.firstLineHook ?? "";
    changed++;
  }
  const trChanged = syncFileTranscripts(result);
  if (changed || trChanged) updateRun(runId, { result });
  return changed;
}

/**
 * Refresh a plan's captions from the caption cache — the repair for a plan whose
 * captions were rewritten before the write-back existed. Costs nothing: it only
 * copies captions already paid for and stored.
 */
export function refreshRunCaptionsFromCache(runId: string): number {
  const run = getRun(runId);
  const result = run?.result as { posts?: any[]; files?: any[] } | null;
  if (!result?.posts?.length) return 0;
  const byFile = new Map<string, Map<string, CachedCaption>>();
  let changed = 0;
  for (const post of result.posts) {
    let caps = byFile.get(post.fileId);
    if (!caps) {
      caps = getCaptions(post.fileId);
      byFile.set(post.fileId, caps);
    }
    const c = caps.get(post.platform);
    if (!c || !c.caption.trim() || c.caption === post.caption) continue;
    post.caption = c.caption;
    post.hashtags = c.hashtags;
    post.firstLineHook = c.firstLineHook;
    changed++;
  }
  const trChanged = syncFileTranscripts(result);
  if (changed || trChanged) updateRun(runId, { result });
  return changed + trChanged;
}

/**
 * Files whose captions were written WITHOUT the video's transcript.
 *
 * Transcription used to run unbounded (227 at once), and the ones that lost the
 * race to a 90s timeout were captioned from the brief alone — grounded in
 * nothing the video actually says, which is exactly what a low caption score
 * measures. Those files are worth re-captioning now that transcription is
 * bounded and works; nothing else about them is wrong, so the guideline checks
 * pass and would never flag them.
 */
/**
 * Files whose captions predate the CURRENT voice — written before bar-Jake
 * existed, or by an older version of it.
 *
 * These are the counterpart to fileIdsMissingTranscript: nothing is wrong with
 * them by the guideline checks, so nothing else would ever flag them, and the
 * tell-strip makes them LOOK current. Only the stamp knows. A file counts as
 * stale if ANY of its platform rows is behind, since they are rewritten together.
 */
export function fileIdsStaleVoice(): string[] {
  const rows = db
    .prepare(
      `SELECT file_id FROM bulk_captions
        WHERE length(trim(caption)) > 0
        GROUP BY file_id
       HAVING MIN(COALESCE(voice_version, 0)) < ?`,
    )
    .all(CAPTION_VOICE_VERSION) as Array<{ file_id: string }>;
  return rows.map((r) => r.file_id);
}

export function fileIdsMissingTranscript(): string[] {
  const rows = db
    .prepare(
      `SELECT file_id FROM bulk_captions
        GROUP BY file_id
       HAVING MAX(CASE WHEN transcript IS NOT NULL AND trim(transcript) <> '' THEN 1 ELSE 0 END) = 0`,
    )
    .all() as Array<{ file_id: string }>;
  return rows.map((r) => r.file_id);
}
