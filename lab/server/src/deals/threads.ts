/**
 * Deal Organizer — reading mail (ports of listThreads, getThread,
 * getEmailAttachment, lookupThread). Logic, inputs and outputs as the original;
 * Gmail goes through integrations/gmail.ts, OpenAI through Claude (fast tier).
 */
import { decodeEntities } from "./inbox.js";
import { z } from "zod";
import { deals, emails, threadIndex, threadBrands, type DealRecord, type EmailRecord } from "./db.js";
import { loadStageConfig } from "./stageUtils.js";
import * as gmail from "./integrations/gmail.js";
import { upsertEmails, rebuildThreadIndexRow } from "./gmailSync.js";
import { dealsForThread } from "./matching.js";
import {
  ARCHIVED_FALSE, FALLBACK_MY_EMAIL, aiText, connectedAccount, resolveAccount, extractEmail, extractText, getHeader,
  isFreemail, parse, parseMessage, safeJson, type Handler,
} from "./common.js";

/* ── listThreads ──────────────────────────────────────────────────────────── */

export const listThreads: Handler = async (raw) => {
  const input = parse(z.object({
    view: z.enum(["inbox", "sent", "drafts", "archived"]).optional(),
    query: z.string().optional(),
    accountEmail: z.string().optional(),
    threadIds: z.array(z.string()).optional(),
  }), raw);

  const account = resolveAccount(input.accountEmail);
  if (!account) return { threads: [], nextPageToken: "", myEmail: "" };

  const accountEmail = account.email ?? "";
  const myEmail = accountEmail;
  const view = input.view ?? "inbox";
  const lq = (input.query ?? "").toLowerCase().trim();
  const isDomainFilter = lq.startsWith("@");

  // Newest threads first (was the OLDEST 2,000 by insertion order — new mail fell off once the index grew).
  const allThreads = threadIndex.where("lower(account_email) = lower(?) ORDER BY last_date DESC, rowid DESC LIMIT 5000", accountEmail);

  let filtered: typeof allThreads;

  if (input.threadIds && input.threadIds.length > 0) {
    const ids = new Set(input.threadIds);
    filtered = allThreads.filter((t) => ids.has(t.threadId ?? ""));
  } else {
    const viewFiltered = allThreads.filter((t) => {
      const labels: string[] = safeJson(t.labels);
      if (view === "inbox") return labels.includes("INBOX");
      if (view === "sent") return labels.includes("SENT");
      if (view === "drafts") return labels.includes("DRAFT");
      if (view === "archived") return !labels.some((l) => ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH"].includes(l));
      return true;
    });

    filtered = lq ? viewFiltered.filter((t) => {
      if (isDomainFilter) {
        const domain = lq.slice(1);
        return (t.senderEmail ?? "").includes(domain) || (t.recipientEmail ?? "").includes(domain);
      }
      return (t.subject ?? "").toLowerCase().includes(lq) ||
        (t.senderName ?? "").toLowerCase().includes(lq) ||
        (t.senderEmail ?? "").toLowerCase().includes(lq);
    }) : viewFiltered;
  }

  const sorted = [...filtered]
    .sort((a, b) => new Date(b.lastDate ?? 0).getTime() - new Date(a.lastDate ?? 0).getTime())
    .slice(0, 100);

  let dealRows: DealRecord[] = [];
  let stageFromDB: Record<string, string> = {};
  try {
    const { fromDB } = await loadStageConfig();
    dealRows = deals.where(`${ARCHIVED_FALSE} ORDER BY created_at, rowid LIMIT 2000`);
    stageFromDB = fromDB;
  } catch { /* best effort */ }

  const liveDeals = new Map(dealRows.map((d) => [d.id, d]));
  const rootOf = (email: string) => {
    const dom = email.split("@")[1] ?? "";
    const parts = dom.split(".");
    return parts.length <= 2 ? dom : parts.slice(-2).join(".");
  };

  const threads = sorted.map((t) => {
    const isFromMe = (t.senderEmail ?? "").toLowerCase() === myEmail.toLowerCase();
    const displayEmail = isFromMe ? (t.recipientEmail ?? "") : (t.senderEmail ?? "");
    const displayName = isFromMe
      ? (t.recipientEmail ?? displayEmail)
      : (t.senderName ?? t.senderEmail ?? "");

    // The thread's deal = the shared matcher (the deal whose Files list this thread), open deals only.
    const deal = dealsForThread(t.threadId ?? "", { senderEmails: displayEmail ? [displayEmail] : [] })
      .map((h) => liveDeals.get(h.dealId)).find((d) => !!d);

    return {
      threadId: t.threadId ?? "",
      subject: t.subject ?? "(no subject)",
      snippet: decodeEntities(t.snippet ?? ""),
      displayName: displayName || displayEmail,
      displayEmail,
      date: t.lastDate ?? "",
      isUnread: !(t.isRead ?? true),
      messageCount: t.messageCount ?? 1,
      dealInfo: deal
        ? { id: deal.id, projectName: deal.projectName ?? "", stage: stageFromDB[deal.stage ?? ""] ?? deal.stage ?? "" }
        : null,
    };
  });

  return { threads, nextPageToken: "", myEmail };
};

/* ── getThread ────────────────────────────────────────────────────────────── */

function parseDateMs(d: string | undefined): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return isNaN(t) ? 0 : t;
}

