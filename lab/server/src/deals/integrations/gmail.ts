/**
 * Deal Organizer — Gmail.
 *
 * WHAT THE AGENT MAY DO WITH THE MAILBOX (rulebook #13, #15, #69):
 *   read threads, apply/create labels, create DRAFTS, mark spam.
 * WHAT IT MUST NEVER DO: send. Automated processes only ever draft.
 *
 * MANUAL SENDS (Jake 2026-10-02): a Send button Jake clicks inside the Deal
 * Organizer may send — "drafting is a rule only for automated processes".
 * Such a call runs inside `runAsManualSend()`, which ONLY routes.ts opens, and
 * only for the explicit send handlers (sendReply / sendFollowUp with
 * mode "send", sendGmailDraft). The scheduler, the agent, the follow-up job,
 * the Slack watcher and the chat assistant never run inside it, so for them
 * every /send is still refused before a request leaves the box.
 *
 * Google has no "drafts but not send" scope — gmail.modify (the narrowest one
 * that covers labels + drafts + spam) technically permits sending. So the rule
 * is enforced here, in this process, the way the Channel Audit enforces
 * read-only: the token is only ever attached to an allow-listed method + path.
 * Nothing in this module can delete permanently, change settings or forward.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getDealsGmailOAuth } from "../../settings/postizSecrets.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/**
 * Read-only Drive (Jake 2026-10-02): brands share briefs, contracts and videos
 * over Google Drive with the sponsor inbox; the Script Generator's deal reader
 * opens them. READ-ONLY — and only the GET calls in DRIVE_CALLS below are ever
 * made with it. Optional: without it the reader falls back to public links.
 */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
/** The only scopes a stored grant may carry. openid/email are harmless identity extras Google sometimes adds. */
const ALLOWED_SCOPES = new Set([GMAIL_SCOPE, DRIVE_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email"]);

/** method + path pattern (relative to users/me). The ONLY calls the token may make. */
const ALLOWED_CALLS: Array<[string, RegExp]> = [
  ["GET", /^\/profile$/],
  ["GET", /^\/threads$/],
  ["GET", /^\/messages$/],
  ["GET", /^\/history$/],
  ["GET", /^\/drafts\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/threads\/[A-Za-z0-9]+$/],
  ["GET", /^\/messages\/[A-Za-z0-9]+$/],
  ["GET", /^\/messages\/[A-Za-z0-9]+\/attachments\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/labels$/],
  ["POST", /^\/labels$/],
  ["POST", /^\/threads\/[A-Za-z0-9]+\/modify$/],
  ["GET", /^\/drafts$/],
  ["POST", /^\/drafts$/],
];

/** The two send calls — only ever allowed inside runAsManualSend(). */
const MANUAL_SEND_CALLS: Array<[string, RegExp]> = [
  ["POST", /^\/messages\/send$/],
  ["POST", /^\/drafts\/send$/],
];

const manualSend = new AsyncLocalStorage<{ fn: string }>();

/**
 * Run `fn` as a send Jake clicked in the Lab. Only routes.ts calls this, for
 * the named manual-send handlers; everything automated runs outside it.
 */
export function runAsManualSend<T>(handlerName: string, fn: () => T): T {
  return manualSend.run({ fn: handlerName }, fn);
}

export function inManualSend(): boolean {
  return Boolean(manualSend.getStore());
}

export class GmailPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailPolicyError";
  }
}

export function assertGmailScope(granted: string | undefined | null): void {
  const scopes = String(granted ?? "").trim().split(/\s+/).filter(Boolean);
  if (!scopes.length) return; // omitted on some refreshes; the stored grant is unchanged
  const extra = scopes.filter((s) => !ALLOWED_SCOPES.has(s));
  if (extra.length) throw new GmailPolicyError(`Gmail grant carries scopes the Deal Organizer must not hold: ${extra.join(", ")}. Nothing was saved.`);
  if (!scopes.includes(GMAIL_SCOPE)) throw new GmailPolicyError("Gmail grant is missing gmail.modify — tick every box on the consent screen.");
}

