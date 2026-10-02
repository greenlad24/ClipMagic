/**
 * Sponsored scripts from a Deal Organizer deal (Jake 2026-10-02: "connect a
 * deal to a script … it pulls out all of the information — summarises it from
 * the agent's knowledge and the thread and also scrapes the text from a brief
 * they've added or from a contract — it scans everything. Then it suggests the
 * best angles based on all of the knowledge — at least 5 angles").
 *
 *   searchSponsorDeals(q)   the deal picker — ONLY deals in production (the
 *                           Deadlines page's rule: in_production = 1, not
 *                           archived; Jake 2026-10-02)
 *   startDealBrief(dealId)  a background job: gather everything about the deal,
 *                           read it with Opus 5.5 (PDF contracts and briefs as
 *                           documents), return the sponsor brief + ≥5 angles
 *   getDealBrief(id)        poll it
 *   dealBriefBlock(...)     what every script stage reads once a deal + angle
 *                           are attached to a run (input.sponsorDeal)
 *
 * What "everything" is: the deal card (fields the Deal Organizer filled from
 * the threads), EVERY email in EVERY thread matched to the deal (matching.ts —
 * the same deal↔thread logic as the Files tab), the email agent's knowledge
 * (its per-email decisions and reasons, the fit check, the focus score, its
 * lessons and Jake's own rules for this brand), the attachments (contracts,
 * briefs, decks, scripts — newest version each, read from Gmail READ-ONLY),
 * and the document links in the emails (Google Docs / Slides / Sheets exports
 * and other pages, when they are public). VIDEOS are moved into text too (Jake
 * 2026-10-02): attached video/audio files are transcribed (ffmpeg → Groq
 * Whisper), YouTube links via the generator's transcript fetcher, public
 * Google Drive videos downloaded and transcribed. Nothing is written anywhere
 * but this module's own table.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { opusScriptChat, extractJson } from "../ai/claude.js";
import { deals, emails } from "../deals/db.js";
import { threadsForDeal, brandForDeal } from "../deals/matching.js";
import { getDealFilesData } from "../deals/dealFiles.js";
import * as gmail from "../deals/integrations/gmail.js";
import { stripQuoted } from "../deals/agent/util.js";
import { getFitCache, relevantLessons } from "../deals/agent/store.js";
import { listRules } from "../deals/agent/houseRules.js";
import { emptyParts, mergeParts, fileToParts, linkToParts, isMedia, downloadAttachment, redactPersonal, redactDeep, SENSITIVE_DOC } from "./dealDocs.js";

db.exec(`
CREATE TABLE IF NOT EXISTS scriptgen_deal_briefs (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- running | done | failed
  progress TEXT,
  result_json TEXT,
  sources_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS scriptgen_deal_briefs_deal ON scriptgen_deal_briefs (deal_id, created_at);
`);

/* ── types ───────────────────────────────────────────────────────────────── */

export interface DealAngle {
  title: string;
  /** The video in one or two sentences — what the viewer gets. */
  premise: string;
  /** How the opening would grab an everyday viewer. */
  hook: string;
  /** Where and how the product shows up working in the video. */
  productMoment: string;
  /** Why this fits Jake's audience AND the sponsor's brief. */
  why: string;
  /** What could go wrong / what the brand might push back on. */
  risk: string;
  /** whole-video | mid-roll — which format it suits best. */
  bestFor: string;
}

export interface DealBrief {
  /**
   * The brand's OWN brief, as they sent it (Notion page, PDF, Doc or the email it
   * was written in) — the latest version, reproduced, personal/payment data left
   * out. This is what Jake used to paste into the Brief box, and the generator
   * balances it against his own channel (Jake 2026-10-02: "I want to retain that").
   */
  brandBrief: string | null;
  sponsor: { brand: string; product: string; website: string | null; whatItDoes: string; offer: string | null; links: string[]; codes: string[] };
  deal: { type: string; price: string | null; deliverables: string[]; deadlines: string[]; approvals: string | null; usageRights: string | null; status: string };
  brief: { keyMessages: string[]; mustSay: string[]; mustShow: string[]; mustNotSay: string[]; cta: string | null; disclosure: string | null; targetAudience: string | null; tone: string | null };
  contractTerms: string[];
  /** Only the contract/brief rules that affect what the VIDEO may say or show (no money, no people). */
  contentRules: string[];
  relationship: string[];
  gaps: string[];
  summary: string;
  angles: DealAngle[];
}