const threadEmails = (threadId: string) => emails.where("thread_id = ? ORDER BY created_at, rowid LIMIT 100", threadId);

/** getThread's repair fetch: when it last ran per thread (a repair never repeats within 6 h). */
const repairedAt = new Map<string, number>();
const REPAIR_EVERY_MS = 6 * 60 * 60 * 1000;

export const getThread: Handler = async (raw) => {
  const input = parse(z.object({ threadId: z.string() }), raw);

  // ── 1. Try DB cache first
  let rows: Array<Partial<EmailRecord> & { id: string }> = threadEmails(input.threadId);
  let accountEmail = "";

  // ── 2. Live Gmail fetch if not cached — or ONE repair fetch when the local
  //       copy is visibly incomplete (fewer rows than Gmail reported, or the
  //       thread's first message missing). At most once per thread per 6 h.
  const indexRecord = threadIndex.where("thread_id = ? LIMIT 1", input.threadId)[0];
  const incomplete = rows.length > 0 && (
    (indexRecord?.messageCount ?? 0) > rows.length ||
    !rows.some((r) => r.messageId === input.threadId)
  );
  const lastRepair = repairedAt.get(input.threadId) ?? 0;
  if (rows.length === 0 || (incomplete && Date.now() - lastRepair > REPAIR_EVERY_MS)) {
    if (incomplete) repairedAt.set(input.threadId, Date.now());
    accountEmail = indexRecord?.accountEmail || rows[0]?.accountEmail || connectedAccount()?.email || "";

    // The account must be the connected mailbox (the original looked up its refresh token).
    const conn = connectedAccount();
    const account = conn && (conn.email ?? "").toLowerCase() === accountEmail.toLowerCase() ? conn : null;
    if (accountEmail && account) {
      try {
        const gmailThread: any = await gmail.getThread(input.threadId);
        const gmailMessages: any[] = gmailThread.messages ?? [];
        const myEmail = accountEmail;

        const parsed: Partial<EmailRecord>[] = [];
        for (const msg of gmailMessages) {
          const record = parseMessage(msg, myEmail, accountEmail);
          if (record) parsed.push(record);
        }

        if (parsed.length > 0) {
          upsertEmails(parsed);
          const saved = threadEmails(input.threadId);
          rows = saved.length > 0 ? saved : parsed.map((r) => ({ ...r, id: r.messageId ?? "" }));
          try { rebuildThreadIndexRow(input.threadId, accountEmail); } catch { /* best effort */ }
        }
      } catch (err) {
        console.error("Failed to fetch thread from Gmail:", err);
      }
    }
  }

  if (rows.length === 0) {
    return { threadId: input.threadId, subject: "", myEmail: "", accountEmail, messages: [], dealInfo: null };
  }

  const sorted = [...rows].sort((a, b) => parseDateMs(a.date) - parseDateMs(b.date));

  const firstEmail = sorted[0];
  const subject = firstEmail.subject ?? "(no subject)";
  if (!accountEmail) accountEmail = firstEmail.accountEmail ?? "";
  const myEmailMsg = sorted.find((e) => e.isFromMe);
  const myEmail = myEmailMsg?.fromEmail ?? accountEmail;

  const participantEmails = new Set(
    sorted.filter((e) => !e.isFromMe).map((e) => (e.fromEmail ?? "").toLowerCase()).filter(Boolean),
  );

  // `stage` stays the stage KEY (as before); additive: `stageName` (the board label)
  // and `matchedBy`. The deal = the shared matcher's best deal for this thread
  // (was: source thread, then the newest deal of a participant's address).
  let dealInfo: { id: string; projectName: string; stage: string; stageName: string; clientName: string; matchedBy: "thread" | "email" } | null = null;
  try {
    const { fromDB } = await loadStageConfig();
    // The shared matcher (matching.ts): the open deal whose Files list this thread
    // (source / manual → "thread"; contact closure, same company + brand, signing notice → "email").
    let d: DealRecord | undefined;
    let byThread = false;
    for (const h of dealsForThread(input.threadId, { senderEmails: [...participantEmails], includeArchived: false })) {
      const r = deals.get(h.dealId);
      if (!r || r.mergedInto) continue;
      d = r;
      byThread = h.matchedBy === "source" || h.matchedBy === "manual";
      break;
    }
    if (d) dealInfo = {
      id: d.id, projectName: d.projectName ?? "",
      stage: fromDB[d.stage ?? ""] ?? d.stage ?? "",
      stageName: d.stage ?? "",
      clientName: d.clientName ?? "",
      matchedBy: byThread ? "thread" : "email",
    };
  } catch { /* best effort */ }

  const messages = sorted.map((email) => {
    const atts: { name: string; mimeType: string; attachmentId: string; size: number }[] = safeJson(email.attachments);
    return {
      id: email.messageId ?? email.id,
      from: `${email.fromName ?? ""} <${email.fromEmail ?? ""}>`,
      fromEmail: email.fromEmail ?? "",
      fromName: email.fromName ?? email.fromEmail ?? "",
      to: email.toEmail ?? "",
      date: email.date ?? "",
      subject: email.subject ?? subject,
      body: (email.bodyText ?? "").slice(0, 6000),
      bodyHtml: email.bodyHtml ?? "",
      attachments: atts.map((a) => ({
        name: a.name ?? "",
        mimeType: a.mimeType ?? "",
        attachmentId: a.attachmentId ?? "",
        size: a.size ?? 0,
      })),
      isRead: email.isRead ?? true,
      isFromMe: email.isFromMe ?? false,
      isDraft: safeJson(email.labels).includes("DRAFT"),
    };
  });

  return { threadId: input.threadId, subject, myEmail, accountEmail, messages, dealInfo };
};

