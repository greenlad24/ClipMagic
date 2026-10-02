/**
 * Everything the agent reads about a thread besides the thread itself (#11,
 * #12): the deal(s) on the board this thread belongs to — decided by the ONE
 * shared matcher (../matching.ts), the same rules the deal card's Files, the
 * Emails page and the scanner use — with their actions, comments and ALL of
 * their threads; and the earlier threads with this company (same brand when
 * the sender is an agency) in the imported mailbox. Read-only.
 */
import { db } from "../../db/index.js";
import { clip, type ParsedMessage } from "./util.js";
import { decodeEntities } from "../inbox.js";
import {
  dealsForThread, threadsForDeal, contactsForDeal, brandForDeal, brandForThread, brandEq, mentions,
  isAgencySender, companyRoot, matchIndex,
} from "../matching.js";

export interface DealMatch {
  id: string;
  clientName: string;
  clientEmail: string;
  projectName: string | null;
  stage: string;
  value: number | null;
  deadline: string | null;
  archived: boolean;
  updatedAt: string;
  sourceThreadId: string | null;
  /**
   * thread = this thread is one of the deal's threads (Files shows it under the deal);
   * email  = the thread isn't synced yet, but its sender is one of the deal's contacts
   *          (or on the deal's company domain with the same brand) — same rules;
   * domain = context only (same sender / company, another brand's deal) — never updated.
   */
  matchedBy: "thread" | "email" | "domain";
  /** The deal's brand as the shared matcher sees it (additive). */
  brand?: string | null;
}

const toMatch = (r: any, by: DealMatch["matchedBy"]): DealMatch => ({
  id: r.id, clientName: r.client_name ?? "", clientEmail: r.client_email ?? "", projectName: r.project_name ?? null, stage: r.stage ?? "",
  value: r.estimated_value ?? null, deadline: r.deadline ?? null, archived: r.archived === 1, updatedAt: r.updated_at ?? "", sourceThreadId: r.source_thread_id ?? null,
  matchedBy: by, brand: brandForDeal(r.id),
});

export function findDeals(threadId: string, senderEmails: string[]): DealMatch[] {
  const out = new Map<string, DealMatch>();
  const row = db.prepare(`SELECT * FROM deals_deals WHERE id = ? AND merged_into IS NULL`);
  const push = (id: string, by: DealMatch["matchedBy"]) => {
    if (out.has(id)) return;
    const r = row.get(id) as any;
    if (r) out.set(id, toMatch(r, by));
  };
  const emails = [...new Set(senderEmails.map((e) => String(e ?? "").toLowerCase()).filter(Boolean))];
  // The deals this thread belongs to (every one of a deal's threads counts, not just its source thread).
  const own = dealsForThread(threadId);
  for (const h of own) push(h.dealId, "thread");
  // Not synced yet → the same rules from the sender side.
  if (!own.length) for (const h of dealsForThread(threadId, { senderEmails: emails })) push(h.dealId, "email");
  // Context only: other deals with the same sender / company (an agency's other brands). Never updated.
  if (emails.length) {
    for (const r of db.prepare(`SELECT id FROM deals_deals WHERE merged_into IS NULL AND lower(client_email) IN (${emails.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 10`).all(...emails) as any[]) push(r.id, "domain");
    const roots = [...new Set(emails.map((e) => companyRoot(e)).filter((d): d is string => !!d))];
    for (const root of roots) for (const r of db.prepare(`SELECT id FROM deals_deals WHERE merged_into IS NULL AND lower(client_email) LIKE ? ORDER BY updated_at DESC LIMIT 10`).all(`%@%${root}`) as any[]) push(r.id, "domain");
  }
  return [...out.values()];
}

/**
 * The deal the agent should update: one of this thread's deals (or, for a thread
 * not synced yet, a deal of its sender with the same brand) — never a context-only
 * "domain" match. Same brand required: agencies pitch several brands from one
 * address, and switch brands inside one thread (Oxylabs → GoHighLevel); each
 * brand is its own deal. Order = the shared matcher's ranking, open before archived.
 */