export interface DealBriefSource { kind: "card" | "email" | "agent" | "file" | "link"; label: string; read: boolean; note?: string }

export interface DealBriefJob {
  id: string; dealId: string; status: "running" | "done" | "failed"; progress: string | null;
  result: DealBrief | null; sources: DealBriefSource[]; error: string | null; createdAt: string; finishedAt: string | null;
}

/* ── search ──────────────────────────────────────────────────────────────── */

export function searchSponsorDeals(q: string, limit = 20): Array<{ id: string; name: string; client: string; brand: string | null; stage: string; updatedAt: string | null }> {
  const term = String(q ?? "").trim().toLowerCase();
  const rows = db.prepare(
    `SELECT id, project_name, client_name, client_email, stage, updated_at FROM deals_deals
     WHERE in_production = 1 AND (archived IS NULL OR archived = 0) AND (merged_into IS NULL OR merged_into = '')
       AND (? = '' OR lower(coalesce(project_name,'')) LIKE ? OR lower(coalesce(client_name,'')) LIKE ? OR lower(coalesce(client_email,'')) LIKE ?)
     ORDER BY updated_at DESC LIMIT ?`,
  ).all(term, `%${term}%`, `%${term}%`, `%${term}%`, limit) as any[];
  return rows.map((r) => {
    let brand: string | null = null;
    try { brand = brandForDeal(r.id); } catch { /* best effort */ }
    return { id: r.id, name: r.project_name || r.client_name || "(unnamed deal)", client: r.client_name || r.client_email || "", brand, stage: r.stage || "", updatedAt: r.updated_at ?? null };
  });
}

/* ── jobs ────────────────────────────────────────────────────────────────── */

const now = () => new Date().toISOString();

