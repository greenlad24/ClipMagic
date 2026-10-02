/**
 * Deal Organizer — company/brand detection (ports of listCompanies and
 * clearThreadBrandsCache).
 *
 * Brand extraction runs on Claude (fast tier, JSON mode), in batches of up to
 * 50 threads (was 400). (The original's description said Gemini while its code called
 * OpenAI gpt-4.1-mini; neither is used here.)
 *
 * Bug-fix pass (SPEC §12 #16, #17):
 *   - Extraction moved out of listCompanies into `extractNewThreadBrands`, a
 *     step of the centralized sync (scheduledSync.ts); listCompanies only reads.
 *   - A thread whose extraction FAILED (AI error / unparseable answer) is not
 *     cached at all, so the next sync retries it. A thread the model answered
 *     with no brand is cached as '' and retried ONCE when it is 7 days old (redesign; was every 24 h) — at most
 *     RETRY_CAP such threads per sync, so a stubborn thread can't make every
 *     run expensive.
 *   - The prompt no longer contradicts itself: the brand is the PRODUCT being
 *     promoted; an agency's domain is never the brand; the sender's own domain
 *     counts only when the sender works for the brand; otherwise null.
 *   - clearThreadBrandsCache is one DELETE (it deleted while paging by offset
 *     and skipped rows).
 */
import { z } from "zod";
import { deals, emails, threadBrands, type DealRecord } from "./db.js";
import { loadStageConfig } from "./stageUtils.js";
import { db } from "../db/index.js";
import { ARCHIVED_FALSE, aiJSONText, resolveAccount, domainOf, isFreemail, parse, rootDomain, safeJson, type Handler } from "./common.js";
import { AUTOMATED_LOCAL, isFreeDomain, dealsForThread, brandForThread } from "./matching.js";

/**
 * Threads cached with no brand are retried ONCE, after this long (redesign
 * 2026-09-30: was every 24 h, forever)… A row whose updated_at is more than a
 * day after its created_at has had its retry.
 */
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** …at most this many per sync. */
const RETRY_CAP = 100;
/** Threads per brand-extraction call (was 400 — risked cutting the JSON answer off). */
const BRAND_BATCH = 50;

function displayFromDomain(domain: string) {
  return domain.split(".")[0].split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const SKIP_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "me.com", "googlemail.com"];
/** Automated mailboxes (info@ / support@ / hello@ are NOT skipped any more — they are often the brand itself). */
const SKIP_PREFIXES = ["noreply", "no-reply", "bounce", "mailer-daemon", "postmaster", "notifications", "news", "newsletter"];

