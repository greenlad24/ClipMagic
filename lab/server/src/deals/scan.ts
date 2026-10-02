/**
 * Deal Organizer — the Gmail deal scanner (port of scanGmail.ts).
 *
 * Same fetch → group-by-partner → three-call AI pipeline → create/update, same
 * caps, prompts, normalisation, Pass 2 backfill, error categories and summary
 * messages. What changed, and why:
 *   - OpenAI → Claude. Call A (classify) and Call C (verify) were gpt-4o-mini →
 *     `fast` tier; Call B (extract) was the preflight-selected gpt-4o → `research`
 *     tier. The OpenAI "preflight" (1–3 paid test calls to find a working model)
 *     has nothing to probe on Claude; it is kept as a free credentials check that
 *     logs the same lines. The rate-limit / bad-model fallback now retries on the
 *     `fast` tier (it was gpt-4o-mini). The error category names are unchanged
 *     ("openai_*"), because the UI shows them.
 *   - pdf-parse is not a Lab dependency: PDF attachment text is read by
 *     Gemini 2.5 Flash (see pdfAttachmentText), with a small built-in
 *     extractor as the fallback — same 4000-char cap.
 *   - The run can report its log live: `onLog` receives each log entry as it is
 *     written (the STREAMER sends them as chunks). The returned `logs` array is
 *     identical to the original.
 *
 * Bug-fix pass (SPEC/server.md §12 #1–#6), output shape unchanged:
 *   #1 Emails in a conversation are ordered NEWEST FIRST (by Gmail internalDate),
 *      so "Email 1 / LATEST: YES" really is the latest. bizScore now only ranks
 *      which conversations get processed when there are more than the cap.
 *   #2 Each attachment is fetched from the message that owns it.
 *   #3 The classification prompt lists the LIVE stages (stagesForAI), and an
 *      update now writes the stage — under the guard in `stageMoveDecision`.
 *   #4 The whole date window is listed (all pages, capped at CONFIG.maxMessages
 *      with a log line), and an existing deal is matched by the SHARED matcher
 *      (matching.ts — the same rules as Files / Emails / the agent): a thread
 *      the deal owns, the partner in its contact closure, or its company domain
 *      with the same brand; the extracted brand separates an agency's brands.
 *   #5 Pass 2 re-reads the deals reviewed longest ago (last_reviewed_at), not
 *      the same first five; a deal a human touched is never auto-archived — it
 *      gets `review_flag` + one "Scanner" comment instead.
 *   #6 The "preflight" makes no API call (credential presence only), and
 *      `categorizeError` uses the HTTP status and precise patterns instead of
 *      substrings like "model" / "not found" / "record".
 */
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { db } from "../db/index.js";
import { deals, dealActions, dealComments, MACHINE_AUTHORS, type DealRecord } from "./db.js";
import { loadStageConfig } from "./stageUtils.js";
import * as gmail from "./integrations/gmail.js";
import { anthropicConfigured, claudeJSONWithModel } from "../ai/claude.js";
import { withSyncLock } from "./syncLock.js";
import { modelForTier } from "../ai/config.js";
import { ARCHIVED_FALSE, aiJSONText, callGemini, connectedAccounts, decodeB64, domainOf, extractEmail, extractName, getHeader, isFreemail, parse, rootDomain } from "./common.js";
import { dealsForThread, brandFromText, brandEq, mentions, isAgencyName, latestThreadForDeal, invalidateMatching, MATCH_RANK, type ThreadDeal } from "./matching.js";

/* ── Log entry ─────────────────────────────────────────────────────────────── */

type LogLevel = "info" | "success" | "warn" | "error";
export interface ScanLogEntry { ts: string; level: LogLevel; step: string; message: string }

function makeLogger(onLog?: (e: ScanLogEntry) => void) {
  const entries: ScanLogEntry[] = [];
  const log = (level: LogLevel, step: string, message: string) => {
    const e = { ts: new Date().toISOString(), level, step, message };
    entries.push(e);
    try { onLog?.(e); } catch { /* a dead listener never stops the scan */ }
  };
  return { entries, log };
}

/* ── Run config ────────────────────────────────────────────────────────────── */

// maxMessages is a safety cap on how many messages of the window are read (was
// 60 / 30 — a 90-day scan read ~the newest 60). Hitting it is logged.
const CONFIG = {
  manual: { maxMessages: 1500, maxGroups: 10, label: "manual (90-day)" },
  cron: { maxMessages: 400, maxGroups: 25, label: "scheduled (24-hour)" }, // was 6: skipped conversations were never picked up again
};
/** Pass 2 re-reads this many existing deals per manual scan, oldest-reviewed first. */
const BACKFILL_PER_RUN = 5;

/* ── Error categorization (same categories; precise matching — bug 6) ─────── */

type ErrorCategory =
  | "openai_invalid_api_key"
  | "openai_invalid_model"
  | "openai_rate_limit"
  | "openai_response_format_unsupported"
  | "openai_timeout"
  | "openai_malformed_response"
  | "gmail_fetch_error"
  | "gmail_parse_error"
  | "attachment_analysis_error"
  | "link_analysis_error"
  | "database_error"
  | "unknown_error";

export function categorizeError(err: any): { category: ErrorCategory; message: string } {
  const msg: string = err?.message ?? err?.error?.message ?? String(err ?? "unknown");
  const out = (category: ErrorCategory) => ({ category, message: msg.slice(0, 300) });
  // HTTP status: an explicit property, else the "(401)" / "failed (404)" our helpers put in the message.
  const status: number = Number(err?.status ?? err?.statusCode ?? msg.match(/\((\d{3})\)/)?.[1] ?? 0);
  const isGmail = /^Gmail\b|gmail\.googleapis|Could not refresh Gmail access|Gmail is not connected/i.test(msg);
  const isSqlite = err?.code?.startsWith?.("SQLITE_") || /\bSQLITE_[A-Z]+\b|no such (table|column)|constraint failed|database is locked/i.test(msg);

  if (isSqlite) return out("database_error");
  if (isGmail) return out("gmail_fetch_error");
  if (status === 401 || status === 403 || /invalid[ _-]?(x-)?api[ _-]?key|authentication_error|No Anthropic credentials/i.test(msg)) return out("openai_invalid_api_key");
  if (status === 429 || status === 529 || /\brate[ _-]?limit|overloaded_error/i.test(msg)) return out("openai_rate_limit");
  if (status === 404 || /\bmodel\b[^.]{0,60}\b(not found|does not exist|not_found|is not supported)|not_found_error[^.]{0,60}\bmodel\b/i.test(msg)) return out("openai_invalid_model");
  if (status === 400 && /response_format|json_object|unsupported/i.test(msg)) return out("openai_response_format_unsupported");
  if (err?.name === "AbortError" || /\btimed? ?out\b|\bETIMEDOUT\b|\bthe operation was aborted\b/i.test(msg)) return out("openai_timeout");
  if (err instanceof SyntaxError || /unexpected token|in JSON at position|is not valid JSON|could not parse json/i.test(msg)) return out("openai_malformed_response");
  return out("unknown_error");
}

/* ── AI call ───────────────────────────────────────────────────────────────── */

type Tier = "fast" | "research";
interface WorkingConfig { tier: Tier; purpose: "deals-classify" | "deals-extract" }

/** The Gmail scanner's extraction model (Jake 2026-10-01: Sonnet 4.6 → Sonnet 5.5). */
function scanModel(): string {
  return (process.env.DEALS_SCAN_MODEL || "claude-sonnet-5-5").trim();
}

/**
 * The original `callAI`: JSON-mode completion at temperature 0.15 with a
 * `{…}`-regex fallback parse; on a rate limit / bad model it retries once on
 * the small model with "CRITICAL: Respond ONLY with a valid JSON object."
 * (`maxTokens` cannot be passed to the Lab helper; kept for the call sites.)
 */
