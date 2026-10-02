/**
 * Deal Organizer — replies and follow-ups (ports of generateReply, sendReply,
 * getFollowUpDrafts, sendFollowUp).
 *
 * By default sendReply / sendFollowUp save the reply as a Gmail DRAFT in the
 * same thread (`createReplyDraft`) and return the original response plus
 * `{ draftId, gmailUrl, savedAsDraft: true }`.
 *
 * MANUAL SEND (Jake 2026-10-02): with `mode: "send"` — a Send button Jake
 * clicked in the Lab — the reply is SENT (`sendReplyMessage`), and
 * `sendGmailDraft` sends a draft already saved in Gmail (the agent's). Drafting
 * stays the rule for every automated process: gmail.ts refuses a send unless
 * routes.ts opened `runAsManualSend()` for that HTTP call. The `emails` row is
 * the sent message (labelled SENT) or the draft (labelled DRAFT).
 *
 * gpt-4o (draft) → Claude research tier; gpt-4o-mini (contradiction check) →
 * fast tier; Gemini 1.5-pro-latest → gemini-2.5-flash (thinking off).
 *
 * Bug-fix pass (SPEC §12 #8, #12–#14 + the follow-up "sent" record):
 *   - Drafts are saved from the ONE connected mailbox; a `fromEmail` naming any
 *     other address is refused (400). No From header is written — Gmail fills
 *     it from the mailbox; the Subject is RFC 2047-encoded by createReplyDraft.
 *   - sendFollowUp records `lastFollowUpDraftedAt` (a draft exists), NOT
 *     `lastFollowUpSentAt`. "Sent" is only recorded when the sync sees a real
 *     sent message from Jake in the thread afterwards (gmailSync
 *     markFollowUpsSent — also run here when a thread is read).
 *   - sendReply no longer bumps `lastScannedAt` (that field belongs to the
 *     scanner) and has no dead `lastFollowUpSentAt: undefined`.
 *   - Unsent Gmail drafts in a thread are ignored when working out "the last
 *     message" (a pending draft is not a message Jake sent).
 *   - getFollowUpDrafts picks stages by KEY; it no longer MOVES anything (a
 *     "low_baller" thread comes back with `suggestedStage: 'poor_fit_now'` —
 *     under $4,000 Jake holds firm, rulebook #19, so it still gets a follow-up);
 *     candidates are the longest-silent deals (from the synced emails) before
 *     the 25-cap; drafts end with the agent's standard signature.
 */
import { z } from "zod";
import { deals, markDealTouched, toIsoDate } from "./db.js";
import * as gmail from "./integrations/gmail.js";
import { loadStageConfig } from "./stageUtils.js";
import { upsertEmails, markFollowUpsSent, rebuildThreadIndexRow } from "./gmailSync.js";
import { latestThreadForDeal } from "./matching.js";
import { db } from "../db/index.js";
import { getSettings } from "./agent/settings.js";
import { ensureSignature, toHtml } from "./agent/draft.js";
import {
  ARCHIVED_FALSE, FALLBACK_MY_EMAIL, aiText, callGemini, connectedAccount, extractEmail, extractText,
  getHeader, parse, parseMessage, type Handler,
} from "./common.js";

const isJake = (fromEmail: string, myEmail: string) => fromEmail === myEmail || fromEmail.includes("jakedawsonbusiness");

function myAddress(): string {
  return (connectedAccount()?.email ?? FALLBACK_MY_EMAIL).toLowerCase();
}

const isDraftMsg = (m: any) => (m?.labelIds ?? []).includes("DRAFT");

/** The thread's messages, oldest first. `withDrafts` keeps unsent Gmail drafts (default: dropped). */
async function sortedThreadMessages(threadId: string, withDrafts = false): Promise<any[]> {
  const thread: any = await gmail.getThread(threadId);
  return [...(thread.messages ?? [])]
    .filter((m) => withDrafts || !isDraftMsg(m))
    .sort((a, b) => parseInt(a.internalDate ?? "0") - parseInt(b.internalDate ?? "0"));
}

