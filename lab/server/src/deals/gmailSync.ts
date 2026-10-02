/**
 * Deal Organizer — Gmail account management + sync (ports of getAccounts,
 * getGmailAuthUrl, exchangeGmailCode, removeAccount, syncEmails,
 * syncThreadIndex).
 *
 * The original juggled several OAuth'd accounts stored in `email_accounts`.
 * The Lab has exactly ONE mailbox, connected by its own OAuth flow
 * (/api/deals-oauth/gmail/start → integrations/gmailOauthRoutes.ts), with the
 * token held by integrations/gmail.ts. So the account endpoints below report /
 * point at that flow instead of managing tokens, and the sync code drives
 * `gmail.ts` instead of googleapis. The sync logic itself is unchanged.
 */
import { z } from "zod";
import { db } from "../db/index.js";
import { emails, emailAccounts, threadIndex, type EmailAccountRecord, type EmailRecord } from "./db.js";
import { getProfile, listMessages, getMessage, listThreads, gmailCall } from "./integrations/gmail.js";
import { connectedAccounts, connectedAccount, resolveAccount, parse, parseMessage, getHeader, extractEmail, extractName, safeJson, type Handler, type Emit } from "./common.js";
import { withSyncLock, syncLockBusy } from "./syncLock.js";
import { recordRefresh } from "./inbox.js";
import { dealsForThread } from "./matching.js";

/* ── getAccounts ──────────────────────────────────────────────────────────── */

export const getAccounts: Handler = async (input) => {
  parse(z.object({}), input);
  return {
    accounts: connectedAccounts().map((a) => ({
      id: a.id,
      email: a.email ?? "",
      displayName: a.displayName ?? a.email ?? "",
      provider: a.provider ?? "gmail",
      historyId: a.historyId ?? "",
      lastSyncedAt: a.lastSyncedAt ?? "",
    })),
  };
};

/* ── getGmailAuthUrl / exchangeGmailCode / removeAccount ──────────────────── */

const LAB_GMAIL_START = "/api/deals-oauth/gmail/start";

export const getGmailAuthUrl: Handler = async (input) => {
  parse(z.object({}), input);
  // The Lab route runs the whole OAuth dance itself (consent → its own callback).
  return { url: LAB_GMAIL_START, redirectUri: "" };
};

export const exchangeGmailCode: Handler = async (raw) => {
  parse(z.object({ code: z.string() }), raw);
  throw Object.assign(
    new Error(`Not used in the Lab: Google redirects to the Lab's own callback, which stores the connection. Start the connection at ${LAB_GMAIL_START}.`),
    { status: 400 },
  );
};

export const removeAccount: Handler = async (raw) => {
  parse(z.object({ accountId: z.string() }), raw);
  throw Object.assign(
    new Error("The Gmail connection is managed by the Lab. Disconnect it from the connections page."),
    { status: 400 },
  );
};

/* ── syncEmails ───────────────────────────────────────────────────────────── */

/** Zite `emails.bulkCreate({ matchOn: ['messageId'] })` — scoped to the account (the Lab's unique key). */
export function upsertEmails(records: Partial<EmailRecord>[]): void {
  for (let i = 0; i < records.length; i += 100) {
    emails.upsertMany(records.slice(i, i + 100) as Record<string, unknown>[], ["accountEmail", "messageId"]);
  }
  try { markFollowUpsSent(records); } catch (e) { console.warn("[deals] markFollowUpsSent failed:", e); }
}

/**
 * A follow-up only counts as SENT when a real sent message from Jake shows up
 * in the deal's thread after the draft was saved (sendFollowUp records
 * `last_follow_up_drafted_at`; nothing here can send). Called on every email
 * upsert (syncEmails, getThread), so the twice-daily sync picks it up.
 * Returns how many deals were marked.
 */