export function primaryDeal(ms: DealMatch[], brand?: string | null): DealMatch | null {
  const b = (brand ?? "").trim();
  const sameBrand = (d: DealMatch) => {
    if (slug(b).length < 3) return true;
    const dealBrand = d.brand === undefined ? brandForDeal(d.id) : d.brand;
    if (dealBrand) return brandEq(b, dealBrand) || mentions(dealBrand, b) || mentions(b, dealBrand);
    // Deal brand unknown: its name decides; a thread of the deal with no brand to compare stays with it.
    const hay = slug(`${d.clientName} ${d.projectName ?? ""}`);
    const bs = slug(b);
    if (hay.includes(bs) || (bs.length > 5 && hay.includes(bs.slice(0, 6)))) return true;
    return d.matchedBy === "thread";
  };
  const rank = (d: DealMatch) => (d.matchedBy === "thread" ? 0 : 1) * 2 + (d.archived ? 1 : 0);
  const eligible = ms.map((d, i) => ({ d, i })).filter(({ d }) => (d.matchedBy === "thread" || d.matchedBy === "email") && sameBrand(d));
  return eligible.sort((x, y) => rank(x.d) - rank(y.d) || x.i - y.i)[0]?.d ?? null;
}

const slug = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** One line per thread of the deal: subject, dates, who wrote last, the last inbound words. */
function dealThreadsText(dealId: string, maxThreads = 6): string[] {
  const ix = matchIndex();
  const rows = threadsForDeal(dealId)
    .map((r) => ({ r, t: ix.threads.get(r.threadId) }))
    .filter((x) => x.t && !x.t.junk)
    .sort((a, b) => (b.t!.lastAt ?? "").localeCompare(a.t!.lastAt ?? ""));
  const out: string[] = [];
  for (const { r, t } of rows.slice(0, maxThreads)) {
    const real = t!.msgs.filter((m) => !m.draft);
    if (!real.length) continue;
    const last = real[real.length - 1];
    const lastIn = [...real].reverse().find((m) => !m.isFromMe);
    const snippet = lastIn ? (db.prepare(`SELECT snippet FROM deals_emails WHERE message_id = ?`).get(lastIn.messageId) as any)?.snippet ?? "" : "";
    out.push(`    - "${clip(t!.subject, 80)}" [${r.matchedBy}] ${String(real[0].date ?? "").slice(0, 10)} → ${String(t!.lastAt ?? "").slice(0, 10)}, ${real.length} msgs, last from ${last.isFromMe ? "Jake" : "them"}${snippet ? ` — "${clip(decodeEntities(snippet), 160)}"` : ""}`);
  }
  if (rows.length > maxThreads) out.push(`    - … ${rows.length - maxThreads} more thread(s)`);
  return out;
}

