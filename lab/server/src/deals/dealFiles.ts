/**
 * Deal Organizer — a deal's files, document links and related threads.
 *
 * A deal is rarely ONE thread: an agency writes from several people, a brand
 * CCs a colleague who starts a new thread, the contract comes back from
 * DocuSign. This module finds every thread that belongs to a deal and indexes
 * the documents in them. Reads are SQL over deals_emails / deals_thread_brands
 * / deals_deals — ZERO Gmail and ZERO AI calls. Only `refreshDealFiles`
 * (an explicit button) reads Gmail, and only with read calls.
 *
 * Deal ↔ thread resolver (`relatedThreadsForDeal` — implemented ONCE in
 * matching.ts and re-exported here), in order of precedence:
 *   source        the deal's source_thread_id (+ those of deals merged into it)
 *   manual        linked by Jake (deals_deal_threads, matched_by='manual';
 *                 the Emails page's linkThreadToDeal writes here too)
 *   contact       any message from/to ANY of the deal's contacts: client_email,
 *                 emails in contact_info, and every non-Jake participant already
 *                 seen on the deal's threads — iterated to closure (capped)
 *   domain+brand  same company domain (never free-mail) AND the thread's brand
 *                 (deals_thread_brands) equals the deal's brand — agencies pitch
 *                 many brands, so a different brand is never pulled in
 *   platform      a signing / payment / doc-share notice (DocuSign, PandaDoc,
 *                 Juro, Sign.com, Stripe receipt, Google Docs share …) that names
 *                 a deal contact or the deal's brand
 * minus manual exclusions (deals_deal_thread_exclusions). Brand guard on every
 * automatic match: a thread whose brand is known and differs from the deal's,
 * or that is the source thread of a DIFFERENT deal with a different brand, is
 * never attached. Auto matches are persisted (INSERT OR IGNORE) so they stay
 * stable; a persisted one that later fails the brand guard is dropped.
 *
 * Own tables (additive):
 *   deals_deal_threads            (deal_id, thread_id) → matched_by, created_at
 *   deals_deal_thread_exclusions  (deal_id, thread_id) → created_at
 */
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { FALLBACK_MY_EMAIL, connectedAccount, safeJson, parseMessage } from "./common.js";
import { upsertEmails, rebuildThreadIndexRow } from "./gmailSync.js";
import * as gmail from "./integrations/gmail.js";
import type { EmailRecord } from "./db.js";
import {
  MATCH_RANK as RANK, sharedSnapshot as shared, relatedThreadsForDeal, brandForDeal, directContactsForDeal,
  isPersonAddress as isPerson, invalidateMatching, type Index, type MatchedBy, type DealRow,
} from "./matching.js";

const now = () => new Date().toISOString();

// The resolver lives in matching.ts (ONE implementation for Files, the scanner,
// the agent, the Emails page …); re-exported here so existing imports keep working.
export { relatedThreadsForDeal, brandEq } from "./matching.js";
export type { MatchedBy, RelatedThread } from "./matching.js";

/* ── files ───────────────────────────────────────────────────────────────── */

export type FileKind = "contract" | "brief" | "invoice" | "deck" | "script" | "other";
export const KIND_ORDER: FileKind[] = ["contract", "brief", "invoice", "deck", "script", "other"];

interface RawFile {
  name: string; mimeType: string; size: number; attachmentId: string; messageId: string; threadId: string;
  from: string; fromName: string; isFromMe: boolean; date: string | null; subject: string;
}
interface RawLink { url: string; key: string; host: string; kind: string; from: string; fromName: string; isFromMe: boolean; date: string | null; threadId: string; messageId: string; subject: string }

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg|tiff?)$/i;
const SIG_NAME = /^(image\d{2,4}|outlook-|att\d+|inline|insertpic|~wrd)|logo|signature|sig[_-]|spacer|banner|icon|facebook|linkedin|twitter|instagram|youtube|tiktok|^temp\w*\.png$|^\d{1,2}\.(png|jpe?g)$|^\d{10,}_\d+\.(png|jpe?g)$/i;
const DELIVERABLE_IMG = /screen ?shot|screenshot|屏幕截图|capture|thumbnail|mock-?up|draft|storyboard|deliverable|frame/i;