export function markFollowUpsSent(records: Partial<EmailRecord>[]): number {
  let marked = 0;
  const sent = records.filter((r) => {
    if (!r.isFromMe || !r.threadId || !r.dateIso) return false;
    const labels: string[] = safeJson(r.labels);
    return labels.includes("SENT") && !labels.includes("DRAFT");
  });
  if (!sent.length) return 0;
  const pending = new Map((db.prepare(`SELECT id, source_thread_id AS src, last_follow_up_drafted_at AS drafted, last_follow_up_sent_at AS sent FROM deals_deals
    WHERE last_follow_up_drafted_at IS NOT NULL`).all() as { id: string; src: string | null; drafted: string; sent: string | null }[]).map((d) => [d.id, d]));
  if (!pending.size) return 0;
  const upd = db.prepare(`UPDATE deals_deals SET last_follow_up_sent_at = ? WHERE id = ?`);
  for (const r of sent) {
    // The deal(s) of this thread — the shared matcher (follow-ups go into the deal's live thread, not only its source).
    const ids = new Set<string>([...pending.values()].filter((d) => d.src === r.threadId).map((d) => d.id));
    try { for (const h of dealsForThread(r.threadId!)) if (pending.has(h.dealId)) ids.add(h.dealId); } catch { /* source match only */ }
    for (const d of [...ids].map((id) => pending.get(id)!)) {
      // Sent after the draft was saved (1 min of clock slack), and newer than what we already know.
      if (Date.parse(r.dateIso!) < Date.parse(d.drafted) - 60_000) continue;
      if (d.sent && Date.parse(d.sent) >= Date.parse(r.dateIso!)) continue;
      upd.run(r.dateIso, d.id);
      d.sent = r.dateIso!;
      marked++;
    }
  }
  return marked;
}

