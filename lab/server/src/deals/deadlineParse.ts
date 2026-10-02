/**
 * Deal Organizer — free-text deadlines, parsed to a real date (2026-09-30).
 *
 * Jake types (or the email scan / autofill writes) a deadline as FREE TEXT —
 * "mid Jul", "late June or early July", "Oct 15 go-live". The text is what the
 * card shows. For sorting, grouping and countdowns we keep a parsed date next to it:
 *
 *   deals_deals.deadline_date         YYYY-MM-DD, nullable
 *   deals_deals.deadline_parsed_from  the exact `deadline` text that date came from
 *                                     (text ≠ parsed_from ⇒ needs a (re)parse)
 *
 * Parsing = deterministic first (`parseDeadlineText`, a port + extension of the
 * frontend's lib/deadline.ts), then — only when the text is ambiguous — one cheap
 * Claude call (fast tier, purpose `deals-extract`) anchored to today in
 * Asia/Bangkok and the deal's latest emails. The AI never blocks a save: the
 * deterministic guess is written at once and the AI refines it in the background.
 *
 * Reading of the words (a deadline is a "by" date):
 *   "June 2026" → last day of June · "early June" / "start of June" → Jun 10 ·
 *   "mid June" → Jun 15 · "late / end of June" → Jun 30 · "first|second|third week
 *   of June" → Jun 7|14|21 · "Q3" → Sep 30 · "… onward" / "from …" / "starting …" →
 *   the START of that window (1st, or 15th for "mid") · ranges and "or" → the first.
 * No year given → the reference year (today for a typed deadline, the deal's latest
 * email for one found in the data), rolled into next year when that date would lie
 * more than 60 days before the reference.
 */
import { db } from "../db/index.js";
import { claudeJSONForPurpose } from "../ai/claude.js";