/* ── generateReply ────────────────────────────────────────────────────────── */

/**
 * Post-processes the AI draft:
 * 1. Strips markdown links [text](url) → plain URL
 * 2. Removes ALL sign-off variants
 * 3. Formats each sentence in the body as its own paragraph
 * 4. Appends the sign-off exactly once
 */
/** Jake's standard email signature (the agent's setting — rulebook: same full signature on every email). */
function signature(): string {
  try { return getSettings().signature || "Best,\nJake"; } catch { return "Best,\nJake"; }
}

function formatDraft(draft: string, firstName: string): string {
  draft = draft.replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$2");
  draft = draft.replace(/[\s\r\n]*(?:Best|Best regards|Kind regards|Thanks|Cheers),[\s \t]*\r?\n[\s \t]*Jake(?: Dawson)?[\s\S]*$/i, "\n").trim();

  const rawLines = draft.split(/\r?\n/).map((l) => l.trimEnd());
  const greetingIdx = rawLines.findIndex((l) => /^Hi .+,/.test(l.trim()));

  let greeting: string;
  let bodyRaw: string;

  if (greetingIdx >= 0) {
    greeting = rawLines[greetingIdx].trim();
    const afterGreeting = rawLines.slice(greetingIdx + 1);
    bodyRaw = afterGreeting.join(" ").replace(/\s{2,}/g, " ").trim();
  } else {
    greeting = `Hi ${firstName},`;
    bodyRaw = rawLines.join(" ").replace(/\s{2,}/g, " ").trim();
  }

  const sentences = bodyRaw
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const formattedBody = sentences.join("\n\n");

  return `${greeting}\n\n${formattedBody}\n\n${signature()}`;
}