/* ── getEmailAttachment ───────────────────────────────────────────────────── */

export const getEmailAttachment: Handler = async (raw) => {
  const input = parse(z.object({
    messageId: z.string(),
    attachmentId: z.string(),
    accountEmail: z.string(),
  }), raw);

  const account = resolveAccount(input.accountEmail);
  if (!account) throw Object.assign(new Error("Gmail is not connected."), { status: 400 });

  const res: any = await gmail.getAttachment(input.messageId, input.attachmentId);

  // Convert base64url to standard base64
  const rawData: string = res.data ?? "";
  const base64 = rawData.replace(/-/g, "+").replace(/_/g, "/");
  const size = res.size ?? 0;

  const meta = await attachmentMeta(input.messageId, input.attachmentId, size);
  return { data: base64, mimeType: meta.mimeType, filename: meta.filename, size };
};

/**
 * The attachment's real filename + MIME type (bug 15: both came back empty).
 * First from the synced `emails` row (the attachmentId the UI holds came from
 * it), then from the live message's parts. Gmail re-issues attachment ids per
 * fetch, so the live lookup also matches on size, then on "the only attachment".
 */
async function attachmentMeta(messageId: string, attachmentId: string, size: number): Promise<{ filename: string; mimeType: string }> {
  type Att = { name?: string; mimeType?: string; attachmentId?: string; size?: number };
  const pick = (atts: Att[]): Att | undefined =>
    atts.find((a) => a.attachmentId === attachmentId) ??
    (size ? atts.filter((a) => a.size === size) : []).find((_, __, arr) => arr.length === 1) ??
    (atts.length === 1 ? atts[0] : undefined);

  for (const row of emails.where("message_id = ? LIMIT 5", messageId)) {
    const hit = pick(safeJson(row.attachments));
    if (hit?.name) return { filename: hit.name, mimeType: hit.mimeType ?? "" };
  }
  try {
    const msg: any = await gmail.getMessage(messageId, "full");
    const atts: Att[] = [];
    const walk = (p: any, depth = 0) => {
      if (!p || depth > 10) return;
      if (p.filename && p.body?.attachmentId) atts.push({ name: p.filename, mimeType: p.mimeType ?? "", attachmentId: p.body.attachmentId, size: p.body.size ?? 0 });
      for (const c of p.parts ?? []) walk(c, depth + 1);
    };
    walk(msg?.payload);
    const hit = pick(atts);
    if (hit?.name) return { filename: hit.name, mimeType: hit.mimeType ?? "" };
  } catch { /* best effort — the data is what matters */ }
  return { filename: "", mimeType: "" };
}