async function callAI(
  cfg: WorkingConfig,
  systemPrompt: string,
  userPrompt: string,
  _maxTokens: number = 800,
): Promise<{ success: true; analysis: any } | { success: false; category: ErrorCategory; message: string }> {
  const tryParse = (text: string): any | null => {
    try { return JSON.parse(text); } catch { /* */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* */ }
    }
    return null;
  };

  try {
    // The extraction pass runs on its own model (Claude Sonnet 5.5 by default, low
    // effort — it thinks by default and thinking bills as output); the "fast"
    // fallback below stays on the Lab's fast tier.
    const text = cfg.tier === "research"
      ? await claudeJSONWithModel({ model: scanModel(), purpose: cfg.purpose, system: systemPrompt, messages: [{ role: "user", content: userPrompt }], effort: "low" })
      : await aiJSONText(cfg.tier, cfg.purpose, systemPrompt, [{ role: "user", content: userPrompt }]);
    const parsed = tryParse(text);
    if (parsed) return { success: true, analysis: parsed };
    return { success: false, category: "openai_malformed_response", message: `Could not parse JSON from response: ${text.slice(0, 150)}` };
  } catch (e1: any) {
    const err1 = categorizeError(e1);

    if (err1.category === "openai_invalid_model" || err1.category === "openai_rate_limit") {
      try {
        const text = await aiJSONText(
          "fast", cfg.purpose,
          systemPrompt + "\n\nCRITICAL: Respond ONLY with a valid JSON object.",
          [{ role: "user", content: userPrompt }],
        );
        const parsed = tryParse(text);
        if (parsed) return { success: true, analysis: parsed };
      } catch { /* fall through */ }
    }

    return { success: false, ...err1 };
  }
}

/* ── Autobot filter ────────────────────────────────────────────────────────── */

const AUTOBOT_PATTERNS = [
  "noreply", "no-reply", "donotreply", "do-not-reply",
  "mailer-daemon", "postmaster@", "bounce@", "bounce+",
  "automated@", "auto-confirm@", "confirm@noreply",
  "notifications@github", "notifications@slack",
  "receipts@", "invoice@stripe", "payments@paypal",
];
function isAutobot(email: string): boolean {
  const e = email.toLowerCase();
  return AUTOBOT_PATTERNS.some((p) => e.includes(p));
}

/* ── Scanner-flavoured parsing (links kept as "label [href]") ───────────────── */

function htmlToText(html: string): string {
  let t = html.replace(/<a[^>]+href=["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, label) => {
      const clean = label.replace(/<[^>]+>/g, "").trim();
      return clean ? `${clean} [${href}]` : href;
    });
  t = t.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  t = t.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  t = t.replace(/<\/(p|div|li|h[1-6]|td|tr|blockquote)>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  return t
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function extractUrls(source: string): string[] {
  const href = [...source.matchAll(/href=["']([^"'#\s]{8,})["']/gi)].map((m) => m[1]);
  const inline = source.match(/https?:\/\/[^\s<>"')\]]{8,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...href, ...inline]) {
    const c = u.replace(/[)>\],.;:'"]+$/, "");
    if (!seen.has(c) && !c.includes("unsubscribe") && !c.includes("utm_")) {
      seen.add(c); out.push(c);
    }
  }
  return out.slice(0, 30);
}

interface PartResult {
  plainText: string;
  htmlText: string;
  rawHtml: string;
  urls: string[];
  attachments: { name: string; mimeType: string; attachmentId: string; messageId?: string }[];
}

function extractParts(payload: any, depth = 0): PartResult {
  const r: PartResult = { plainText: "", htmlText: "", rawHtml: "", urls: [], attachments: [] };
  if (!payload || depth > 8) return r;
  const mime = payload.mimeType ?? "";
  if (payload.body?.data) {
    const decoded = decodeB64(payload.body.data);
    if (mime === "text/plain") { r.plainText = decoded; r.urls.push(...extractUrls(decoded)); }
    else if (mime === "text/html") { r.rawHtml = decoded; r.htmlText = htmlToText(decoded); r.urls.push(...extractUrls(decoded)); }
    return r;
  }
  if (payload.filename && payload.body?.attachmentId) {
    r.attachments.push({ name: payload.filename, mimeType: mime, attachmentId: payload.body.attachmentId });
    return r;
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) merge(r, extractParts(part, depth + 1));
    if (!r.plainText && r.htmlText) r.plainText = r.htmlText;
  }
  return r;
}
function merge(t: PartResult, s: PartResult): void {
  if (!t.plainText) t.plainText = s.plainText;
  if (!t.htmlText) t.htmlText = s.htmlText;
  if (!t.rawHtml) t.rawHtml = s.rawHtml;
  t.urls.push(...s.urls);
  t.attachments.push(...s.attachments);
}

/* ── PDF text (replaces pdf-parse) ─────────────────────────────────────────── */

function decodePdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[e] ?? e;
  });
}

/**
 * Best-effort text of a PDF: inflate every FlateDecode stream and read the
 * literal strings shown by Tj / TJ / ' / " inside BT…ET blocks. Handles the
 * common case (contracts exported from Word/Docs/DocuSign); PDFs whose fonts
 * use CID/hex encodings come back empty, as a scanned PDF did with pdf-parse.
 */
export function pdfToText(buf: Buffer): string {
  const bin = buf.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf("endstream", start);
    if (end < 0) break;
    const dict = bin.slice(Math.max(0, m.index - 400), m.index);
    let content: string;
    const raw = buf.subarray(start, end);
    if (/FlateDecode/.test(dict.slice(dict.lastIndexOf("<<")))) {
      try { content = inflateSync(raw).toString("latin1"); } catch { re.lastIndex = end; continue; }
    } else {
      content = raw.toString("latin1");
    }
    re.lastIndex = end;
    if (!/\bBT\b/.test(content)) continue;
    for (const block of content.match(/BT[\s\S]*?ET/g) ?? []) {
      let line = "";
      const tokRe = /\((?:\\.|[^\\)])*\)|\bT\*|\bTd\b|\bTD\b|'|"/g;
      let t: RegExpExecArray | null;
      while ((t = tokRe.exec(block))) {
        const tok = t[0];
        if (tok.startsWith("(")) line += decodePdfString(tok.slice(1, -1));
        else if (tok === "T*" || tok === "'" || tok === '"') line += "\n";
        else if (tok === "Td" || tok === "TD") line += " ";
      }
      if (line.trim()) out.push(line);
    }
  }
  const text = out.join("\n").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

/**
 * PDF → text. pdf-parse is not available, and contract PDFs (DocuSign, Docs,
 * Word exports) almost all use embedded subset fonts whose text only decodes
 * through ToUnicode maps — the small extractor above returns nothing or
 * gibberish for them (measured on Jake's own attachments). So the text is read
 * by Gemini (the Lab's paid key, already used by this app) and the local
 * extractor is only the fallback when Gemini is unavailable.
 */
export async function pdfAttachmentText(buffer: Buffer): Promise<string> {
  if (buffer.length <= 15 * 1024 * 1024) {
    try {
      const text = await callGemini(
        "Extract the full plain text of this PDF, in reading order. Output ONLY the text — no commentary, no markdown formatting.",
        { maxTokens: 2048, temperature: 0, pdfBase64: buffer.toString("base64") },
      );
      if (text) return text;
    } catch { /* fall back to the local extractor */ }
  }
  return pdfToText(buffer);
}

async function fetchAttachmentText(messageId: string, attachmentId: string, mimeType: string): Promise<string> {
  if (mimeType.includes("application/pdf")) {
    try {
      const res: any = await gmail.getAttachment(messageId, attachmentId);
      if (!res.data) return "";
      const buffer = Buffer.from(res.data, "base64url");
      return (await pdfAttachmentText(buffer)).slice(0, 4000);
    } catch { return ""; }
  }
  const textTypes = ["text/plain", "text/html", "text/csv", "application/json"];
  if (!textTypes.some((t) => mimeType.includes(t))) return "";
  try {
    const res: any = await gmail.getAttachment(messageId, attachmentId);
    if (!res.data) return "";
    const c = decodeB64(res.data);
    return (mimeType.includes("html") ? htmlToText(c) : c).slice(0, 3000);
  } catch { return ""; }
}