export function gmailConfigured(): boolean {
  return Boolean(getDealsGmailOAuth());
}

export function gmailConnected(): { connected: boolean; email: string | null } {
  const c = getDealsGmailOAuth();
  return { connected: Boolean(c?.refreshToken), email: c?.email ?? null };
}

let cached: { token: string; until: number } | null = null;
/** Scopes Google reported on the last refresh — tells whether Drive was granted. */
let grantedScopes: string | null = null;

export function forgetGmailToken(): void {
  cached = null;
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const c = getDealsGmailOAuth();
  if (!c) throw new Error("No Google OAuth client is configured for Gmail.");
  if (!c.refreshToken) throw new Error("Gmail is not connected. Connect it on the Deal Organizer page.");
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    const detail = j?.error === "invalid_grant" ? "the connection was revoked or expired — reconnect Gmail" : j?.error_description || j?.error || r.status;
    throw new Error(`Could not refresh Gmail access: ${detail}`);
  }
  assertGmailScope(j.scope); // a grant widened at Google's end is refused on every refresh
  if (j.scope) grantedScopes = String(j.scope);
  cached = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return cached.token;
}

/** The single door the token goes through. */
export async function gmailCall(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | string[]>): Promise<any> {
  if (/\/send\b/i.test(path)) {
    if (!inManualSend()) throw new GmailPolicyError("Refused: automated Deal Organizer processes never send email — they only write drafts.");
    if (!MANUAL_SEND_CALLS.some(([m, re]) => m === method && re.test(path))) throw new GmailPolicyError(`Refused: ${method} ${path} is not an allowed Gmail call.`);
  } else if (!ALLOWED_CALLS.some(([m, re]) => m === method && re.test(path))) {
    throw new GmailPolicyError(`Refused: ${method} ${path} is not an allowed Gmail call.`);
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x);
  const url = `${API}${path}${qs.toString() ? `?${qs}` : ""}`;
  const token = await accessToken();
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail ${method} ${path} failed (${r.status}): ${j?.error?.message || "unknown error"}`);
  return j;
}

// ── The operations the agent uses ─────────────────────────────────────────

export const getProfile = () => gmailCall("GET", "/profile");

export const listThreads = (q: string, maxResults = 50, pageToken?: string) =>
  gmailCall("GET", "/threads", undefined, { q, maxResults: String(maxResults), ...(pageToken ? { pageToken } : {}) });

export const getThread = (id: string) => gmailCall("GET", `/threads/${id}`, undefined, { format: "full" });

export const listLabels = () => gmailCall("GET", "/labels");

/** Find a user label by name, creating it if missing. Returns its id. */
export async function ensureLabel(name: string): Promise<string> {
  const { labels = [] } = await listLabels();
  const hit = labels.find((l: any) => l.name === name);
  if (hit) return hit.id;
  const made = await gmailCall("POST", "/labels", { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
  return made.id;
}

export const modifyThread = (id: string, addLabelIds: string[] = [], removeLabelIds: string[] = []) =>
  gmailCall("POST", `/threads/${id}/modify`, { addLabelIds, removeLabelIds });

/** Rulebook #69: suspicious senders are marked spam and never answered. */
export const markThreadSpam = (id: string) => modifyThread(id, ["SPAM"], ["INBOX"]);

export interface ReplyInput {
  threadId: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * The RFC 822 reply, built from parts so callers never hand-roll headers.
 * `html` (optional) adds a text/html part next to the plain-text body — used
 * for the signature's links. Returned base64url-encoded, as Gmail wants `raw`.
 */
function buildReplyRaw(input: ReplyInput): string {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
  const headers = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references || input.inReplyTo ? [`References: ${input.references || input.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  let mime: string;
  if (input.html) {
    const boundary = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    mime = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      // Plain-text copy: footer lines read "Website", not "Website <https://…>" (Jake 2026-10-01).
      // The links live on the words in the HTML part.
      b64(input.body.replace(/^([A-Za-z][A-Za-z ]{0,30}) <(?:(?:https?:\/\/|mailto:)[^\s>]+|[\w.+-]+@[\w.-]+\.\w+)>[ \t]*$/gm, "$1")),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(input.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    mime = [...headers, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(input.body)].join("\r\n");
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** Save a reply as a DRAFT in the thread. */
export async function createReplyDraft(input: ReplyInput) {
  return gmailCall("POST", "/drafts", { message: { threadId: input.threadId, raw: buildReplyRaw(input) } });
}

/** SEND a reply in the thread. Manual Lab sends only — refused outside runAsManualSend(). */
export async function sendReplyMessage(input: ReplyInput) {
  return gmailCall("POST", "/messages/send", { threadId: input.threadId, raw: buildReplyRaw(input) });
}

/** SEND a draft already saved in Gmail (e.g. the agent's), exactly as it is there. Manual Lab sends only. */
export async function sendSavedDraft(draftId: string) {
  return gmailCall("POST", "/drafts/send", { id: draftId });
}

export const listMessages = (q: string, maxResults = 100, pageToken?: string) =>
  gmailCall("GET", "/messages", undefined, { q, maxResults: String(maxResults), ...(pageToken ? { pageToken } : {}) });

export const getMessage = (id: string, format: "full" | "metadata" | "minimal" = "full") =>
  gmailCall("GET", `/messages/${id}`, undefined, { format });

export const getAttachment = (messageId: string, attachmentId: string) =>
  gmailCall("GET", `/messages/${messageId}/attachments/${attachmentId}`);

export const listDrafts = (q?: string, maxResults = 100) =>
  gmailCall("GET", "/drafts", undefined, { maxResults: String(maxResults), ...(q ? { q } : {}) });

export const getDraft = (id: string) => gmailCall("GET", `/drafts/${id}`, undefined, { format: "full" });

/** Web link to a thread in the connected inbox (for "Open in Gmail" buttons in the Lab). */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

/**
 * The thread link used in SLACK messages only. On Jake's phone/desktop Slack
 * the sponsor inbox is the 8th signed-in Google account → /u/8/ (Jake,
 * 2026-09-30: "only when he sends in Slack"). Override: DEALS_GMAIL_SLACK_BASE.
 */
export const GMAIL_SLACK_BASE = process.env.DEALS_GMAIL_SLACK_BASE || "https://mail.google.com/mail/u/8/#inbox";
export function gmailSlackThreadUrl(threadId: string): string {
  return `${GMAIL_SLACK_BASE}/${threadId}`;
}

/* ── Google Drive, READ-ONLY (the deal reader) ─────────────────────────────── */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
/** GET only: file metadata / download (alt=media), Google-file export, and a folder listing. */
const DRIVE_CALLS: RegExp[] = [/^\/files\/[A-Za-z0-9_-]+$/, /^\/files\/[A-Za-z0-9_-]+\/export$/, /^\/files$/];

/** True once the stored grant includes Drive (known after the first token refresh). */
export async function driveGranted(): Promise<boolean> {
  try {
    if (grantedScopes === null) cached = null; // a token from before this process knew to look: refresh once to learn the scopes
    await accessToken();
  } catch { return false; }
  return !!grantedScopes && grantedScopes.split(/\s+/).includes(DRIVE_SCOPE);
}

/** One read-only Drive GET. `binary` returns the body as a Buffer (downloads, exports). */
export async function driveGet(path: string, query: Record<string, string> = {}, binary = false): Promise<{ status: number; json: any; buf: Buffer | null; type: string }> {
  if (!DRIVE_CALLS.some((re) => re.test(path))) throw new GmailPolicyError(`Refused: GET ${path} is not an allowed Drive call.`);
  const token = await accessToken();
  const qs = new URLSearchParams({ supportsAllDrives: "true", ...query });
  const r = await fetch(`${DRIVE_API}${path}?${qs}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(180_000) });
  const type = r.headers.get("content-type") ?? "";
  if (binary && r.ok) return { status: r.status, json: null, buf: Buffer.from(await r.arrayBuffer()), type };
  const json: any = await r.json().catch(() => ({}));
  return { status: r.status, json, buf: null, type };
}