/* ── lookupThread ─────────────────────────────────────────────────────────── */

async function extractKeyword(phrase: string): Promise<string> {
  try {
    const content = `You extract the company or contact name to search for from a phrase. Return ONLY the name — nothing else, no punctuation, no explanation.

Examples:
"pull up the Softr threads" → Softr
"email from Emilya" → Emilya
"BMW thread" → BMW
"show me the threads with Notion" → Notion
"threads from Germany" → Germany
"the Venngage emails" → Venngage
"Apify" → Apify

Phrase: "${phrase}"`;
    const out = await aiText("fast", "deals-classify", "", [{ role: "user", content }]);
    const extracted = out.trim().replace(/^["'\s]+|["'\s]+$/g, "");
    return (extracted && extracted.length > 0) ? extracted : phrase;
  } catch {
    return phrase;
  }
}

type MatchItem = {
  threadId: string;
  dealId: string;
  clientName: string;
  projectName: string;
  clientEmail: string;
  stage: string;
  toEmail: string;
  hasDeal: boolean;
};

export const lookupThread: Handler = async (raw) => {
  const input = parse(z.object({ searchTerm: z.string() }), raw);
  const rawTerm = input.searchTerm.trim();
  const isWildcard = rawTerm === "" || rawTerm === "*";

  const allDeals = deals.where(`${ARCHIVED_FALSE} ORDER BY updated_at DESC, rowid DESC LIMIT 5000`);
  const keyword = isWildcard ? "" : await extractKeyword(rawTerm);

  const account = connectedAccount();
  const accountEmail = account?.email ?? FALLBACK_MY_EMAIL;
  const myEmail = accountEmail.toLowerCase();

  const dealByThreadId = new Map<string, DealRecord>();
  for (const d of allDeals) {
    if (d.sourceThreadId) dealByThreadId.set(d.sourceThreadId, d);
  }

  // ── Wildcard: return all deal-linked threads
  if (isWildcard || !keyword) {
    const items: MatchItem[] = allDeals
      .filter((d) => d.sourceThreadId)
      .slice(0, 25)
      .map((d) => ({
        threadId: d.sourceThreadId!,
        dealId: d.id,
        clientName: d.clientName ?? "",
        projectName: d.projectName ?? "",
        clientEmail: d.clientEmail ?? "",
        stage: d.stage ?? "",
        toEmail: d.clientEmail ?? "",
        hasDeal: true,
      }));
    return fetchAndBuildMatches(items, myEmail, "");
  }

  const kw = keyword.toLowerCase();
  const matchItems = new Map<string, MatchItem>();

  // ThreadBrands index scan
  const brands = threadBrands.where("lower(account_email) = lower(?) ORDER BY created_at, rowid", accountEmail);
  for (const b of brands) {
    if (!b.threadId) continue;
    const brandMatch = b.brandName?.toLowerCase().includes(kw);
    const domainMatch = b.senderDomain?.toLowerCase().includes(kw);
    const senderNameMatch = b.senderName?.toLowerCase().includes(kw);
    if (!brandMatch && !domainMatch && !senderNameMatch) continue;

    const linkedDeal = dealByThreadId.get(b.threadId);
    const senderEmail = b.senderEmail ?? "";
    matchItems.set(b.threadId, {
      threadId: b.threadId,
      dealId: linkedDeal?.id ?? "",
      clientName: linkedDeal?.clientName ?? b.senderName ?? senderEmail,
      projectName: linkedDeal?.projectName ?? b.brandName ?? keyword,
      clientEmail: linkedDeal?.clientEmail ?? senderEmail,
      stage: linkedDeal?.stage ?? "",
      toEmail: linkedDeal?.clientEmail ?? senderEmail,
      hasDeal: !!linkedDeal,
    });
  }

  // Direct Gmail search — always fresh, catches threads not yet indexed
  const gmailSearchRes: any = await gmail.listThreads(`"${keyword}" -in:spam -in:trash`, 20);
  for (const t of (gmailSearchRes.threads ?? [])) {
    if (!t.id || matchItems.has(t.id)) continue;
    const linkedDeal = dealByThreadId.get(t.id);
    matchItems.set(t.id, {
      threadId: t.id,
      dealId: linkedDeal?.id ?? "",
      clientName: linkedDeal?.clientName ?? keyword,
      projectName: linkedDeal?.projectName ?? keyword,
      clientEmail: linkedDeal?.clientEmail ?? "",
      stage: linkedDeal?.stage ?? "",
      toEmail: linkedDeal?.clientEmail ?? "",
      hasDeal: !!linkedDeal,
    });
  }

  if (matchItems.size === 0) return { matches: [], total: 0, keyword };

  const sorted = [...matchItems.values()]
    .sort((a, b) => Number(b.hasDeal) - Number(a.hasDeal))
    .slice(0, 25);

  return fetchAndBuildMatches(sorted, myEmail, keyword);
};

async function fetchAndBuildMatches(items: MatchItem[], myEmail: string, keyword: string) {
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    if (seen.has(i.threadId)) return false;
    seen.add(i.threadId);
    return true;
  });

  const results = await Promise.allSettled(
    unique.map(async (item) => {
      const thread: any = await gmail.getThread(item.threadId);
      const messages: any[] = [...(thread.messages ?? [])].sort(
        (a, b) => parseInt(a.internalDate ?? "0") - parseInt(b.internalDate ?? "0"),
      );
      if (!messages.length) return null;

      let myCount = 0;
      let theirCount = 0;
      let resolvedToEmail = item.toEmail;

      for (const msg of messages) {
        const mFrom = extractEmail(getHeader(msg.payload?.headers ?? [], "From"));
        const isMe = mFrom === myEmail || mFrom.includes("jakedawsonbusiness");
        if (isMe) myCount++;
        else {
          theirCount++;
          if (!resolvedToEmail && mFrom.includes("@")) resolvedToEmail = mFrom;
        }
      }

      const firstInbound = messages.find((m) => {
        const fe = extractEmail(getHeader(m.payload?.headers ?? [], "From"));
        return fe !== myEmail && !fe.includes("jakedawsonbusiness");
      });
      if (firstInbound && !item.clientEmail) {
        const fromRaw = getHeader(firstInbound.payload?.headers ?? [], "From");
        item.clientEmail = extractEmail(fromRaw);
        item.toEmail = item.clientEmail;
        const resolvedName = fromRaw.replace(/<[^>]+>/, "").trim().replace(/^"|"$/g, "");
        if (resolvedName && resolvedName !== item.clientName) {
          item.clientName = resolvedName || item.clientEmail;
          item.projectName = getHeader(firstInbound.payload?.headers ?? [], "Subject") || item.projectName;
        }
      }

      const lastMsg = messages[messages.length - 1];
      const lastHeaders = lastMsg.payload?.headers ?? [];
      const lastFromRaw = getHeader(lastHeaders, "From");
      const lastFromEmail = extractEmail(lastFromRaw);
      const lastIsFromMe = lastFromEmail === myEmail || lastFromEmail.includes("jakedawsonbusiness");
      const lastIsDraft = (lastMsg.labelIds ?? []).includes("DRAFT");
      const lastDate = lastMsg.internalDate ? new Date(parseInt(lastMsg.internalDate)).toISOString() : null;
      const lastText = extractText(lastMsg.payload).slice(0, 300).trim();
      const lastSubject = getHeader(lastHeaders, "Subject");
      const lastMessageId = getHeader(lastHeaders, "Message-ID");
      const lastReferences = getHeader(lastHeaders, "References");

      const lastMessages = messages.slice(-3).map((msg) => {
        const h = msg.payload?.headers ?? [];
        const fromRaw = getHeader(h, "From");
        const fromEmail = extractEmail(fromRaw);
        const isMe = fromEmail === myEmail || fromEmail.includes("jakedawsonbusiness");
        const dateMs = parseInt(msg.internalDate ?? "0");
        return {
          role: (isMe ? "me" : "them") as "me" | "them",
          fromName: isMe ? "Jake" : (fromRaw.replace(/<[^>]+>/, "").trim() || fromEmail),
          date: dateMs ? new Date(dateMs).toISOString() : "",
          snippet: extractText(msg.payload).slice(0, 300).trim(),
        };
      });

      return {
        dealId: item.dealId,
        clientName: item.clientName,
        projectName: item.projectName,
        clientEmail: item.clientEmail,
        stage: item.stage,
        threadId: item.threadId,
        messageCount: messages.length,
        myMessageCount: myCount,
        theirMessageCount: theirCount,
        lastMessageDate: lastDate,
        lastMessageFrom: lastIsFromMe ? "Jake" : (lastFromRaw.replace(/<[^>]+>/, "").trim() || lastFromEmail),
        lastMessageIsFromMe: lastIsFromMe,
        lastMessageIsDraft: lastIsDraft,
        lastMessageSnippet: lastText,
        lastMessages,
        lastMessageId,
        lastReferences,
        lastSubject,
        toEmail: resolvedToEmail,
        hasDeal: item.hasDeal,
      };
    }),
  );

  const matches: any[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value !== null) matches.push(r.value);
  }

  matches.sort((a, b) => {
    const dateA = a.lastMessageDate ? new Date(a.lastMessageDate).getTime() : 0;
    const dateB = b.lastMessageDate ? new Date(b.lastMessageDate).getTime() : 0;
    return dateB - dateA;
  });

  return { matches, total: matches.length, keyword };
}