const URL_ALLOW = ["notion.so", "docs.google.com", "drive.google.com", "dropbox.com", "docsend.com", "pitch.com"];
const URL_BLOCK = ["twitter.com", "x.com", "instagram.com", "tiktok.com", "youtube.com", "linkedin.com", "facebook.com"];

function shouldFetchUrl(url: string): boolean {
  const u = url.toLowerCase();
  return !URL_BLOCK.some((p) => u.includes(p)) && URL_ALLOW.some((p) => u.includes(p));
}

async function fetchUrlText(url: string): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; DealScanner/1.0)" } });
    clearTimeout(t);
    if (!r.ok) return "";
    return htmlToText(await r.text()).slice(0, 2000);
  } catch { return ""; }
}

const BIZ_KEYWORDS = [
  "sponsor", "sponsorship", "collab", "collaboration", "partner", "partnership",
  "campaign", "proposal", "brief", "contract", "invoice", "payment", "rate", "rates",
  "pricing", "budget", "quote", "fee", "compensation", "deliverable", "timeline",
  "deadline", "filming", "video", "script", "brand deal", "brand partnership", "paid",
  "opportunity", "project", "inquiry", "interested", "work together", "media kit",
  "reach out", "great fit", "love to collaborate", "open to", "are you open",
];
function bizScore(text: string): number {
  const l = text.toLowerCase();
  return BIZ_KEYWORDS.filter((k) => l.includes(k)).length;
}

/* ── Prompts (verbatim) ────────────────────────────────────────────────────── */

const CLASSIFICATION_PROMPT = `You are an AI assistant for a content creator / influencer managing their business deal pipeline.

You analyze email conversations between the creator and a specific contact. Emails include INBOUND messages and OUTBOUND replies (marked [MY REPLY]). Use both sides to determine if a deal exists.

CLASSIFICATION — Only create deals for genuine partnership opportunities:
Classify as a deal (isDeal: true) ONLY when:
- A brand, company, or agency is offering Jake a PAID sponsorship, partnership, or campaign
- There is active negotiation of rates, deliverables, or contract terms
- A prior collaboration is being followed up (payment, revisions, completion)
- A script, video draft, or deliverable is being reviewed or approved by a paying client
- Someone is specifically asking about Jake's rates or packages WITH intent to hire him

Do NOT classify as a deal (isDeal: false) for:
- Random questions or general inquiries (e.g. "how do I do X?", "can you help with Y?")
- Inbound service pitches where SOMEONE ELSE is trying to sell TO Jake (thumbnail designers, editors, SEO agencies, lead gen, cold outreach selling a service)
- Newsletters, product announcements, or marketing emails with no personal business intent
- Automated platform notifications, receipts, or order confirmations
- Conversations about thumbnails, editing, or other services where Jake is the potential BUYER, not the seller
- Personal conversations with no business component
- True spam

Key test: Is Jake the one being PAID, or is Jake being asked to PAY? If Jake is the buyer, it's NOT a deal.

STAGE OPTIONS (exact text only):
{{STAGES}}

Return ONLY valid JSON.
If isDeal is true: {"isDeal": true, "confidence": "High"|"Medium"|"Low", "stage": "<exact stage name>"}
If isDeal is false: {"isDeal": false}`;

/** The classification prompt with the LIVE stage list (bug 3: it was hardcoded). */
function classificationPrompt(stagesForAI: string[]): string {
  return CLASSIFICATION_PROMPT.replace("{{STAGES}}", stagesForAI.join(" | "));
}

const EXTRACTION_PROMPT = `You are an AI assistant for a content creator / influencer managing their business deal pipeline.

The deal has already been confirmed. Your ONLY job is to extract the structured data fields accurately. Apply the CRITICAL EXTRACTION RULES below. Return null for any field you are not confident about.

NOTE: Content labeled [CONTRACT/ATTACHMENT — HIGH PRIORITY SOURCE] comes from signed documents and takes priority over email body text for all fields, especially deadline and estimatedValue.

CRITICAL EXTRACTION RULES — read carefully before extracting any field:
- For EVERY field: read emails from newest to oldest (Email 1 first, it is marked LATEST: YES). Use the FIRST value you find. Newest always wins.
- If a value appears in multiple emails, always use the one from the most recent email. Ignore older values entirely.
- "estimatedValue": Use the most recently AGREED or OFFERED dollar amount. Do not average. Do not use the first offer if a later offer exists. Return as a plain number (e.g. 5500). Return null ONLY if no dollar figure exists anywhere in the thread.
- "deadline": This is the VIDEO UPLOAD / GO-LIVE DATE — the date Jake must publish the video. Look for: "upload date", "go live", "publish by", "live on", "video due", "delivery date", "air date" in BOTH email bodies AND attachment text. Contract PDFs (marked [CONTRACT/ATTACHMENT — HIGH PRIORITY SOURCE]) take PRIORITY over email text for this field — if the contract says June 2026, use that even if an older email said something different. Extract ONLY explicit calendar dates or months (e.g. "June 2026", "April 15", "end of Q2"). Vague words like "soon", "ASAP" are NOT deadlines — return null. Return null if no upload/go-live date is found anywhere.
- "nextSteps": Base ONLY on the most recent email (LATEST: YES). Do not infer from older emails.
- "keyDetails": Include payment terms (upfront %, on-approval %), contract status (signed/pending), and any deliverable specs mentioned. If a signed contract exists (attachment present), note: "Contract signed."
- "files": If any PDF or document attachment was present in the thread, list its filename here. Example: "contract.pdf, brief.pdf". Return empty string if no files.
- If you are not at least 80% confident in a value, return null. A null is always better than a wrong value.
- Never invent or infer values that are not explicitly stated in the thread.

Respond ONLY with a valid JSON object:
{"clientName":string,"clientEmail":string,"projectName":string,"about":string,"opportunity":string,"keyDetails":string,"contactInfo":string,"links":string,"files":string,"nextSteps":string,"deadline":string|null,"estimatedValue":number|null,"todos":string[]}

"todos": 2-5 concrete action items the creator should take next based on the thread content. Be specific and actionable. Max 5 items.`;

const VERIFICATION_PROMPT = `You are verifying two extracted values from an email thread.
NOTE: Content labeled [CONTRACT/ATTACHMENT — HIGH PRIORITY SOURCE] comes from signed documents and takes priority over email body text for all fields, especially deadline and estimatedValue.
Find the EXACT sentence in the emails or attachments that supports each claimed value. If you cannot find a verbatim or near-verbatim match, return false for that field.
Return ONLY: {"deadlineVerified": boolean, "deadlineSource": string, "valueVerified": boolean, "valueSource": string}`;

function buildStructuredFields(a: any, threadUrl: string, existing?: DealRecord) {
  const existingIsEmpty = !existing?.about && !existing?.opportunity && !existing?.keyDetails;
  const keep = (newVal: string | undefined, existingVal?: string): string | undefined => {
    if (newVal && typeof newVal === "string" && newVal.trim()) return newVal.trim();
    if (existingIsEmpty) return undefined;
    return existingVal ?? undefined;
  };

  const fields: Record<string, any> = {
    about: keep(a.about, existing?.about),
    opportunity: keep(a.opportunity, existing?.opportunity),
    keyDetails: keep(a.keyDetails, existing?.keyDetails),
    contactInfo: keep(a.contactInfo, existing?.contactInfo),
    links: keep(a.links, existing?.links),
    files: keep(a.files, existing?.files),
    nextSteps: keep(a.nextSteps, existing?.nextSteps),
    threadLink: threadUrl || existing?.threadLink,
    lastScannedAt: new Date().toISOString(),
  };

  if (!existing || !existing.deadline) {
    fields.deadline = a.deadline ?? undefined;
  }

  return fields;
}

