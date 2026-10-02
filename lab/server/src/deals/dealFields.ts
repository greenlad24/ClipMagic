/**
 * Deal Organizer — the analytics deal fields, filled SILENTLY by AI
 * (Jake, 2026-09-30: "AI fills them silently" — no review list).
 *
 *   agreed_price · slot_month · lost_reason · deal_type  (+ won_at / lost_at estimates)
 *
 * An AI extraction (Claude research tier, purpose `deals-analytics`) reads the
 * deal's email thread from the LOCAL `deals_emails` table (never Gmail) and
 * saves the values straight onto the deal. A value a human typed is never
 * overwritten: `fields_source` holds `{ field: "ai" | "human" }`.
 *
 * Two entry points:
 *   fillDealFields(log)        — a step of the central sync (twice a day): the
 *                                deals queued by the stage trigger (db.ts:
 *                                every stage change / new deal sets fields_dirty),
 *                                capped per run, + the weekly note (≤ once a week).
 *   backfillDealFields(opts)   — one-time pass over every deal never extracted,
 *                                closed/production deals first.
 * Both are logged to `deals_fields_runs` with their real token cost.
 */
import { db } from "../db/index.js";
import { claudeJSONForPurposeWithUsage } from "../ai/claude.js";
import { ANTHROPIC_RATES, tokenCost } from "../ai/pricing.js";
import { callGemini, GEMINI_MODEL } from "./common.js";
import { stripQuoted } from "./agent/util.js";
import {
  analyticsMetrics, metricsSummaryText, loadStageGroups, LOST_REASONS, DEAL_TYPES,
  GROUP_LABELS, type StageGroup,
} from "./metrics.js";
// Card autofill (2026-09-30): the same call also keeps the deal card + to-dos current.
import { CARD_SYSTEM, cardContext, applyCardAutofill, markCardNoThread, markThreadActivityDirty, type CardResult } from "./dealAutofill.js";
import { syncDeadlineDates } from "./deadlineParse.js";
import { relatedThreadsForDeal } from "./dealFiles.js";

export type Log = (msg: string) => void;

export const FIELD_KEYS = ["agreed_price", "slot_month", "lost_reason", "deal_type"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
type Source = "ai" | "human";

export interface DealFields {
  agreed_price: number | null;
  slot_month: string | null;
  lost_reason: string | null;
  deal_type: string | null;
  won_at: string | null;
  lost_at: string | null;
  fields_source: Record<string, Source>;
  fields_extracted_at: string | null;
  fields_evidence: string | null;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseSource(raw: string | null | undefined): Record<string, Source> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}

function rowToFields(r: any): DealFields {
  return {
    agreed_price: typeof r?.agreed_price === "number" ? r.agreed_price : null,
    slot_month: r?.slot_month ?? null,
    lost_reason: r?.lost_reason ?? null,
    deal_type: r?.deal_type ?? null,
    won_at: r?.won_at ?? null,
    lost_at: r?.lost_at ?? null,
    fields_source: parseSource(r?.fields_source),
    fields_extracted_at: r?.fields_extracted_at ?? null,
    fields_evidence: r?.fields_evidence ?? null,
  };
}

const FIELD_COLS = `agreed_price, slot_month, lost_reason, deal_type, won_at, lost_at, fields_source, fields_extracted_at, fields_evidence`;

/** The analytics fields of one deal (for getDeal / updateDeal responses). */
export function readDealFields(id: string): DealFields {
  return rowToFields(db.prepare(`SELECT ${FIELD_COLS} FROM deals_deals WHERE id = ?`).get(id));
}

/** The analytics fields of many deals (getDeals). */
export function readDealFieldsMany(ids: string[]): Map<string, DealFields> {
  const out = new Map<string, DealFields>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`SELECT id, ${FIELD_COLS} FROM deals_deals WHERE id IN (${slice.map(() => "?").join(",")})`).all(...slice) as any[];
    for (const r of rows) out.set(r.id, rowToFields(r));
  }
  return out;
}

