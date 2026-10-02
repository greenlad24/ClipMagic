/**
 * Deal Organizer — THE matcher: which threads, contacts and brand belong to a
 * deal, and (the same rules in reverse) which deal a thread belongs to.
 *
 * Every place that answers one of these questions calls this module: the deal
 * card's Files (dealFiles.ts), the Gmail scanner (scan.ts), the live email agent
 * (agent/context.ts), the Emails page (inbox.ts, threads.ts), the company list
 * (companies.ts), analytics (metrics.ts), follow-ups (replies.ts, gmailSync.ts)
 * and the chat's tools (chatAgent.ts). So a thread shown under a deal in Files
 * is the thread that maps back to that deal everywhere else.
 *
 * Reads are SQL over deals_emails / deals_thread_brands / deals_thread_index /
 * deals_deals — ZERO Gmail and ZERO AI calls.
 *
 * Deal → threads (`threadsForDeal` = `relatedThreadsForDeal`), in precedence:
 *   source        the deal's source_thread_id (+ those of deals merged into it)
 *   manual        linked by Jake (deals_deal_threads, matched_by='manual')
 *   contact       any message from/to ANY of the deal's contacts: client_email,
 *                 emails in contact_info, and every non-Jake participant already
 *                 seen on the deal's threads — iterated to closure (capped)
 *   domain+brand  same company domain (never free-mail / platform) AND the
 *                 thread's brand equals the deal's brand — agencies pitch many
 *                 brands, so a different brand is never pulled in
 *   platform      a signing / payment / doc-share notice that names a deal
 *                 contact (or contact name + brand)
 * minus manual exclusions. Brand guard on every automatic match: a thread whose
 * brand is known and differs from the deal's, or that is the source thread of a
 * DIFFERENT deal with a different brand, is never attached.
 *
 * Thread → deals (`dealsForThread`): the exact inverse — every deal whose
 * threadsForDeal contains the thread (one cached reverse map, rebuilt when the
 * data changes). A thread the local tables don't have yet (the agent / scanner
 * read it straight from Gmail) gets the same rules applied from the sender side:
 * a sender in a deal's contact closure (brand guard), or a sender on a deal's
 * company domain with the same brand. Ranked: open before archived, then the
 * brand hint, then source > manual > contact > domain+brand > platform, then
 * most recently updated.
 *
 * Brand (`brandForThread` / `brandForDeal`) — one logic:
 *   thread  the extracted brand (deals_thread_brands), else the one known brand
 *           its subject names, else the brand whose own domain the counterpart
 *           writes from (okara.ai → Okara) when that domain is not an agency's.
 *   deal    the brand of its source/manual threads — unless the card's own
 *           project name names a DIFFERENT known brand (the card was re-pointed
 *           at another brand's thread: the card wins) — else the known brand its
 *           project / client name names, else its source thread's inferred brand.
 * Agency (`isAgencySender` / `senderKind`): a company domain that pitches
 * several brands, or whose name is not the brand's. Free-mail and platform
 * domains are never a company.
 *
 * Own tables (additive):
 *   deals_deal_threads            (deal_id, thread_id) → matched_by, created_at
 *   deals_deal_thread_exclusions  (deal_id, thread_id) → created_at
 */
import { db } from "../db/index.js";
import { FREEMAIL_DOMAINS, FALLBACK_MY_EMAIL, connectedAccount, domainOf, rootDomain, safeJson } from "./common.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_deal_threads (
  deal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  matched_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deal_id, thread_id)
);
CREATE INDEX IF NOT EXISTS deals_deal_threads_thread ON deals_deal_threads (thread_id);