/** Collect every page of `users.history.list` (messageAdded). Throws on HTTP error (404 = historyId too old). */
async function historyMessageIds(startHistoryId: string, cap: number): Promise<{ ids: string[]; historyId: string; capped: boolean }> {
  const ids: string[] = [];
  const seen = new Set<string>();
  let historyId = "";
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const histRes: any = await gmailCall("GET", "/history", undefined, {
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: "500",
      ...(pageToken ? { pageToken } : {}),
    });
    historyId = histRes.historyId ?? historyId;
    for (const item of histRes.history ?? []) {
      for (const ma of item.messagesAdded ?? []) {
        const id = ma.message?.id;
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    pageToken = histRes.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && ids.length < cap && pages < 50);
  return { ids: ids.slice(0, cap), historyId, capped: !!pageToken };
}

/** Every message id matching `q`, paging until `cap`. */
async function listAllMessageIds(q: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const listRes: any = await listMessages(q, Math.min(500, Math.max(1, cap - out.length)), pageToken);
    out.push(...(listRes.messages ?? []).map((m: any) => m.id).filter(Boolean));
    pageToken = listRes.nextPageToken ?? undefined;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

/**
 * Sync a single account.
 * @param daysBack   When > 0, forces a date-range query for that many days (used for backfill or weekly refresh).
 *                   When 0, uses historyId incremental sync (fastest, daily use).
 * @param maxResults Max messages to fetch in date-range mode (default 500).
 */
async function syncAccount(account: EmailAccountRecord, daysBack: number, maxResults: number): Promise<number> {
  let myEmail = account.email ?? "";
  let messagesToFetch: string[] = [];
  let latestHistoryId = account.historyId ?? "";

  // ── Mode A: date-range query with full pagination (backfill or weekly refresh) ──
  if (daysBack > 0) {
    try {
      const afterDate = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
      const q = `-in:spam -in:trash after:${afterDate}`;
      let pageToken: string | undefined;
      const pageSize = 500; // Gmail API max per page

      do {
        const listRes: any = await listMessages(q, pageSize, pageToken);
        const pageIds = (listRes.messages ?? []).map((m: any) => m.id).filter(Boolean);
        messagesToFetch.push(...pageIds);
        pageToken = listRes.nextPageToken ?? undefined;
      } while (pageToken && messagesToFetch.length < maxResults);

      messagesToFetch = messagesToFetch.slice(0, maxResults);

      try {
        const p = await getProfile();
        latestHistoryId = p.historyId ?? "";
        myEmail = p.emailAddress?.toLowerCase() ?? myEmail;
      } catch { /* best effort */ }
    } catch { return 0; }
  }

  // ── Mode B: incremental historyId sync (default on page refresh) ─────────
  else {
    const hasHistoryId = !!account.historyId;
    let needFullSync = !hasHistoryId;

    if (hasHistoryId) {
      // Every page of the history (bug 22: stopped at the first 200), capped at maxResults.
      try {
        const h = await historyMessageIds(account.historyId!, maxResults);
        latestHistoryId = h.historyId || latestHistoryId;
        messagesToFetch.push(...h.ids);
        if (h.capped) console.warn(`[deals] syncEmails: history has more than ${maxResults} new messages — capped`);
      } catch (e: any) {
        // 404 = the stored historyId is too old for Gmail to replay → date-window sync instead.
        if (/\(404\)/.test(String(e?.message ?? ""))) needFullSync = true;
        else return 0;
      }
    }

    if (needFullSync) {
      // Date-window fallback: everything since the last successful sync (at least
      // 7 days, at most 30), all pages up to maxResults — not just the first 200.
      try {
        const last = Date.parse(account.lastSyncedAt ?? "");
        const DAY = 24 * 60 * 60 * 1000;
        const windowMs = Number.isFinite(last) ? Math.min(30 * DAY, Math.max(7 * DAY, Date.now() - last + DAY)) : 7 * DAY;
        const afterDate = Math.floor((Date.now() - windowMs) / 1000);
        messagesToFetch = await listAllMessageIds(`-in:spam -in:trash after:${afterDate}`, maxResults);
        try {
          const p = await getProfile();
          latestHistoryId = p.historyId ?? "";
          myEmail = p.emailAddress?.toLowerCase() ?? myEmail;
        } catch { /* best effort */ }
      } catch { return 0; }
    }
  }

  if (messagesToFetch.length === 0) {
    if (latestHistoryId && latestHistoryId !== account.historyId) {
      emailAccounts.update(account.id, { historyId: latestHistoryId });
    }
    return 0;
  }

  // Fetch messages in batches of 10
  const records: Partial<EmailRecord>[] = [];
  for (let i = 0; i < messagesToFetch.length; i += 10) {
    const batch = messagesToFetch.slice(i, i + 10);
    const results = await Promise.allSettled(batch.map((id) => getMessage(id, "full")));
    for (const res of results) {
      if (res.status !== "fulfilled") continue;
      const record = parseMessage(res.value, myEmail, account.email ?? "");
      if (record) records.push(record);
    }
  }

  upsertEmails(records);

  if (latestHistoryId) {
    emailAccounts.update(account.id, { historyId: latestHistoryId, lastSyncedAt: new Date().toISOString() });
  }
  return records.length;
}

export const syncEmails: Handler = async (raw) => {
  const input = parse(z.object({
    accountEmail: z.string().optional(),
    daysBack: z.number().optional(),
    maxResults: z.number().optional(),
  }), raw);

  // (The original bootstrapped an account from ZITE_GMAIL_REFRESH_TOKEN here;
  // the Lab's single connected mailbox is always "bootstrapped".)
  const account = resolveAccount(input.accountEmail);
  const toSync = account ? [account] : [];

  const daysBack = input.daysBack ?? 0;
  const maxResults = Math.min(input.maxResults ?? 500, 2000);

  let totalNew = 0;
  for (const account of toSync) {
    totalNew += await syncAccount(account, daysBack, maxResults);
  }

  return {
    synced: true,
    accountsProcessed: toSync.length,
    newEmails: totalNew,
    message: `Synced ${totalNew} new emails across ${toSync.length} account(s)`,
  };
};

/* ── syncThreadIndex (streaming) ──────────────────────────────────────────── */

/**
 * Chunks: `{ phase: 'metadata', progress: number, total: number }` — the same
 * object the original wrote as an NDJSON line. Once after listing (progress 0),
 * then after every batch of 25 threads.
 */
export async function syncThreadIndex(raw: any, emit: Emit): Promise<{ indexed: number; isInitialSync: boolean; accountsProcessed: number }> {
  const input = parse(z.object({ accountEmail: z.string().optional() }), raw);
  const account = resolveAccount(input.accountEmail);
  if (!account) {
    return { indexed: 0, isInitialSync: false, accountsProcessed: 0 };
  }

  const toSync = [account];

  let totalIndexed = 0;
  let wasInitialSync = false;

  for (const account of toSync) {
    const accountEmail = account.email ?? "";

    // Detect initial vs incremental sync
    const existing = threadIndex.where("account_email = ? LIMIT 1", accountEmail);
    const isInitial = existing.length === 0;
    if (isInitial) wasInitialSync = true;

    const daysBack = isInitial ? 90 : 7;
    const afterDate = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);

    // Step 1: Paginate threads.list to get all thread IDs + snippets
    const threadItems: { id: string; snippet: string }[] = [];
    let pageToken: string | undefined;
    do {
      const listRes: any = await listThreads(`-in:spam -in:trash after:${afterDate}`, 500, pageToken);
      for (const t of listRes.threads ?? []) {
        if (t.id) threadItems.push({ id: t.id, snippet: t.snippet ?? "" });
      }
      pageToken = listRes.nextPageToken ?? undefined;
    } while (pageToken && threadItems.length < 3000);

    emit({ phase: "metadata", progress: 0, total: threadItems.length });

    if (threadItems.length === 0) continue;

    // Step 2: Fetch metadata for each thread in parallel batches of 25
    const BATCH = 25;
    const threadRecords: Record<string, unknown>[] = [];

    for (let batchStart = 0; batchStart < threadItems.length; batchStart += BATCH) {
      const batch = threadItems.slice(batchStart, batchStart + BATCH);

      const results = await Promise.allSettled(
        batch.map(({ id }) =>
          gmailCall("GET", `/threads/${id}`, undefined, {
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          }),
        ),
      );

      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        if (res.status !== "fulfilled") continue;
        const thread = res.value as any;
        const msgs: any[] = thread.messages ?? [];
        if (msgs.length === 0) continue;

        const firstMsg = msgs[0];
        const lastMsg = msgs[msgs.length - 1];
        const firstHeaders: any[] = firstMsg.payload?.headers ?? [];

        const fromRaw = getHeader(firstHeaders, "From");
        const toRaw = getHeader(firstHeaders, "To");
        const subject = getHeader(firstHeaders, "Subject") || "(no subject)";
        const labels: string[] = lastMsg.labelIds ?? [];
        const isRead = !labels.includes("UNREAD");

        const lastDate = lastMsg.internalDate
          ? new Date(parseInt(lastMsg.internalDate, 10)).toISOString()
          : new Date().toISOString();

        threadRecords.push({
          threadId: thread.id,
          accountEmail,
          subject,
          senderName: extractName(fromRaw),
          senderEmail: extractEmail(fromRaw),
          recipientEmail: extractEmail(toRaw),
          snippet: batch[j]?.snippet ?? lastMsg.snippet ?? "",
          lastDate,
          labels: JSON.stringify(labels),
          messageCount: msgs.length,
          isRead,
        });
      }

      const progress = Math.min(batchStart + BATCH, threadItems.length);
      emit({ phase: "metadata", progress, total: threadItems.length });
    }

    for (let i = 0; i < threadRecords.length; i += 100) {
      threadIndex.upsertMany(threadRecords.slice(i, i + 100), ["threadId"]);
    }

    totalIndexed += threadRecords.length;
  }

  return { indexed: totalIndexed, isInitialSync: wasInitialSync, accountsProcessed: toSync.length };
}

