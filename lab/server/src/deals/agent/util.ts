/**
 * Sponsorship email agent — small shared helpers: Bangkok time, Gmail message
 * parsing, quote stripping, domains, and the model/cost plumbing every step uses.
 *
 * Self-contained on purpose: the Deal Organizer port is being written next door
 * at the same time, and the agent must not break when those files move.
 */
import { claudeJSONWithModel, extractJson } from "../../ai/claude.js";
import type { CallPurpose } from "../../ai/runAccounting.js";
import type { ScopedCall } from "../../ai/usageScope.js";
import { modelForTier } from "../../ai/config.js";

export const TZ = "Asia/Bangkok";
export const ACCOUNT_FALLBACK = "jakedawsonbusiness@gmail.com";

/* ── time ─────────────────────────────────────────────────────────────────── */

/** Wall-clock parts of `d` in Bangkok. */
export function bangkokParts(d = new Date()): { y: number; m: number; day: number; hh: number; mm: number; weekday: string; iso: string } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const y = Number(p.year), m = Number(p.month), day = Number(p.day);
  const hh = Number(p.hour) % 24, mm = Number(p.minute);
  return { y, m, day, hh, mm, weekday: p.weekday, iso: `${p.year}-${p.month}-${p.day}` };
}

/** UTC instant of a Bangkok wall-clock time (UTC+7, no DST). */
export function bangkokToUtc(dateIso: string, hhmm: string): Date {
  const [h, mi] = hhmm.split(":").map(Number);
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 7, mi));
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function longDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
}

/* ── addresses / domains ──────────────────────────────────────────────────── */

export function extractEmail(raw: string | undefined | null): string {
  const s = String(raw ?? "");
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

export function extractName(raw: string | undefined | null): string {
  const s = String(raw ?? "");
  const m = s.match(/^\s*"?([^"<]*?)"?\s*</);
  return (m ? m[1] : "").trim();
}

export function domainOf(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

const MULTI_SUFFIX = new Set(["co.uk", "co.nz", "co.jp", "com.au", "com.br", "org.uk", "net.au", "co.in", "com.sg", "co.il"]);
export function rootDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join(".") : last2;
}

export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "proton.me",
  "protonmail.com", "aol.com", "qq.com", "163.com", "126.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

/* ── Gmail payload parsing ────────────────────────────────────────────────── */