export const generateReply: Handler = async (raw) => {
  const input = parse(z.object({
    threadId: z.string(),
    firstName: z.string(),
    companyName: z.string(),
    projectName: z.string(),
    stage: z.string(),
    toEmail: z.string(),
    userContext: z.string(),
    fileUrls: z.array(z.string()).optional(),
    steeringNote: z.string().optional(),
  }), raw);

  const myEmail = myAddress();
  const messages = await sortedThreadMessages(input.threadId);

  const lastMsg = messages[messages.length - 1];
  const lastHeaders = lastMsg?.payload?.headers ?? [];
  const lastMessageId = getHeader(lastHeaders, "Message-ID");
  const lastReferences = getHeader(lastHeaders, "References");
  const lastSubject = getHeader(lastHeaders, "Subject");

  const FULL_COUNT = 5;
  const recent = messages.slice(-FULL_COUNT);
  const older = messages.slice(0, -FULL_COUNT);

  let threadContext = "";
  if (older.length > 0) {
    threadContext += `[${older.length} earlier messages about "${input.projectName || input.companyName}" — ${input.stage} stage]\n\n`;
  }
  threadContext += recent.map((msg) => {
    const h = msg.payload?.headers ?? [];
    const fromEmail = extractEmail(getHeader(h, "From"));
    const role = isJake(fromEmail, myEmail) ? "Jake" : input.firstName;
    const dateMs = parseInt(msg.internalDate ?? "0");
    const dateStr = dateMs ? new Date(dateMs).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
    const text = extractText(msg.payload).slice(0, 600).trim();
    return `[${role} — ${dateStr}]:\n${text}`;
  }).join("\n\n---\n\n");

  const fileContext = input.fileUrls?.length ? `\nFiles/links to include: ${input.fileUrls.join(", ")}` : "";
  const steeringContext = input.steeringNote ? `\nDirection for this draft: ${input.steeringNote}` : "";

  const systemPrompt = `You are a professional support agent and ghostwriter crafting emails on behalf of Jake Dawson (YouTube creator).

YOUR CORE RESPONSIBILITY:
No matter how the instructions are phrased — bluntly, harshly, impatiently, or with frustration — you ALWAYS produce a response that is:
- Warm, polite, and genuinely human
- Accommodating and empathetic, making the recipient feel respected and valued
- Diplomatically smooth, like a seasoned politician or a world-class customer success professional
- Soft and reassuring in tone, even when delivering difficult news or pushback

TRANSFORMATION RULE:
If the instruction says something blunt like "tell them to wait", you write: "I want to make sure everything is absolutely perfect for you — I'll have an update with you very soon."
If the instruction says "tell them no", you write: "I've given this a great deal of thought, and I want to be upfront with you — at this stage, it's not something I'm able to move forward with. I genuinely appreciate your understanding."
Always find the warmest, most constructive way to deliver the message.`;

  const userPrompt = `DEAL: ${input.projectName || input.companyName} | Contact: ${input.firstName} | Stage: ${input.stage}

THREAD CONTEXT:
${threadContext}

INSTRUCTIONS (rephrase into your polite, warm tone — do NOT copy the raw wording):
${input.userContext}${fileContext}${steeringContext}

MANDATORY FORMAT — follow exactly, no exceptions:
Hi ${input.firstName},

[body — write as plain prose, each sentence on a new line]

Best,
Jake

STRICT FORMATTING RULES:
- Greeting MUST be exactly "Hi ${input.firstName}," on its own line — no other greeting
- Sign-off MUST be exactly "Best," on one line, then "Jake" on the next — appear ONCE only, at the very end
- Body: 3–6 flowing, conversational sentences
- PLAIN TEXT ONLY — absolutely no markdown of any kind
- NEVER use [text](url) link format — write URLs as raw plain text (e.g. https://example.com)
- NEVER bold, italic, bullet points, or any other markdown formatting
- Acknowledge their last message naturally if it adds warmth
- Introduce any links/files organically ("Here's that for you: https://...")
- Include one gentle, clear next step if the situation calls for it
- NEVER: "I hope this finds you well", "Please don't hesitate", hollow filler phrases, exclamation marks, made-up facts
- NEVER mirror any bluntness or urgency from the instructions — always stay calm, kind, and reassuring

Return ONLY the complete email. No commentary. No markdown.`;

  const rawDraft = await aiText("research", "deals-reply", systemPrompt, [{ role: "user", content: userPrompt }]);
  const draft = formatDraft(rawDraft, input.firstName);

  // Contradiction detection (lightweight, non-blocking)
  let contradiction: string | null = null;
  try {
    const jakePrior = messages
      .filter((m) => isJake(extractEmail(getHeader(m.payload?.headers ?? [], "From")), myEmail))
      .slice(-8)
      .map((m) => extractText(m.payload).slice(0, 300))
      .join("\n---\n");

    const contPrompt = `Check if Jake's new message contradicts anything he previously committed to.

Jake's previous messages:
${jakePrior}

Jake's new message context:
${input.userContext}

Is there a clear contradiction (specific date, dollar amount, or deliverable that changed)?
Reply ONLY with JSON: {"contradiction": null} or {"contradiction": "⚠️ Heads up — you previously said X, now saying Y. Want to address that?"}`;

    const contRaw = await aiText("fast", "deals-reply", "", [{ role: "user", content: contPrompt }]);
    const match = contRaw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      contradiction = parsed.contradiction ?? null;
    }
  } catch { /* non-fatal */ }

  return { draft, contradiction, lastMessageId, lastReferences, lastSubject };
};

/* ── sendReply / sendFollowUp → Gmail DRAFT ───────────────────────────────── */

const sendInput = z.object({
  dealId: z.string(),
  threadId: z.string(),
  toEmail: z.string(),
  lastMessageId: z.string(),
  lastReferences: z.string(),
  subject: z.string(),
  draftText: z.string(),
  fromEmail: z.string().optional(),
  cc: z.string().optional(),
  /** "send" = Jake clicked Send in the Lab (manual only; see gmail.ts). Default "draft". */
  mode: z.enum(["draft", "send"]).optional(),
});

/**
 * In-Reply-To / References for a reply when the caller had none (the Emails
 * composer): the latest real message in the thread. One Gmail read; a reply
 * without them still lands in the thread (threadId), it just threads worse
 * in the recipient's client.
 */