/* Additive migration: the two columns (nullable; NULL on every existing row until parsed). */
for (const col of ["deadline_date", "deadline_parsed_from"]) {
  const has = (db.prepare(`PRAGMA table_info(deals_deals)`).all() as { name: string }[]).some((c) => c.name === col);
  if (!has) db.exec(`ALTER TABLE deals_deals ADD COLUMN ${col} TEXT`);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NO_DATE_RE = /^\s*(tbd|tba|tbc|asap|n\/?a|none|no deadline|flexible|unknown|-+)\s*$/i;

export interface ParsedDeadline {
  /** YYYY-MM-DD or null. */
  date: string | null;
  /** false → worth asking the AI (unparseable, or a genuinely ambiguous reading). */
  confident: boolean;
  why: string;
}

/* ── date helpers (pure UTC calendar arithmetic, no timezone drift) ───────── */

function dim(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}
function ymd(y: number, m0: number, d: number): string {
  const day = Math.min(Math.max(1, d), dim(y, m0));
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function toUtc(s: string): number {
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
}
function addDays(s: string, n: number): string {
  const d = new Date(toUtc(s) + n * 86_400_000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Today's calendar date in Asia/Bangkok (UTC+7, no DST) — Jake's day. */
export function todayBangkok(now = Date.now()): string {
  return new Date(now + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= dim(y, m - 1);
}

/* ── the deterministic parser ────────────────────────────────────────────── */

/**
 * @param text  the deadline as written
 * @param ref   YYYY-MM-DD the text is relative to (default: today in Bangkok)
 */
export function parseDeadlineText(text: string | null | undefined, ref: string = todayBangkok()): ParsedDeadline {
  const raw = (text ?? "").trim();
  if (!raw) return { date: null, confident: true, why: "empty" };
  if (NO_DATE_RE.test(raw)) return { date: null, confident: true, why: "no date in the text" };
  const refY = +ref.slice(0, 4);

  // 1. ISO date / date-time (imports, a pasted date): the calendar date as written.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso && isYmd(`${iso[1]}-${iso[2]}-${iso[3]}`)) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, confident: true, why: "ISO date" };

  const lower = raw.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/\s+/g, " ");
  const explicitYear = lower.match(/\b(20\d{2})\b/);
  /** Place a month/day in the right year. */
  const inYear = (m0: number, day: (y: number) => number): string => {
    if (explicitYear) { const y = +explicitYear[1]; return ymd(y, m0, day(y)); }
    let s = ymd(refY, m0, day(refY));
    if (toUtc(s) < toUtc(ref) - 60 * 86_400_000) s = ymd(refY + 1, m0, day(refY + 1));
    return s;
  };

  // 2. Relative words (typed deadlines: "tomorrow", "next Friday", "in 2 weeks", "EOM").
  if (/\btoday\b|\beod\b/.test(lower)) return { date: ref, confident: true, why: "today" };
  if (/\btomorrow\b/.test(lower)) return { date: addDays(ref, 1), confident: true, why: "tomorrow" };
  const inN = lower.match(/\bin (\d{1,3}) (day|week|month)s?\b/);
  if (inN) {
    const n = +inN[1];
    if (inN[2] === "day") return { date: addDays(ref, n), confident: true, why: `in ${n} days` };
    if (inN[2] === "week") return { date: addDays(ref, 7 * n), confident: true, why: `in ${n} weeks` };
    const y = refY, m0 = +ref.slice(5, 7) - 1 + n;
    return { date: ymd(y + Math.floor(m0 / 12), m0 % 12, +ref.slice(8, 10)), confident: true, why: `in ${n} months` };
  }
  if (/\b(end of (this |the )?month|eom)\b/.test(lower) && !MONTH_RE.test(lower)) {
    return { date: ymd(refY, +ref.slice(5, 7) - 1, 31), confident: true, why: "end of this month" };
  }
  if (/\bend of next month\b/.test(lower)) {
    const m0 = +ref.slice(5, 7); // next month, 0-based
    return { date: ymd(refY + Math.floor(m0 / 12), m0 % 12, 31), confident: true, why: "end of next month" };
  }
  if (/\bnext week\b/.test(lower) && !MONTH_RE.test(lower)) return { date: addDays(ref, 7), confident: false, why: "next week (approx.)" };
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w.slice(0, 3)}(${w.slice(3)})?\\b`).test(lower));
  if (wd >= 0 && !MONTH_RE.test(lower) && !/\d/.test(lower)) {
    const cur = new Date(toUtc(ref)).getUTCDay();
    let delta = (wd - cur + 7) % 7;
    if (delta === 0) delta = 7;
    if (/\bnext\b/.test(lower) && delta < 7) delta += 7;
    return { date: addDays(ref, delta), confident: !/\bnext\b/.test(lower), why: `weekday ${WEEKDAYS[wd]}` };
  }

  // 3. Quarters: "Q3", "Q4 2026", "end of Q2".
  const q = lower.match(/\bq([1-4])\b/);
  if (q && !MONTH_RE.test(lower)) {
    const m0 = +q[1] * 3 - 1;
    return { date: inYear(m0, (y) => dim(y, m0)), confident: true, why: `Q${q[1]}` };
  }

  // 4. A month name — the FIRST one mentioned wins ("late June or early July" → June).
  const mm = lower.match(MONTH_RE);
  if (mm && mm.index !== undefined) {
    const m0 = MONTHS.indexOf(mm[1].slice(0, 3));
    const before = lower.slice(0, mm.index);
    const after = lower.slice(mm.index + mm[0].length);
    const dayAfter = after.match(/^\s*(\d{1,2})\b(?![:.]\d)/);
    const dayBefore = before.match(/\b(\d{1,2})\s*(?:of\s+)?$/);
    const startWindow = /\b(onward|onwards|from|starting|start from|beginning from|after|and later|or later)\b/.test(lower);
    let day: ((y: number) => number) | null = null;
    let why = "";
    if (dayAfter && +dayAfter[1] >= 1 && +dayAfter[1] <= 31) { const d = +dayAfter[1]; day = () => d; why = "month + day"; }
    else if (dayBefore && +dayBefore[1] >= 1 && +dayBefore[1] <= 31) { const d = +dayBefore[1]; day = () => d; why = "day + month"; }
    else {
      const wk = before.match(/\b(first|1|second|2|third|3|fourth|4|last|final) week\b/);
      if (wk) {
        const n = ({ first: 1, "1": 1, second: 2, "2": 2, third: 3, "3": 3, fourth: 4, "4": 4 } as Record<string, number>)[wk[1]];
        day = n ? (startWindow ? () => (n - 1) * 7 + 1 : () => n * 7) : (y) => (startWindow ? dim(y, m0) - 6 : dim(y, m0));
        why = `${wk[1]} week`;
      } else if (/\bmid(-|\s)?$|\bmiddle of\s*$|\bmid\b/.test(before)) { day = () => 15; why = "mid-month"; }
      else if (/\b(end of|late|by the end of|by end of|last days? of)\s*$/.test(before) || /\b(late|end)\b/.test(before)) {
        day = (y) => (startWindow ? 20 : dim(y, m0)); why = "late / end of month";
      } else if (/\b(early|beginning of|start of|first days? of)\b/.test(before)) { day = () => (startWindow ? 1 : 10); why = "early month"; }
      else { day = (y) => (startWindow ? 1 : dim(y, m0)); why = startWindow ? "from the month" : "month only (by its end)"; }
    }
    const date = inYear(m0, day!);
    // Year never written and the reference is far from the date → a guess worth checking.
    const far = !explicitYear && Math.abs(toUtc(date) - toUtc(ref)) > 300 * 86_400_000;
    return { date, confident: !far, why: why + (explicitYear ? "" : " (year inferred)") };
  }

  // 5. Numeric dates: 10/15/2026, 15.10.2026, 15/10 (day-first only when unambiguous).
  const num = lower.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (num) {
    const a = +num[1], b = +num[2];
    let month = a, day = b, ambiguous = a <= 12 && b <= 12 && a !== b;
    if (a > 12 && b <= 12) { month = b; day = a; ambiguous = false; }
    if (month < 1 || month > 12 || day < 1 || day > 31) return { date: null, confident: false, why: "unreadable numbers" };
    let y: number | null = num[3] ? +num[3] : null;
    if (y !== null && y < 100) y += 2000;
    const date = y ? ymd(y, month - 1, day) : inYear(month - 1, () => day);
    return { date, confident: !ambiguous, why: ambiguous ? "numeric date, day/month order unclear" : "numeric date" };
  }

  return { date: null, confident: false, why: "no date pattern" };
}

/* ── the AI fallback (fast tier, one short call) ─────────────────────────── */

const AI_SYSTEM = `You turn a deadline written in free text into ONE calendar date for a YouTube creator's sponsorship board (Jake Dawson, Asia/Bangkok). The deadline is normally the date the sponsored video must go live / be delivered.
Rules: a deadline is a "by" date — "late June" → the last day of June, "mid July" → the 15th, "early Aug" → the 10th, a bare month → its last day, "Q3" → Sep 30, a range or "X or Y" → the earliest option's by-date, "from X onward" → the start of X. Relative words are relative to the REFERENCE date. With no year, pick the year that makes sense against the reference date and the emails (usually the upcoming occurrence). If the text contains no date at all (e.g. "after script approval") use the emails to find the agreed date; if there is none, return null.
Output ONLY JSON: {"date": "YYYY-MM-DD" | null, "reason": "<max 100 chars>"}`;

export async function aiParseDeadline(text: string, ref: string, context: string): Promise<{ date: string | null; reason: string }> {
  const user = [
    `Deadline text: "${text}"`,
    `Reference date (when it was written): ${ref} (${WEEKDAYS[new Date(toUtc(ref)).getUTCDay()]}). Today in Bangkok: ${todayBangkok()}.`,
    context ? `Latest emails of the deal (newest last):\n${context}` : "No emails available.",
  ].join("\n");
  const json = await claudeJSONForPurpose({ tier: "fast", purpose: "deals-extract", system: AI_SYSTEM, messages: [{ role: "user", content: user }] });
  const out = JSON.parse(json) as { date?: unknown; reason?: unknown };
  return { date: isYmd(out.date) ? out.date : null, reason: typeof out.reason === "string" ? out.reason.slice(0, 120) : "" };
}

/* ── applying it to a deal ───────────────────────────────────────────────── */

/** A short thread excerpt for the AI (latest 3 messages of the source thread / contact). */
function threadContext(dealId: string): string {
  const d = db.prepare(`SELECT source_thread_id, client_email FROM deals_deals WHERE id = ?`).get(dealId) as { source_thread_id: string | null; client_email: string | null } | undefined;
  if (!d) return "";
  const rows = db.prepare(`
    SELECT date_iso, is_from_me, from_name, body_text, snippet FROM deals_emails
    WHERE (thread_id = @t OR (@e <> '' AND lower(from_email) = lower(@e))) AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%')
    ORDER BY date_iso DESC LIMIT 3`).all({ t: d.source_thread_id ?? "", e: d.client_email ?? "" }) as any[];
  return rows.reverse().map((r) => `--- ${String(r.date_iso ?? "").slice(0, 10)} ${r.is_from_me === 1 ? "JAKE" : r.from_name || "them"}: ${String(r.body_text || r.snippet || "").replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
}

/**
 * The dates a deal's (non-typed) deadline text may be relative to: when the deal
 * was created, and its latest email. We never know when a scanned/imported text
 * was written, so a year-less text that lands in different years from the two
 * is ambiguous → AI.
 */
function dataRefDates(dealId: string): { created: string; latest: string } {
  const r = db.prepare(`
    SELECT d.created_at AS created,
      COALESCE((SELECT MAX(date_iso) FROM deals_emails e WHERE e.thread_id = d.source_thread_id), d.last_scanned_at, d.created_at) AS latest
    FROM deals_deals d WHERE d.id = ?`).get(dealId) as { created: string | null; latest: string | null } | undefined;
  const norm = (v: string | null | undefined) => { const s = v ? String(v).slice(0, 10) : ""; return isYmd(s) ? s : todayBangkok(); };
  return { created: norm(r?.created), latest: norm(r?.latest) };
}

/** Parse a text found in the data (scanner / import / autofill), anchored to the deal. */
export function parseDataDeadline(dealId: string, text: string): ParsedDeadline & { ref: string } {
  const refs = dataRefDates(dealId);
  const a = parseDeadlineText(text, refs.created);
  const b = parseDeadlineText(text, refs.latest);
  if (a.date !== b.date) return { ...a, confident: false, why: `${a.why}; year unclear (${a.date} vs ${b.date})`, ref: refs.created };
  return { ...a, ref: refs.created };
}

const aiInFlight = new Set<string>();

/**
 * (Re)parse a deal's deadline text into deadline_date. Writes the deterministic
 * result at once; when that is not confident and `ai` is on, asks the AI in the
 * background and overwrites the date only if the text is still the same.
 * `typed` = Jake just typed it (relative to today) vs text found in the data.
 * Returns the synchronous result.
 */
export function refreshDeadlineDate(dealId: string, opts: { typed?: boolean; ai?: boolean; log?: (m: string) => void } = {}): ParsedDeadline & { aiPending: boolean; ref: string } {
  const row = db.prepare(`SELECT deadline, deadline_parsed_from FROM deals_deals WHERE id = ?`).get(dealId) as { deadline: string | null; deadline_parsed_from: string | null } | undefined;
  if (!row) return { date: null, confident: true, why: "no deal", aiPending: false, ref: todayBangkok() };
  const text = (row.deadline ?? "").trim();
  if (!text) {
    db.prepare(`UPDATE deals_deals SET deadline_date = NULL, deadline_parsed_from = NULL WHERE id = ?`).run(dealId);
    return { date: null, confident: true, why: "empty", aiPending: false, ref: todayBangkok() };
  }
  const typedRef = todayBangkok();
  const p = opts.typed ? { ...parseDeadlineText(text, typedRef), ref: typedRef } : parseDataDeadline(dealId, text);
  const ref = p.ref;
  db.prepare(`UPDATE deals_deals SET deadline_date = ?, deadline_parsed_from = ? WHERE id = ?`).run(p.date, text, dealId);
  const wantAi = !p.confident && opts.ai !== false && !aiInFlight.has(dealId);
  if (wantAi) {
    aiInFlight.add(dealId);
    void aiParseDeadline(text, ref, threadContext(dealId))
      .then((r) => {
        const cur = db.prepare(`SELECT deadline FROM deals_deals WHERE id = ?`).get(dealId) as { deadline: string | null } | undefined;
        if ((cur?.deadline ?? "").trim() !== text) return; // edited again meanwhile
        if (r.date || !p.date) db.prepare(`UPDATE deals_deals SET deadline_date = ? WHERE id = ?`).run(r.date, dealId);
        opts.log?.(`deadline "${text}" → ${r.date ?? "none"} (AI: ${r.reason})`);
      })
      .catch((e) => opts.log?.(`deadline AI parse failed for "${text}": ${e?.message ?? e}`))
      .finally(() => aiInFlight.delete(dealId));
  }
  return { ...p, aiPending: wantAi };
}

/**
 * Every deal whose deadline text changed since it was last parsed (any writer:
 * the scanner, the chat agent, a legacy row) → parse it. The sync runs this; the
 * one-time backfill is the same call. AI only for the ambiguous ones, awaited in
 * small batches so a run's cost is bounded (cap per call).
 */
export async function syncDeadlineDates(opts: { ai?: boolean; aiCap?: number; log?: (m: string) => void } = {}): Promise<{ parsed: number; dated: number; aiAsked: number; aiDated: number; failures: { id: string; text: string }[] }> {
  const rows = db.prepare(`
    SELECT id, deadline FROM deals_deals
    WHERE (deadline IS NOT NULL AND trim(deadline) <> '' AND deadline_parsed_from IS NOT deadline)
       OR ((deadline IS NULL OR trim(deadline) = '') AND (deadline_date IS NOT NULL OR deadline_parsed_from IS NOT NULL))`).all() as { id: string; deadline: string | null }[];
  const out = { parsed: 0, dated: 0, aiAsked: 0, aiDated: 0, failures: [] as { id: string; text: string }[] };
  const ambiguous: { id: string; text: string; ref: string; guess: string | null }[] = [];
  for (const r of rows) {
    const p = refreshDeadlineDate(r.id, { ai: false });
    out.parsed++;
    if (p.date) out.dated++;
    if (!p.confident && r.deadline) ambiguous.push({ id: r.id, text: r.deadline.trim(), ref: p.ref, guess: p.date });
  }
  if (opts.ai !== false) {
    for (const a of ambiguous.slice(0, opts.aiCap ?? 30)) {
      out.aiAsked++;
      try {
        const r = await aiParseDeadline(a.text, a.ref, threadContext(a.id));
        if (r.date) { db.prepare(`UPDATE deals_deals SET deadline_date = ? WHERE id = ? AND deadline = ?`).run(r.date, a.id, a.text); out.aiDated++; if (!a.guess) out.dated++; }
        opts.log?.(`deadline "${a.text}" → ${r.date ?? "none"} (AI${a.guess ? `, rule said ${a.guess}` : ""}: ${r.reason})`);
      } catch (e: any) {
        opts.log?.(`deadline AI parse failed for "${a.text}": ${e?.message ?? e}`);
      }
    }
  }
  for (const r of rows) {
    const d = db.prepare(`SELECT deadline, deadline_date FROM deals_deals WHERE id = ?`).get(r.id) as { deadline: string | null; deadline_date: string | null };
    if (d.deadline && d.deadline.trim() && !d.deadline_date) out.failures.push({ id: r.id, text: d.deadline });
  }
  return out;
}