export function dealContextText(ms: DealMatch[]): string {
  if (!ms.length) return "";
  const lines: string[] = [];
  for (const d of ms.slice(0, 5)) {
    const full = db.prepare(`SELECT about, opportunity, key_details, next_steps, description FROM deals_deals WHERE id = ?`).get(d.id) as any;
    const actions = db.prepare(`SELECT content, status, created_at FROM deals_deal_actions WHERE deal_id = ? ORDER BY created_at DESC LIMIT 6`).all(d.id) as any[];
    const comments = db.prepare(`SELECT content, author, created_at FROM deals_deal_comments WHERE deal_id = ? ORDER BY created_at DESC LIMIT 4`).all(d.id) as any[];
    const own = d.matchedBy !== "domain";
    const threads = own ? dealThreadsText(d.id) : [];
    const contacts = own ? contactsForDeal(d.id).slice(0, 8) : [];
    lines.push([
      `• ${d.projectName || d.clientName} <${d.clientEmail}> — column "${d.stage}"${d.archived ? " (archived)" : ""}${d.value ? `, value $${d.value}` : ""}${d.deadline ? `, deadline "${d.deadline}"` : ""}; matched by ${d.matchedBy}${d.matchedBy === "domain" ? " (context only — another deal of this sender/company, possibly another brand)" : ""}${d.brand ? `; brand ${d.brand}` : ""}; last updated ${d.updatedAt.slice(0, 10)}${d.value && d.value < 6000 ? " (value from an older price era — not binding for new quotes)" : ""}`,
      full?.about ? `  about: ${clip(full.about, 300)}` : "",
      full?.opportunity ? `  opportunity: ${clip(full.opportunity, 300)}` : "",
      full?.key_details ? `  key details: ${clip(full.key_details, 500)}` : "",
      full?.next_steps ? `  next steps: ${clip(full.next_steps, 300)}` : "",
      actions.length ? `  actions: ${actions.map((a) => `[${a.status}] ${clip(a.content, 120)}`).join(" | ")}` : "",
      comments.length ? `  comments: ${comments.map((c) => `${c.author}: ${clip(c.content, 160)}`).join(" | ")}` : "",
      contacts.length ? `  contacts on this deal: ${contacts.join(", ")}` : "",
      threads.length ? `  all email threads of this deal (newest first):\n${threads.join("\n")}` : "",
    ].filter(Boolean).join("\n"));
  }
  return lines.join("\n");
}

/**
 * Other threads with the same company (non-freemail domain) — or, when the
 * sender is an AGENCY (a domain pitching several brands), only the threads about
 * this thread's brand plus the sender's own threads. Free-mail → the sender's own threads.
 */
export function brandHistoryText(threadId: string, senderEmail: string): string {
  const ix = matchIndex();
  const sender = String(senderEmail ?? "").toLowerCase();
  const root = companyRoot(sender);
  const brand = brandForThread(threadId);
  const ids = new Set<string>(ix.byEmail.get(sender) ?? []);
  if (root) {
    const agency = isAgencySender(sender, brand);
    for (const tid of ix.byRoot.get(root) ?? []) {
      if (!agency) { ids.add(tid); continue; }
      const tb = ix.threads.get(tid)?.effBrand ?? null;
      if (brand && tb && brandEq(brand, tb)) ids.add(tid);
    }
  }
  ids.delete(threadId);
  const rows = [...ids].map((tid) => ix.threads.get(tid)).filter((t) => !!t && !t.junk).map((t) => {
    const real = t!.msgs.filter((m) => !m.draft);
    const all = t!.msgs;
    return {
      subject: all.reduce((m, x) => (x.subject > m ? x.subject : m), ""),
      first: all.reduce<string | null>((m, x) => (x.date && (!m || x.date < m) ? x.date : m), null),
      last: all.reduce<string | null>((m, x) => (x.date && (!m || x.date > m) ? x.date : m), null),
      n: all.length,
      mine: real.filter((m) => m.isFromMe).length,
    };
  }).sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? ""))).slice(0, 8);
  if (!rows.length) return "";
  return rows.map((r) => `- "${clip(r.subject, 90)}" (${String(r.first ?? "").slice(0, 10)} → ${String(r.last ?? "").slice(0, 10)}, ${r.n} msgs, Jake replied ${r.mine ?? 0}×)`).join("\n");
}

/** The thread as the models read it: oldest first, quotes stripped, Jake's side marked. */
export function transcriptOf(messages: ParsedMessage[]): string {
  return messages
    .filter((m) => !m.isDraft)
    .map((m) => {
      const who = m.isFromMe ? "[JAKE]" : `[${m.fromName} <${m.fromEmail}>]`;
      const when = m.date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const att = m.attachments.length ? `\n(attachments: ${m.attachments.join(", ")})` : "";
      return `----- ${when} ${who}${m.cc ? ` cc: ${m.cc}` : ""}\n${clip(m.fresh || m.body, 5000)}${att}`;
    })
    .join("\n\n");
}