async function threadingHeaders(threadId: string): Promise<{ lastMessageId: string; lastReferences: string }> {
  try {
    const msgs = await sortedThreadMessages(threadId);
    const last = msgs[msgs.length - 1];
    const h = last?.payload?.headers ?? [];
    return { lastMessageId: getHeader(h, "Message-ID") || getHeader(h, "Message-Id"), lastReferences: getHeader(h, "References") };
  } catch {
    return { lastMessageId: "", lastReferences: "" };
  }
}

/** Store a just-sent message (re-read from Gmail) so the inbox shows it at once. */
async function recordSentMessage(gmailMessageId: string | undefined, threadId: string, myEmail: string, fallback: { subject: string; to: string; text: string }) {
  let rec: Record<string, unknown> | null = null;
  if (gmailMessageId) {
    try { rec = parseMessage(await gmail.getMessage(gmailMessageId), myEmail, myEmail) as Record<string, unknown> | null; } catch { /* fall back below */ }
  }
  if (!rec) {
    const now = new Date().toISOString();
    rec = {
      messageId: gmailMessageId ?? `sent-${Date.now()}`, threadId, accountEmail: myEmail, subject: fallback.subject,
      fromEmail: myEmail, fromName: "Jake", toEmail: fallback.to, date: now, dateIso: toIsoDate(now),
      snippet: fallback.text.slice(0, 200), bodyText: fallback.text, labels: JSON.stringify(["SENT"]), isFromMe: true,
    };
  }
  try {
    upsertEmails([{ ...rec, accountEmail: myEmail, isFromMe: true }]);
    rebuildThreadIndexRow(threadId, myEmail);
  } catch { /* best effort — the next refresh picks it up */ }
}

/** Send (manual) or draft one reply; the shared core of sendReply / sendFollowUp. */
async function deliverReply(input: z.infer<typeof sendInput>) {
  if (input.mode !== "send") return { ...(await saveReplyAsDraft(input)), sent: false as const };
  if (!input.lastMessageId) Object.assign(input, await threadingHeaders(input.threadId));
  const replySubject = input.subject.startsWith("Re:") ? input.subject : `Re: ${input.subject}`;
  const replyReferences = [input.lastReferences, input.lastMessageId].filter(Boolean).join(" ");
  const body = ensureSignature(input.draftText, signature());
  const msg: any = await gmail.sendReplyMessage({
    threadId: input.threadId,
    to: input.toEmail,
    cc: input.cc || undefined,
    subject: replySubject,
    body,
    html: toHtml(body),
    inReplyTo: input.lastMessageId || undefined,
    references: replyReferences || undefined,
  });
  return { replySubject, draftId: "", messageId: msg?.id as string | undefined, gmailUrl: gmail.gmailThreadUrl(input.threadId), sent: true as const, body };
}

/** The original send path's headers, handed to createReplyDraft instead of messages.send. */
async function saveReplyAsDraft(input: z.infer<typeof sendInput>) {
  const replySubject = input.subject.startsWith("Re:") ? input.subject : `Re: ${input.subject}`;
  const replyReferences = [input.lastReferences, input.lastMessageId].filter(Boolean).join(" ");
  // Every email ends with Jake's full footer (Jake 2026-10-01), links clickable like the agent's drafts.
  const body = ensureSignature(input.draftText, signature());
  const draft: any = await gmail.createReplyDraft({
    threadId: input.threadId,
    to: input.toEmail,
    subject: replySubject,
    cc: input.cc || undefined,
    body,
    html: toHtml(body),
    inReplyTo: input.lastMessageId || undefined,
    references: replyReferences || undefined,
  });
  return {
    replySubject,
    draftId: String(draft?.id ?? ""),
    messageId: draft?.message?.id as string | undefined,
    gmailUrl: gmail.gmailThreadUrl(input.threadId),
  };
}

/**
 * The mailbox a draft is saved in: the connected one (bug 12/14). A `fromEmail`
 * naming another address is refused rather than silently ignored.
 */