/* ── validation (shared by the human path and the AI path) ───────────────── */

function cleanValue(key: FieldKey, v: unknown): { ok: true; value: string | number | null } | { ok: false; why: string } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  switch (key) {
    case "agreed_price": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || n < 0 || n > 200_000) return { ok: false, why: "agreed_price must be a number of USD (0–200,000)" };
      return { ok: true, value: Math.round(n) };
    }
    case "slot_month": {
      const s = String(v).trim().slice(0, 7);
      return MONTH_RE.test(s) ? { ok: true, value: s } : { ok: false, why: "slot_month must be YYYY-MM" };
    }
    case "lost_reason":
      return (LOST_REASONS as readonly string[]).includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, why: `lost_reason must be one of ${LOST_REASONS.join(", ")}` };
    case "deal_type":
      return (DEAL_TYPES as readonly string[]).includes(String(v)) ? { ok: true, value: String(v) } : { ok: false, why: `deal_type must be one of ${DEAL_TYPES.join(", ")}` };
  }
}

/**
 * Save fields a HUMAN typed (updateDeal). Each key present is written and
 * marked "human" — including a clear (null), so the AI never refills a field
 * Jake emptied on purpose. Throws a 400 on an invalid value.
 */
export function applyHumanFields(dealId: string, updates: Partial<Record<FieldKey, unknown>>): void {
  const keys = FIELD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(updates, k) && updates[k] !== undefined);
  if (!keys.length) return;
  const cur = db.prepare(`SELECT fields_source FROM deals_deals WHERE id = ?`).get(dealId) as { fields_source: string | null } | undefined;
  if (!cur) return;
  const source = parseSource(cur.fields_source);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: dealId };
  for (const k of keys) {
    const c = cleanValue(k, updates[k]);
    if (!c.ok) throw Object.assign(new Error(c.why), { status: 400 });
    sets.push(`${k} = @${k}`);
    params[k] = c.value;
    source[k] = "human";
  }
  params.fields_source = JSON.stringify(source);
  db.prepare(`UPDATE deals_deals SET ${sets.join(", ")}, fields_source = @fields_source WHERE id = @id`).run(params);
}

/* ── thread transcript (local deals_emails only) ─────────────────────────── */

const MAX_MSG_CHARS = 2_000;
const MAX_TRANSCRIPT_CHARS = 36_000;

/** Most threads one extraction reads (source / manual links first). */
const MAX_DEAL_THREADS = 8;

/**
 * The deal's threads: dealFiles.ts's resolver (source, manual links, contacts,
 * same-brand domain, signing/payment notices) when it works, else the source
 * thread + threads the client's address wrote in.
 */
function dealThreadIds(deal: any): string[] {
  // ONE matching process (matching.ts) — no brand-blind "every thread the client
  // wrote in" fallback: agency contacts pitch several brands.
  try {
    const rel = relatedThreadsForDeal(deal.id);
    if (rel.length) return rel.slice(0, MAX_DEAL_THREADS).map((r) => r.threadId);
  } catch { /* fall back to the source thread only */ }
  return deal.source_thread_id ? [deal.source_thread_id] : [];
}

/**
 * Threads the "new email arrived" check watches: the resolver's full set (the
 * same threads the extraction reads — ALL of them, not just the first 8) + the
 * fallback set. Only called for deals that could be dirty (markThreadActivityDirty).
 */
function watchedThreads(deal: { id: string; source_thread_id: string | null; client_email: string | null }): string[] {
  const out = new Set<string>(deal.source_thread_id ? [deal.source_thread_id] : []);
  try { for (const r of relatedThreadsForDeal(deal.id)) out.add(r.threadId); } catch { /* resolver failed → source thread only */ }
  return [...out];
}