/* ── LIGHT inbox refresh (every 15 min; Jake 2026-09-30) ──────────────────────
 *
 * The cheap sibling of the heavy twice-a-day sync (scheduledSync.ts, untouched):
 *
 *   1. users.history.list from the stored historyId (messageAdded + labelAdded
 *      + labelRemoved) — ~2 quota units a page, usually one page;
 *   2. messages.get(full) ONLY for message ids not already in deals_emails;
 *   3. label changes applied to the rows we already have (labels / is_read);
 *   4. every touched thread's deals_thread_index row rebuilt FROM LOCAL ROWS;
 *      one threads.get(full) repair only when the local copy is visibly
 *      incomplete (fewer rows than Gmail said, or the thread's first message
 *      missing) — at most REPAIR_CAP per refresh.
 *
 * NO AI. Shares the process-wide sync lock with the heavy sync and simply
 * SKIPS when anything holds it. Shares the historyId cursor with syncEmails
 * (both only ever move it forward to what they have stored), so the heavy
 * sync then finds nothing left to fetch. The cursor is NOT advanced when a
 * message fetch failed, so the next refresh retries it. A historyId Gmail no
 * longer knows (404) is left for the heavy sync's date-window fallback.
 */
const REFRESH_EVERY_MS = 15 * 60_000;
const REPAIR_CAP = 10;
const MAX_NEW_MESSAGES = 300;