async function extractBrandsWithAI(
  threads: Array<{ threadId: string; senderDomain: string; subject: string; senderName?: string; snippet?: string }>,
): Promise<{ brands: Record<string, string | null>; rawPrompt: string; rawResponse: string; error: string | null }> {
  if (threads.length === 0) return { brands: {}, rawPrompt: "", rawResponse: "", error: null };

  const payload = threads.map((t) => ({
    thread_id: t.threadId,
    subject: t.subject,
    sender: t.senderName ?? "",
    domain: t.senderDomain,
    snippet: (t.snippet ?? "").slice(0, 160),
  }));

  const prompt = `You are analyzing sponsorship/partnership/collaboration emails sent to a YouTube creator.
For each thread, identify the BRAND: the product or company that would be PROMOTED in the creator's video.

Key rules:
- The brand is the product being promoted — not the company that sent the email.
- Senders are often AGENCIES or talent/influencer-marketing firms. An agency's name or domain is NEVER the brand.
- Look for the brand in the subject first, then the snippet (e.g. "Genspark partnership", "Lovart AI collaboration" → "Genspark", "Lovart AI").
- Use the sender's domain as the brand ONLY when the sender clearly works for that product's own company (e.g. someone@notion.so pitching Notion) and nothing else names a brand.
- If you cannot tell which product would be promoted, return null. Never guess.
- Return the shortest recognizable brand name (e.g. "Nike" not "Nike Inc.").
- Normalize casing consistently (e.g. "Genspark" not "GENSPARK").

Return a JSON object mapping each thread_id to the brand name string or null:
{"thread_id_1": "BrandName", "thread_id_2": null}

Threads:
${JSON.stringify(payload)}`;

  try {
    const text = await aiJSONText("fast", "deals-company", "", [{ role: "user", content: prompt }]);
    const rawResponse = text;
    try {
      return { brands: JSON.parse(text || "{}"), rawPrompt: prompt, rawResponse, error: null };
    } catch (e) {
      return { brands: {}, rawPrompt: prompt, rawResponse, error: `JSON parse failed: ${String(e)}` };
    }
  } catch (e) {
    return { brands: {}, rawPrompt: prompt, rawResponse: "", error: String(e) };
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type ThreadDebug = { threadId: string; subject: string; domain: string };
type BatchDebug = {
  batchIndex: number; threadCount: number; threads: ThreadDebug[];
  rawPrompt: string; rawResponse: string;
  parsedBrands: Array<ThreadDebug & { brand: string | null }>;
  error: string | null; savedToDb: number; retried?: number;
};

type ThreadMeta = {
  threadId: string; senderDomain: string; senderEmail: string;
  senderName: string; subject: string; date: string; snippet: string;
};

/** Threads (with the partner's company domain) from the synced emails — the newest 5,000 (was the oldest 2,000). */
function buildThreadMeta(accountEmail: string, viewParam: "inbox" | "sent" | "drafts" | "archived" | "all") {
  const myDomain = rootDomain(domainOf(accountEmail));
  const emailRows = emails.where("lower(account_email) = lower(?) ORDER BY date_iso DESC, rowid DESC LIMIT 5000", accountEmail);
  const labelFiltered = viewParam === "all"
    ? emailRows
    : emailRows.filter((e) => {
        const labels: string[] = safeJson(e.labels);
        if (viewParam === "inbox") return labels.includes("INBOX");
        if (viewParam === "sent") return labels.includes("SENT");
        if (viewParam === "drafts") return labels.includes("DRAFT");
        if (viewParam === "archived") return !labels.some((l) => ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH"].includes(l));
        return true;
      });

  const threadMetaMap = new Map<string, ThreadMeta>();
  for (const email of labelFiltered) {
    const isFromMe = email.isFromMe ?? false;
    const rawEmail = isFromMe
      ? (email.toEmail ?? "").split(",")[0]?.trim().match(/<([^>]+)>/)?.[1] ?? (email.toEmail ?? "").trim()
      : (email.fromEmail ?? "");
    const name = isFromMe ? rawEmail : (email.fromName ?? rawEmail);

    if (!rawEmail || !rawEmail.includes("@")) continue;
    const domain = domainOf(rawEmail);
    const root = rootDomain(domain);
    if (!root) continue;
    // Shared rules (matching.ts): free-mail domains say nothing about a company, and only
    // automated mailboxes are skipped — hello@ / info@ / support@ are often the brand itself (was: skipped,
    // so e.g. support@okara.ai never got a brand).
    if (root === myDomain || SKIP_DOMAINS.includes(domain) || isFreeDomain(root)) continue;
    const prefix = rawEmail.split("@")[0].toLowerCase();
    if (AUTOMATED_LOCAL.test(prefix) || SKIP_PREFIXES.some((s) => prefix.startsWith(s))) continue;

    const tid = email.threadId;
    if (!tid) continue;

    if (!threadMetaMap.has(tid)) {
      threadMetaMap.set(tid, {
        threadId: tid, senderDomain: root, senderEmail: rawEmail,
        senderName: name || rawEmail, subject: email.subject ?? "",
        date: email.date ?? "", snippet: email.snippet ?? "",
      });
    } else {
      const ex = threadMetaMap.get(tid)!;
      if (email.date && (!ex.date || new Date(email.date) > new Date(ex.date))) ex.date = email.date;
    }
  }
  return { emailRows, labelFiltered, threadMetaMap };
}

/**
 * Brand extraction for threads not in the cache yet (plus due retries of
 * brandless rows) — the step of the centralized sync pipeline. The only place
 * the brand AI runs. Never throws for an AI failure (reported in `errors`).
 */
export async function extractNewThreadBrands(opts: { accountEmail?: string } = {}): Promise<{
  threads: number; cached: number; extracted: number; retried: number; branded: number; failedBatches: number; errors: string[];
}> {
  const account = resolveAccount(opts.accountEmail);
  if (!account) return { threads: 0, cached: 0, extracted: 0, retried: 0, branded: 0, failedBatches: 0, errors: ["Gmail is not connected"] };
  const accountEmail = account.email ?? "";
  const { threadMetaMap } = buildThreadMeta(accountEmail, "all");

  const cached = new Set<string>();
  const retryIds = new Set<string>();
  const now = Date.now();
  for (const r of threadBrands.where("lower(account_email) = lower(?) ORDER BY updated_at, rowid", accountEmail)) {
    if (!r.threadId) continue;
    // A brandless row older than 7 days, not yet retried, is due its one retry (oldest first, capped).
    const retriedAlready = Date.parse(r.updatedAt ?? "") - Date.parse(r.createdAt ?? "") > 24 * 60 * 60 * 1000;
    const due = !r.brandName && !retriedAlready && now - Date.parse(r.updatedAt ?? "") > RETRY_AFTER_MS && threadMetaMap.has(r.threadId);
    if (due && retryIds.size < RETRY_CAP) { retryIds.add(r.threadId); continue; }
    cached.add(r.threadId);
  }
  const todo = [...threadMetaMap.values()].filter((t) => !cached.has(t.threadId));

  const errors: string[] = [];
  let extracted = 0, branded = 0, failedBatches = 0;
  const batches = chunk(todo, BRAND_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const { brands: batchBrands, error } = await extractBrandsWithAI(batch);
    if (error) {
      // A failed batch is NOT cached, so the next run retries it.
      failedBatches++;
      errors.push(`Batch ${bi + 1}: ${error}`);
      continue;
    }
    // An answered batch caches '' for "no brand", retried after RETRY_AFTER_MS.
    const dbRecords = batch.map((t) => {
      const b = batchBrands[t.threadId];
      const brandName = typeof b === "string" ? b.trim().replace(/\s+/g, " ") : "";
      if (brandName) branded++;
      return {
        threadId: t.threadId, brandName, senderDomain: t.senderDomain, senderEmail: t.senderEmail,
        senderName: t.senderName, subject: t.subject, lastDate: t.date, accountEmail,
      };
    });
    try {
      for (const dbChunk of chunk(dbRecords, 100)) threadBrands.upsertMany(dbChunk, ["threadId"]);
      extracted += batch.length;
    } catch (e) {
      errors.push(`DB save batch ${bi + 1}: ${String(e)}`);
    }
  }
  return { threads: threadMetaMap.size, cached: cached.size, extracted, retried: retryIds.size, branded, failedBatches, errors };
}

export const listCompanies: Handler = async (raw) => {
  const input = parse(z.object({
    accountEmail: z.string().optional(),
    forceRefresh: z.boolean().optional(),
    debug: z.boolean().optional(),
    view: z.enum(["inbox", "sent", "drafts", "archived", "all"]).optional(),
  }), raw);
  const isDebug = input.debug === true;
  const errors: string[] = [];

  const account = resolveAccount(input.accountEmail);
  if (!account) return { companies: [], myEmail: "", newThreadsProcessed: 0, debugInfo: null };

  const accountEmail = account.email ?? "";
  const myEmail = accountEmail;

  // ── Step 1: threads from the synced emails (tables only)
  const { emailRows, labelFiltered, threadMetaMap } = buildThreadMeta(accountEmail, input.view ?? "all");
  const allThreadIds = [...threadMetaMap.keys()];

  // ── Step 2 + 3: brands from the cache. READ-ONLY: this endpoint no longer
  // calls the AI on page load — new threads are extracted by the centralized
  // sync (scheduledSync → extractNewThreadBrands). A thread not extracted yet
  // is grouped by its domain until then. `forceRefresh` is accepted but no
  // longer re-extracts (clearThreadBrandsCache + the next sync does that).
  const cachedBrandMap = new Map<string, string | null>();
  for (const r of threadBrands.where("lower(account_email) = lower(?) ORDER BY created_at, rowid", accountEmail)) {
    if (r.threadId) cachedBrandMap.set(r.threadId, r.brandName || null);
  }
  const cacheHits = allThreadIds.filter((tid) => cachedBrandMap.has(tid)).length;
  const cacheMisses = allThreadIds.length - cacheHits;
  const newThreads = allThreadIds.filter((tid) => !cachedBrandMap.has(tid)).map((tid) => threadMetaMap.get(tid)!);
  const newThreadsProcessed = 0;
  const batchDebugLogs: BatchDebug[] = [];


  // ── Step 5+6: Load deals & build groups
  let dbDeals: DealRecord[] = [];
  let stageFromDB: Record<string, string> = {};
  try {
    const { fromDB } = await loadStageConfig();
    dbDeals = deals.where(`${ARCHIVED_FALSE} ORDER BY created_at, rowid LIMIT 2000`);
    stageFromDB = fromDB;
  } catch { /* best effort */ }

  // A group's deals = the deals its threads belong to (shared matcher — the same
  // answer as the deal card's Files and the Emails page), open deals only.
  const liveDeals = new Map(dbDeals.map((d) => [d.id, d]));
  function dealsForThreads(threadIds: string[]) {
    const out = new Map<string, { id: string; projectName: string; stage: string }>();
    for (const tid of threadIds) for (const h of dealsForThread(tid)) {
      const d = liveDeals.get(h.dealId);
      if (d && !out.has(d.id)) out.set(d.id, { id: d.id, projectName: d.projectName ?? "", stage: stageFromDB[d.stage ?? ""] ?? d.stage ?? "" });
    }
    return [...out.values()];
  }

  type GroupData = {
    brandName: string | null; senderDomain: string; threadIds: string[];
    lastDate: string; sampleEmail: string; sampleName: string;
  };
  const groups = new Map<string, GroupData>();

  for (const t of threadMetaMap.values()) {
    // The shared brand logic: extracted, else inferred (subject / the brand's own domain).
    const rawBrand = cachedBrandMap.get(t.threadId) ?? brandForThread(t.threadId) ?? null;
    const brandName = rawBrand ? rawBrand.trim().replace(/\s+/g, " ") : null;
    const groupKey = brandName ? `${brandName.toLowerCase()}::${t.senderDomain}` : `::${t.senderDomain}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        brandName, senderDomain: t.senderDomain, threadIds: [],
        lastDate: "", sampleEmail: t.senderEmail, sampleName: t.senderName,
      });
    }
    const g = groups.get(groupKey)!;
    g.threadIds.push(t.threadId);
    if (!g.lastDate || (t.date && new Date(t.date) > new Date(g.lastDate))) g.lastDate = t.date;
  }

  const companies = [...groups.values()].map((g) => {
    const hasBrand = !!g.brandName;
    const displayName = hasBrand ? g.brandName! : displayFromDomain(g.senderDomain);
    const companyKey = hasBrand
      ? `${g.brandName!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}::${g.senderDomain}`
      : `::${g.senderDomain}`;

    return {
      domain: g.senderDomain,
      displayName,
      sampleEmail: g.sampleEmail,
      sampleName: hasBrand ? g.brandName! : g.sampleName,
      threadCount: g.threadIds.length,
      lastDate: g.lastDate,
      deals: dealsForThreads(g.threadIds),
      brandTag: g.brandName ?? "",
      agencyName: g.senderDomain,
      companyKey,
      threadIds: g.threadIds,
    };
  });

  companies.sort((a, b) => {
    if (b.threadCount !== a.threadCount) return b.threadCount - a.threadCount;
    return new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime();
  });

  const debugInfo = isDebug ? {
    step1_emailsFetched: emailRows.length,
    step1_inboxEmails: labelFiltered.length,
    step2_uniqueThreads: allThreadIds.length,
    step2_threads: allThreadIds.slice(0, 200).map((tid) => {
      const t = threadMetaMap.get(tid)!;
      return { threadId: t.threadId, subject: t.subject, domain: t.senderDomain };
    }),
    step3_cacheHits: cacheHits,
    step3_cacheMisses: cacheMisses,
    step3_cachedSample: allThreadIds
      .filter((tid) => cachedBrandMap.has(tid))
      .slice(0, 50)
      .map((tid) => ({ threadId: tid, brand: cachedBrandMap.get(tid) ?? null })),
    step4_newThreads: newThreads.slice(0, 200).map((t) => ({
      threadId: t.threadId, subject: t.subject, domain: t.senderDomain,
    })),
    step5_batches: batchDebugLogs,
    step6_groups: [...groups.entries()].map(([key, g]) => ({
      companyKey: key,
      displayName: g.brandName ?? displayFromDomain(g.senderDomain),
      brand: g.brandName,
      domain: g.senderDomain,
      threadCount: g.threadIds.length,
    })).sort((a, b) => b.threadCount - a.threadCount),
    totalNewProcessed: newThreadsProcessed,
    errors,
  } : null;

  // pendingBrandThreads (additive): threads the next sync will run brand extraction on.
  return { companies, myEmail, newThreadsProcessed, pendingBrandThreads: newThreads.length, debugInfo };
};

/* ── clearThreadBrandsCache ───────────────────────────────────────────────── */

export const clearThreadBrandsCache: Handler = async (raw) => {
  const input = parse(z.object({ accountEmail: z.string().optional() }), raw);
  const account = resolveAccount(input.accountEmail);
  if (!account) return { deleted: 0 };

  // One statement (bug 16: the original deleted while paging by OFFSET, so every
  // second page was skipped).
  const deleted = db.prepare("DELETE FROM deals_thread_brands WHERE lower(account_email) = lower(?)").run(account.email ?? "").changes;
  return { deleted };
};