interface EmailData {
  id: string; threadId: string; subject: string; date: string;
  /** Gmail internalDate (ms) — the reliable ordering key; falls back to the Date header. */
  ts: number;
  fromEmail: string; isFromMe: boolean;
  partnerEmail: string; partnerName: string;
  plainBody: string; htmlBody: string;
  attachments: { name: string; mimeType: string; attachmentId: string; messageId?: string }[];
  urls: string[]; score: number;
}

/** Newest first (bug 1: the original put the highest bizScore first). */
const newestFirst = (a: EmailData, b: EmailData) => b.ts - a.ts;

/** Unique attachments across a conversation, newest message's copy first, each tagged with ITS message id (bug 2). */
function conversationAttachments(sorted: EmailData[]) {
  return sorted
    .flatMap((e) => e.attachments.map((a) => ({ ...a, messageId: e.id })))
    .filter((a, i, arr) => arr.findIndex((b) => b.name === a.name) === i)
    .slice(0, 15);
}

function buildEmailsContext(sorted: EmailData[]): string {
  return sorted.slice(0, 10).map((e, i) => {
    const role = e.isFromMe ? "[MY REPLY]" : "[INBOUND]";
    const latest = i === 0 ? "| LATEST: YES" : "| LATEST: NO";
    const body = (e.plainBody || e.htmlBody).slice(0, 1800);
    const attLine = e.attachments.length > 0 ? `\n[Attachments: ${e.attachments.map((a) => a.name).join(", ")}]` : "";
    const urlLine = e.urls.length > 0 ? `\n[Links: ${e.urls.slice(0, 5).join(" | ")}]` : "";
    return `=== Email ${i + 1} ${role} | DATE: ${e.date} ${latest} ===\nSubject: ${e.subject}\n\n${body}${attLine}${urlLine}`;
  }).join("\n\n");
}

async function runAIPipeline(
  extractionCfg: WorkingConfig,
  classificationSystemPrompt: string,
  userPrompt: string,
  groupLabel: string,
  log: (level: LogLevel, step: string, msg: string) => void,
): Promise<
  | { success: false; category: ErrorCategory; message: string }
  | { success: true; isDeal: false }
  | { success: true; isDeal: true; analysis: any }
> {
  const miniCfg: WorkingConfig = { tier: "fast", purpose: "deals-classify" };

  // ── Call A: Classification
  const classResult = await callAI(miniCfg, classificationSystemPrompt, userPrompt, 150);
  if (!classResult.success) {
    return { success: false, category: classResult.category, message: classResult.message };
  }
  const classAnalysis = classResult.analysis;
  if (!classAnalysis || typeof classAnalysis !== "object") {
    return { success: false, category: "openai_malformed_response", message: "Call A returned null/invalid object" };
  }
  if (!classAnalysis.isDeal) {
    return { success: true, isDeal: false };
  }

  // ── Call B: Data extraction
  const extractResult = await callAI(extractionCfg, EXTRACTION_PROMPT, userPrompt, 800);
  if (!extractResult.success) {
    return { success: false, category: extractResult.category, message: extractResult.message };
  }
  const extractAnalysis = extractResult.analysis;
  if (!extractAnalysis || typeof extractAnalysis !== "object") {
    return { success: false, category: "openai_malformed_response", message: "Call B returned null/invalid object" };
  }

  let analysis: any = { ...classAnalysis, ...extractAnalysis };

  // ── Call C: Verification (only if deadline or estimatedValue is non-null)
  if (analysis.deadline != null || analysis.estimatedValue != null) {
    const verifyUserPrompt = `${userPrompt}\n\nClaimed deadline: "${analysis.deadline ?? "null"}"\nClaimed value: ${analysis.estimatedValue ?? "null"}`;
    const verifyResult = await callAI(miniCfg, VERIFICATION_PROMPT, verifyUserPrompt, 200);

    if (verifyResult.success) {
      const v = verifyResult.analysis;
      if (analysis.deadline != null && v.deadlineVerified === false) {
        analysis = { ...analysis, deadline: null };
        log("info", "ai", `${groupLabel} — deadline verification failed, set to null`);
      }
      if (analysis.estimatedValue != null && v.valueVerified === false) {
        analysis = { ...analysis, estimatedValue: null };
        log("info", "ai", `${groupLabel} — estimatedValue verification failed, set to null`);
      }
    } else {
      log("warn", "ai", `${groupLabel} — Call C verification failed (${verifyResult.message}), keeping extracted values`);
    }
  }

  return { success: true, isDeal: true, analysis };
}

/** Parse one Gmail message the scanner way (partner = the other side). Null = skip. */
function toEmailData(msg: any, threadIdOverride: string | null, myEmail: string): EmailData | null {
  const headers = msg.payload?.headers ?? [];
  const fromRaw = getHeader(headers, "From");
  const toRaw = getHeader(headers, "To");
  const subject = getHeader(headers, "Subject");
  const date = getHeader(headers, "Date");
  const fromEmail = extractEmail(fromRaw);
  const isFromMe = myEmail ? fromEmail === myEmail : false;

  let partnerEmail: string, partnerName: string;
  if (isFromMe) {
    const firstTo = toRaw.split(",")[0]?.trim() ?? "";
    partnerEmail = extractEmail(firstTo);
    partnerName = extractName(firstTo) || partnerEmail;
  } else {
    partnerEmail = fromEmail;
    partnerName = extractName(fromRaw);
  }
  if (!partnerEmail || isAutobot(partnerEmail)) return null;

  const parts = extractParts(msg.payload);
  const internal = parseInt(msg.internalDate ?? "", 10);
  const headerTs = Date.parse(date);
  return {
    id: msg.id ?? "", threadId: threadIdOverride ?? msg.threadId ?? "",
    ts: Number.isFinite(internal) && internal > 0 ? internal : (Number.isFinite(headerTs) ? headerTs : 0),
    subject, date, fromEmail, isFromMe, partnerEmail, partnerName,
    plainBody: parts.plainText, htmlBody: parts.htmlText,
    attachments: parts.attachments,
    urls: [...new Set(parts.urls)].slice(0, 20),
    score: bizScore(`${subject} ${parts.plainText || parts.htmlText}`),
  };
}

/* ── Deal matching, stage guard, human-touch detection ─────────────────────── */

/**
 * Bug 4 (unified 2026-09-30): find the existing deal for a conversation with the
 * SHARED matcher (matching.ts) — the same rules as the deal card's Files, the
 * Emails page and the live agent. Each of the group's threads (newest first) →
 * the deal(s) it belongs to; a thread not synced locally yet → the partner in a
 * deal's contact closure (brand guard), or on the deal's company domain with
 * the same brand. The brand the extraction names decides between several (an
 * agency pitches several brands from one address): a KNOWN brand that matches
 * none of the candidates' known brands means a new brand → a new deal. A deal
 * that owns the thread but is ARCHIVED is returned with `archived` so the
 * caller never creates its duplicate.
 */