/** Real documents only: no inline logos / signature images / calendar invites. */
export function isDocumentAttachment(name: string, mimeType: string, size: number): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  const mt = (mimeType ?? "").toLowerCase();
  if (/\.ics$/i.test(n) || mt.includes("calendar") || mt === "application/ics") return false;
  if (/\.(p7s|asc|sig|vcf)$/i.test(n)) return false;
  const isImg = mt.startsWith("image/") || IMG_EXT.test(n);
  if (!isImg) return true;
  if (/\.svg$/i.test(n) || mt === "image/svg+xml") return false;
  if (size < 40_000) return false;
  if (SIG_NAME.test(n)) return size >= 400_000;
  if (size >= 200_000) return true;
  return DELIVERABLE_IMG.test(n);
}

const normName = (name: string) => name
  .replace(/\.[a-z0-9]{1,5}$/i, "")
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/[_\-.–—+&<>|,]+/g, " ")
  .toLowerCase();

const NAME_RULES: Array<[FileKind, RegExp]> = [
  ["invoice", /\b(invoice|inv ?\d+|receipt|vendor ?form|vendor|w ?8( ?ben( ?e)?)?|w ?9|tax ?form|remittance|transfer ?notice|purchase ?order|po ?\d{3,}|pur ?\d+|billing|bank ?details|payment ?(details|form|info))\b/],
  ["contract", /\b(contract|contracting|agreement|insertion ?order|sow|statement ?of ?work|msa|amendment|addendum|nda|redline|terms ?(and|&)? ?conditions|cooperation|countersigned|signed|for ?signature|certificate)\b/],
  ["brief", /\b(brief|briefing|guidelines?|requirements|talking ?points|onboarding|campaign|creative ?direction|key ?messages?)\b/],
  ["deck", /\b(deck|media ?kit|case ?stud(y|ies)|brochure|booklet|one ?pager|presentation|rate ?card|proposal|offer|portfolio|strategy ?preview|pitch|overview)\b/],
  ["script", /\b(script|draft|outline|storyboard|voice ?over|revised ?(v ?)?\d+|revised ?v\d|\d{2,4} ?\d ?(ways|jobs|tools))\b/],
];

function kindFromName(name: string): FileKind | null {
  const n = normName(name);
  if (/\bIO\b/.test(name)) return "contract";
  for (const [k, re] of NAME_RULES) if (re.test(n)) return k;
  return null;
}

const CONTEXT_RULES: Array<[FileKind, RegExp]> = [
  ["contract", /\b(contracts?|agreements?|sign(ed|ing|ature)?|docusign|redline|countersign\w*|insertion order|sow)\b/gi],
  ["invoice", /\b(invoices?|receipts?|vendor form|w-?8|w-?9|remittance)\b/gi],
  ["brief", /\b(brief|guidelines)\b/gi],
  ["deck", /\b(media kit|deck|case stud(y|ies)|brochure)\b/gi],
  ["script", /\b(script|draft|outline)\b/gi],
];