export function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function b64(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const l = String(label).replace(/<[^>]+>/g, "").trim();
      return l && !href.includes(l) ? `${l} <${href}>` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walk(payload: any, out: { text: string; html: string; attachments: string[] }, depth = 0): void {
  if (!payload || depth > 8) return;
  const mime = String(payload.mimeType ?? "");
  if (payload.filename) out.attachments.push(String(payload.filename));
  if (mime === "text/plain" && payload.body?.data && !payload.filename) out.text += b64(payload.body.data);
  else if (mime === "text/html" && payload.body?.data && !payload.filename) out.html += b64(payload.body.data);
  for (const p of payload.parts ?? []) walk(p, out, depth + 1);
}

export interface ParsedMessage {
  id: string;
  messageIdHeader: string;
  references: string;
  from: string;
  fromEmail: string;
  fromName: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: Date;
  labels: string[];
  isDraft: boolean;
  isFromMe: boolean;
  body: string;          // full text (quotes included)
  fresh: string;         // quotes stripped
  attachments: string[];
}

export function parseGmailMessage(msg: any, myEmail: string): ParsedMessage {
  const headers = msg.payload?.headers ?? [];
  const out = { text: "", html: "", attachments: [] as string[] };
  walk(msg.payload, out);
  const body = (out.text.trim() || htmlToText(out.html) || String(msg.snippet ?? "")).replace(/\r\n/g, "\n");
  const from = header(headers, "From");
  const fromEmail = extractEmail(from);
  const labels: string[] = msg.labelIds ?? [];
  return {
    id: msg.id,
    messageIdHeader: header(headers, "Message-ID") || header(headers, "Message-Id"),
    references: header(headers, "References"),
    from,
    fromEmail,
    fromName: extractName(from) || fromEmail,
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    replyTo: header(headers, "Reply-To"),
    subject: header(headers, "Subject"),
    date: new Date(Number(msg.internalDate) || Date.parse(header(headers, "Date")) || Date.now()),
    labels,
    isDraft: labels.includes("DRAFT"),
    isFromMe: fromEmail === myEmail.toLowerCase(),
    body,
    fresh: stripQuoted(body),
    attachments: out.attachments,
  };
}

/** Cut the quoted history off a reply ("On … wrote:", ">" lines, Outlook headers). */
export function stripQuoted(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  const cuts = [
    /\n\s*On [^\n]{3,200}\n?[^\n]{0,120}wrote:\s*\n/i,
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*From:\s[^\n]+\n\s*(Sent|Date):\s[^\n]+/i,
    /\n\s*_{8,}\s*\n\s*From:/i,
    /\n\s*在\s.{3,80}写道：/,
  ];
  for (const re of cuts) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index > 0) t = t.slice(0, m.index);
  }
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeWs(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/* ── models + cost ────────────────────────────────────────────────────────── */

/** Drafting + final check. Verified live 2026-09-30 with a one-token call. */
export function draftModel(): string {
  return (process.env.DEALS_AGENT_MODEL || "claude-opus-5-5").trim();
}
/** Triage / fit / learning — cheaper tier. */
export function triageModel(): string {
  return (process.env.DEALS_AGENT_TRIAGE_MODEL || "claude-sonnet-5-5").trim();
}

/** Models that failed with "model not found" this process — we fall back to the director tier. */
const deadModels = new Set<string>();
export const modelNotes: string[] = [];

/**
 * JSON call on a named model with: one retry on unparseable JSON, and a
 * fallback to the director tier when the model id is rejected (404/400
 * "model"). Returns the parsed object.
 */
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * Sonnet 5.x thinks by default (billed as output). The agent's Sonnet calls are
 * classification/extraction, so they run at low effort unless the caller asks
 * for more (triage: medium). Other models keep their current behaviour.
 */
function effortFor(model: string, asked?: Effort): Effort | undefined {
  if (asked) return asked;
  return /^claude-sonnet-5/.test(model) ? "low" : undefined;
}

export async function aiJSON<T = any>(opts: { model: string; purpose: CallPurpose; system: string; systemTail?: string; user: string; effort?: Effort }): Promise<T> {
  let model = deadModels.has(opts.model) ? modelForTier("director") : opts.model;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await claudeJSONWithModel({ model, purpose: opts.purpose, system: opts.system, systemTail: opts.systemTail, effort: effortFor(model, opts.effort), messages: [{ role: "user", content: opts.user }] });
      return JSON.parse(extractJson(raw)) as T;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      if (/\((404|400)\)/.test(msg) && /model/i.test(msg) && model !== modelForTier("director")) {
        deadModels.add(model);
        modelNotes.push(`${model} rejected (${msg.slice(0, 120)}) — fell back to ${modelForTier("director")}`);
        model = modelForTier("director");
        continue;
      }
      if (e instanceof SyntaxError || /JSON/i.test(msg)) continue; // ask again once more
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** $ per million tokens. Local table so models pricing.ts doesn't know yet are still priced. */
const RATES: Record<string, { in: number; out: number; cw: number; cr: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cw: 5, cr: 0.2 },
  "claude-opus-5": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-opus-4-8": { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cw: 2.5, cr: 0.2 },
  "claude-sonnet-4-6": { in: 3, out: 15, cw: 3.75, cr: 0.3 },
  "claude-haiku-4-5": { in: 1, out: 5, cw: 1.25, cr: 0.1 },
};
export function priceCalls(calls: ScopedCall[]): { usd: number; byModel: Record<string, number> } {
  const byModel: Record<string, number> = {};
  let usd = 0;
  for (const c of calls) {
    const r = RATES[c.model];
    const cost = r ? (c.input * r.in + c.output * r.out + c.cacheWrite * r.cw + c.cacheRead * r.cr) / 1e6 : c.costUsd;
    byModel[c.model] = (byModel[c.model] ?? 0) + cost;
    usd += cost;
  }
  return { usd: Math.round(usd * 10000) / 10000, byModel };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function clip(s: string | undefined | null, n: number): string {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