function draftingAccount(fromEmail?: string): string {
  const acct = connectedAccount();
  if (!acct?.email) throw Object.assign(new Error("Gmail is not connected — connect it on the Deal Organizer connections page."), { status: 400 });
  const want = (fromEmail ?? "").trim().toLowerCase();
  if (want && want !== acct.email.toLowerCase()) {
    throw Object.assign(new Error(`Drafts can only be saved in the connected mailbox (${acct.email}), not ${fromEmail}.`), { status: 400 });
  }
  return acct.email.toLowerCase();
}

export const sendReply: Handler = async (raw) => {
  const input = parse(sendInput, raw);
  const myEmail = draftingAccount(input.fromEmail);

  const saved = await deliverReply(input);
  const now = new Date().toISOString();

  // Jake replying on a deal = the deal is curated (never auto-archived by the scanner).
  if (input.dealId) { try { markDealTouched(input.dealId); } catch { /* best effort */ } }
  if (saved.sent) {
    await recordSentMessage(saved.messageId, input.threadId, myEmail, { subject: saved.replySubject, to: input.toEmail, text: saved.body });
    return { success: true, gmailMessageId: saved.messageId ?? undefined, draftId: "", gmailUrl: saved.gmailUrl, savedAsDraft: false as const, sent: true as const };
  }
  // Save the drafted message to the emails table (labelled DRAFT — it has not been
  // sent). Upserted by message id, so when Jake sends it the sync turns it into SENT.
  try {
    upsertEmails([{
      messageId: saved.messageId ?? `draft-${Date.now()}`,
      threadId: input.threadId,
      accountEmail: myEmail,
      subject: saved.replySubject,
      fromEmail: myEmail,
      fromName: "Jake",
      toEmail: input.toEmail,
      date: now,
      dateIso: toIsoDate(now),
      snippet: input.draftText.slice(0, 200),
      bodyText: input.draftText,
      labels: JSON.stringify(["DRAFT"]),
      isFromMe: true,
    }]);
  } catch { /* best effort, as the original's allSettled */ }

  return {
    success: true,
    gmailMessageId: saved.messageId ?? undefined,
    draftId: saved.draftId,
    gmailUrl: saved.gmailUrl,
    savedAsDraft: true as const,
  };
};

export const sendFollowUp: Handler = async (raw) => {
  const input = parse(sendInput.omit({ fromEmail: true }), raw);
  const myEmail = draftingAccount();
  const saved = await deliverReply(input);

  if (saved.sent) {
    // Sent from the Lab: drafted and sent in the same moment.
    const now = new Date().toISOString();
    deals.update(input.dealId, { lastFollowUpDraftedAt: now, lastFollowUpSentAt: now });
    await recordSentMessage(saved.messageId, input.threadId, myEmail, { subject: saved.replySubject, to: input.toEmail, text: saved.body });
    return { success: true, gmailMessageId: saved.messageId ?? undefined, draftId: "", gmailUrl: saved.gmailUrl, savedAsDraft: false as const, sent: true as const };
  }

  // Only a DRAFT exists now. `lastFollowUpSentAt` is set later, when the sync
  // sees the sent message in the thread (gmailSync.markFollowUpsSent).
  deals.update(input.dealId, { lastFollowUpDraftedAt: new Date().toISOString() });

  return {
    success: true,
    gmailMessageId: saved.messageId ?? undefined,
    draftId: saved.draftId,
    gmailUrl: saved.gmailUrl,
    savedAsDraft: true as const,
  };
};

/**
 * Send a draft that is already saved in Gmail (the agent's), exactly as it is
 * there — including any edits Jake made in Gmail. Manual Lab sends only.
 */