/** The message's own words (quoted history cut) decide when the filename says nothing. */
function kindFromContext(subject: string, body: string): FileKind | null {
  const own = String(body ?? "").split(/\n\s*On .{5,200}wrote:|\n-{2,} ?(Original|Forwarded) Message|\n>|\nFrom: .+\nSent: /i)[0].slice(0, 2500);
  const text = `${subject}\n${own}`;
  let best: FileKind | null = null, bestN = 0;
  for (const [k, re] of CONTEXT_RULES) {
    const n = (text.match(re) ?? []).length;
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

/** "TopView Contract V2 Revised (1).pdf" and "TopView Contract V2.pdf" share one key. */
export function versionKey(name: string): string {
  return normName(name)
    .replace(/\(\d+\)/g, " ")
    .replace(/\b(19|20)\d{6}\b/g, " ")
    .replace(/\b(final|revised|revision|redline|clean|signed|fully|countersigned|copy|updated|update|new|latest|for signature|v ?\d+|version ?\d+|rev ?\d+|draft ?\d*)\b/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || normName(name);
}

function threadFiles(ix: Index, tid: string): { files: RawFile[]; links: RawLink[] } {
  const hit = ix.memo.get(tid);
  if (hit) return hit;
  const t = ix.threads.get(tid);
  const files: RawFile[] = [];
  const links: RawLink[] = [];
  for (const m of t?.msgs ?? []) {
    if (m.draft || m.junk) continue;
    for (const a of safeJson(m.attachments ?? "[]") as any[]) {
      if (!a?.attachmentId || !isDocumentAttachment(a.name, a.mimeType, Number(a.size ?? 0))) continue;
      files.push({ name: a.name, mimeType: a.mimeType ?? "", size: Number(a.size ?? 0), attachmentId: a.attachmentId, messageId: m.messageId, threadId: tid,
        from: m.fromEmail, fromName: m.fromName, isFromMe: m.isFromMe, date: m.date, subject: m.subject });
    }
    for (const u of safeJson(m.urls ?? "[]") as any[]) {
      const l = docLink(String(u ?? ""));
      if (l) links.push({ ...l, from: m.fromEmail, fromName: m.fromName, isFromMe: m.isFromMe, date: m.date, threadId: tid, messageId: m.messageId, subject: m.subject });
    }
  }
  const r = { files, links };
  ix.memo.set(tid, r);
  return r;
}

/* ── document links ──────────────────────────────────────────────────────── */

const LINK_NOISE = /unsubscribe|calendly\.com|mail\.google\.com|accounts\.google\.com|support\.google\.com|\/mail-sig\/|googleusercontent\.com|list-manage|mailchi\.mp|click\.|tracking\.|\/track\/|utm_medium=email|\/o\/[A-Za-z0-9]+\/open|pixel/i;

function unwrap(url: string): string {
  let u = url.replace(/&amp;/g, "&").trim();
  try {
    const p = new URL(u);
    if (/(^|\.)google\.[a-z.]+$/.test(p.hostname) && p.pathname === "/url") u = p.searchParams.get("q") || p.searchParams.get("url") || u;
    if (/safelinks\.protection\.outlook\.com$/.test(p.hostname)) u = p.searchParams.get("url") || u;
  } catch { /* keep */ }
  return u;
}

/** A document link (Docs/Drive/Notion/Dropbox/DocSend/Canva/Figma/Frame.io/Loom/*.pdf …) or null. */
export function docLink(raw: string): { url: string; key: string; host: string; kind: string } | null {
  if (!/^https?:\/\//i.test(raw)) return null;
  const url = unwrap(raw).replace(/[)>\],.;:'"]+$/, "");
  if (LINK_NOISE.test(url)) return null;
  let p: URL;
  try { p = new URL(url); } catch { return null; }
  const host = p.hostname.replace(/^www\./, "").toLowerCase();
  const path = p.pathname;
  let kind: string | null = null;
  let key = `${host}${path.replace(/\/+$/, "")}`.toLowerCase();
  const gid = path.match(/\/d\/(?:e\/)?([A-Za-z0-9_-]{15,})/)?.[1] ?? p.searchParams.get("id") ?? null;
  if (host === "docs.google.com") {
    kind = path.startsWith("/document") ? "google-doc" : path.startsWith("/spreadsheets") ? "google-sheet"
      : path.startsWith("/presentation") ? "google-slides" : path.startsWith("/forms") ? "google-form" : "google-doc";
    if (gid) key = `g:${gid}`;
  } else if (host === "drive.google.com") {
    if (!/\/(file|folders|drive|open|uc)\b/.test(path) && !gid) return null;
    kind = "google-drive";
    const fid = path.match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1] ?? gid;
    if (fid) key = `g:${fid}`;
  } else if (host === "notion.so" || host.endsWith(".notion.so") || host.endsWith(".notion.site") || host === "notion.com" || host.endsWith(".notion.com")) {
    // notion.com: Notion's newer domain (app.notion.com/p/…) — Linearity's brief lived there and was missed.
    if (path.length < 2) return null;
    kind = "notion";
    const nid = path.match(/([0-9a-f]{32})(?:$|[/?#])/i)?.[1];
    if (nid) key = `n:${nid.toLowerCase()}`;
  } else if (host.endsWith("dropbox.com") || host.endsWith("dropboxusercontent.com")) {
    if (!/\/(s|scl|sh|l)\//.test(path) && !/\.[a-z0-9]{2,4}$/i.test(path)) return null;
    kind = "dropbox";
  } else if (host.endsWith("docsend.com")) {
    if (!/\/view\//.test(path)) return null;
    kind = "docsend";
  } else if (host.endsWith("canva.com")) {
    if (!/\/design\//.test(path)) return null;
    kind = "canva";
  } else if (host.endsWith("figma.com")) {
    if (!/\/(file|design|proto|board|deck)\//.test(path)) return null;
    kind = "figma";
  } else if (host === "frame.io" || host.endsWith(".frame.io") || host === "f.io") {
    if (path.length < 3) return null;
    kind = "frameio";
  } else if (host.endsWith("loom.com")) {
    if (!/\/(share|embed)\//.test(path)) return null;
    kind = "loom";
  } else if (host === "wetransfer.com" || host === "we.tl") {
    if (path.length < 3) return null;
    kind = "wetransfer";
  } else if (host.endsWith("box.com") && /\/s\//.test(path)) {
    kind = "box";
  } else if (host === "1drv.ms" || host.endsWith("sharepoint.com") || host === "onedrive.live.com") {
    kind = "onedrive";
  } else if (host === "pitch.com" || host === "gamma.app" || host.endsWith(".gamma.site")) {
    if (path.length < 3) return null;
    kind = "deck";
  } else if (host === "airtable.com" && /\/shr/.test(path)) {
    kind = "airtable";
  } else if (host === "invoice.stripe.com" || host === "pay.stripe.com") {
    kind = "invoice";
  } else if (/\.(pdf|docx?|pptx?|xlsx?|key|pages|zip)$/i.test(path)) {
    kind = "file";
  }
  if (!kind) return null;
  return { url, key, host, kind };
}

/** Anchor text of links in the message HTML ("Campaign Brief" for a bare Docs URL). */
function anchorTitles(messageIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!messageIds.length) return out;
  const ph = messageIds.map(() => "?").join(",");
  for (const r of db.prepare(`SELECT subject, body_html FROM deals_emails WHERE message_id IN (${ph})`).all(...messageIds) as any[]) {
    const html = String(r.body_html ?? "");
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{1,400}?)<\/a>/gi)) {
      const l = docLink(m[1]);
      if (!l || out.has(l.key)) continue;
      const text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
      if (text.length >= 4 && text.length <= 140 && !/^https?:|^www\.|^(here|link|this|click here|manage sharing|share|download|reply|edit|view( (it|document|file|doc|brief))?|open( (it|document|file|doc|in \w+))?)$/i.test(text)) out.set(l.key, text);
    }
    const shared = String(r.subject ?? "").match(/shared with you: ["“](.+?)["”]/i)?.[1];
    if (shared) out.set(`subject:${r.subject}`, shared);
  }
  return out;
}

function linkTitle(l: RawLink, anchors: Map<string, string>): string | null {
  const a = anchors.get(l.key);
  if (a) return a;
  const shared = anchors.get(`subject:${l.subject}`);
  if (shared && l.kind.startsWith("google")) return shared;
  try {
    const p = new URL(l.url);
    if (l.kind === "notion") {
      const seg = decodeURIComponent(p.pathname.split("/").filter(Boolean).pop() ?? "").replace(/-?[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim();
      return seg || null;
    }
    if (l.kind === "file" || l.kind === "dropbox") {
      const seg = decodeURIComponent(p.pathname.split("/").filter(Boolean).pop() ?? "");
      return seg || null;
    }
  } catch { /* none */ }
  return null;
}

/* ── the deal's files index ──────────────────────────────────────────────── */

export interface DealFile {
  key: string; name: string; mimeType: string; size: number; kind: FileKind;
  threadId: string; messageId: string; attachmentId: string;
  from: string; fromName: string; isFromMe: boolean; date: string | null; subject: string;
  versions: number;
  /** Older versions of the same document, newest first. */
  older: Omit<DealFile, "older" | "versions">[];
}
export interface DealLink { url: string; host: string; kind: string; title: string | null; from: string; fromName: string; isFromMe: boolean; date: string | null; threadId: string; subject: string; mentions: number }
export interface DealThread {
  threadId: string; subject: string; participants: Array<{ email: string; name: string }>; matchedBy: MatchedBy; via: string | null;
  brand: string | null; lastAt: string | null; messageCount: number; gmailCount: number; synced: boolean; fileCount: number; gmailUrl: string;
}
export interface DealFilesResult {
  dealId: string; brand: string | null; accountEmail: string;
  threads: DealThread[]; files: DealFile[]; links: DealLink[];
  counts: { threads: number; files: number; links: number; byKind: Record<FileKind, number> };
}

const fileKey = (f: RawFile) => createHash("sha1").update(`${f.messageId}|${f.name}|${f.size}`).digest("hex").slice(0, 16);

/** Dedupe (same name + size → newest), then group versions by name key, newest first. */
function groupFiles(raw: RawFile[]): RawFile[][] {
  const byIdentity = new Map<string, RawFile>();
  for (const f of raw) {
    const id = `${f.name.toLowerCase()}|${f.size}`;
    const cur = byIdentity.get(id);
    if (!cur || (f.date ?? "") > (cur.date ?? "")) byIdentity.set(id, f);
  }
  const uniq = [...byIdentity.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const groups: Array<{ key: string; files: RawFile[] }> = [];
  for (const f of uniq) {
    const k = versionKey(f.name);
    // Same key, or one key a word-prefix of the other ("… agreement jake dawson" / "… agreement jake dawson agency").
    const g = groups.find((x) => x.key === k || (Math.min(x.key.length, k.length) >= 12 && (x.key.startsWith(k + " ") || k.startsWith(x.key + " "))));
    if (g) g.files.push(f);
    else groups.push({ key: k, files: [f] });
  }
  return groups.map((g) => g.files);
}

function dealRowOrThrow(dealId: string): DealRow {
  const d = db.prepare(`SELECT id, client_name, project_name, client_email, contact_info, source_thread_id, archived, merged_into FROM deals_deals WHERE id = ?`).get(dealId) as DealRow | undefined;
  if (!d) throw Object.assign(new Error("Deal not found"), { status: 404 });
  return d;
}

export function getDealFilesData(dealId: string): DealFilesResult {
  dealRowOrThrow(dealId);
  const sh = shared();
  const { ix } = sh;
  const related = relatedThreadsForDeal(dealId, { persist: true, sh });
  const ctx = { brand: brandForDeal(dealId) };

  const rawFiles: RawFile[] = [];
  const rawLinks: RawLink[] = [];
  const threads: DealThread[] = [];
  for (const r of related) {
    const t = ix.threads.get(r.threadId);
    const tf = threadFiles(ix, r.threadId);
    rawFiles.push(...tf.files);
    rawLinks.push(...tf.links);
    const people = [...(t?.people ?? [])].filter((e) => isPerson(e, ix.me) || e === (t?.msgs[0]?.fromEmail ?? ""));
    const local = t?.msgs.filter((m) => !m.draft).length ?? 0;
    const hasFirst = !!t?.msgs.some((m) => m.messageId === r.threadId);
    threads.push({
      threadId: r.threadId,
      subject: t?.subject || (db.prepare(`SELECT subject FROM deals_thread_index WHERE thread_id = ?`).get(r.threadId) as any)?.subject || "(not synced yet)",
      participants: people.slice(0, 8).map((e) => ({ email: e, name: t?.names.get(e) ?? e })),
      matchedBy: r.matchedBy, via: r.via ?? null,
      brand: t?.brand ?? null,
      lastAt: t?.lastAt ?? null,
      messageCount: local,
      gmailCount: t?.indexCount ?? 0,
      synced: local > 0 && hasFirst && local >= (t?.indexCount ?? 0),
      fileCount: groupFiles(tf.files).length,
      gmailUrl: gmail.gmailThreadUrl(r.threadId),
    });
  }
  threads.sort((a, b) => RANK[a.matchedBy] - RANK[b.matchedBy] || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

  // Kind: filename first; else the words of the message the file came with.
  const needBody = rawFiles.filter((f) => !kindFromName(f.name)).map((f) => f.messageId);
  const bodies = new Map<string, string>();
  if (needBody.length) {
    const ids = [...new Set(needBody)];
    const ph = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT message_id, body_text FROM deals_emails WHERE message_id IN (${ph})`).all(...ids) as any[]) bodies.set(r.message_id, r.body_text ?? "");
  }
  // Every copy of a file votes (the same PDF often arrives twice: from the person and from the signing tool).
  const copies = new Map<string, RawFile[]>();
  for (const f of rawFiles) {
    const id = `${f.name.toLowerCase()}|${f.size}`;
    if (!copies.has(id)) copies.set(id, []);
    copies.get(id)!.push(f);
  }
  const kindOf = (f: RawFile): FileKind => {
    const byName = kindFromName(f.name);
    if (byName) return byName;
    if (IMG_EXT.test(f.name) || f.mimeType.startsWith("image/") || f.mimeType.startsWith("video/")) return "other";
    const all = copies.get(`${f.name.toLowerCase()}|${f.size}`) ?? [f];
    if (all.some((c) => ix.threads.get(c.threadId)?.platform && /sign|docusign|pandadoc|juro|documenso/i.test(`${c.from} ${c.subject}`))) return "contract";
    const votes = new Map<FileKind, number>();
    for (const c of all) {
      const k = kindFromContext(c.subject, bodies.get(c.messageId) ?? "");
      if (k) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    let best: FileKind = "other", n = 0;
    for (const k of KIND_ORDER) if ((votes.get(k) ?? 0) > n) { best = k; n = votes.get(k)!; }
    return best;
  };

  const toFile = (f: RawFile, kind: FileKind) => ({
    key: fileKey(f), name: f.name, mimeType: f.mimeType, size: f.size, kind, threadId: f.threadId, messageId: f.messageId,
    attachmentId: f.attachmentId, from: f.from, fromName: f.fromName, isFromMe: f.isFromMe, date: f.date, subject: f.subject,
  });
  const files: DealFile[] = groupFiles(rawFiles).map((g) => {
    const kinds = g.map(kindOf);
    const kind = kinds.find((k) => k !== "other") ?? "other";
    return { ...toFile(g[0], kind), versions: g.length, older: g.slice(1).map((f) => toFile(f, kind)) };
  });
  files.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.date ?? "").localeCompare(a.date ?? ""));

  // Links: first share wins (who sent it, when); mentions = how often it came up.
  const anchors = anchorTitles([...new Set(rawLinks.map((l) => l.messageId))]);
  const byKey = new Map<string, { l: RawLink; n: number }>();
  for (const l of [...rawLinks].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))) {
    const cur = byKey.get(l.key);
    if (cur) cur.n++;
    else byKey.set(l.key, { l, n: 1 });
  }
  const links: DealLink[] = [...byKey.values()].map(({ l, n }) => ({
    url: l.url, host: l.host, kind: l.kind, title: linkTitle(l, anchors), from: l.from, fromName: l.fromName, isFromMe: l.isFromMe,
    date: l.date, threadId: l.threadId, subject: l.subject, mentions: n,
  })).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, files.filter((f) => f.kind === k).length])) as Record<FileKind, number>;
  return {
    dealId, brand: ctx.brand, accountEmail: connectedAccount()?.email ?? [...ix.me][0] ?? FALLBACK_MY_EMAIL,
    threads, files, links, counts: { threads: threads.length, files: files.length, links: links.length, byKind },
  };
}

/** { dealId: files + document links } for every live deal — one call per board load. No writes. */
export function dealFileCounts(): Record<string, number> {
  const sh = shared();
  const out: Record<string, number> = {};
  for (const d of sh.all) {
    if (d.merged_into || d.archived === 1) continue;
    const related = relatedThreadsForDeal(d.id); // the cached reverse map — no per-deal re-resolve
    const raw: RawFile[] = [];
    const keys = new Set<string>();
    for (const r of related) {
      const tf = threadFiles(sh.ix, r.threadId);
      raw.push(...tf.files);
      for (const l of tf.links) keys.add(l.key);
    }
    const n = groupFiles(raw).length + keys.size;
    if (n) out[d.id] = n;
  }
  return out;
}

/* ── manual link / unlink ────────────────────────────────────────────────── */

export function linkDealThread(dealId: string, threadId: string): void {
  dealRowOrThrow(dealId);
  db.transaction(() => {
    db.prepare(`DELETE FROM deals_deal_thread_exclusions WHERE deal_id = ? AND thread_id = ?`).run(dealId, threadId);
    db.prepare(`INSERT INTO deals_deal_threads (deal_id, thread_id, matched_by, created_at) VALUES (?, ?, 'manual', ?)
      ON CONFLICT(deal_id, thread_id) DO UPDATE SET matched_by = 'manual'`).run(dealId, threadId, now());
  })();
  invalidateMatching(); // every page / the agent sees the link at once
}

/** Unlink = an exclusion, so automatic matching never re-adds it. */
export function unlinkDealThread(dealId: string, threadId: string): void {
  dealRowOrThrow(dealId);
  db.transaction(() => {
    db.prepare(`DELETE FROM deals_deal_threads WHERE deal_id = ? AND thread_id = ?`).run(dealId, threadId);
    db.prepare(`INSERT OR IGNORE INTO deals_deal_thread_exclusions (deal_id, thread_id, created_at) VALUES (?, ?, ?)`).run(dealId, threadId, now());
  })();
  invalidateMatching();
}

/** Threads manually linked to a deal (for the Emails page's deal badge). */
export function manualDealLinks(): Array<{ dealId: string; threadId: string }> {
  return (db.prepare(`SELECT deal_id, thread_id FROM deals_deal_threads WHERE matched_by = 'manual'`).all() as any[])
    .map((r) => ({ dealId: r.deal_id, threadId: r.thread_id }));
}

/* ── refresh (explicit button; Gmail READ calls only) ────────────────────── */

export const REFRESH_THREAD_CAP = 10;

/**
 * Fill related threads that aren't fully synced locally (one threads.get each),
 * plus ONE threads.list for the deal's direct contacts to find threads the sync
 * never pulled. At most REFRESH_THREAD_CAP threads.get calls. Nothing is sent,
 * labelled or modified in Gmail.
 */
export async function refreshDealFilesData(dealId: string): Promise<DealFilesResult & { refresh: { fetched: number; discovered: number; gmailCalls: number; errors: string[] } }> {
  const d = dealRowOrThrow(dealId);
  const acct = connectedAccount();
  if (!acct?.email) throw Object.assign(new Error("Gmail is not connected."), { status: 400 });
  const accountEmail = acct.email.toLowerCase();
  const sh = shared();
  const related = relatedThreadsForDeal(dealId, { sh });
  const errors: string[] = [];
  let gmailCalls = 0;

  const want: string[] = [];
  for (const r of related) {
    const t = sh.ix.threads.get(r.threadId);
    const local = t?.msgs.length ?? 0;
    const hasFirst = !!t?.msgs.some((m) => m.messageId === r.threadId);
    if (!local || !hasFirst || (t?.indexCount ?? 0) > local) want.push(r.threadId);
  }

  // Discovery: threads with the deal's direct contacts that aren't local at all.
  let discovered = 0;
  const direct = directContactsForDeal(dealId).filter((e) => isPerson(e, sh.ix.me) || e === (d.client_email ?? "").toLowerCase()).slice(0, 8);
  if (direct.length && want.length < REFRESH_THREAD_CAP) {
    const q = `{${direct.map((e) => `from:${e} to:${e}`).join(" ")}} -in:spam -in:trash`;
    try {
      gmailCalls++;
      const res: any = await gmail.listThreads(q, 25);
      const excluded = new Set((db.prepare(`SELECT thread_id FROM deals_deal_thread_exclusions WHERE deal_id = ?`).all(dealId) as any[]).map((r) => r.thread_id));
      for (const t of res?.threads ?? []) {
        if (!t?.id || sh.ix.threads.has(t.id) || excluded.has(t.id) || want.includes(t.id)) continue;
        want.push(t.id);
        discovered++;
      }
    } catch (e: any) { errors.push(`search: ${e?.message ?? e}`); }
  }

  let fetched = 0;
  for (const tid of want.slice(0, REFRESH_THREAD_CAP)) {
    try {
      gmailCalls++;
      const thread: any = await gmail.getThread(tid);
      const parsed = (thread?.messages ?? []).map((m: any) => parseMessage(m, accountEmail, accountEmail)).filter(Boolean) as Partial<EmailRecord>[];
      if (parsed.length) {
        upsertEmails(parsed);
        try { rebuildThreadIndexRow(tid, accountEmail); } catch { /* best effort */ }
        fetched++;
      }
    } catch (e: any) { errors.push(`${tid}: ${e?.message ?? e}`); }
  }
  invalidateMatching(); // new rows → rebuild the index
  return { ...getDealFilesData(dealId), refresh: { fetched, discovered: Math.min(discovered, REFRESH_THREAD_CAP), gmailCalls, errors } };
}