CREATE TABLE IF NOT EXISTS deals_deal_thread_exclusions (
  deal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deal_id, thread_id)
);
`);

export type MatchedBy = "source" | "manual" | "contact" | "domain+brand" | "platform";
export const MATCH_RANK: Record<MatchedBy, number> = { source: 0, manual: 1, contact: 2, "domain+brand": 3, platform: 4 };

const MAX_ROUNDS = 3;
const MAX_CONTACTS = 40;
const MAX_THREADS = 60;
const now = () => new Date().toISOString();

/* ── small helpers ───────────────────────────────────────────────────────── */

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
export const emailsIn = (s: string | null | undefined): string[] => (String(s ?? "").match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/^['.]+|['.]+$/g, ""));
export const slug = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Same brand: equal slugs, or one a prefix of the other ("Genspark" / "Genspark AI"). */
export function brandEq(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = slug(a), y = slug(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x));
}

/** Short brand names that are also ordinary words: only a case-exact mention counts. */
const COMMON_WORDS = new Set(["make", "air", "atom", "twin", "dub", "riff", "eva", "aha", "lama", "base", "poppy", "nori", "cuey", "rork", "pexo", "apob", "veed"]);
const mentionCache = new Map<string, RegExp | null>();
/** Word-boundary mention of a brand name in free text (brand ≥ 4 letters). */
export function mentions(text: string, brand: string): boolean {
  let re = mentionCache.get(brand);
  if (re === undefined) {
    const b = brand.trim();
    const s = slug(b);
    if (s.length < 4) re = null;
    else {
      const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s._-]*");
      // Short / common-word brands ("Make", "Twin") must match the brand's own casing.
      const exact = s.length < 5 || COMMON_WORDS.has(s);
      re = new RegExp(`(^|[^a-zA-Z0-9])${esc}([^a-zA-Z0-9]|$)`, exact ? "" : "i");
    }
    mentionCache.set(brand, re);
  }
  return !!re && re.test(text ?? "");
}

/** No-reply / notification mailboxes: never a person, never expanded from. */
export const AUTOMATED_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|noreply-\w+|notifications?|notify|mailer-daemon|postmaster|alerts?|digest|newsletters?|billing|receipts?|invoice|statements|affiliates?|calendar-notification|drive-shares-\w+|comments-noreply|security|dse|docs|mailer)([._+-]|$)/i;

/** Signing / payment / doc-share platforms whose notices carry contracts, receipts and briefs. */
export const PLATFORM_ROOTS = new Set([
  "docusign.net", "docusign.com", "pandadoc.net", "pandadoc.com", "sign.com", "signatureapi.com", "juro.com",
  "documenso.com", "opensignlabs.com", "hellosign.com", "dropboxsign.com", "echosign.com", "adobesign.com",
  "signnow.com", "yousign.com", "signwell.com", "stripe.com", "paypal.com", "wise.com", "payoneer.com",
  "tipalti.com", "deel.com", "bill.com", "google.com", "dropbox.com", "docsend.com", "notion.so", "box.com",
]);
/** Domains that say nothing about which company someone belongs to. */
export const NON_COMPANY_ROOTS = new Set([...PLATFORM_ROOTS, "example.com", "googlegroups.com", "calendly.com", "zoom.us"]);

/** Free-mail root (gmail.com, yahoo.co.uk …) — or empty. */
export function isFreeDomain(root: string): boolean {
  const r = (root ?? "").toLowerCase();
  return !r || FREEMAIL_DOMAINS.has(r) || /^(yahoo|hotmail|outlook|live)\./.test(r);
}

/** The root domain when it identifies a company (never free-mail / platform / example), else null. */
export function companyRoot(emailOrDomain: string | null | undefined): string | null {
  const s = String(emailOrDomain ?? "").trim().toLowerCase();
  const root = rootDomain(s.includes("@") ? domainOf(s) : s);
  if (!root || isFreeDomain(root) || NON_COMPANY_ROOTS.has(root)) return null;
  return root;
}

/** A real person's address (not Jake, not a no-reply / platform mailbox). */
export function isPersonAddress(e: string, me: Set<string> = myAddresses()): boolean {
  if (!e || me.has(e)) return false;
  const [local, dom] = e.split("@");
  if (!dom || rootDomain(dom) === "example.com") return false;
  return !AUTOMATED_LOCAL.test(local) && !PLATFORM_ROOTS.has(rootDomain(dom));
}

/** The company part of a domain: "tec-do.com" → "tecdo", "foo.co.uk" → "foo". */
function domainLabel(root: string): string {
  const parts = root.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 1) return slug(parts[0]);
  const sld = parts[parts.length - 2];
  const core = ["co", "com", "net", "org"].includes(sld) && parts.length >= 3 ? parts[parts.length - 3] : sld;
  return slug(core);
}

/** Does the domain look like the brand's own ("okara.ai" / "Okara", "createugc.ai" / "CreateUGC")? */
export function domainIsBrand(root: string, brand: string | null | undefined): boolean {
  const label = domainLabel(root);
  const b = slug(brand);
  if (!label || !b || label.length < 3) return false;
  if (b.includes(label) || label.includes(b)) return true;
  if (b.length >= 5 && label.startsWith(b.slice(0, 5))) return true;
  return String(brand ?? "").toLowerCase().split(/[^a-z0-9]+/).some((t) => t.length >= 4 && label.includes(t));
}

/* ── the local index (one pass over deals_emails; cached on a data signature) ── */

export interface Msg {
  messageId: string; threadId: string; subject: string; fromEmail: string; fromName: string; to: string;
  date: string | null; isFromMe: boolean; draft: boolean; junk: boolean; attachments: string | null; urls: string | null;
}
export interface ThreadInfo {
  id: string;
  subject: string;
  /** Extracted brand (deals_thread_brands). */
  brand: string | null;
  /** Extracted brand, else inferred from the subject / the brand's own domain. */
  effBrand: string | null;
  msgs: Msg[];
  people: Set<string>;               // non-Jake participants (from + to)
  names: Map<string, string>;        // email → display name (their own From header)
  lastAt: string | null;
  platform: boolean;                 // first sender is a signing/payment/share platform
  platformText: string;              // subject + from names + attachment names (platform threads)
  junk: boolean;
  indexCount: number;                // message count Gmail reported (deals_thread_index)
}
export interface Index {
  sig: string;
  me: Set<string>;
  threads: Map<string, ThreadInfo>;
  byEmail: Map<string, Set<string>>;
  byRoot: Map<string, Set<string>>;
  platformThreads: string[];
  brands: string[];                  // distinct known brand names
  /** company root → distinct brand slugs its senders pitched (agency detection). */
  rootBrands: Map<string, Set<string>>;
  /** extracted brand per thread id, incl. threads with no local mail. */
  brandOf: Map<string, string>;
  memo: Map<string, any>;            // per-thread memo for callers (dealFiles' file lists)
}

let cache: Index | null = null;

/**
 * Data signatures are aggregate scans over big tables (deals_emails rows carry
 * whole bodies), so one computed signature is reused for SIG_TTL_MS: a page that
 * asks about 1,000 threads pays for it once. Writers in this process can call
 * invalidateMatching() to see their rows at once.
 */
const SIG_TTL_MS = 1000;
let sigMemo: { at: number; ix: string; map: string } | null = null;
function signatures(): { ix: string; map: string } {
  if (sigMemo && Date.now() - sigMemo.at < SIG_TTL_MS) return sigMemo;
  const ix = signature();
  sigMemo = { at: Date.now(), ix, map: mapSignature(ix) };
  return sigMemo;
}

function signature(): string {
  const a = db.prepare(`SELECT count(*) n, max(updated_at) u FROM deals_emails`).get() as any;
  const b = db.prepare(`SELECT count(*) n, max(updated_at) u FROM deals_thread_brands`).get() as any;
  const c = db.prepare(`SELECT count(*) n, max(updated_at) u FROM deals_thread_index`).get() as any;
  return `${a.n}|${a.u}|${b.n}|${b.u}|${c.n}|${c.u}`;
}

/** Jake's own addresses (the connected account + every address he sent from). */
export function myAddresses(): Set<string> {
  const me = new Set<string>([FALLBACK_MY_EMAIL]);
  const acct = connectedAccount()?.email;
  if (acct) me.add(acct.toLowerCase());
  for (const r of db.prepare(`SELECT DISTINCT lower(from_email) e FROM deals_emails WHERE is_from_me = 1`).all() as any[]) if (r.e) me.add(r.e);
  return me;
}

/** Forget the cached index + reverse map (after writing new mail rows). */
export function invalidateMatching(): void {
  cache = null;
  mapCache = null;
  sigMemo = null;
}

/** The local index; rebuilt only when deals_emails / thread_brands / thread_index change. */
export function matchIndex(): Index {
  const sig = signatures().ix;
  if (cache && cache.sig === sig) return cache;
  const me = myAddresses();
  const threads = new Map<string, ThreadInfo>();
  const rows = db.prepare(`SELECT message_id, thread_id, subject, from_email, from_name, to_email, date_iso, is_from_me, labels, attachments, urls
    FROM deals_emails WHERE thread_id IS NOT NULL AND thread_id != '' ORDER BY date_iso ASC, rowid ASC`).all() as any[];
  const brandRows = db.prepare(`SELECT thread_id, brand_name, sender_domain FROM deals_thread_brands`).all() as any[];
  const brandOf = new Map<string, string>();
  const brandSet = new Map<string, string>();
  const rootBrands = new Map<string, Set<string>>();
  for (const b of brandRows) {
    const name = String(b.brand_name ?? "").trim();
    if (!b.thread_id || !name || /^(unknown|none|n\/a)$/i.test(name)) continue;
    brandOf.set(b.thread_id, name);
    if (slug(name).length >= 4 && !brandSet.has(slug(name))) brandSet.set(slug(name), name);
    const root = companyRoot(b.sender_domain);
    if (root) {
      if (!rootBrands.has(root)) rootBrands.set(root, new Set());
      const set = rootBrands.get(root)!;
      // Distinct by brandEq ("Kimi" / "Kimi AI" are one brand).
      if (![...set].some((x) => brandEq(x, name))) set.add(slug(name));
    }
  }
  const counts = new Map<string, number>();
  for (const r of db.prepare(`SELECT thread_id, message_count FROM deals_thread_index`).all() as any[]) counts.set(r.thread_id, Number(r.message_count ?? 0));

  for (const r of rows) {
    const labels = String(r.labels ?? "");
    const m: Msg = {
      messageId: r.message_id, threadId: r.thread_id, subject: r.subject ?? "", fromEmail: String(r.from_email ?? "").toLowerCase(),
      fromName: r.from_name ?? "", to: r.to_email ?? "", date: r.date_iso ?? null,
      isFromMe: r.is_from_me === 1 || me.has(String(r.from_email ?? "").toLowerCase()),
      draft: labels.includes('"DRAFT"'), junk: labels.includes('"SPAM"') || labels.includes('"TRASH"'),
      attachments: r.attachments ?? null, urls: r.urls ?? null,
    };
    let t = threads.get(m.threadId);
    if (!t) {
      const brand = brandOf.get(m.threadId) ?? null;
      t = { id: m.threadId, subject: m.subject, brand, effBrand: brand, msgs: [], people: new Set(), names: new Map(), lastAt: null,
        platform: PLATFORM_ROOTS.has(rootDomain(domainOf(m.fromEmail))), platformText: "", junk: true, indexCount: counts.get(m.threadId) ?? 0 };
      threads.set(m.threadId, t);
    }
    t.msgs.push(m);
    if (!m.junk) t.junk = false;
    if (!m.draft && m.date && (!t.lastAt || m.date > t.lastAt)) t.lastAt = m.date;
    if (!m.isFromMe && m.fromEmail) {
      t.people.add(m.fromEmail);
      if (m.fromName && !t.names.has(m.fromEmail)) t.names.set(m.fromEmail, m.fromName);
    }
    for (const e of emailsIn(m.to)) if (!me.has(e)) t.people.add(e);
    if (t.platform) {
      const names = (safeJson(m.attachments ?? "[]") as any[]).map((a) => a?.name ?? "").join(" ");
      t.platformText += ` ${m.subject} ${m.fromName} ${names}`;
    }
  }

  const brands = [...brandSet.values()];
  const byEmail = new Map<string, Set<string>>();
  const byRoot = new Map<string, Set<string>>();
  const platformThreads: string[] = [];
  for (const t of threads.values()) {
    if (!t.brand && !t.platform) t.effBrand = inferThreadBrand(t.subject, t.people, brands, rootBrands);
    if (t.junk) continue;
    if (t.platform) platformThreads.push(t.id);
    for (const e of t.people) {
      if (!byEmail.has(e)) byEmail.set(e, new Set());
      byEmail.get(e)!.add(t.id);
      const root = companyRoot(e);
      if (root) {
        if (!byRoot.has(root)) byRoot.set(root, new Set());
        byRoot.get(root)!.add(t.id);
      }
    }
  }
  cache = { sig, me, threads, byEmail, byRoot, platformThreads, brands, rootBrands, brandOf, memo: new Map() };
  mapCache = null;
  return cache;
}

/** The longest known brand the text names (null when none). */
function brandNamedIn(text: string | null | undefined, brands: string[]): string | null {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  let best: string | null = null;
  for (const b of brands) if (mentions(s, b) && (!best || slug(b).length > slug(best).length)) best = b;
  return best;
}

/**
 * A thread with no extracted brand: the ONE known brand its subject names
 * (two different ones → unknown), else the brand whose own domain the
 * counterpart writes from — never an agency's (multi-brand) domain.
 */
function inferThreadBrand(subject: string, people: Iterable<string>, brands: string[], rootBrands: Map<string, Set<string>>): string | null {
  const named = brands.filter((b) => mentions(subject, b));
  const distinct: string[] = [];
  for (const b of named.sort((x, y) => slug(y).length - slug(x).length)) if (!distinct.some((d) => brandEq(d, b) || mentions(d, b))) distinct.push(b);
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) return null;
  for (const e of people) {
    const root = companyRoot(e);
    if (!root || (rootBrands.get(root)?.size ?? 0) > 1) continue;
    const label = domainLabel(root);
    if (label.length < 4) continue;
    const own = brands.find((b) => { const s = slug(b); return s.length >= 4 && (s === label || s.startsWith(label) || label.startsWith(s)); });
    if (own) return own;
  }
  return null;
}

/* ── brand / agency ──────────────────────────────────────────────────────── */

/** The brand a thread is about (extracted → subject → brand's own domain), or null. */
export function brandForThread(threadId: string): string | null {
  const ix = matchIndex();
  const t = ix.threads.get(threadId);
  if (t) return t.effBrand;
  return ix.brandOf.get(threadId) ?? null;
}

/** The known brand a free text names (a project name, the scanner's extraction), else null. */
export function brandFromText(text: string | null | undefined): string | null {
  return brandNamedIn(text, matchIndex().brands);
}

/**
 * Sender relationship to the brand: "direct" (the brand's own domain),
 * "agency" (a company domain pitching several brands, or not named like the
 * brand), "unknown" (free-mail / platform / no brand to compare with).
 */
export function senderKind(emailOrDomain: string | null | undefined, brand: string | null | undefined): "direct" | "agency" | "unknown" {
  const root = companyRoot(emailOrDomain);
  if (!root) return "unknown";
  const b = String(brand ?? "").trim();
  if (b && domainIsBrand(root, b)) return "direct";
  if ((matchIndex().rootBrands.get(root)?.size ?? 0) > 1) return "agency";
  if (!b || slug(b).length < 3) return "unknown";
  return "agency";
}

/** The "brand" is really the sender's agency: a multi-brand company domain named like it ("Mediamz" / mediamz.com). */
export function isAgencyName(emailOrDomain: string | null | undefined, brand: string | null | undefined): boolean {
  const root = companyRoot(emailOrDomain);
  return !!root && !!brand && (matchIndex().rootBrands.get(root)?.size ?? 0) > 1 && domainIsBrand(root, brand);
}

/** True when the sender writes on behalf of a brand that isn't their own company. */
export function isAgencySender(emailOrDomain: string | null | undefined, brand?: string | null): boolean {
  return senderKind(emailOrDomain, brand) === "agency";
}

/* ── deals ───────────────────────────────────────────────────────────────── */

export interface DealRow {
  id: string; client_name: string | null; project_name: string | null; client_email: string | null; contact_info: string | null;
  source_thread_id: string | null; archived: number | null; merged_into: string | null; updated_at: string | null; source?: string | null;
}

interface DealCtx {
  id: string;
  brand: string | null;
  contacts: Set<string>;          // direct: client_email + contact_info
  sources: string[];
}

function loadDeals(): DealRow[] {
  return db.prepare(`SELECT id, client_name, project_name, client_email, contact_info, source_thread_id, archived, merged_into, updated_at, source FROM deals_deals`).all() as DealRow[];
}

const PLATFORM_BRAND = /^(docusign|pandadoc|google|stripe|paypal|dropbox|notion|wise)$/i;

function dealBrandOf(d: DealRow, ix: Index, sources: string[], manual: string[]): string | null {
  let threadBrand: string | null = null;
  for (const t of [...sources, ...manual]) { const b = ix.threads.get(t)?.brand ?? ix.brandOf.get(t); if (b && !PLATFORM_BRAND.test(slug(b))) { threadBrand = b; break; } }
  const known = ix.brands.filter((b) => !PLATFORM_BRAND.test(slug(b)));
  // A deal the live agent created: client_name IS the brand it triaged (its project name repeats it).
  const agentBrand = d.source === "agent" && slug(d.client_name).length >= 4 && mentions(d.project_name ?? "", String(d.client_name)) ? String(d.client_name).trim() : null;
  if (agentBrand) return agentBrand;
  const nameBrand = brandNamedIn(d.project_name, known);
  // The card names a different brand than its thread → the card was re-pointed at another brand's thread; the card wins.
  if (threadBrand && nameBrand && !brandEq(threadBrand, nameBrand) && !mentions(d.project_name ?? "", threadBrand)) return nameBrand;
  if (threadBrand) return threadBrand;
  const inferred = nameBrand ?? brandNamedIn(d.client_name, known);
  if (inferred) return inferred;
  for (const t of sources) { const b = ix.threads.get(t)?.effBrand; if (b) return b; }
  return null;
}

function dealCtx(d: DealRow, all: DealRow[], ix: Index, manual: string[]): DealCtx {
  const sources = [d.source_thread_id, ...all.filter((x) => x.merged_into === d.id).map((x) => x.source_thread_id)]
    .filter((x): x is string => !!x);
  const contacts = new Set<string>();
  const ce = (d.client_email ?? "").trim().toLowerCase();
  if (ce && !ix.me.has(ce) && rootDomain(domainOf(ce)) !== "example.com") contacts.add(ce); // the client address even if it's a no-reply
  for (const e of emailsIn(d.contact_info)) if (isPersonAddress(e, ix.me)) contacts.add(e);
  for (const x of all) if (x.merged_into === d.id) {
    const e = (x.client_email ?? "").toLowerCase();
    if (e && isPersonAddress(e, ix.me)) contacts.add(e);
  }
  return { id: d.id, brand: dealBrandOf(d, ix, [...new Set(sources)], manual), contacts, sources: [...new Set(sources)] };
}

/** thread → brand of the deal(s) whose SOURCE thread it is (for the "other deal" guard). */
function sourceBrands(all: DealRow[], ix: Index): Map<string, Array<{ dealId: string; brand: string | null }>> {
  const m = new Map<string, Array<{ dealId: string; brand: string | null }>>();
  for (const d of all) {
    if (!d.source_thread_id || d.merged_into) continue;
    const brand = dealBrandOf(d, ix, [d.source_thread_id], []);
    if (!m.has(d.source_thread_id)) m.set(d.source_thread_id, []);
    m.get(d.source_thread_id)!.push({ dealId: d.id, brand });
  }
  return m;
}

/* ── resolver ────────────────────────────────────────────────────────────── */

export interface RelatedThread { threadId: string; matchedBy: MatchedBy; via?: string }

export interface Shared { ix: Index; all: DealRow[]; srcBrands: Map<string, Array<{ dealId: string; brand: string | null }>> }
/** One snapshot of the index + deals, to pass to many resolver calls in a row. */
export function sharedSnapshot(): Shared {
  const ix = matchIndex();
  const all = loadDeals();
  return { ix, all, srcBrands: sourceBrands(all, ix) };
}

interface Resolved {
  threads: RelatedThread[];
  brand: string | null;
  /** contact closure (every address that pulled a thread in, + the deal's own). */
  seen: Set<string>;
  /** the deal's own contacts + the people on its source/manual threads. */
  direct: Set<string>;
  /** company roots of the closure. */
  roots: Set<string>;
}

function resolve(dealId: string, sh: Shared, persist: boolean): Resolved | null {
  const { ix, all, srcBrands } = sh;
  const d = all.find((x) => x.id === dealId);
  if (!d) return null;

  const stored = db.prepare(`SELECT thread_id, matched_by FROM deals_deal_threads WHERE deal_id = ?`).all(dealId) as Array<{ thread_id: string; matched_by: MatchedBy }>;
  const excluded = new Set((db.prepare(`SELECT thread_id FROM deals_deal_thread_exclusions WHERE deal_id = ?`).all(dealId) as any[]).map((r) => r.thread_id as string));
  const manual = stored.filter((s) => s.matched_by === "manual").map((s) => s.thread_id);
  const ctx = dealCtx(d, all, ix, manual);

  /** false when the thread belongs to a different brand (known) or is another brand's deal's source. */
  const brandOk = (tid: string, direct: boolean): boolean => {
    const t = ix.threads.get(tid);
    if (!t || t.junk) return false;
    for (const s of srcBrands.get(tid) ?? []) {
      if (s.dealId === dealId || !s.brand) continue;
      if (!ctx.brand || !brandEq(s.brand, ctx.brand)) return false;
    }
    if (t.effBrand) {
      if (ctx.brand) return brandEq(t.effBrand, ctx.brand);
      return direct; // unknown deal brand: only the deal's own contacts' branded threads
    }
    // No brand at all: refuse when the subject names another known brand and not ours.
    const other = ix.brands.find((b) => mentions(t.subject, b) && !(ctx.brand && brandEq(b, ctx.brand)));
    if (other && !(ctx.brand && mentions(t.subject, ctx.brand))) return false;
    return true;
  };

  const out = new Map<string, RelatedThread>();
  const add = (tid: string, by: MatchedBy, via?: string): boolean => {
    if (!tid || excluded.has(tid)) return false;
    const cur = out.get(tid);
    if (cur && MATCH_RANK[cur.matchedBy] <= MATCH_RANK[by]) return false;
    if (!cur && out.size >= MAX_THREADS && by !== "source" && by !== "manual") return false;
    out.set(tid, { threadId: tid, matchedBy: by, via });
    return true;
  };

  for (const t of ctx.sources) add(t, "source");
  for (const t of manual) add(t, "manual");
  for (const s of stored) {
    if (s.matched_by === "manual" || s.matched_by === "source") continue;
    if (brandOk(s.thread_id, s.matched_by === "contact")) add(s.thread_id, s.matched_by);
  }

  // Contact closure. Seeds: the deal's contacts + the people on its own (source/manual) threads.
  const seen = new Set<string>();
  let frontier: string[] = [];
  const pushContact = (e: string) => { if (!seen.has(e) && seen.size < MAX_CONTACTS) { seen.add(e); frontier.push(e); } };
  for (const e of ctx.contacts) pushContact(e);
  for (const tid of [...ctx.sources, ...manual]) for (const e of ix.threads.get(tid)?.people ?? []) if (isPersonAddress(e, ix.me)) pushContact(e);
  const direct = new Set(seen);
  for (let round = 0; round < MAX_ROUNDS && frontier.length; round++) {
    const next: string[] = [];
    const cur = frontier;
    frontier = next;
    for (const e of cur) {
      for (const tid of ix.byEmail.get(e) ?? []) {
        if (excluded.has(tid)) continue;
        if (!out.has(tid)) {
          if (!brandOk(tid, direct.has(e))) continue;
          if (!add(tid, "contact", e)) continue;
        }
        for (const p of ix.threads.get(tid)?.people ?? []) if (isPersonAddress(p, ix.me)) pushContact(p);
      }
    }
  }

  // Same company domain, same brand.
  const roots = new Set<string>();
  for (const e of seen) { const root = companyRoot(e); if (root) roots.add(root); }
  if (ctx.brand) {
    for (const root of roots) for (const tid of ix.byRoot.get(root) ?? []) {
      const t = ix.threads.get(tid);
      if (!t?.effBrand || out.has(tid) || excluded.has(tid)) continue;
      if (brandEq(t.effBrand, ctx.brand) && brandOk(tid, false)) add(tid, "domain+brand", root);
    }
  }

  // Signing / payment / share notices. Evidence must point at THIS deal's people —
  // a brand name alone is not enough (several agencies can pitch the same brand).
  const fullNames = new Set<string>();
  const firstNames = new Set<string>();
  for (const tid of out.keys()) {
    const t = ix.threads.get(tid);
    if (!t) continue;
    for (const [e, n] of t.names) if (seen.has(e)) {
      const nn = n.toLowerCase().replace(/\(.*?\)|["']/g, "").replace(/\s+/g, " ").trim();
      if (!nn || nn.includes("@")) continue;
      if (nn.split(" ").length >= 2) fullNames.add(nn);
      else if (nn.length >= 4) firstNames.add(nn);
    }
  }
  const companies = new Set<string>();
  for (const root of roots) {
    const label = slug(root.split(".")[0]);
    if (label.length >= 4) companies.add(label);
  }
  const hasWord = (text: string, w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);
  for (const tid of ix.platformThreads) {
    if (out.has(tid) || excluded.has(tid)) continue;
    const t = ix.threads.get(tid)!;
    const text = t.platformText.toLowerCase();
    const flat = slug(t.platformText);
    const brandHit = !!ctx.brand && mentions(t.platformText, ctx.brand);
    let via: string | null = null;
    if ([...t.people].some((p) => seen.has(p))) via = "contact";
    else if ([...fullNames].some((n) => text.includes(n))) via = "contact name";
    else if (brandHit && [...firstNames].some((n) => hasWord(text, n))) via = "contact name + brand";
    else if ([...companies].some((c) => flat.includes(c)) && (brandHit || [...companies].some((c) => ctx.brand && brandEq(c, ctx.brand) && flat.includes(c)))) via = "company + brand";
    if (via && brandOk(tid, true)) add(tid, "platform", via);
  }

  // Persisted auto rows that now fail the brand guard are dropped.
  if (persist) {
    const ts = now();
    const ins = db.prepare(`INSERT OR IGNORE INTO deals_deal_threads (deal_id, thread_id, matched_by, created_at) VALUES (?, ?, ?, ?)`);
    const del = db.prepare(`DELETE FROM deals_deal_threads WHERE deal_id = ? AND thread_id = ? AND matched_by NOT IN ('manual')`);
    db.transaction(() => {
      for (const s of stored) if (s.matched_by !== "manual" && !out.has(s.thread_id)) del.run(dealId, s.thread_id);
      for (const r of out.values()) if (r.matchedBy !== "manual") ins.run(dealId, r.threadId, r.matchedBy, ts);
    })();
  }
  return { threads: [...out.values()], brand: ctx.brand, seen, direct, roots };
}

/**
 * Every thread that belongs to the deal (see the header for the rules).
 * Pure SQL + memory; `persist` writes the automatic matches (INSERT OR IGNORE).
 */
export function relatedThreadsForDeal(dealId: string, opts: { persist?: boolean; sh?: Shared } = {}): RelatedThread[] {
  if (!opts.persist && !opts.sh) {
    const hit = dealMap().deals.get(dealId);
    if (hit) return hit.threads.map((t) => ({ ...t }));
  }
  return resolve(dealId, opts.sh ?? sharedSnapshot(), !!opts.persist)?.threads ?? [];
}

/** = relatedThreadsForDeal (the name the rest of the app uses). */
export function threadsForDeal(dealId: string): RelatedThread[] {
  return relatedThreadsForDeal(dealId);
}

/** Thread ids only, in precedence order. */
export function threadIdsForDeal(dealId: string): string[] {
  return threadsForDeal(dealId).map((t) => t.threadId);
}

/** The deal's contact closure: every address that pulls threads into it (Jake and no-reply boxes excluded). */
export function contactsForDeal(dealId: string): string[] {
  const r = dealMap().deals.get(dealId) ?? resolve(dealId, sharedSnapshot(), false);
  const me = matchIndex().me;
  return r ? [...r.seen].filter((e) => isPersonAddress(e, me)) : [];
}

/** The deal's OWN contacts: client_email + the emails in contact_info (+ those of deals merged into it). */
export function directContactsForDeal(dealId: string): string[] {
  const sh = sharedSnapshot();
  const d = sh.all.find((x) => x.id === dealId);
  return d ? [...dealCtx(d, sh.all, sh.ix, []).contacts] : [];
}

/** The deal's brand (see the header), or null. */
export function brandForDeal(dealId: string): string | null {
  const hit = dealMap().deals.get(dealId);
  if (hit) return hit.brand;
  const sh = sharedSnapshot();
  const d = sh.all.find((x) => x.id === dealId);
  return d ? dealCtx(d, sh.all, sh.ix, []).brand : null;
}

/**
 * The deal's live conversation: the most recently active thread among its
 * source / manual / contact threads (never a signing/payment notice, never
 * spam). Falls back to the source thread. For follow-ups and "last email".
 */
export function latestThreadForDeal(dealId: string): { threadId: string; lastAt: string | null; lastFromMe: boolean | null; subject: string | null } | null {
  const ix = matchIndex();
  let best: { threadId: string; lastAt: string | null; lastFromMe: boolean | null; subject: string | null } | null = null;
  let source: string | null = null;
  for (const r of threadsForDeal(dealId)) {
    if (r.matchedBy === "source" && !source) source = r.threadId;
    if (r.matchedBy === "platform" || r.matchedBy === "domain+brand") continue;
    const t = ix.threads.get(r.threadId);
    if (!t || t.junk || t.platform || !t.lastAt) continue;
    if (!best || (best.lastAt ?? "") < t.lastAt) {
      const last = [...t.msgs].reverse().find((m) => !m.draft && m.date === t.lastAt) ?? null;
      best = { threadId: t.id, lastAt: t.lastAt, lastFromMe: last ? last.isFromMe : null, subject: t.subject || null };
    }
  }
  if (best) return best;
  return source ? { threadId: source, lastAt: null, lastFromMe: null, subject: null } : null;
}

/* ── the reverse map (thread → deals), cached on the data signature ──────── */

export interface ThreadDeal {
  dealId: string;
  matchedBy: MatchedBy;
  via?: string;
  archived: boolean;
  updatedAt: string;
  brand: string | null;
}

interface DealMap {
  sig: string;
  byThread: Map<string, ThreadDeal[]>;
  deals: Map<string, Resolved & { archived: boolean; updatedAt: string }>;
  byContact: Map<string, string[]>;
  byRoot: Map<string, string[]>;
  bySource: Map<string, string[]>;
  names: Map<string, string>;
}
let mapCache: DealMap | null = null;

function mapSignature(ixSig: string): string {
  const d = db.prepare(`SELECT count(*) n, max(updated_at) u, total(length(coalesce(source_thread_id,'')) + length(coalesce(client_email,'')) + length(coalesce(merged_into,''))) s FROM deals_deals`).get() as any;
  const t = db.prepare(`SELECT count(*) n, max(created_at) u FROM deals_deal_threads`).get() as any;
  const x = db.prepare(`SELECT count(*) n, max(created_at) u FROM deals_deal_thread_exclusions`).get() as any;
  return `${ixSig}#${d.n}|${d.u}|${d.s}#${t.n}|${t.u}#${x.n}|${x.u}`;
}