export const sendGmailDraft: Handler = async (raw) => {
  const input = parse(z.object({ threadId: z.string(), draftId: z.string(), dealId: z.string().optional() }), raw);
  const myEmail = draftingAccount();
  const draft: any = await gmail.getDraft(input.draftId).catch(() => null);
  if (!draft?.message) throw Object.assign(new Error("That draft is no longer in Gmail — it was sent or deleted there."), { status: 404 });
  if (draft.message.threadId && draft.message.threadId !== input.threadId) {
    throw Object.assign(new Error("That draft belongs to a different thread."), { status: 400 });
  }
  const msg: any = await gmail.sendSavedDraft(input.draftId);
  if (input.dealId) { try { markDealTouched(input.dealId); } catch { /* best effort */ } }
  const h = draft.message.payload?.headers ?? [];
  await recordSentMessage(msg?.id, input.threadId, myEmail, { subject: getHeader(h, "Subject"), to: getHeader(h, "To"), text: extractText(draft.message.payload) });
  return { success: true, gmailMessageId: msg?.id as string | undefined, gmailUrl: gmail.gmailThreadUrl(input.threadId), sent: true as const };
};

/* ── getFollowUpDrafts ────────────────────────────────────────────────────── */

/** Follow-up stages by KEY (bug 8: were display names, which a rename breaks). */
const FOLLOW_UP_STAGE_KEYS = [
  "started_negotiation_no_answer",
  "to_follow_up_with",
  "potential_future_collaboration",
  "contract_negotiation",
  "new_requests",
];
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** Last synced activity per thread (emails table, drafts excluded) — for "longest silent first". */
function lastActivityByThread(threadIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < threadIds.length; i += 500) {
    const ids = threadIds.slice(i, i + 500);
    const rows = db.prepare(`SELECT thread_id AS t, MAX(date_iso) AS d FROM deals_emails
      WHERE thread_id IN (${ids.map(() => "?").join(",")}) AND (labels IS NULL OR labels NOT LIKE '%"DRAFT"%') GROUP BY thread_id`).all(...ids) as { t: string; d: string | null }[];
    for (const r of rows) if (r.d) out.set(r.t, r.d);
  }
  return out;
}

type ThreadClass = "follow_up" | "low_baller" | "skip";

async function classifyThread(messages: any[], myEmail: string): Promise<{ classification: ThreadClass; reason: string }> {
  const conversationLines = messages.slice(-6).map((msg) => {
    const headers = msg.payload?.headers ?? [];
    const fromEmail = extractEmail(getHeader(headers, "From"));
    const role = isJake(fromEmail, myEmail) ? "[Jake]" : "[Client]";
    const text = extractText(msg.payload).slice(0, 500).trim();
    return `${role}: ${text}`;
  }).join("\n\n---\n\n");

  const prompt = `You are filtering a YouTube sponsorship deal pipeline for Jake Dawson.
Jake's minimum fee for a dedicated sponsored video is $6,000. A counter-offer below $4,000 is a low-ball (Jake then holds firm at $6,500 rather than dropping).

Analyze this email thread and classify it into EXACTLY ONE of these three categories:

"follow_up" — The client seems genuinely interested and was OK with pricing/timeline, but simply stopped responding. OR the client never replied after Jake sent his first response (ghost). These deals are worth a polite follow-up.

"low_baller" — The client explicitly tried to negotiate the price DOWN to under $4,000. Examples: "our budget is $500", "can you do $1,800?", "max we can do is $3,000".

"skip" — Anything else where a follow-up is NOT appropriate right now: client explicitly said no/passed, deal is at an unrelated stage, client is actively responding (not silent), or situation is unclear.

IMPORTANT: Only classify as "low_baller" if there is an EXPLICIT dollar amount under $4,000 offered by the client in the thread. If no price was discussed, use "follow_up" or "skip" based on context.

Email thread (newest message last):
${conversationLines}

Respond ONLY with valid JSON (no other text):
{"classification": "follow_up", "reason": "one short sentence explaining why"}`;

  try {
    const rawOut = await callGemini(prompt, { maxTokens: 120, temperature: 0.2 });
    const match = rawOut.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (["follow_up", "low_baller", "skip"].includes(parsed.classification)) {
        return { classification: parsed.classification as ThreadClass, reason: (parsed.reason ?? "").slice(0, 120) };
      }
    }
  } catch { /* fall through to safe default */ }

  return { classification: "follow_up", reason: "Classification unavailable — defaulting to follow-up" };
}