export function matchExistingDeal(
  existingDeals: DealRecord[],
  partnerEmail: string,
  threadIds: string[],
  analysis: { projectName?: string; clientName?: string },
): { deal: DealRecord; by: "email" | "thread" | "domain"; archived?: boolean } | null {
  // The brand the extraction names (a known brand in the project name). An agency's OWN name
  // (a multi-brand domain named like the brand, e.g. "Mediamz" from mediamz.com) is not a brand.
  let hint = brandFromText(analysis.projectName);
  if (hint && isAgencyName(partnerEmail, hint)) hint = null;
  const cands = new Map<string, { h: ThreadDeal; order: number }>();
  [...new Set(threadIds.filter(Boolean))].forEach((tid, order) => {
    for (const h of dealsForThread(tid, { senderEmails: [partnerEmail], brand: hint })) {
      const cur = cands.get(h.dealId);
      if (!cur || order < cur.order || (order === cur.order && MATCH_RANK[h.matchedBy] < MATCH_RANK[cur.h.matchedBy])) cands.set(h.dealId, { h, order });
    }
  });
  let list = [...cands.values()];
  if (!list.length) return null;
  const text = `${analysis.projectName ?? ""} ${analysis.clientName ?? ""}`;
  const named = (b: string | null) => !!b && ((hint ? brandEq(b, hint) : false) || mentions(text, b));
  if (hint || list.some((c) => named(c.h.brand))) {
    const same = list.filter((c) => named(c.h.brand));
    if (same.length) list = same;
    else if (list.every((c) => c.h.brand)) return null; // every candidate is another brand → new brand, new deal
    else list = list.filter((c) => !c.h.brand);
  }
  // Open deals first (an archived one only when nothing open owns the conversation), newest thread first.
  // Then the card whose own name carries its brand (a card re-pointed at another brand's thread loses).
  const nameOf = (id: string) => { const d = existingDeals.find((x) => x.id === id) ?? deals.get(id); return `${d?.projectName ?? ""} ${d?.clientName ?? ""}`; };
  const ownName = (h: ThreadDeal) => (h.brand && mentions(nameOf(h.dealId), h.brand) ? 0 : 1);
  list.sort((a, b) => Number(a.h.archived) - Number(b.h.archived) || a.order - b.order || ownName(a.h) - ownName(b.h) ||
    MATCH_RANK[a.h.matchedBy] - MATCH_RANK[b.h.matchedBy] || b.h.updatedAt.localeCompare(a.h.updatedAt));
  const best = list[0].h;
  const by = best.matchedBy === "domain+brand" ? "domain" : best.matchedBy === "contact" || best.matchedBy === "platform" ? "email" : "thread";
  const live = existingDeals.find((d) => d.id === best.dealId);
  if (live) return { deal: live, by };
  const rec = deals.get(best.dealId);
  return rec ? { deal: rec, by, archived: true } : null;
}

/**
 * Bug 3 — when may the scanner change an existing deal's stage? ALL of:
 *   1. the deal is not in a production stage, and the new stage is not one
 *      (production columns are human-owned: never in, out, or backwards);
 *   2. the stage was not set through the board (stage_source = 'board': Jake in
 *      the UI, or the agent's board move) — the scanner only moves stages it set
 *      itself ('scan') or that nobody recorded (legacy rows);
 *   3. it is a real change and not a regression to the default "New Requests"
 *      column (an ongoing thread re-read as "new" is a misread, not news);
 *   4. the deal is not in a CLOSED column (rejected / poor_fit_now) — a decline
 *      is a decision; a returning brand is the agent's / Jake's call;
 *   5. it moves FORWARD in the board order, or into a closed column (the same
 *      rule the agent follows: never back from Waiting For Payment to Negotiation).
 */
export function stageMoveDecision(
  deal: DealRecord, newStage: string, prodDbNames: Set<string>, defaultStageName: string,
  order: Map<string, number>, closed: Set<string>,
): { move: boolean; why: string } {
  const cur = deal.stage ?? "";
  if (newStage === cur) return { move: false, why: "unchanged" };
  if (prodDbNames.has(cur)) return { move: false, why: `kept "${cur}" — production stages are human-owned` };
  if (prodDbNames.has(newStage)) return { move: false, why: `kept "${cur}" — the scanner never moves a deal into production ("${newStage}")` };
  if (deal.stageSource === "board") return { move: false, why: `kept "${cur}" — set on the board${deal.stageChangedAt ? ` ${deal.stageChangedAt.slice(0, 10)}` : ""}` };
  if (newStage === defaultStageName) return { move: false, why: `kept "${cur}" — not moving an ongoing deal back to "${defaultStageName}"` };
  if (closed.has(cur)) return { move: false, why: `kept "${cur}" — a closed deal is reopened by Jake or the agent, not the scanner` };
  if (cur && !closed.has(newStage) && (order.get(newStage) ?? 0) < (order.get(cur) ?? 0)) return { move: false, why: `kept "${cur}" — the scanner only moves deals forward (not to "${newStage}")` };
  return { move: true, why: `"${cur || "(none)"}" → "${newStage}"` };
}

/**
 * Bug 5 — has a human (or the agent, through the board API) curated this deal?
 * Any of: edited / moved / merged through the board (human_touched_at), a stage
 * set on the board, created by hand, in production, a comment by a non-machine
 * author, or an action that was changed or added after the deal was created
 * (the scanner's own to-dos are inserted with the deal).
 */
function isHumanTouched(deal: DealRecord): string | null {
  if (deal.humanTouchedAt) return "edited on the board";
  if (deal.stageSource === "board") return "stage set on the board";
  if (deal.source && !["gmail", "agent"].includes(deal.source)) return `created ${deal.source}`;
  if (deal.inProduction) return "in production";
  const comments = db.prepare(`SELECT author FROM deals_deal_comments WHERE deal_id = ?`).all(deal.id) as { author: string | null }[];
  if (comments.some((c) => !MACHINE_AUTHORS.has(c.author ?? "You"))) return "has comments";
  const created = Date.parse(deal.createdAt ?? "");
  // To-dos the email autofill wrote or ticked (source / status_by 'auto') are machine work, not curation.
  const actions = db.prepare(`SELECT status, created_at, source, status_by FROM deals_deal_actions WHERE deal_id = ?`).all(deal.id) as { status: string | null; created_at: string; source: string | null; status_by: string | null }[];
  if (actions.some((a) => a.status_by === "human"
    || (a.source !== "auto" && (((a.status ?? "Pending") !== "Pending" && a.status_by !== "auto") || !Number.isFinite(created) || Date.parse(a.created_at) - created > 5 * 60_000)))) return "has actions";
  return null;
}

/* ── Main ──────────────────────────────────────────────────────────────────── */

export const scanGmailInput = z.object({
  daysBack: z.number().optional(),
  targetEmail: z.string().optional(),
});

export interface ScanResult {
  created: number; updated: number; nonDeals: number; errored: number; skipped: number;
  scanned: number; senderGroups: number; groupsProcessed: number; groupsCapped: number;
  topErrorCategory: string; sampleErrors: string[]; message: string; logs: ScanLogEntry[];
}

/**
 * The endpoint: waits for the process-wide Gmail lock (so it never runs next to
 * the scheduled sync pipeline), then scans. Same input/output as before.
 */
export function scanGmail(raw: unknown, onLog?: (e: ScanLogEntry) => void): Promise<ScanResult> {
  const input = parse(scanGmailInput, raw); // validate before queueing
  return withSyncLock(() => scanGmailUnlocked(input, onLog));
}

