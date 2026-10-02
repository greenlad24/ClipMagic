/**
 * Deal Organizer — shared plumbing for the Phase 2 endpoints (Gmail sync,
 * threads, companies, scan, replies, chat, analytics).
 *
 * Everything here replaces a Zite/googleapis/OpenAI dependency of the original
 * `src/api/*.ts` files with the Lab equivalent, keeping the original helper
 * functions (getHeader / extractEmail / extractParts / parseMessage …) verbatim
 * so the ported endpoint code stays line-for-line comparable:
 *
 *   googleapis gmail.users.*  → ./integrations/gmail.ts (the only door to Gmail;
 *                               allow-listed, refuses any send)
 *   zite.emailAccounts        → ONE account: the mailbox connected through the
 *                               Lab's own OAuth flow. Its deals_email_accounts
 *                               row only carries historyId / lastSyncedAt —
 *                               tokens are never read from (or written to) it.
 *   OpenAI gpt-4o-mini/4.1-mini → Claude `fast` tier; gpt-4o → `research` tier
 *   Gemini 1.5-pro-latest     → gemini-2.5-flash, thinking off
 *   ZITE_BRAVE_API_KEY        → the Lab's Brave key
 */
import { z } from "zod";
import { emailAccounts, toIsoDate, NOT_ARCHIVED, type EmailAccountRecord, type EmailRecord } from "./db.js";
import { gmailConnected } from "./integrations/gmail.js";
import { claudeJSONForPurpose, claudeTextForPurpose } from "../ai/claude.js";
import { getGeminiApiKey, getBraveSearchApiKey } from "../settings/postizSecrets.js";

export type Handler = (input: any) => Promise<unknown> | unknown;
export type Emit = (chunk: unknown) => void;
export type Streamer = (input: any, emit: Emit) => Promise<unknown>;

/* ── errors / input validation (same style as handlers.ts) ─────────────────── */

export function ziteError(code: "NOT_FOUND" | "BAD_REQUEST", message: string): Error {
  return Object.assign(new Error(message), { status: code === "NOT_FOUND" ? 404 : 400, code });
}

export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw Object.assign(new Error(msg), { status: 400 });
  }
  return r.data;
}

/**
 * The not-archived filter. Was Zite's strict `{ archived: false }` (which
 * dropped rows whose archived was NULL); now the single db.ts definition, where
 * NULL = not archived (bug 20). Name kept for the existing call sites.
 */
export const ARCHIVED_FALSE = NOT_ARCHIVED;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function safeJson(s: string | undefined): any {
  try { return JSON.parse(s ?? "[]"); } catch { return []; }
}

/* ── the one Gmail account ─────────────────────────────────────────────────── */

/** Original fallback identity, used where the Zite code did. */
export const FALLBACK_MY_EMAIL = "jakedawsonbusiness@gmail.com";

/**
 * Zite `emailAccounts.findAll({})`, for the single Lab-connected mailbox:
 * `[row]` when Gmail is connected (the row is created on first use, keyed by the
 * connected address), `[]` otherwise. The row never holds tokens.
 */
export function connectedAccounts(): EmailAccountRecord[] {
  const c = gmailConnected();
  if (!c.connected || !c.email) return [];
  const email = c.email.toLowerCase();
  let row = emailAccounts.where("lower(email) = ? ORDER BY created_at, rowid LIMIT 1", email)[0];
  if (!row) row = emailAccounts.insert({ email, displayName: email, provider: "gmail", historyId: "" });
  return [row];
}

/** The connected mailbox's account row, or null when Gmail is not connected. */
export function connectedAccount(): EmailAccountRecord | null {
  return connectedAccounts()[0] ?? null;
}

/**
 * The account an endpoint works on (bug 14): always the ONE connected mailbox.
 * An `accountEmail` input is accepted only when it names that mailbox
 * (case-insensitive); any other address is a 400, not a silent empty result.
 * Returns null when Gmail is not connected.
 */