function transcriptFor(deal: any): { text: string; messages: number; firstAt: string | null; lastAt: string | null } {
  const threads = new Set<string>(dealThreadIds(deal));
  if (!threads.size) return { text: "", messages: 0, firstAt: null, lastAt: null };
  const ids = [...threads];
  const rows = db.prepare(`
    SELECT thread_id, subject, from_name, from_email, date_iso, is_from_me, body_text, snippet
    FROM deals_emails
    WHERE thread_id IN (${ids.map(() => "?").join(",")}) AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%')
    ORDER BY date_iso
  `).all(...ids) as any[];
  if (!rows.length) return { text: "", messages: 0, firstAt: null, lastAt: null };
  const parts = rows.map((r) => {
    const body = stripQuoted(String(r.body_text || r.snippet || "")).replace(/\n{2,}/g, "\n").trim();
    const who = r.is_from_me === 1 ? "JAKE (us)" : `${r.from_name || ""} <${r.from_email || ""}>`.trim();
    return `--- ${String(r.date_iso ?? "").slice(0, 10)} · ${who} · "${String(r.subject ?? "").slice(0, 120)}"\n${body.slice(0, MAX_MSG_CHARS)}${body.length > MAX_MSG_CHARS ? " […]" : ""}`;
  });
  // Keep the first 2 messages and as many of the LATEST as fit.
  let text = parts.join("\n\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const head = parts.slice(0, 2);
    const tail: string[] = [];
    let len = head.join("\n\n").length + 60;
    for (let i = parts.length - 1; i >= 2; i--) {
      if (len + parts[i].length + 2 > MAX_TRANSCRIPT_CHARS) break;
      tail.unshift(parts[i]);
      len += parts[i].length + 2;
    }
    text = [...head, `[… ${parts.length - head.length - tail.length} earlier messages omitted …]`, ...tail].join("\n\n");
  }
  return { text, messages: rows.length, firstAt: rows[0].date_iso ?? null, lastAt: rows[rows.length - 1].date_iso ?? null };
}

/* ── the AI extraction ───────────────────────────────────────────────────── */

const SYSTEM = `You read the email thread of ONE YouTube sponsorship deal for creator Jake Dawson (AI tools channel) and extract structured facts for his sales analytics. Output ONLY a JSON object.

Pricing context (for judging what was agreed — do NOT assume it): Jake quotes $6,500 per dedicated sponsored video today (earlier in 2026 he quoted $5,500, floor $5,000; a long-form integration was ~$2,300). A YouTube Short is $2,500 each.

Fields:
- "deal_type": WHAT WAS BEING DISCUSSED, regardless of the outcome (a sponsorship inquiry that was declined, ghosted, too cheap or countered with affiliate-only is STILL a sponsorship type):
    "dedicated"      — a brand (or an agency on a brand's behalf) discussing paid placement in Jake's long-form YouTube video(s): dedicated video or integration, with or without Shorts added. Default for brand/agency sponsorship inquiries.
    "shorts"         — the discussion is about YouTube Shorts only, no long-form video
    "service_vendor" — someone selling Jake THEIR service: video editor, thumbnails, talent management / representation, an agency recruiting him to its roster, outreach services, UGC footage for their ads, tools for Jake to use
    "other"          — not a sponsorship discussion at all: scam/impersonation, personal, event or in-person appearance, pure equity/investment pitch, spam
- "agreed_price": the TOTAL USD the brand agreed IN WRITING to pay for this deal (both sides agreed; e.g. contract/invoice/“we accept $X”). Include Shorts in the total. Convert other currencies to USD roughly. null if no price was agreed (an offer or a quote alone is NOT agreed).
- "slot_month": "YYYY-MM" — the month the sponsored video (or the first Short) was/is to be PUBLISHED. Use the agreed go-live date; else the agreed delivery/draft deadline's month; else, for a finished deal, the month the brand confirmed it went live. null if the thread gives no basis.
- "won_date": "YYYY-MM-DD" when the deal was secured (contract signed / price accepted in writing / first payment), else null.
- "lost_reason": ONLY if the deal is lost/closed without a sale, one of
    "price_below_4k" (their budget/offer was under $4,000), "budget" (no budget / budget cut / too expensive, no number under $4k), "no_fit" (product or audience not a fit — either side), "ghosted" (they stopped answering), "timing_capacity" (dates or Jake's capacity didn't work), "format_not_sold" (they wanted something Jake doesn't sell: e.g. only a mention, live stream, UGC, reels for their channel), "duplicate" (same deal exists elsewhere / another agency already booked it), "not_a_sponsorship", "other".
  Otherwise null.
- "lost_date": "YYYY-MM-DD" of the decline or of the last message before they went silent; null if not lost.
- "evidence": ONE short sentence (max 160 chars) citing what the thread says (e.g. "Signed at $6,000 on Aug 4; live Sep 12").

Be conservative: null beats a guess.`;