function toJob(r: any): DealBriefJob {
  const parse = <T>(s: string | null, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  return { id: r.id, dealId: r.deal_id, status: r.status, progress: r.progress ?? null, result: parse(r.result_json, null), sources: parse(r.sources_json, []), error: r.error ?? null, createdAt: r.created_at, finishedAt: r.finished_at ?? null };
}

export function getDealBrief(id: string): DealBriefJob | null {
  const r = db.prepare(`SELECT * FROM scriptgen_deal_briefs WHERE id = ?`).get(id);
  return r ? toJob(r) : null;
}

/** What the UI gets: the read, minus everything that is not about the video. */
export function getDealBriefForUi(id: string): (Omit<DealBriefJob, "result"> & { result: (Omit<DealBrief, "deal" | "relationship" | "contractTerms"> & { videoBriefs: string[] }) | null }) | null {
  const j = getDealBrief(id);
  if (!j) return null;
  if (!j.result) return { ...j, result: null };
  const { deal: _deal, relationship: _rel, contractTerms: _terms, ...video } = j.result;
  return { ...j, result: { ...video, contentRules: (j.result.contentRules?.length ? j.result.contentRules : j.result.contractTerms ?? []).filter((x) => !MONEY.test(x)), videoBriefs: j.result.angles.map((_, i) => videoBriefText(j.result!, i)) } };
}

/** The newest finished brief for a deal (so re-picking a deal is instant). */
export function latestDealBrief(dealId: string): DealBriefJob | null {
  const r = db.prepare(`SELECT * FROM scriptgen_deal_briefs WHERE deal_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`).get(dealId);
  return r ? toJob(r) : null;
}

const setProgress = (id: string, p: string) => db.prepare(`UPDATE scriptgen_deal_briefs SET progress = ? WHERE id = ?`).run(p, id);

/** Start reading a deal. Returns the job id at once; poll getDealBrief. */
export function startDealBrief(dealId: string, idea = ""): string {
  if (!deals.get(dealId)) throw Object.assign(new Error("That deal no longer exists."), { status: 404 });
  const id = randomUUID();
  db.prepare(`INSERT INTO scriptgen_deal_briefs (id, deal_id, status, progress, created_at) VALUES (?, ?, 'running', 'Starting…', ?)`).run(id, dealId, now());
  void runDealBrief(id, dealId, idea).catch((e) => {
    db.prepare(`UPDATE scriptgen_deal_briefs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(e instanceof Error ? e.message : String(e), now(), id);
  });
  return id;
}

/* ── gathering ───────────────────────────────────────────────────────────── */

const MAX_EMAIL_CHARS = 90_000;
const MAX_ATTACHMENTS = 12;
/** Money / payment / admin wording — never handed to the script stages. */
const MONEY = /\$|usd|eur|gbp|€|£|\bfee\b|pay(?:ment|out|able)?|invoice|installment|instalment|bank|transfer|net\s?\d+|price|rate|compensation|tax|vat\b/i;
const MAX_LINKS = 10;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut at ${n} characters)` : s);

function cardText(dealId: string): string {
  const r = db.prepare(`SELECT * FROM deals_deals WHERE id = ?`).get(dealId) as any;
  if (!r) return "";
  const field = (label: string, v: unknown) => (v === null || v === undefined || v === "" ? "" : `${label}: ${String(v).trim()}`);
  return [
    field("Deal", r.project_name), field("Client", r.client_name), field("Client email", r.client_email), field("Stage", r.stage),
    field("Deal type", r.deal_type), field("Agreed price", r.agreed_price), field("Estimated value", r.estimated_value), field("Slot month", r.slot_month),
    field("Deadline", r.deadline), field("Deadline date", r.deadline_date), field("Description", r.description), field("About the company", r.about),
    field("Opportunity", r.opportunity), field("Key details", r.key_details), field("Contacts", r.contact_info), field("Next steps", r.next_steps),
    field("Links", r.links),
  ].filter(Boolean).join("\n");
}

function emailsText(dealId: string): { text: string; threads: number; messages: number } {
  const threads = threadsForDeal(dealId);
  const ids = threads.map((t) => t.threadId);
  if (!ids.length) return { text: "", threads: 0, messages: 0 };
  const rows = db.prepare(
    `SELECT thread_id, subject, from_name, from_email, to_email, date_iso, body_text, snippet, labels, is_from_me FROM deals_emails
     WHERE thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY date_iso ASC`,
  ).all(...ids) as any[];
  const real = rows.filter((r) => !String(r.labels ?? "").includes("DRAFT"));
  const blocks = real.map((r) => {
    const who = String(r.is_from_me) === "1" || r.is_from_me === true || r.is_from_me === "True" ? "JAKE" : `${r.from_name || r.from_email}`;
    const body = stripQuoted(String(r.body_text || r.snippet || "")).trim();
    return `--- ${String(r.date_iso ?? "").slice(0, 10)} · ${who} → ${r.to_email ?? ""} · "${r.subject ?? ""}"\n${body}`;
  });
  // Keep the newest when it doesn't fit: the latest messages carry the current terms.
  let text = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (text.length + blocks[i].length > MAX_EMAIL_CHARS) { text = `(… ${i + 1} older message(s) not shown — the newest are what counts)\n\n${text}`; break; }
    text = `${blocks[i]}\n\n${text}`;
  }
  return { text: text.trim(), threads: ids.length, messages: real.length };
}

function agentText(dealId: string, brand: string | null, threadIds: string[]): string {
  const out: string[] = [];
  if (threadIds.length) {
    const items = db.prepare(
      `SELECT subject, stage, goal, decision, reason, fit, created_at FROM deals_agent_items WHERE preview = 0 AND thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 12`,
    ).all(...threadIds) as any[];
    for (const it of items) out.push(`- ${String(it.created_at).slice(0, 10)} "${it.subject}": stage ${it.stage ?? "?"}, decided ${it.decision}${it.goal ? `; they want: ${it.goal}` : ""}${it.reason ? `; why: ${String(it.reason).slice(0, 400)}` : ""}${it.fit ? `; fit: ${String(it.fit).slice(0, 300)}` : ""}`);
  }
  const focus = db.prepare(`SELECT grade, score, fit, price, ease, reasons_json FROM deals_agent_focus WHERE deal_id = ?`).get(dealId) as any;
  if (focus) out.push(`- Focus score: ${focus.grade} (${focus.score}) — fit ${focus.fit ?? "?"}, price ${focus.price ?? "?"}, ease ${focus.ease ?? "?"}; ${String(focus.reasons_json ?? "").slice(0, 600)}`);
  const domain = (db.prepare(`SELECT client_email FROM deals_deals WHERE id = ?`).get(dealId) as any)?.client_email?.split("@")[1];
  const fit = domain ? getFitCache(domain, 365) : null;
  if (fit) out.push(`- Sponsor-fit research on ${domain}: ${JSON.stringify(fit).slice(0, 1500)}`);
  for (const l of relevantLessons(brand, null, 8)) if (l.brand) out.push(`- Lesson for ${l.brand}: ${l.lesson}`);
  for (const r of listRules()) if (r.scope === "brand" && r.brand && brand && r.brand.toLowerCase().includes(brand.toLowerCase())) out.push(`- Jake's rule for ${r.brand}: ${r.rule}`);
  return out.join("\n");
}

/* ── the read ────────────────────────────────────────────────────────────── */

const SYSTEM = `You prepare sponsored YouTube videos for Jake Dawson, whose channel makes AI tools approachable for everyday, non-technical people — small-business owners and curious professionals, many of them 45+ (no developers, no jargon). Jake's videos are hands-on demos: the viewer sees the tool working and can copy every step.

You are given EVERYTHING about one sponsorship deal: the deal card, every email in every thread with the brand or its agency, the email agent's notes, and the brand's attached contracts and briefs. Read all of it. Then:

1. Extract the sponsor brief exactly as agreed — the LATEST agreed terms win over earlier ones (a counter-offer replaced by a later acceptance, a brief replaced by a v2). Quote must-say lines, CTAs, codes and links exactly. Never invent a term: if something isn't in the material, it goes under "gaps".
PRIVACY (strict): never write personal or payment data anywhere in your answer — no bank, IBAN, SWIFT, account, card or tax numbers, no home/office addresses, phone numbers, personal email addresses, signatures, ID numbers, or private details about people. Refer to people by role ("the agency's campaign manager"), not by name. The fee and payment terms may appear ONLY under deal.price; nowhere else.

2. Propose AT LEAST 5 (5–7) genuinely different video angles. Each must satisfy the sponsor's brief (key messages, must-show) AND be a video Jake's audience would click and finish: a concrete everyday outcome, the product shown working in a real task, plain words. Vary them: a tutorial, a challenge/experiment, a "replace X with Y", a business use-case, a before/after, a comparison the contract allows, etc. Respect every contract restriction (exclusivity, claims they forbid, what can't be shown). Rank the best first.

Return JSON only:
{"brandBrief": "THE BRAND'S OWN BRIEF, REPRODUCED AS THEY WROTE IT — from their brief document(s) (Notion, PDF, Doc, deck) or the email where they wrote it out; the LATEST version if there are several. Keep their headings, wording, requirements, talking points, do's and don'ts, CTA, links and codes. Add nothing, summarise nothing, interpret nothing. Leave out only personal and payment data and anything about money or dates. null if the brand never sent a brief.",
 "summary": "3-5 sentences about THE VIDEO ONLY: who the sponsor is, what the product does in plain words, and what the video must achieve for them — NOTHING about money, payment, dates, the negotiation or the email back-and-forth",
 "sponsor": {"brand": "the brand's plain name only (e.g. \"Linearity\") — never the agency, legal suffix or campaign", "product": "the product's plain name only", "website": null, "whatItDoes": "plain words", "offer": null, "links": [], "codes": []},
 "deal": {"type": "dedicated video / mid-roll / Shorts / …", "price": null, "deliverables": [], "deadlines": ["what — when"], "approvals": null, "usageRights": null, "status": "where the deal stands now"},
 "brief": {"keyMessages": [], "mustSay": [], "mustShow": [], "mustNotSay": [], "cta": null, "disclosure": null, "targetAudience": null, "tone": null},
 "contractTerms": ["each term that affects the video or its publishing"],
 "contentRules": ["ONLY the rules that affect what the video may say, show or claim — no money, payment, dates, people or admin"],
 "relationship": ["what the emails/agent say about working with them: sensitivities, preferences, people"],
 "gaps": ["ONLY unknowns about the VIDEO's content: missing brief items, CTA/links/codes not provided, features not confirmed — never dates, payment or negotiation"],
 "angles": [{"title": "", "premise": "", "hook": "", "productMoment": "", "why": "", "risk": "", "bestFor": "whole-video | mid-roll"}]}`;

async function runDealBrief(id: string, dealId: string, idea: string): Promise<void> {
  const sources: DealBriefSource[] = [];
  const brand = (() => { try { return brandForDeal(dealId); } catch { return null; } })();

  setProgress(id, "Reading the deal card and every email…");
  const card = cardText(dealId);
  sources.push({ kind: "card", label: "Deal card", read: !!card });
  const mail = emailsText(dealId);
  sources.push({ kind: "email", label: `${mail.messages} email(s) in ${mail.threads} thread(s)`, read: mail.messages > 0 });
  const threadIds = threadsForDeal(dealId).map((t) => t.threadId);
  const agent = agentText(dealId, brand, threadIds);
  sources.push({ kind: "agent", label: "Email agent's notes, fit check, lessons and your rules", read: !!agent });

  setProgress(id, "Opening the attachments and linked documents…");
  const filesData = getDealFilesData(dealId);
  const parts = emptyParts();
  // Attachments: newest version of each, contracts and briefs first; invoices skipped.
  const order = ["contract", "brief", "deck", "script", "other"];
  const attachments = filesData.files
    .filter((f) => f.kind !== "invoice" && !SENSITIVE_DOC.test(f.name))
    .sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))
    .slice(0, MAX_ATTACHMENTS);
  let n = 0;
  for (const f of attachments) {
    n++;
    const label = `${f.kind.toUpperCase()}: "${f.name}" (from ${f.fromName || f.from}, ${String(f.date ?? "").slice(0, 10)})`;
    setProgress(id, `Reading attachment ${n}/${attachments.length}: ${f.name}${isMedia(f.name, f.mimeType) ? " (transcribing)" : ""}…`);
    try {
      const buf = await downloadAttachment(f.messageId, f.attachmentId, f.name);
      mergeParts(parts, await fileToParts(buf, f.name, f.mimeType, label));
    } catch (e) {
      parts.notes.push({ label, read: false, note: `could not download (${e instanceof Error ? e.message.slice(0, 60) : "error"})` });
    }
  }
  // Links in the emails: Notion, Google Docs/Slides/Sheets/Drive (files, folders, videos),
  // Loom, Vimeo, Dropbox, DocSend… — plus YouTube links the BRAND sent (not Jake's own).
  const links: Array<{ url: string; label: string }> = filesData.links
    .filter((l) => !/calendly|zoom\.us|linkedin|twitter|x\.com|instagram|facebook|tiktok/i.test(l.host))
    .map((l) => ({ url: l.url, label: `${l.kind} link: ${l.title || l.url}` }));
  if (threadIds.length) {
    const bodies = db.prepare(`SELECT body_text, is_from_me FROM deals_emails WHERE thread_id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds) as any[];
    const seen = new Set(links.map((l) => l.url));
    for (const b of bodies) {
      if (String(b.is_from_me) === "1" || b.is_from_me === true || b.is_from_me === "True") continue;
      const body = stripQuoted(String(b.body_text ?? ""));
      for (const m of body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
        const u = m[0].replace(/[.,;:]+$/, "");
        if (seen.has(u)) continue;
        if (/youtube\.com\/(?:watch|shorts)|youtu\.be\/|loom\.com\/share|vimeo\.com\/\d|notion\.(?:so|site|com)|docsend\.com|pitch\.com|gamma\.app|canva\.com\/design|frame\.io|wistia/i.test(u)) {
          seen.add(u);
          links.push({ url: u, label: `link: ${u}` });
        }
      }
    }
  }
  const linkList = links.slice(0, MAX_LINKS);
  n = 0;
  for (const l of linkList) {
    n++;
    setProgress(id, `Reading link ${n}/${linkList.length}${/loom|vimeo|youtu|video/i.test(l.url) ? " (transcribing)" : /notion/.test(l.url) ? " (Notion)" : ""}…`);
    mergeParts(parts, await linkToParts(l.url, l.label));
  }
  for (const note of parts.notes) sources.push({ kind: /link/.test(note.label) ? "link" : "file", label: note.label, read: note.read, note: note.note });
  const docs = parts.pdfs;
  const images = parts.images;
  const textDocs = parts.texts;

  setProgress(id, `Reading it all with Opus 5.5 (${docs.length} PDF${docs.length === 1 ? "" : "s"})…`);
  const prompt = [
    idea.trim() ? `Jake's idea for the video so far (optional, he may change it): ${idea.trim()}\n` : "",
    // Personal / payment details are blanked BEFORE anything leaves the Lab (Jake 2026-10-02).
    `# THE DEAL CARD\n${redactPersonal(card) || "(empty)"}`,
    `# EVERY EMAIL, OLDEST FIRST (quoted replies stripped)\n${redactPersonal(mail.text) || "(no synced emails for this deal)"}`,
    `# THE EMAIL AGENT'S KNOWLEDGE\n${redactPersonal(agent) || "(none)"}`,
    textDocs.length ? `# LINKED / TEXT DOCUMENTS\n${textDocs.join("\n\n---\n\n")}` : "",
    docs.length || images.length ? `# ATTACHMENTS\nBelow: ${docs.length} PDF(s) (contracts first, then briefs — read every page) and ${images.length} image(s) the brand or Jake attached.` : "",
  ].filter(Boolean).join("\n\n");
  const raw = await opusScriptChat({
    system: SYSTEM,
    messages: [{ role: "user", content: prompt, documents: docs, images: images as any }],
    maxTokens: 16000,
    effort: "high",
    label: "deal-brief",
    purpose: "scriptgen",
  });
  // And scrubbed again on the way back in: nothing personal is stored or shown.
  const parsed = redactDeep(JSON.parse(extractJson(raw))) as DealBrief;
  if (!Array.isArray(parsed.contentRules)) parsed.contentRules = (parsed.contractTerms ?? []).filter((t) => !MONEY.test(t));
  if (!Array.isArray(parsed.angles) || parsed.angles.length < 5) throw new Error(`Only ${parsed.angles?.length ?? 0} angles came back — run it again.`);
  db.prepare(`UPDATE scriptgen_deal_briefs SET status = 'done', progress = NULL, result_json = ?, sources_json = ?, finished_at = ? WHERE id = ?`)
    .run(JSON.stringify(parsed), JSON.stringify(sources), now(), id);
}

/* ── what the script stages read ─────────────────────────────────────────── */

export interface SponsorDealInput { dealId: string; briefId: string; angle: number }

export function dealBriefBlock(sd: SponsorDealInput | undefined | null): string {
  if (!sd) return "";
  const b = getDealBrief(sd.briefId)?.result;
  if (!b) return "";
  // The readable video brief (angle, messages, must-say…) is put in the run's
  // Brief field by the UI, where Jake can edit it. This block carries only what
  // must be EXACT, and the confidentiality rule. Never the fee, payment, dates,
  // people or anything from the negotiation (Jake 2026-10-02).
  const clean = (xs: string[] | undefined) => (xs ?? []).filter((x) => !MONEY.test(x)).map(redactPersonal);
  const list = (title: string, xs: string[] | undefined) => { const c = clean(xs); return c.length ? [`**${title}:**`, ...c.map((x) => `- ${x}`)] : []; };
  return [
    "",
    "---",
    "",
    `## SPONSORED BY ${b.sponsor.brand}${b.sponsor.product && b.sponsor.product !== b.sponsor.brand ? ` (${b.sponsor.product})` : ""} — EXACT ITEMS`,
    "",
    "Use these exactly as written (the brand's own wording): links, codes and must-say lines are quoted character for character; the disclosure is said as given.",
    ...list("Links", b.sponsor.links), ...list("Codes", b.sponsor.codes), ...list("Must say (verbatim)", b.brief.mustSay),
    b.brief.cta ? `**CTA:** ${redactPersonal(b.brief.cta)}` : "",
    b.brief.disclosure ? `**Disclosure:** ${redactPersonal(b.brief.disclosure)}` : "",
    "",
    "**CONFIDENTIAL — never in the script, its notes, or a web search:** the fee, payment, contract dates or terms, the people involved, or anything about the negotiation or the emails. The viewer only hears that the video is sponsored, as the disclosure says.",
  ].filter((l) => l !== "").join("\n");
}

/** The video brief for the form's Brief field — the angle and the video, nothing else. */
export function videoBriefText(b: DealBrief, angleIndex: number): string {
  const a = b.angles[angleIndex] ?? b.angles[0];
  // The brand's brief as they sent it — exactly what Jake used to paste here — then the angle he chose.
  if (b.brandBrief && b.brandBrief.trim().length > 80) {
    return [
      `THE BRAND'S BRIEF — ${b.sponsor.brand} (as they sent it)`,
      "",
      redactPersonal(b.brandBrief.trim()),
      "",
      "---",
      `THE ANGLE JAKE CHOSE: ${a.title}`,
      `- ${a.premise}`,
      `- Hook: ${a.hook}`,
      `- Product moment: ${a.productMoment}`,
      `- Watch out for: ${a.risk}`,
    ].join("\n");
  }
  const clean = (xs: string[] | undefined) => (xs ?? []).filter((x) => !MONEY.test(x)).map(redactPersonal);
  const list = (title: string, xs: string[] | undefined) => { const c = clean(xs); return c.length ? [`${title}:`, ...c.map((x) => `- ${x}`), ""] : []; };
  return [
    `SPONSORED VIDEO — ${b.sponsor.brand}${b.sponsor.product && b.sponsor.product !== b.sponsor.brand ? ` (${b.sponsor.product})` : ""}`,
    "",
    `ANGLE: ${a.title}`,
    `- ${a.premise}`,
    `- Hook: ${a.hook}`,
    `- Product moment: ${a.productMoment}`,
    `- Watch out for: ${a.risk}`,
    "",
    `WHAT IT IS: ${redactPersonal(b.sponsor.whatItDoes)}${b.sponsor.website ? ` (${b.sponsor.website})` : ""}`,
    b.sponsor.offer ? `OFFER FOR VIEWERS: ${redactPersonal(b.sponsor.offer)}` : "",
    "",
    ...list("KEY MESSAGES", b.brief.keyMessages),
    ...list("MUST SHOW", b.brief.mustShow),
    ...list("MUST NOT SAY", b.brief.mustNotSay),
    ...list("CONTENT RULES", b.contentRules?.length ? b.contentRules : b.contractTerms),
    b.brief.tone ? `TONE: ${redactPersonal(b.brief.tone)}` : "",
    b.brief.targetAudience ? `THEIR TARGET AUDIENCE: ${redactPersonal(b.brief.targetAudience)}` : "",
    "",
    ...list("STILL OPEN (don't invent)", b.gaps),
  ].filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n").trim();
}