export interface InboxRefreshResult {
  ok: boolean;
  skipped: string | null;
  counts: { historyPages: number; added: number; fetched: number; labelChanges: number; draftsRemoved: number; threadsTouched: number; repairs: number; gmailCalls: number };
  error: string | null;
}

let refreshing: Promise<InboxRefreshResult> | null = null;

export function refreshInbox(trigger: "timer" | "manual" = "timer"): Promise<InboxRefreshResult> {
  if (refreshing) return refreshing;
  refreshing = refreshInboxInner(trigger).finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshInboxInner(trigger: string): Promise<InboxRefreshResult> {
  const startedAt = new Date().toISOString();
  const counts = { historyPages: 0, added: 0, fetched: 0, labelChanges: 0, draftsRemoved: 0, threadsTouched: 0, repairs: 0, gmailCalls: 0 };
  const done = (r: Omit<InboxRefreshResult, "counts">): InboxRefreshResult => {
    try {
      recordRefresh({ trigger, startedAt, finishedAt: new Date().toISOString(), ok: r.skipped ? null : r.ok, skipped: r.skipped, counts, error: r.error });
    } catch (e) { console.warn("[deals] inbox refresh log failed:", e); }
    return { ...r, counts };
  };

  let account: EmailAccountRecord | null = null;
  try { account = connectedAccount(); } catch (e: any) { return done({ ok: false, skipped: null, error: String(e?.message ?? e) }); }
  if (!account) return done({ ok: false, skipped: "Gmail is not connected", error: null });
  if (!account.historyId) return done({ ok: false, skipped: "No history cursor yet — the next full sync sets it", error: null });
  if (syncLockBusy()) return done({ ok: false, skipped: "The full sync is running", error: null });

  try {
    return await withSyncLock(async () => {
      // Re-read inside the lock: a heavy sync that just finished moved the cursor.
      const acct = connectedAccount();
      if (!acct?.historyId) return done({ ok: false, skipped: "No history cursor", error: null });
      const accountEmail = acct.email ?? "";
      const myEmail = accountEmail.toLowerCase();

      // 1. history
      const added = new Map<string, string>();            // messageId → threadId
      const labelled = new Map<string, { threadId: string; labelIds: string[] | null }>();
      const deleted = new Map<string, string>();          // messageId → threadId
      let newHistoryId = "";
      let pageToken: string | undefined;
      try {
        do {
          const h: any = await gmailCall("GET", "/history", undefined, {
            startHistoryId: acct.historyId,
            historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
            maxResults: "500",
            ...(pageToken ? { pageToken } : {}),
          });
          counts.gmailCalls++;
          counts.historyPages++;
          newHistoryId = h.historyId ?? newHistoryId;
          for (const item of h.history ?? []) {
            for (const ma of item.messagesAdded ?? []) {
              if (ma.message?.id) added.set(ma.message.id, ma.message.threadId ?? "");
            }
            for (const md of item.messagesDeleted ?? []) {
              if (md.message?.id) deleted.set(md.message.id, md.message.threadId ?? "");
            }
            for (const la of [...(item.labelsAdded ?? []), ...(item.labelsRemoved ?? [])]) {
              const m = la.message;
              if (!m?.id) continue;
              labelled.set(m.id, { threadId: m.threadId ?? "", labelIds: Array.isArray(m.labelIds) ? m.labelIds : null });
            }
          }
          pageToken = h.nextPageToken ?? undefined;
        } while (pageToken && counts.historyPages < 20);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/\(404\)/.test(msg)) return done({ ok: false, skipped: "History cursor too old — the next full sync re-reads the recent window", error: null });
        return done({ ok: false, skipped: null, error: msg });
      }
      counts.added = added.size;

      // 2. fetch only what we don't have
      const have = db.prepare(`SELECT 1 FROM deals_emails WHERE lower(account_email) = lower(?) AND message_id = ?`);
      const allMissing = [...added.keys()].filter((id) => !deleted.has(id) && !have.get(accountEmail, id));
      const missing = allMissing.slice(0, MAX_NEW_MESSAGES);
      const capped = allMissing.length > MAX_NEW_MESSAGES;
      const records: Partial<EmailRecord>[] = [];
      let fetchFailed = false;
      for (let i = 0; i < missing.length; i += 10) {
        const batch = missing.slice(i, i + 10);
        const res = await Promise.allSettled(batch.map((id) => getMessage(id, "full")));
        counts.gmailCalls += batch.length;
        res.forEach((r, k) => {
          if (r.status === "fulfilled") {
            const rec = parseMessage(r.value, myEmail, accountEmail);
            if (rec) records.push(rec);
          } else if (!/\(404\)/.test(String((r.reason as any)?.message ?? r.reason))) {
            fetchFailed = true; // a deleted message (404) is fine; anything else → retry next time
            console.warn(`[deals] inbox refresh: message ${batch[k]} failed:`, (r.reason as any)?.message ?? r.reason);
          }
        });
      }
      if (records.length) upsertEmails(records);
      counts.fetched = records.length;

      // 3. label changes on rows we already had
      const touched = new Set<string>([...added.values(), ...records.map((r) => r.threadId ?? "")].filter(Boolean));
      const fetchedIds = new Set(records.map((r) => r.messageId));
      const upd = db.prepare(`UPDATE deals_emails SET labels = ?, is_read = ?, updated_at = ? WHERE lower(account_email) = lower(?) AND message_id = ?`);
      const nowIso = new Date().toISOString();
      for (const [id, l] of labelled) {
        if (fetchedIds.has(id) || !l.labelIds) continue;
        const r = upd.run(JSON.stringify(l.labelIds), l.labelIds.includes("UNREAD") ? 0 : 1, nowIso, accountEmail, id);
        if (r.changes > 0) { counts.labelChanges++; if (l.threadId) touched.add(l.threadId); }
      }

      // 3b. a deleted DRAFT (edited in Gmail = new id, or discarded) leaves no stale
      //     "pending draft" behind. Only DRAFT rows are ever removed.
      const delDraft = db.prepare(`DELETE FROM deals_emails WHERE lower(account_email) = lower(?) AND message_id = ? AND labels LIKE '%"DRAFT"%'`);
      for (const [id, threadId] of deleted) {
        if (added.has(id) && !fetchedIds.has(id)) continue;
        if (delDraft.run(accountEmail, id).changes > 0) { counts.draftsRemoved++; if (threadId) touched.add(threadId); }
      }

      // 4. thread index from local rows (+ capped repairs)
      const addedPerThread = new Map<string, number>();
      for (const t of added.values()) if (t) addedPerThread.set(t, (addedPerThread.get(t) ?? 0) + 1);
      for (const threadId of touched) {
        const before = db.prepare(`SELECT message_count FROM deals_thread_index WHERE thread_id = ?`).get(threadId) as { message_count: number } | undefined;
        const local = localThreadRows(threadId);
        const expected = before ? Number(before.message_count ?? 0) + (addedPerThread.get(threadId) ?? 0) : 0;
        const firstMissing = !local.some((r) => r.message_id === threadId);
        if (counts.repairs < REPAIR_CAP && (local.length < expected || firstMissing)) {
          try {
            const t: any = await gmailCall("GET", `/threads/${threadId}`, undefined, { format: "full" });
            counts.gmailCalls++;
            counts.repairs++;
            const parsed = (t.messages ?? []).map((m: any) => parseMessage(m, myEmail, accountEmail)).filter(Boolean) as Partial<EmailRecord>[];
            if (parsed.length) upsertEmails(parsed);
          } catch (e: any) {
            if (!/\(404\)/.test(String(e?.message ?? e))) console.warn(`[deals] inbox refresh: repair of ${threadId} failed:`, e?.message ?? e);
          }
        }
        rebuildThreadIndexRow(threadId, accountEmail);
      }
      counts.threadsTouched = touched.size;

      // Cursor: forward only, and only when every fetch landed (else the next run retries).
      if (!fetchFailed && !capped && newHistoryId && newHistoryId !== acct.historyId) {
        emailAccounts.update(acct.id, { historyId: newHistoryId });
      }
      return done({ ok: !fetchFailed, skipped: null, error: fetchFailed ? "Some messages could not be fetched — they are retried on the next refresh" : capped ? `More than ${MAX_NEW_MESSAGES} new messages — the rest come with the next refresh` : null });
    });
  } catch (e: any) {
    return done({ ok: false, skipped: null, error: String(e?.message ?? e) });
  }
}