/** Every live (not merged) deal resolved once; rebuilt only when mail, brands, deals or links change. */
function dealMap(): DealMap {
  const ix = matchIndex();
  const sig = signatures().map;
  if (mapCache && mapCache.sig === sig) return mapCache;
  const sh: Shared = { ix, all: loadDeals(), srcBrands: new Map() };
  sh.srcBrands = sourceBrands(sh.all, ix);
  const byThread = new Map<string, ThreadDeal[]>();
  const deals = new Map<string, Resolved & { archived: boolean; updatedAt: string }>();
  const byContact = new Map<string, string[]>();
  const byRoot = new Map<string, string[]>();
  const bySource = new Map<string, string[]>();
  const names = new Map<string, string>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) { if (!l.includes(v)) l.push(v); } else m.set(k, [v]); };
  for (const d of sh.all) {
    if (d.merged_into) continue;
    const r = resolve(d.id, sh, false);
    if (!r) continue;
    const archived = d.archived === 1;
    const updatedAt = d.updated_at ?? "";
    deals.set(d.id, { ...r, archived, updatedAt });
    for (const t of r.threads) push(byThread, t.threadId, { dealId: d.id, matchedBy: t.matchedBy, via: t.via, archived, updatedAt, brand: r.brand });
    for (const e of r.seen) push(byContact, e, d.id);
    for (const root of r.roots) push(byRoot, root, d.id);
    if (d.source_thread_id) push(bySource, d.source_thread_id, d.id);
    names.set(d.id, `${d.project_name ?? ""} ${d.client_name ?? ""}`);
  }
  mapCache = { sig, byThread, deals, byContact, byRoot, bySource, names };
  return mapCache;
}