/**
 * JSON.parse, or — when the model added prose after the object (seen live:
 * "{…} Wait, I made a duplicate key. {…}") — the first balanced {...}.
 */
function parseFirstObject(text: string): AiOut | null {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

interface AiOut {
  deal_type?: string | null;
  agreed_price?: number | string | null;
  slot_month?: string | null;
  won_date?: string | null;
  lost_reason?: string | null;
  lost_date?: string | null;
  evidence?: string | null;
  /** The deal card (dealAutofill.ts CARD_SYSTEM). */
  card?: unknown;
}

export interface ExtractUsage { input: number; output: number; cacheRead: number; cacheWrite: number; usd: number; model: string }

function extractionUser(deal: any, group: StageGroup, stageName: string, tr: { text: string; messages: number }, now: string): string {
  return [
    `Deal on Jake's board: "${deal.project_name || deal.client_name || ""}" — contact ${deal.client_name || ""} <${deal.client_email || ""}>.`,
    `Current board stage: "${stageName}" (group: ${GROUP_LABELS[group]}). ${group === "lost" ? "The deal is LOST — give lost_reason and lost_date." : group === "production" || group === "completed" ? "The deal is WON (contract signed) — find agreed_price, slot_month and won_date." : "The deal is still OPEN — lost_reason must be null."}`,
    `Today: ${now.slice(0, 10)}. Thread (${tr.messages} messages, oldest first, quoted history removed):`,
    "",
    tr.text,
  ].join("\n");
}

/** The exact prompt the extraction would send for one deal (debugging / tests). */
export function extractionPrompt(dealId: string): { system: string; user: string } | null {
  const deal = db.prepare(`${DEAL_SELECT} WHERE id = ?`).get(dealId) as any;
  if (!deal) return null;
  const group: StageGroup = loadStageGroups().get(deal.stage ?? "")?.group ?? "new";
  return { system: SYSTEM + CARD_SYSTEM, user: extractionUser(deal, group, deal.stage ?? "", transcriptFor(deal), new Date().toISOString()) + cardContext(deal.id) };
}

async function extractOne(deal: any, group: StageGroup, stageName: string): Promise<{ saved: string[]; usage: ExtractUsage | null; skipped?: string; card?: CardResult }> {
  const tr = transcriptFor(deal);
  const now = new Date().toISOString();
  if (!tr.text) {
    db.prepare(`UPDATE deals_deals SET fields_dirty = 0, fields_extracted_at = ?, fields_evidence = COALESCE(fields_evidence, 'No email thread synced for this deal.') WHERE id = ?`).run(now, deal.id);
    markCardNoThread(deal.id);
    return { saved: [], usage: null, skipped: "no thread" };
  }
  const user = extractionUser(deal, group, stageName, tr, now) + cardContext(deal.id);

  const usage: ExtractUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, model: "" };
  let out: AiOut | null = null;
  // One retry when the answer isn't parseable JSON (both attempts are costed).
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const res = await claudeJSONForPurposeWithUsage({ tier: "research", purpose: "deals-analytics", system: SYSTEM + CARD_SYSTEM, messages: [{ role: "user", content: user }] });
    const u = res.usage;
    const rate = ANTHROPIC_RATES[res.model];
    usage.input += u?.input_tokens ?? 0;
    usage.output += u?.output_tokens ?? 0;
    usage.cacheRead += u?.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u?.cache_creation_input_tokens ?? 0;
    usage.usd += rate ? tokenCost(rate, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_creation_input_tokens ?? 0, u?.cache_read_input_tokens ?? 0) : 0;
    usage.model = res.model;
    out = parseFirstObject(res.json);
  }
  if (!out) throw new Error("AI returned unparseable JSON (twice)");
  const ai: AiOut = out;

  // Re-read inside the write: a human may have typed a value while the AI was thinking.
  const saved: string[] = [];
  db.transaction(() => {
    const cur = db.prepare(`SELECT ${FIELD_COLS}, stage FROM deals_deals WHERE id = ?`).get(deal.id) as any;
    if (!cur) return;
    const source = parseSource(cur.fields_source);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: deal.id };
    const put = (k: FieldKey, v: unknown) => {
      if (source[k] === "human") return;
      const c = cleanValue(k, v);
      if (!c.ok) return;
      if (c.value === null && cur[k] === null) return;
      sets.push(`${k} = @${k}`);
      params[k] = c.value;
      source[k] = "ai";
      saved.push(k);
    };
    put("deal_type", ai.deal_type);
    put("agreed_price", ai.agreed_price);
    put("slot_month", group === "lost" ? null : ai.slot_month);
    put("lost_reason", group === "lost" ? ai.lost_reason : null);
    const day = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(0, 10)}T12:00:00.000Z` : null);
    // won_at / lost_at: only fill a gap (the stage trigger stamps real moves).
    if (!cur.won_at && (group === "production" || group === "completed")) {
      const w = day(ai.won_date) ?? deal.stage_changed_at ?? tr.lastAt;
      if (w) { sets.push("won_at = @won_at"); params.won_at = w; source.won_at = "ai"; saved.push("won_at"); }
    }
    if (!cur.lost_at && group === "lost") {
      const l = day(ai.lost_date) ?? tr.lastAt;
      if (l) { sets.push("lost_at = @lost_at"); params.lost_at = l; source.lost_at = "ai"; saved.push("lost_at"); }
    }
    params.fields_source = JSON.stringify(source);
    params.at = now;
    params.evidence = typeof ai.evidence === "string" ? ai.evidence.slice(0, 240) : null;
    db.prepare(`UPDATE deals_deals SET ${[...sets, "fields_source = @fields_source", "fields_dirty = 0", "fields_extracted_at = @at", "fields_evidence = @evidence"].join(", ")} WHERE id = @id`).run(params);
  })();
  // The card (deadline, next steps, key details, contacts, value, to-dos) — same answer.
  const card = applyCardAutofill(deal.id, ai.card, { asof: tr.lastAt, lost: group === "lost" });
  saved.push(...card.saved.map((k) => `card.${k}`));
  const t = card.todos;
  if (t.added.length) saved.push(`+todo ${t.added.map((x) => `"${x}"`).join(" ")}`);
  if (t.done.length) saved.push(`done ${t.done.length}`);
  if (t.removed.length) saved.push(`-todo ${t.removed.length}`);
  return { saved, usage, card };
}

/* ── runs ────────────────────────────────────────────────────────────────── */

let running = false;

interface RunResult { kind: string; deals: number; filled: number; failed: number; skipped: number; inputTokens: number; outputTokens: number; costUsd: number; ms: number; errors: string[] }

async function runExtraction(kind: string, dealRows: any[], log: Log, concurrency: number): Promise<RunResult> {
  const t0 = Date.now();
  const stages = loadStageGroups();
  const runId = Number(db.prepare(`INSERT INTO deals_fields_runs (kind, started_at, deals) VALUES (?, ?, ?)`).run(kind, new Date().toISOString(), dealRows.length).lastInsertRowid);
  const r: RunResult = { kind, deals: dealRows.length, filled: 0, failed: 0, skipped: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, errors: [] };
  let next = 0;
  const worker = async () => {
    while (next < dealRows.length) {
      const deal = dealRows[next++];
      const info = stages.get(deal.stage ?? "");
      const group: StageGroup = info?.group ?? "new";
      try {
        const res = await extractOne(deal, group, deal.stage ?? "");
        if (res.skipped) r.skipped++;
        else r.filled++;
        if (res.usage) {
          r.inputTokens += res.usage.input + res.usage.cacheRead + res.usage.cacheWrite;
          r.outputTokens += res.usage.output;
          r.costUsd += res.usage.usd;
        }
        log(`deal fields: ${deal.project_name || deal.client_name || deal.id} [${deal.stage}] → ${res.skipped ?? (res.saved.join(", ") || "nothing new")}`);
      } catch (e: any) {
        r.failed++;
        const msg = `${deal.project_name || deal.client_name || deal.id}: ${e?.message ?? e}`;
        r.errors.push(msg);
        log(`deal fields FAILED — ${msg}`);
        // leave fields_dirty as it was → retried next run
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  r.ms = Date.now() - t0;
  r.costUsd = Math.round(r.costUsd * 10_000) / 10_000;
  db.prepare(`UPDATE deals_fields_runs SET finished_at = ?, filled = ?, failed = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, note = ? WHERE id = ?`)
    .run(new Date().toISOString(), r.filled, r.failed, r.inputTokens, r.outputTokens, r.costUsd, r.errors.slice(0, 5).join(" | ") || null, runId);
  log(`deal fields (${kind}): ${r.filled} filled, ${r.skipped} without a thread, ${r.failed} failed — ${r.inputTokens} in / ${r.outputTokens} out tokens, $${r.costUsd.toFixed(4)}, ${Math.round(r.ms / 1000)}s`);
  return r;
}

const DEAL_SELECT = `SELECT id, client_name, client_email, project_name, stage, source_thread_id, stage_changed_at FROM deals_deals`;
const LIVE = `(archived IS NULL OR archived = 0) AND merged_into IS NULL`;

/** Per sync run: at most this many queued deals (the rest wait for the next run). */
const PER_SYNC_CAP = 40;

/**
 * The central-sync step (scheduledSync calls it after the scan). Fills the
 * deals the stage trigger queued, then writes the weekly note if a week has
 * passed. Never throws — a failure is logged and retried next run.
 */
export async function fillDealFields(log: Log = () => {}): Promise<{ extraction: RunResult | null; weeklyNote: string | null }> {
  if (running) { log("deal fields: a run is already in progress — skipped"); return { extraction: null, weeklyNote: null }; }
  running = true;
  try {
    // New emails on a deal's thread(s) since its last extraction → queue it (the card follows the thread).
    try { const n = await markThreadActivityDirty(watchedThreads); if (n) log(`deal fields: ${n} deal(s) queued — new email on their thread(s)`); }
    catch (e: any) { log(`deal fields: thread-activity check failed — ${e?.message ?? e}`); }
    // Deadline texts written since the last run (scanner, chat agent, legacy) → deadline_date.
    try {
      const d = await syncDeadlineDates({ aiCap: 20, log });
      if (d.parsed) log(`deadlines: ${d.parsed} parsed, ${d.dated} dated, ${d.aiAsked} asked the AI, ${d.failures.length} without a date`);
    } catch (e: any) { log(`deadlines: parse failed — ${e?.message ?? e}`); }
    const queued = db.prepare(`${DEAL_SELECT} WHERE ${LIVE} AND fields_dirty = 1 ORDER BY updated_at DESC LIMIT ?`).all(PER_SYNC_CAP) as any[];
    let extraction: RunResult | null = null;
    if (queued.length) {
      try { extraction = await runExtraction("sync", queued, log, 3); }
      catch (e: any) { log(`deal fields: run failed — ${e?.message ?? e}`); }
    } else log("deal fields: nothing queued");
    let weeklyNote: string | null = null;
    try { weeklyNote = await maybeWeeklyNote(log); }
    catch (e: any) { log(`weekly note failed — ${e?.message ?? e}`); }
    return { extraction, weeklyNote };
  } finally {
    running = false;
  }
}

/**
 * One-time backfill over every live deal never extracted: won (production /
 * published) deals first, then lost, then open by recent activity.
 * `limit` caps how many deals this call handles (default: all).
 */
export async function backfillDealFields(opts: { limit?: number; concurrency?: number; log?: Log; includeExtracted?: boolean; cards?: boolean; ids?: string[] } = {}): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  if (running) throw Object.assign(new Error("A deal-fields run is already in progress"), { status: 409 });
  running = true;
  try {
    const stages = loadStageGroups();
    // cards: every live deal whose card was never auto-filled (the one-time card refresh);
    // ids: exactly these deals (validation / a hand re-run).
    const where = opts.ids?.length ? ` AND id IN (${opts.ids.map(() => "?").join(",")})`
      : opts.cards ? " AND card_filled_at IS NULL"
      : opts.includeExtracted ? "" : " AND fields_extracted_at IS NULL";
    const all = db.prepare(`${DEAL_SELECT} WHERE ${LIVE}${where} ORDER BY updated_at DESC`).all(...(opts.ids ?? [])) as any[];
    const rank = (d: any) => {
      const g = stages.get(d.stage ?? "")?.group ?? "new";
      return g === "completed" || g === "production" ? 0 : g === "lost" ? 1 : g === "contract" || g === "negotiating" ? 2 : 3;
    };
    const ordered = all.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
    const batch = ordered.slice(0, opts.limit ?? ordered.length);
    log(`deal fields backfill: ${batch.length} of ${ordered.length} deals`);
    return await runExtraction(opts.cards ? "cards" : opts.ids?.length ? "manual" : "backfill", batch, log, opts.concurrency ?? 4);
  } finally {
    running = false;
  }
}

export function dealFieldsStatus() {
  const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    running,
    live: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE}`),
    extracted: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE} AND fields_extracted_at IS NOT NULL`),
    queued: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE} AND fields_dirty = 1`),
    cardsFilled: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE} AND card_filled_at IS NOT NULL`),
    deadlinesDated: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE} AND deadline_date IS NOT NULL`),
    deadlinesText: q(`SELECT COUNT(*) AS n FROM deals_deals WHERE ${LIVE} AND trim(COALESCE(deadline, '')) <> ''`),
    runs: db.prepare(`SELECT * FROM deals_fields_runs ORDER BY id DESC LIMIT 10`).all(),
    totalCostUsd: (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS n FROM deals_fields_runs`).get() as { n: number }).n,
  };
}

/* ── weekly note (Gemini Flash, stored, ≤ once a week, never on page load) ─ */

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const wk = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
}

export async function maybeWeeklyNote(log: Log = () => {}, force = false): Promise<string | null> {
  const last = db.prepare(`SELECT created_at FROM deals_analytics_notes ORDER BY created_at DESC LIMIT 1`).get() as { created_at: string } | undefined;
  if (!force && last && Date.now() - Date.parse(last.created_at) < 7 * 86_400_000) return null;
  const week = isoWeek(new Date());
  const m = analyticsMetrics();
  const prompt = `You write a 3-bullet weekly note for Jake Dawson, a YouTuber who sells sponsored videos (goal ≈ $20,000/month from ~3 dedicated videos). Using ONLY the numbers below, say what matters this week: where he stands vs the goal, the biggest risk (e.g. replies owed, empty slots next month), and one concrete next action. Plain English, each bullet under 30 words, start each line with "• ". No preamble. If data coverage is thin, say so in the relevant bullet.

${metricsSummaryText(m)}`;
  const note = (await callGemini(prompt, { maxTokens: 400, temperature: 0.3 })).trim();
  if (!note) return null;
  db.prepare(`INSERT INTO deals_analytics_notes (week, note, model, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(week) DO UPDATE SET note = excluded.note, model = excluded.model, created_at = excluded.created_at`)
    .run(week, note, GEMINI_MODEL, new Date().toISOString());
  log(`weekly note written (${week})`);
  return note;
}