export function resolveAccount(accountEmail?: string | null): EmailAccountRecord | null {
  const acct = connectedAccount();
  if (!acct) return null;
  const want = (accountEmail ?? "").trim().toLowerCase();
  if (want && want !== (acct.email ?? "").toLowerCase()) {
    throw Object.assign(new Error(`Only ${acct.email} is connected — ${accountEmail} is not a mailbox this app can read.`), { status: 400 });
  }
  return acct;
}

/** Free-mail domains: a shared domain says nothing about which company a sender belongs to. */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com", "naver.com", "hey.com",
  "fastmail.com", "tutanota.com", "hotmail.co.uk", "yahoo.co.uk", "outlook.fr", "hotmail.fr", "web.de",
]);
export function isFreemail(domain: string): boolean {
  const d = (domain ?? "").toLowerCase();
  return !d || FREEMAIL_DOMAINS.has(d) || /^(yahoo|hotmail|outlook|live)\./.test(d);
}

/* ── Gmail message helpers (verbatim from the original endpoints) ──────────── */

export function getHeader(h: { name?: string | null; value?: string | null }[], n: string): string {
  return h.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
}
export function extractEmail(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw.match(/\S+@\S+/)?.[0] ?? raw).trim().toLowerCase();
}
export function extractName(raw: string): string {
  return raw.replace(/<[^>]+>/, "").trim().replace(/^"|"$/g, "") || extractEmail(raw);
}
export function decodeB64(data: string): string {
  try { return Buffer.from(data, "base64url").toString("utf-8"); }
  catch { try { return Buffer.from(data, "base64").toString("utf-8"); } catch { return ""; } }
}
/** syncEmails / getThread flavour of html → text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}
export function extractUrls(source: string): string[] {
  const href = [...source.matchAll(/href=["']([^"'#\s]{8,})["']/gi)].map((m) => m[1]);
  const inline = source.match(/https?:\/\/[^\s<>"')\]]{8,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...href, ...inline]) {
    const c = u.replace(/[)>\],.;:'"]+$/, "");
    if (!seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out.slice(0, 30);
}

export interface PartResult {
  plainText: string; htmlText: string; rawHtml: string;
  urls: string[];
  attachments: { name: string; mimeType: string; attachmentId: string; size: number }[];
}

export function extractParts(payload: any, depth = 0): PartResult {
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
    r.attachments.push({ name: payload.filename, mimeType: mime, attachmentId: payload.body.attachmentId, size: payload.body.size ?? 0 });
    return r;
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const s = extractParts(part, depth + 1);
      if (!r.plainText) r.plainText = s.plainText;
      if (!r.htmlText) r.htmlText = s.htmlText;
      if (!r.rawHtml) r.rawHtml = s.rawHtml;
      r.urls.push(...s.urls);
      r.attachments.push(...s.attachments);
    }
    if (!r.plainText && r.htmlText) r.plainText = r.htmlText;
  }
  return r;
}

/** syncEmails `parseMessage` / getThread `parseGmailMessage` (+ dateIso for the Lab column). */
export function parseMessage(msg: any, myEmail: string, accountEmail: string): Partial<EmailRecord> | null {
  if (!msg?.id) return null;
  const headers = msg.payload?.headers ?? [];
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const subject = getHeader(headers, "Subject") || "(no subject)";
  const date = getHeader(headers, "Date");
  const fromEmail = extractEmail(from);
  const isFromMe = myEmail ? fromEmail === myEmail : false;
  const parts = extractParts(msg.payload);
  return {
    messageId: msg.id ?? "",
    threadId: msg.threadId ?? "",
    accountEmail,
    subject,
    fromEmail,
    fromName: extractName(from) || fromEmail,
    toEmail: to,
    date,
    dateIso: toIsoDate(date),
    snippet: (msg.snippet ?? "").slice(0, 200),
    bodyText: (parts.plainText || parts.htmlText).slice(0, 50000),
    bodyHtml: parts.rawHtml.slice(0, 200000),
    labels: JSON.stringify(msg.labelIds ?? []),
    attachments: JSON.stringify(parts.attachments),
    urLs: JSON.stringify(parts.urls.slice(0, 30)),
    isRead: !(msg.labelIds ?? []).includes("UNREAD"),
    isFromMe,
    historyId: String(msg.historyId ?? ""),
  };
}