/** The scan itself. Callers must hold the sync lock (the pipeline does). */
export async function scanGmailUnlocked(raw: unknown, onLog?: (e: ScanLogEntry) => void): Promise<ScanResult> {
  const input = parse(scanGmailInput, raw);
  const { stagesForAI, toDB: stageToDB, prodDbNames, records: stageRecords } = await loadStageConfig();
  const stageOrder = new Map(stageRecords.map((r) => [r.displayName ?? "", r.sortOrder ?? 0]));
  const closedStages = new Set(["rejected", "poor_fit_now"].map((k) => stageToDB[k]).filter(Boolean));
  const defaultStageName = stageToDB["new_requests"] ?? "New Requests";
  const classifySystem = classificationPrompt(stagesForAI);
  const { entries: logs, log } = makeLogger(onLog);

  try {
    const empty = (msg: string): ScanResult => ({
      created: 0, updated: 0, nonDeals: 0, errored: 0, skipped: 0,
      scanned: 0, senderGroups: 0, groupsProcessed: 0, groupsCapped: 0,
      topErrorCategory: "", sampleErrors: [], message: msg, logs,
    });

    // ── Clients
    if (connectedAccounts().length === 0) {
      log("error", "auth", "No Gmail account connected. Please add an account in Settings.");
      return empty("No Gmail account connected. Please add an account in Settings → Gmail Accounts.");
    }

    // ── Preflight (credentials check — see header)
    const candidates = [scanModel(), modelForTier("fast")];
    log("info", "preflight", `Testing AI model availability… Candidates: ${candidates.join(", ")}`);
    if (!anthropicConfigured()) {
      const reason = "Anthropic API key is invalid or missing.";
      log("error", "preflight", `FAILED — ${reason}`);
      return empty(`AI preflight failed — scan aborted. Reason: ${reason}`);
    }
    const aiCfg: WorkingConfig = { tier: "research", purpose: "deals-extract" };
    log("success", "preflight", `Model selected: ${candidates[0]} | JSON mode: true`);

    // ── Run mode
    const targetEmail = input.targetEmail?.toLowerCase().trim();
    const daysBack = input.daysBack ?? 7;
    const isCron = !targetEmail && daysBack <= 1;
    const runCfg = isCron ? CONFIG.cron : CONFIG.manual;
    const afterTs = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
    log("info", "config", `Run mode: ${runCfg.label} | daysBack=${daysBack} | maxMessages=${runCfg.maxMessages} | maxGroups=${runCfg.maxGroups}`);

    // ── My email
    let myEmail = "";
    try {
      const p = await gmail.getProfile();
      myEmail = (p.emailAddress ?? "").toLowerCase();
      log("info", "gmail", `Authenticated Gmail account: ${myEmail}`);
    } catch (e: any) {
      log("warn", "gmail", `Could not fetch Gmail profile: ${e?.message ?? "unknown"}`);
    }

    // ── Paginated Gmail fetch
    log("info", "gmail", `Fetching messages since ${new Date(afterTs * 1000).toLocaleDateString()} (after:${afterTs})…`);
    const allMsgIds: string[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const listRes: any = await gmail.listMessages(
          `after:${afterTs} -in:spam -in:trash${targetEmail ? ` (from:${targetEmail} OR to:${targetEmail})` : ""}`,
          500, pageToken,
        );
        for (const m of listRes.messages ?? []) {
          if (m.id) allMsgIds.push(m.id);
        }
        pageToken = listRes.nextPageToken ?? undefined;
        if (allMsgIds.length >= runCfg.maxMessages) break;
      } while (pageToken);
      if (pageToken) log("warn", "gmail", `Window has more than ${runCfg.maxMessages} messages — reading the newest ${runCfg.maxMessages} (safety cap); older ones in the window are not scanned this run`);
    } catch (e: any) {
      log("error", "gmail", `Failed to list messages: ${e?.message ?? "unknown"}`);
      return empty(`Gmail listing failed: ${e?.message ?? "unknown"}`);
    }

    const msgIds = allMsgIds.slice(0, runCfg.maxMessages);
    const hitMsgCap = allMsgIds.length >= runCfg.maxMessages;
    log("info", "gmail", `Found ${allMsgIds.length} message IDs${hitMsgCap ? ` (capped at ${runCfg.maxMessages})` : ""}`);

    if (msgIds.length === 0) {
      log("warn", "gmail", "No emails found in scan window — nothing to process");
      return empty(`No emails found in the ${runCfg.label} scan window.`);
    }

    // ── Fetch full messages
    log("info", "gmail", `Fetching full content for ${msgIds.length} messages in batches of 10…`);
    const emailsFound: EmailData[] = [];
    let batchesDone = 0;
    for (let i = 0; i < msgIds.length; i += 10) {
      const batch = msgIds.slice(i, i + 10);
      const results = await Promise.allSettled(batch.map((id) => gmail.getMessage(id, "full")));
      batchesDone++;
      for (const res of results) {
        if (res.status !== "fulfilled") continue;
        try {
          const e = toEmailData(res.value, null, myEmail);
          if (e) emailsFound.push(e);
        } catch { /* skip malformed */ }
      }
      if (batchesDone % 5 === 0 || i + 10 >= msgIds.length) {
        log("info", "gmail", `Batch ${batchesDone}/${Math.ceil(msgIds.length / 10)} done — ${emailsFound.length} emails parsed so far`);
      }
    }
    log("success", "gmail", `Fetched and parsed ${emailsFound.length} emails (excluded autobots & unresolvable senders)`);

    // ── Group by partner
    const groups = new Map<string, EmailData[]>();
    for (const e of emailsFound) {
      if (!groups.has(e.partnerEmail)) groups.set(e.partnerEmail, []);
      groups.get(e.partnerEmail)!.push(e);
    }
    log("info", "groups", `Grouped into ${groups.size} unique sender conversations`);

    // ── Fetch existing deals
    log("info", "database", "Fetching existing deals from database…");
    let existingDeals: DealRecord[] = [];
    try {
      existingDeals = deals.where(`${ARCHIVED_FALSE} ORDER BY created_at, rowid LIMIT 10000`);
      log("info", "database", `Found ${existingDeals.length} existing active deals`);
    } catch (e: any) {
      log("error", "database", `Failed to fetch existing deals: ${e?.message ?? "unknown"}`);
    }

    // ── Sort and cap groups
    if (targetEmail) {
      for (const key of [...groups.keys()]) {
        if (key !== targetEmail) groups.delete(key);
      }
    }

    // Which conversations to process when there are more than the cap: highest
    // biz-signal first, newest activity breaking ties.
    const sortedGroups = [...groups.entries()].sort(([, a], [, b]) =>
      (b.reduce((s, e) => s + e.score, 0) - a.reduce((s, e) => s + e.score, 0)) ||
      (Math.max(...b.map((e) => e.ts)) - Math.max(...a.map((e) => e.ts))),
    );
    const groupsToProcess = sortedGroups.slice(0, runCfg.maxGroups);
    const groupsCapped = Math.max(0, sortedGroups.length - groupsToProcess.length);

    if (groupsCapped > 0) {
      log("warn", "groups", `Processing top ${runCfg.maxGroups} groups by biz-signal score; ${groupsCapped} groups skipped (batch cap)`);
    } else {
      log("info", "groups", `Processing all ${groupsToProcess.length} groups`);
    }

    // ── Process each group
    let created = 0, updated = 0, nonDeals = 0, errored = 0;
    const errorCategoryCounts: Record<string, number> = {};
    const sampleErrorMessages: string[] = [];
    const recordError = (category: string, message: string) => {
      errored++;
      errorCategoryCounts[category] = (errorCategoryCounts[category] ?? 0) + 1;
      if (sampleErrorMessages.length < 5) sampleErrorMessages.push(`[${category}] ${message}`);
    };
    /** Deal ids read in Pass 1 — Pass 2 skips them. */
    const touchedDealIds = new Set<string>();

    for (let gi = 0; gi < groupsToProcess.length; gi++) {
      const [partnerEmailKey, groupEmails] = groupsToProcess[gi];
      const groupLabel = `[${gi + 1}/${groupsToProcess.length}] ${partnerEmailKey}`;

      try {
        const sorted = [...groupEmails].sort(newestFirst);
        const latestInbound = sorted.find((e) => !e.isFromMe) ?? sorted[0];
        const latestAny = sorted[0];
        const inboundCount = groupEmails.filter((e) => !e.isFromMe).length;
        const sentCount = groupEmails.filter((e) => e.isFromMe).length;
        const topScore = Math.max(0, ...sorted.map((e) => e.score));

        log("info", "ai", `${groupLabel} — ${groupEmails.length} emails (${inboundCount} inbound, ${sentCount} sent) | biz score: ${topScore}`);

        const allUrls = [...new Set(sorted.flatMap((e) => e.urls))].slice(0, 25);
        const uniqueAtts = conversationAttachments(sorted);

        const attachContents: string[] = [];
        for (const att of uniqueAtts.slice(0, 2)) {
          const c = await fetchAttachmentText(att.messageId, att.attachmentId, att.mimeType);
          if (c) {
            attachContents.push(`[CONTRACT/ATTACHMENT — HIGH PRIORITY SOURCE: ${att.name}]\n${c}`);
            log("info", "attachments", `${groupLabel} — fetched attachment: ${att.name} (${att.mimeType})`);
          }
        }

        const urlContents: string[] = [];
        for (const url of allUrls.filter(shouldFetchUrl).slice(0, 2)) {
          const c = await fetchUrlText(url);
          if (c) {
            urlContents.push(`[LINKED PAGE: ${url}]\n${c}`);
            log("info", "urls", `${groupLabel} — fetched linked page: ${url}`);
          }
        }

        const emailsContext = buildEmailsContext(sorted);

        const userPrompt = [
          `Contact: ${(latestInbound ?? latestAny).partnerName} <${partnerEmailKey}>`,
          `Conversation: ${groupEmails.length} emails (${inboundCount} inbound, ${sentCount} sent by me)`,
          allUrls.length > 0 ? `All URLs:\n${allUrls.join("\n")}` : null,
          uniqueAtts.length > 0 ? `Attachments: ${uniqueAtts.map((a) => a.name).join(", ")}` : null,
          attachContents.length > 0 ? attachContents.join("\n\n") : null,
          urlContents.length > 0 ? urlContents.join("\n\n") : null,
          "", emailsContext,
        ].filter(Boolean).join("\n");

        const pipelineResult = await runAIPipeline(aiCfg, classifySystem, userPrompt, groupLabel, log);

        if (!pipelineResult.success) {
          recordError(pipelineResult.category, pipelineResult.message);
          log("error", "ai", `${groupLabel} — AI failed: [${pipelineResult.category}] ${pipelineResult.message}`);
          continue;
        }

        if (!pipelineResult.isDeal) {
          nonDeals++;
          log("info", "ai", `${groupLabel} — classified as non-deal`);
          continue;
        }

        const { analysis } = pipelineResult;

        const stage: string = (stagesForAI as string[]).includes(analysis.stage) ? analysis.stage : defaultStageName;
        const confidence = ["High", "Medium", "Low"].includes(analysis.confidence) ? analysis.confidence : "Medium";
        const threadUrl = `https://mail.google.com/mail/u/0/#all/${(latestInbound ?? latestAny).threadId}`;

        log("success", "ai", `${groupLabel} — isDeal=true | stage="${stage}" | confidence=${confidence} | project="${analysis.projectName || "?"}"`);

        // Newest thread first: the extraction reads the conversation newest first.
        const match = matchExistingDeal(existingDeals, partnerEmailKey, [...new Set(sorted.map((e) => e.threadId))], analysis);
        if (match?.archived) {
          touchedDealIds.add(match.deal.id);
          log("info", "database", `${groupLabel} — belongs to ARCHIVED deal "${match.deal.projectName || match.deal.clientName}" (matched by ${match.by}) — left as is, no duplicate created`);
          continue;
        }
        const existing = match?.deal;
        if (existing) {
          try {
            touchedDealIds.add(existing.id);
            const structuredFields = buildStructuredFields(analysis, threadUrl, existing);
            const updatedEstimatedValue =
              (existing.estimatedValue && existing.estimatedValue !== 0)
                ? existing.estimatedValue
                : (analysis.estimatedValue ?? null);
            const now = new Date().toISOString();
            const decision = stageMoveDecision(existing, stage, prodDbNames, defaultStageName, stageOrder, closedStages);

            deals.update(existing.id, {
              ...structuredFields,
              // Confidence is never overwritten; the stage only under stageMoveDecision's guard.
              ...(decision.move ? { stage, stageSource: "scan", stageChangedAt: now } : {}),
              // The deal keeps its source thread: its other threads belong to it through the shared
              // matcher (re-pointing the source moved agency deals onto another brand's thread).
              ...(existing.sourceThreadId ? {} : { sourceEmailId: (latestInbound ?? latestAny).id, sourceThreadId: (latestInbound ?? latestAny).threadId }),
              estimatedValue: updatedEstimatedValue ?? undefined,
              lastReviewedAt: now,
            });
            updated++;
            log("success", "database", `${groupLabel} — UPDATED existing deal "${existing.projectName || existing.clientName}" (matched by ${match!.by}) | stage: ${decision.move ? decision.why : `unchanged (${decision.why})`}`);
          } catch (dbErr: any) {
            const { category, message } = categorizeError(dbErr);
            recordError(category, message);
            log("error", "database", `${groupLabel} — Failed to update deal: [${category}] ${message}`);
          }
        } else {
          const clientName = String(analysis.clientName || (latestInbound ?? latestAny).partnerName || partnerEmailKey).trim();
          const projectName = String(analysis.projectName || (latestInbound ?? latestAny).subject || "Untitled Opportunity").slice(0, 120);
          // A new deal never starts in a production column (production is human-owned).
          const newStage = prodDbNames.has(stage) ? defaultStageName : stage;
          if (newStage !== stage) log("info", "ai", `${groupLabel} — classified as production stage "${stage}"; creating in "${newStage}" (production moves are Jake's)`);
          try {
            const structuredFields = buildStructuredFields(analysis, threadUrl);
            const now = new Date().toISOString();
            const newDeal = deals.insert({
              clientName, clientEmail: partnerEmailKey, projectName,
              ...structuredFields,
              stage: newStage, confidence, source: "gmail",
              stageSource: "scan", stageChangedAt: now, lastReviewedAt: now,
              sourceEmailId: (latestInbound ?? latestAny).id,
              sourceThreadId: (latestInbound ?? latestAny).threadId,
              currency: "USD", archived: false,
              estimatedValue: analysis.estimatedValue ?? undefined,
            });
            created++;
            existingDeals.push(newDeal); // a later group from the same company matches it instead of duplicating
            invalidateMatching(); // …through the shared matcher, at once
            touchedDealIds.add(newDeal.id);
            log("success", "database", `${groupLabel} — CREATED new deal "${projectName}" for ${clientName}`);
            const todosToAdd: string[] = Array.isArray(analysis.todos) ? analysis.todos.slice(0, 5) : [];
            if (todosToAdd.length > 0) {
              try {
                for (const t of todosToAdd) dealActions.insert({ content: String(t), status: "Pending", deal: newDeal.id });
                log("info", "database", `${groupLabel} — Created ${todosToAdd.length} AI todos`);
              } catch (tErr: any) {
                log("warn", "database", `${groupLabel} — Failed to create todos: ${tErr?.message ?? "unknown"}`);
              }
            }
          } catch (dbErr: any) {
            const { category, message } = categorizeError(dbErr);
            recordError(category, message);
            log("error", "database", `${groupLabel} — Failed to create deal: [${category}] ${message}`);
          }
        }
      } catch (groupErr: any) {
        const { category, message } = categorizeError(groupErr);
        recordError(category, message);
        log("error", "ai", `${groupLabel} — Unhandled exception: [${category}] ${message}`);
      }
    }

    // ── Pass 2: Force-update existing deals not covered in Pass 1 (manual only)
    if (!isCron && !targetEmail) {
      // Rotation (bug 5): the deals re-read longest ago (never-reviewed first), not the same first five.
      const processedEmails = new Set(groupsToProcess.map(([email]) => email));
      const unprocessedDeals = existingDeals
        .filter((d) => d.clientEmail && d.sourceThreadId && !touchedDealIds.has(d.id) && !processedEmails.has(d.clientEmail.toLowerCase()))
        .sort((a, b) => (a.lastReviewedAt ?? "").localeCompare(b.lastReviewedAt ?? "") || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
        .slice(0, BACKFILL_PER_RUN);

      log("info", "backfill", `Pass 2: ${unprocessedDeals.length} existing deals not covered by email window (least recently reviewed) — fetching their threads directly`);

      for (const deal of unprocessedDeals) {
        const groupLabel = `[backfill] ${deal.clientEmail}`;
        // Stamp first, so a deal that keeps failing still rotates to the back of the queue.
        deals.update(deal.id, { lastReviewedAt: new Date().toISOString() });
        try {
          // The deal's live conversation (shared matcher), else its source thread.
          const thread: any = await gmail.getThread(latestThreadForDeal(deal.id)?.threadId ?? deal.sourceThreadId!);
          const msgs: any[] = thread.messages ?? [];
          if (msgs.length === 0) continue;

          const threadEmailsData: EmailData[] = [];
          for (const msg of msgs) {
            const e = toEmailData(msg, thread.id ?? "", myEmail);
            if (e) threadEmailsData.push(e);
          }
          if (threadEmailsData.length === 0) continue;

          const sorted = [...threadEmailsData].sort(newestFirst);
          const latestInbound = sorted.find((e) => !e.isFromMe) ?? sorted[0];
          const latestAny = sorted[0];
          const inboundCount = threadEmailsData.filter((e) => !e.isFromMe).length;
          const sentCount = threadEmailsData.filter((e) => e.isFromMe).length;

          const allUrls = [...new Set(sorted.flatMap((e) => e.urls))].slice(0, 25);
          const uniqueAtts = conversationAttachments(sorted);

          const attachContents: string[] = [];
          for (const att of uniqueAtts.slice(0, 2)) {
            const c = await fetchAttachmentText(att.messageId, att.attachmentId, att.mimeType);
            if (c) attachContents.push(`[CONTRACT/ATTACHMENT — HIGH PRIORITY SOURCE: ${att.name}]\n${c}`);
          }

          const urlContents: string[] = [];
          for (const url of allUrls.filter(shouldFetchUrl).slice(0, 2)) {
            const c = await fetchUrlText(url);
            if (c) urlContents.push(`[LINKED PAGE: ${url}]\n${c}`);
          }

          const emailsContext = buildEmailsContext(sorted);

          const userPrompt = [
            `Contact: ${(latestInbound ?? latestAny).partnerName} <${deal.clientEmail}>`,
            `Conversation: ${threadEmailsData.length} emails (${inboundCount} inbound, ${sentCount} sent by me)`,
            allUrls.length > 0 ? `All URLs:\n${allUrls.join("\n")}` : null,
            attachContents.length > 0 ? attachContents.join("\n\n") : null,
            urlContents.length > 0 ? urlContents.join("\n\n") : null,
            "", emailsContext,
          ].filter(Boolean).join("\n");

          const pipelineResult = await runAIPipeline(aiCfg, classifySystem, userPrompt, groupLabel, log);

          if (!pipelineResult.success) {
            recordError(pipelineResult.category, pipelineResult.message);
            log("error", "ai", `${groupLabel} — AI failed: ${pipelineResult.message}`);
            continue;
          }

          if (!pipelineResult.isDeal) {
            // Never auto-archive a curated deal (bug 5): flag it for Jake instead.
            const touched = isHumanTouched(deal);
            if (touched) {
              const flag = `Scanner re-read this thread on ${new Date().toISOString().slice(0, 10)} and thinks it is not a deal. Not archived because it was curated (${touched}) — archive it yourself if that's right.`;
              if (!deal.reviewFlag) {
                deals.update(deal.id, { reviewFlag: flag });
                dealComments.insert({ content: flag, author: "Scanner", deal: deal.id });
              }
              log("warn", "database", `${groupLabel} — Re-classified as non-deal, NOT archived (${touched}) — flagged for review`);
            } else {
              deals.update(deal.id, { archived: true });
              log("info", "database", `${groupLabel} — Re-classified as non-deal, archived (no human edits, comments or actions)`);
            }
            nonDeals++;
            continue;
          }

          const { analysis } = pipelineResult;
          const threadUrl = `https://mail.google.com/mail/u/0/#all/${(latestInbound ?? latestAny).threadId}`;
          const backfillStage: string = (stagesForAI as string[]).includes(analysis.stage) ? analysis.stage : defaultStageName;
          const decision = stageMoveDecision(deal, backfillStage, prodDbNames, defaultStageName, stageOrder, closedStages);

          const structuredFields = buildStructuredFields(analysis, threadUrl, deal);
          const updatedEstimatedValue =
            (deal.estimatedValue && deal.estimatedValue !== 0)
              ? deal.estimatedValue
              : (analysis.estimatedValue ?? null);

          deals.update(deal.id, {
            ...structuredFields,
            // Confidence is never overwritten; the stage only under stageMoveDecision's guard.
            ...(decision.move ? { stage: backfillStage, stageSource: "scan", stageChangedAt: new Date().toISOString() } : {}),
            ...(deal.sourceThreadId ? {} : { sourceEmailId: (latestInbound ?? latestAny).id, sourceThreadId: (latestInbound ?? latestAny).threadId }),
            estimatedValue: updatedEstimatedValue ?? undefined,
          });
          updated++;
          log("success", "database", `${groupLabel} — UPDATED (backfill) "${deal.projectName || deal.clientName}" | stage: ${decision.move ? decision.why : `unchanged (${decision.why})`}`);
        } catch (err: any) {
          const { category, message } = categorizeError(err);
          recordError(category, message);
          log("error", "backfill", `${groupLabel} — Failed: [${category}] ${message}`);
        }
      }
    }

    // ── Summary
    const skipped = nonDeals + errored;
    const groupsProcessed = groupsToProcess.length;
    const topErrorCategory = Object.entries(errorCategoryCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "";

    const capNote = hitMsgCap ? ` Message cap of ${runCfg.maxMessages} reached.` : "";
    const groupNote = groupsCapped > 0 ? ` ${groupsCapped} sender group${groupsCapped !== 1 ? "s" : ""} not processed (batch limit).` : "";

    let message: string;
    if (errored > 0 && errored === groupsProcessed) {
      message = `Scanned ${emailsFound.length} emails across ${groups.size} senders. Processed ${groupsProcessed} groups: ALL ${errored} FAILED. Primary failure: ${topErrorCategory || "unknown"}. Model: ${candidates[0]}.${groupNote}${capNote}`;
    } else if (errored > 0) {
      message = `Scanned ${emailsFound.length} emails across ${groups.size} senders, processed ${groupsProcessed} groups: ${created} created, ${updated} updated, ${nonDeals} non-deals, ${errored} errors (${topErrorCategory}).${groupNote}${capNote}`;
    } else if (created + updated === 0) {
      message = `Scanned ${emailsFound.length} emails across ${groups.size} senders, processed ${groupsProcessed} groups: ${nonDeals} classified as non-deals, 0 created, 0 updated.${groupNote}${capNote}`;
    } else {
      message = `Scanned ${emailsFound.length} emails across ${groups.size} senders, processed ${groupsProcessed} groups: ${created} created, ${updated} updated, ${nonDeals} non-deals.${groupNote}${capNote}`;
    }

    log(errored > 0 && errored === groupsProcessed ? "error" : errored > 0 ? "warn" : "success", "summary",
      `SCAN COMPLETE — emails: ${emailsFound.length} | senders: ${groups.size} | processed: ${groupsProcessed} | created: ${created} | updated: ${updated} | non-deals: ${nonDeals} | errors: ${errored}${groupsCapped > 0 ? ` | capped: ${groupsCapped}` : ""}`,
    );

    return {
      created, updated, nonDeals, errored, skipped,
      scanned: emailsFound.length, senderGroups: groups.size,
      groupsProcessed, groupsCapped,
      topErrorCategory, sampleErrors: sampleErrorMessages,
      message, logs,
    };
  } catch (fatalErr: any) {
    const msg = fatalErr?.message ?? String(fatalErr ?? "Unknown fatal error");
    log("error", "fatal", `Unhandled exception: ${msg.slice(0, 300)}`);
    return {
      created: 0, updated: 0, nonDeals: 0, errored: 1, skipped: 0,
      scanned: 0, senderGroups: 0, groupsProcessed: 0, groupsCapped: 0,
      topErrorCategory: "unknown_error",
      sampleErrors: [`[fatal] ${msg.slice(0, 300)}`],
      message: `Scan failed with an unexpected error: ${msg.slice(0, 200)}`,
      logs,
    };
  }
}