function rankDeals(list: ThreadDeal[], brand: string | null | undefined, names: Map<string, string>): ThreadDeal[] {
  const agree = (d: ThreadDeal) => (brand && d.brand && brandEq(brand, d.brand) ? 0 : 1);
  // A card whose own name carries its brand beats one re-pointed at another brand's thread.
  const ownName = (d: ThreadDeal) => (d.brand && mentions(names.get(d.dealId) ?? "", d.brand) ? 0 : 1);
  return list.sort((a, b) =>
    Number(a.archived) - Number(b.archived) ||
    agree(a) - agree(b) ||
    ownName(a) - ownName(b) ||
    MATCH_RANK[a.matchedBy] - MATCH_RANK[b.matchedBy] ||
    b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The deal(s) a thread belongs to — threadsForDeal in reverse — best first.
 *
 * A thread in the local tables: exactly the deals whose threadsForDeal holds
 * it (so Files, the Emails page, the agent and the scanner agree). A thread the
 * local tables don't have yet: the same rules applied from `senderEmails` —
 * a sender in a deal's contact closure (brand guard: a known brand must equal
 * the deal's; unknown deal brand → only the deal's direct contacts), or a
 * sender on one of the deal's company domains with the same (known) brand.
 * `brand` (e.g. the agent's triage / the scanner's extraction) is used when the
 * thread's own brand is unknown, and to rank several deals.
 */
export function dealsForThread(threadId: string, opts: { senderEmails?: string[]; brand?: string | null; includeArchived?: boolean } = {}): ThreadDeal[] {
  const m = dealMap();
  const ix = matchIndex();
  const local = ix.threads.get(threadId);
  const known = local?.effBrand ?? ix.brandOf.get(threadId) ?? null;
  const hint = known ?? (opts.brand ? String(opts.brand) : null);
  const out = new Map<string, ThreadDeal>();
  for (const h of m.byThread.get(threadId) ?? []) out.set(h.dealId, { ...h });

  // Not in the local tables yet → apply the rules from the sender side.
  if (!local && !out.size) {
    const brand = hint;
    const senders = [...new Set((opts.senderEmails ?? []).map((e) => String(e ?? "").trim().toLowerCase()).filter((e) => e && !ix.me.has(e)))];
    for (const e of senders) {
      for (const id of m.byContact.get(e) ?? []) {
        const r = m.deals.get(id)!;
        if (brand && r.brand && !brandEq(brand, r.brand)) continue;
        if (brand && !r.brand && !r.direct.has(e)) continue;
        if (!out.has(id)) out.set(id, { dealId: id, matchedBy: "contact", via: e, archived: r.archived, updatedAt: r.updatedAt, brand: r.brand });
      }
      const root = companyRoot(e);
      if (!root || !brand) continue;
      for (const id of m.byRoot.get(root) ?? []) {
        const r = m.deals.get(id)!;
        if (out.has(id) || !r.brand || !brandEq(brand, r.brand)) continue;
        out.set(id, { dealId: id, matchedBy: "domain+brand", via: root, archived: r.archived, updatedAt: r.updatedAt, brand: r.brand });
      }
    }
  } else if (local && !out.size && !known && opts.brand && !local.junk) {
    // A local thread whose brand isn't extracted yet: the caller's brand may complete domain+brand.
    for (const e of local.people) {
      const root = companyRoot(e);
      if (!root) continue;
      for (const id of m.byRoot.get(root) ?? []) {
        const r = m.deals.get(id)!;
        if (out.has(id) || !r.brand || !brandEq(opts.brand, r.brand)) continue;
        out.set(id, { dealId: id, matchedBy: "domain+brand", via: root, archived: r.archived, updatedAt: r.updatedAt, brand: r.brand });
      }
    }
  }
  let list = [...out.values()];
  if (opts.includeArchived === false) list = list.filter((d) => !d.archived);
  return rankDeals(list, opts.brand ?? known, m.names);
}

/** The best deal for a thread (see dealsForThread), or null. */
export function dealForThread(threadId: string, opts: { senderEmails?: string[]; brand?: string | null; includeArchived?: boolean } = {}): ThreadDeal | null {
  return dealsForThread(threadId, opts)[0] ?? null;
}