/** lookupThread / generateReply / getFollowUpDrafts flavour: first text part, html flattened. */
export function extractText(payload: any, depth = 0): string {
  if (!payload || depth > 5) return "";
  const mime = payload.mimeType ?? "";
  if (payload.body?.data) {
    const decoded = decodeB64(payload.body.data);
    if (mime === "text/plain") return decoded;
    if (mime === "text/html") return decoded.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return "";
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const t = extractText(part, depth + 1);
      if (t.length > 10) return t;
    }
  }
  return "";
}

/* ── domains (listCompanies / getAnalytics) ─────────────────────────────────── */

export function domainOf(email: string) { return (email.split("@")[1] ?? "").toLowerCase(); }

export function rootDomain(domain: string): string {
  if (!domain) return "";
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const multiPart = ["co.uk", "co.nz", "co.jp", "com.au", "com.br", "org.uk", "net.au"];
  if (multiPart.includes(parts.slice(-2).join("."))) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/* ── AI ─────────────────────────────────────────────────────────────────────── */

type Tier = "fast" | "research";
type DealsPurpose = "deals-classify" | "deals-extract" | "deals-reply" | "deals-followup" | "deals-chat" | "deals-analytics" | "deals-company";
export interface Turn { role: "user" | "assistant"; content: string }

/**
 * The Anthropic API wants the conversation to open on a user turn and to
 * alternate; OpenAI did not care. Leading assistant turns are dropped and
 * consecutive same-role turns merged, so the original chat history can be
 * passed through untouched.
 */
export function toClaudeTurns(messages: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    if (!out.length && m.role !== "user") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out.length ? out : [{ role: "user", content: "(empty)" }];
}

/**
 * An OpenAI chat completion, on Claude. `system` may be "" (the call had no
 * system message). Temperature / max_tokens of the original cannot be passed
 * through the Lab helper — it uses the model's defaults.
 */
export async function aiText(tier: Tier, purpose: DealsPurpose, system: string, messages: Turn[], maxTokens?: number): Promise<string> {
  return (await claudeTextForPurpose({ tier, purpose, system, messages: toClaudeTurns(messages), maxTokens })).trim();
}

/** JSON-mode completion (`response_format: json_object`): returns the raw JSON text. */
export async function aiJSONText(tier: Tier, purpose: DealsPurpose, system: string, messages: Turn[]): Promise<string> {
  return await claudeJSONForPurpose({ tier, purpose, system, messages: toClaudeTurns(messages) });
}

export const GEMINI_MODEL = "gemini-2.5-flash";

/** The original `callGemini`: one prompt, text back. Throws on HTTP error. */
export async function callGemini(
  prompt: string,
  opts: { maxTokens: number; temperature: number; json?: boolean; pdfBase64?: string },
): Promise<string> {
  const key = getGeminiApiKey();
  if (!key) throw new Error("Gemini API key is not configured");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{
        parts: [
          ...(opts.pdfBase64 ? [{ inline_data: { mime_type: "application/pdf", data: opts.pdfBase64 } }] : []),
          { text: prompt },
        ],
      }],
      generationConfig: {
        ...(opts.json ? { response_mime_type: "application/json" } : {}),
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data: any = await res.json();
  const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p?.text ?? "").join("").trim();
}

export function braveKey(): string {
  return getBraveSearchApiKey() ?? "";
}