function localThreadRows(threadId: string): Array<{ message_id: string; date_iso: string | null; labels: string | null }> {
  return db.prepare(`SELECT message_id, date_iso, labels FROM deals_emails WHERE thread_id = ?`).all(threadId) as any[];
}

/**
 * One deals_thread_index row from the local email rows — the same fields
 * syncThreadIndex writes (subject/sender/recipient of the FIRST message, labels
 * + read state + date of the LAST one), with no Gmail call.
 */
export function rebuildThreadIndexRow(threadId: string, accountEmail: string): void {
  const rows = db.prepare(`SELECT subject, from_email, from_name, to_email, snippet, labels, date_iso, is_read FROM deals_emails
    WHERE thread_id = ? ORDER BY date_iso ASC, rowid ASC`).all(threadId) as any[];
  if (!rows.length) return;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const labels: string[] = safeJson(last.labels);
  threadIndex.upsertMany([{
    threadId,
    accountEmail,
    subject: first.subject || "(no subject)",
    senderName: first.from_name || first.from_email || "",
    senderEmail: (first.from_email ?? "").toLowerCase(),
    recipientEmail: extractEmail(first.to_email ?? ""),
    snippet: last.snippet ?? "",
    lastDate: last.date_iso ?? new Date().toISOString(),
    labels: JSON.stringify(labels),
    messageCount: rows.length,
    isRead: !labels.includes("UNREAD"),
  }], ["threadId"]);
}

let refresher: ReturnType<typeof setInterval> | null = null;

/**
 * Start the 15-minute light refresh (idempotent; the timer never keeps the
 * process alive). The first tick is 2 minutes after boot, then every 15.
 */
export function startInboxRefresher(): void {
  if (refresher) return;
  const tick = () => { refreshInbox("timer").catch((e) => console.warn("[deals] inbox refresh failed:", e)); };
  refresher = setInterval(tick, REFRESH_EVERY_MS);
  refresher.unref?.();
  const first = setTimeout(tick, 2 * 60_000);
  first.unref?.();
}