export const getFollowUpDrafts: Handler = async (raw) => {
  // Additive (redesign 2026-09-30): `dealIds` limits the run to those deals (the
  // chat's draft_follow_ups tool and the Emails "Waiting on them" bulk action);
  // absent = every eligible deal, as before. Still capped at 25 per run.
  const input = parse(z.object({ dealIds: z.array(z.string()).optional() }), raw);
  const only = input.dealIds?.length ? new Set(input.dealIds) : null;
  const now = Date.now();
  const myEmail = myAddress();
  const { toDB } = await loadStageConfig();
  const followUpStages = new Set(FOLLOW_UP_STAGE_KEYS.map((k) => toDB[k]).filter(Boolean));

  const allDeals = deals.where(`${ARCHIVED_FALSE} ORDER BY created_at, rowid LIMIT 10000`);

  const recent = (iso?: string) => !!iso && now - new Date(iso).getTime() < THREE_DAYS_MS;
  const eligible = allDeals.filter((d) => {
    if (only && !only.has(d.id)) return false;
    if (!followUpStages.has(d.stage ?? "")) return false;
    if (!d.sourceThreadId) return false;
    if (recent(d.lastFollowUpSentAt) || recent(d.lastFollowUpDraftedAt)) return false;
    return true;
  });
  // Longest silent first, BEFORE the 25-cap (the original took the first 25 by
  // creation). Silence = the thread's last synced email; a thread with no synced
  // mail falls back to the deal's last scan / creation date.
  // The follow-up goes into the deal's LIVE thread: the most recently active of all its
  // threads (shared matcher — source, manual links, contact closure), else the source thread.
  const liveThread = new Map(eligible.map((d) => [d.id, latestThreadForDeal(d.id)?.threadId ?? d.sourceThreadId!]));
  const activity = lastActivityByThread([...new Set(liveThread.values())]);
  const lastSeen = (d: typeof allDeals[number]) => activity.get(liveThread.get(d.id)!) ?? d.lastScannedAt ?? d.createdAt ?? "";
  const candidates = eligible.sort((a, b) => lastSeen(a).localeCompare(lastSeen(b))).slice(0, 25);

  const sig = signature();
  const template = (firstName: string) =>
    `Hi ${firstName},\n\nJust following up here as it's been a while. Any movement or feedback on your end regarding this potential collaboration?\n\n${sig}`;

  const results = await Promise.allSettled(
    candidates.map(async (deal) => {
      const threadId = liveThread.get(deal.id) ?? deal.sourceThreadId!;
      const withDrafts = await sortedThreadMessages(threadId, true);
      // Record a follow-up Jake has since SENT (the draft became a real message).
      if (deal.lastFollowUpDraftedAt) {
        try { markFollowUpsSent(withDrafts.map((m) => parseMessage(m, myEmail, myEmail) ?? {}).filter((r) => r.messageId)); } catch { /* best effort */ }
      }
      const messages = withDrafts.filter((m) => !isDraftMsg(m));
      if (!messages.length) return null;
      // A draft already waiting in the thread (newer than the last real message) = already drafted.
      const lastReal = parseInt(messages[messages.length - 1].internalDate ?? "0");
      if (withDrafts.some((m) => isDraftMsg(m) && parseInt(m.internalDate ?? "0") >= lastReal)) return null;

      const lastMsg = messages[messages.length - 1];
      const lastHeaders = lastMsg.payload?.headers ?? [];
      const fromEmail = extractEmail(getHeader(lastHeaders, "From"));
      if (!isJake(fromEmail, myEmail)) return null; // they replied — no follow-up needed

      const internalDate = parseInt(lastMsg.internalDate ?? "0");
      const daysSinceLast = internalDate ? Math.floor((now - internalDate) / 86_400_000) : 999;
      if (daysSinceLast < 3) return null;

      const { classification, reason } = await classifyThread(messages, myEmail);

      const firstName = (deal.clientName ?? "").trim().split(/\s+/)[0] || "there";
      const companyName = deal.projectName || deal.clientName || "Unknown";

      // No auto-move any more: a low-baller is only a SUGGESTION (and still gets
      // a follow-up — rulebook #19: below $4,000, hold firm at $6,500).
      const suggestedStage = classification === "low_baller" ? "poor_fit_now" : null;

      if (classification === "skip") return null;

      const lastMessageId = getHeader(lastHeaders, "Message-ID");
      const lastReferences = getHeader(lastHeaders, "References");
      const lastSubject = getHeader(lastHeaders, "Subject");

      let toEmail = deal.clientEmail ?? "";
      if (!toEmail) {
        for (const msg of messages) {
          const mFrom = extractEmail(getHeader(msg.payload?.headers ?? [], "From"));
          if (mFrom && !isJake(mFrom, myEmail) && mFrom.includes("@")) {
            toEmail = mFrom;
            break;
          }
        }
      }
      if (!toEmail) return null;

      let priorFollowUpCount = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const mFrom = extractEmail(getHeader(messages[i].payload?.headers ?? [], "From"));
        if (isJake(mFrom, myEmail)) priorFollowUpCount++;
        else break;
      }

      let draft: string;
      let isCustomDraft = false;

      if (priorFollowUpCount === 0) {
        draft = template(firstName);
      } else {
        isCustomDraft = true;
        const contextSnippets = messages.slice(-4).map((m) => {
          const mFrom = extractEmail(getHeader(m.payload?.headers ?? [], "From"));
          const role = isJake(mFrom, myEmail) ? "Jake" : "Contact";
          return `[${role}]: ${extractText(m.payload).slice(0, 400).trim()}`;
        }).join("\n\n---\n\n");

        const prompt = `You are writing a follow-up email for Jake Dawson (YouTube creator, AI tutorials for solopreneurs).

His standard follow-up ("Just following up here as it's been a while...") was already sent ${priorFollowUpCount} time(s). Write a SHORT custom follow-up.

RULES:
- Body ≤60 words (not counting greeting or sign-off)
- Reference at least one specific detail from the thread (project, something they said, a deadline)
- Ask for a concrete next step: a date, a decision, or "is this still on?"
- Optionally end with: "If I don't hear back this week, I'll assume it's not moving forward — happy to revisit later if anything changes."
- Voice: direct, short sentences, no "hope you're doing well", no fluff
- Greeting: "Hi ${firstName},"
- NO sign-off and no name at the end — the signature is added automatically

Deal: ${companyName}  |  Stage: ${deal.stage}  |  ${daysSinceLast} days silent

Thread (newest at bottom):
${contextSnippets}

Return ONLY the complete email. No commentary.`;

        try {
          const out = await callGemini(prompt, { maxTokens: 350, temperature: 0.2 });
          const body = out.replace(/[\s\r\n]*(?:Best|Best regards|Kind regards|Thanks|Cheers),?[\s \t]*\r?\n[\s \t]*Jake(?: Dawson)?[\s\S]*$/i, "").trim();
          draft = body ? `${body}\n\n${sig}` : template(firstName);
        } catch {
          draft = template(firstName);
          isCustomDraft = false;
        }
      }

      return {
        type: "deal" as const,
        deal: {
          dealId: deal.id,
          threadId,
          toEmail,
          firstName,
          companyName,
          projectName: deal.projectName || "",
          stage: deal.stage || "",
          daysSinceLast,
          lastMessageId,
          lastReferences,
          lastSubject,
          draft,
          priorFollowUpCount,
          isCustomDraft,
          // Added (additive): the classifier's view. 'poor_fit_now' = the client offered
          // under $4,000 — a suggestion for Jake, nothing is moved.
          classification,
          classificationReason: reason,
          suggestedStage,
        },
      };
    }),
  );

  const out: any[] = [];
  const autoMoved: any[] = []; // kept for the response shape — always empty now (nothing is auto-moved)
  for (const r of results) {
    if (r.status !== "fulfilled" || r.value === null) continue;
    if (r.value.type === "deal") out.push(r.value.deal);
  }

  out.sort((a, b) => b.daysSinceLast - a.daysSinceLast);

  return { deals: out, autoMoved, scanned: candidates.length };
};
