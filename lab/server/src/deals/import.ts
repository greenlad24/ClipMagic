/**
 * Deal Organizer — one-shot importer for the Zite export.
 *
 * Reads `<DATA_DIR>/imports/dealorg/_data/*.json` (one file per Zite table plus
 * `_schema.json`) into the `deals_*` tables:
 *
 *   - single-select values are exported as OPTION IDS ("bJ7t") → mapped to their
 *     labels ("New Requests") through `_schema.json`;
 *   - link fields (`deal: ["<uuid>"]`) → the `deal_id` foreign key;
 *   - original ids and createdAt/updatedAt are preserved;
 *   - the Zite sample/seed rows are dropped (see SAMPLE RULES below);
 *   - emails are deduped on (accountEmail, messageId), keeping the most
 *     recently updated copy (the duplicates differ only in historyId /
 *     attachments / labels / isRead — the later sync is the truer one);
 *   - duplicate deals are kept as-is (mergeDeals handles them in the app);
 *   - Gmail tokens are not in the export, so email_accounts has none.
 *
 * Guarded: it refuses to run once `deals_deals` has rows, unless `force` is
 * passed — and `force` wipes every deals_* table first. The whole import is
 * one transaction, so a failure leaves the tables as they were.
 *
 * CLI (inside the container):  node dist/deals/import.js [--force] [--dir <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  ALL_TABLES,
  deals,
  dealComments,
  dealActions,
  stageConfig,
  deadlineProjects,
  emails,
  emailAccounts,
  threadIndex,
  threadBrands,
  companyResearchCache,
  aiConfig,
  users,
  toIsoDate,
} from "./db.js";

export const DEFAULT_IMPORT_DIR = path.join(config.dataDir, "imports", "dealorg", "_data");

type Row = Record<string, any>;

interface SchemaField { sdkName: string; definition: { type: string; template?: { options?: { value: string; label: string }[] } } }
interface SchemaTable { sdkName: string; fields: SchemaField[] }

export interface TableReport {
  source: number;
  droppedSamples: number;
  droppedDuplicates: number;
  droppedOrphans: number;
  unmappedOptions: number;
  imported: number;
}

export interface ImportReport {
  ok: boolean;
  skipped?: string;
  dir: string;
  tables: Record<string, TableReport>;
}

/* ── SAMPLE RULES (from SPEC/data-and-lab-fit.md "Oddities") ──────────────── */

const HEX_ID = /^[0-9a-f]+$/;
const SAMPLE_RULES: Record<string, (r: Row) => boolean> = {
  // No deals rule: the 7 "seed-looking" deals (example.com threadLink, 2023 scan dates) are REAL
  // archived deals with real client emails + Gmail thread ids — only their AI fields came from
  // Zite's seed. Jake wants the exact data, so every deal is kept.
  // 3 each: comments/actions linked to no deal.
  dealComments: (r) => !linkId(r.deal),
  dealActions: (r) => !linkId(r.deal),
  // 3 example.com users.
  users: (r) => /@example\.com$/i.test(r.email ?? ""),
  // All 3 deadline projects are "Project Alpha/Beta/Gamma" samples.
  deadlineProjects: (r) => /^Project (Alpha|Beta|Gamma)$/.test(r.dealName ?? ""),
  // 3 each: non-hex Gmail ids (msg-12345, THR1234A, T12345).
  emails: (r) => !HEX_ID.test(r.messageId ?? ""),
  threadIndex: (r) => !HEX_ID.test(r.threadId ?? ""),
  threadBrands: (r) => !HEX_ID.test(r.threadId ?? ""),
};

function linkId(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return typeof v === "string" && v ? v : undefined;
}

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as T;
}

/** sdkName → { field → { optionId → label } } for every single_select field. */
function optionMaps(schema: { tables: SchemaTable[] }): Record<string, Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, Record<string, string>>> = {};
  for (const t of schema.tables) {
    for (const f of t.fields) {
      if (f.definition.type !== "single_select") continue;
      const map: Record<string, string> = {};
      for (const o of f.definition.template?.options ?? []) map[o.value] = o.label;
      (out[t.sdkName] ??= {})[f.sdkName] = map;
    }
  }
  return out;
}

/** Every deals_* table empty? (used by the guard and the HTTP handler). */
export function dealsTableEmpty(): boolean {
  return deals.count() === 0;
}

export function importDealOrganizerData(opts: { force?: boolean; dir?: string } = {}): ImportReport {
  const dir = opts.dir ?? DEFAULT_IMPORT_DIR;
  const report: ImportReport = { ok: false, dir, tables: {} };
  if (!opts.force && !dealsTableEmpty()) {
    report.skipped = `deals_deals already has ${deals.count()} rows — import refused (pass force to wipe and re-import).`;
    return report;
  }
  if (!fs.existsSync(path.join(dir, "_schema.json"))) {
    throw Object.assign(new Error(`No Zite export found at ${dir}`), { status: 400 });
  }

  const options = optionMaps(readJson(dir, "_schema.json"));
  const meta = (r: Row) => ({ id: r.id as string, createdAt: r.createdAt as string, updatedAt: r.updatedAt as string });

  /** Load a file, drop samples, map single-selects; returns rows + a report entry. */
  const load = (sdkName: string, file: string): { rows: Row[]; rep: TableReport } => {
    const all = readJson<Row[]>(dir, file);
    const rule = SAMPLE_RULES[sdkName];
    const rows = rule ? all.filter((r) => !rule(r)) : [...all];
    const rep: TableReport = {
      source: all.length,
      droppedSamples: all.length - rows.length,
      droppedDuplicates: 0,
      droppedOrphans: 0,
      unmappedOptions: 0,
      imported: 0,
    };
    for (const [field, map] of Object.entries(options[sdkName] ?? {})) {
      for (const r of rows) {
        const v = r[field];
        if (v === null || v === undefined || v === "") continue;
        if (map[v] !== undefined) r[field] = map[v];
        else if (!Object.values(map).includes(v)) rep.unmappedOptions++;
      }
    }
    report.tables[sdkName] = rep;
    return { rows, rep };
  };

  const run = db.transaction(() => {
    if (opts.force) for (const t of ALL_TABLES) db.prepare(`DELETE FROM ${t.table}`).run();

    /* deals — keep duplicates as-is */
    const d = load("deals", "deals.json");
    const dealIds = new Set<string>();
    for (const r of d.rows) {
      deals.insert({
        clientName: r.clientName, clientEmail: r.clientEmail, projectName: r.projectName,
        description: r.description, estimatedValue: r.estimatedValue, currency: r.currency,
        stage: r.stage, confidence: r.confidence, source: r.source,
        sourceEmailId: r.sourceEmailId, sourceThreadId: r.sourceThreadId, archived: r.archived,
        about: r.about, opportunity: r.opportunity, keyDetails: r.keyDetails,
        contactInfo: r.contactInfo, links: r.links, files: r.files, nextSteps: r.nextSteps,
        threadLink: r.threadLink, lastScannedAt: r.lastScannedAt, deadline: r.deadline,
        inProduction: r.inProduction, lastFollowUpSentAt: r.lastFollowUpSentAt,
      }, meta(r));
      dealIds.add(r.id);
    }
    d.rep.imported = d.rows.length;

    /* comments + actions — link → deal_id FK; drop any whose deal was dropped */
    for (const [sdk, file, table] of [
      ["dealComments", "dealComments.json", dealComments],
      ["dealActions", "dealActions.json", dealActions],
    ] as const) {
      const x = load(sdk, file);
      for (const r of x.rows) {
        const dealId = linkId(r.deal)!;
        if (!dealIds.has(dealId)) { x.rep.droppedOrphans++; continue; }
        const rec: Row = sdk === "dealComments"
          ? { content: r.content, author: r.author, deal: dealId }
          : { content: r.content, status: r.status, deal: dealId };
        table.insert(rec, meta(r));
        x.rep.imported++;
      }
    }

    /* stage config — as exported (incl. the 3 user-created stages) */
    const sc = load("stageConfig", "stageConfig.json");
    for (const r of sc.rows) {
      stageConfig.insert({
        stageKey: r.stageKey, displayName: r.displayName, shortName: r.shortName,
        cssVariable: r.cssVariable, sortOrder: r.sortOrder, isProductionStage: r.isProductionStage,
      }, meta(r));
      sc.rep.imported++;
    }

    /* deadline projects (all samples today, but keep the path) */
    const dp = load("deadlineProjects", "deadlineProjects.json");
    for (const r of dp.rows) {
      deadlineProjects.insert({
        dealName: r.dealName, clientName: r.clientName, value: r.value,
        deadline: r.deadline, status: r.status, completed: r.completed,
      }, meta(r));
      dp.rep.imported++;
    }

    /* emails — dedupe on (accountEmail, messageId), keep the latest updatedAt */
    const em = load("emails", "emails.json");
    const byKey = new Map<string, Row>();
    for (const r of em.rows) {
      const key = `${r.accountEmail ?? ""}\u0000${r.messageId}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, r); continue; }
      em.rep.droppedDuplicates++;
      if (String(r.updatedAt ?? "") > String(prev.updatedAt ?? "")) byKey.set(key, r);
    }
    for (const r of byKey.values()) {
      emails.insert({
        messageId: r.messageId, threadId: r.threadId, accountEmail: r.accountEmail,
        subject: r.subject, fromEmail: r.fromEmail, fromName: r.fromName, toEmail: r.toEmail,
        date: r.date, dateIso: toIsoDate(r.date), snippet: r.snippet,
        bodyText: r.bodyText, bodyHtml: r.bodyHtml, labels: r.labels,
        attachments: r.attachments, urLs: r.urLs, isRead: r.isRead, isFromMe: r.isFromMe,
        historyId: r.historyId,
      }, meta(r));
      em.rep.imported++;
    }

    /* email accounts — no tokens in the export */
    const ea = load("emailAccounts", "emailAccounts.json");
    for (const r of ea.rows) {
      emailAccounts.insert({
        email: r.email, displayName: r.displayName, provider: r.provider,
        refreshToken: r.refreshToken, accessToken: r.accessToken,
        historyId: r.historyId, lastSyncedAt: r.lastSyncedAt,
      }, meta(r));
      ea.rep.imported++;
    }

    const ti = load("threadIndex", "threadIndex.json");
    for (const r of ti.rows) {
      threadIndex.insert({
        threadId: r.threadId, accountEmail: r.accountEmail, subject: r.subject,
        senderName: r.senderName, senderEmail: r.senderEmail, recipientEmail: r.recipientEmail,
        snippet: r.snippet, lastDate: r.lastDate, labels: r.labels,
        messageCount: r.messageCount, isRead: r.isRead,
      }, meta(r));
      ti.rep.imported++;
    }

    const tb = load("threadBrands", "threadBrands.json");
    for (const r of tb.rows) {
      threadBrands.insert({
        threadId: r.threadId, brandName: r.brandName, senderDomain: r.senderDomain,
        senderEmail: r.senderEmail, senderName: r.senderName, subject: r.subject,
        lastDate: r.lastDate, accountEmail: r.accountEmail,
      }, meta(r));
      tb.rep.imported++;
    }

    const cr = load("companyResearchCache", "companyResearchCache.json");
    for (const r of cr.rows) {
      companyResearchCache.insert({ companyName: r.companyName, researchData: r.researchData, cachedAt: r.cachedAt }, meta(r));
      cr.rep.imported++;
    }

    const ac = load("aiConfig", "aiConfig.json");
    for (const r of ac.rows) {
      aiConfig.insert({ key: r.key, value: r.value, description: r.description }, meta(r));
      ac.rep.imported++;
    }

    const us = load("users", "users.json");
    for (const r of us.rows) {
      users.insert({ email: r.email, firstName: r.firstName, lastName: r.lastName }, meta(r));
      us.rep.imported++;
    }
  });

  run();
  report.ok = true;
  return report;
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const report = importDealOrganizerData({
    force: args.includes("--force"),
    dir: dirIdx >= 0 ? args[dirIdx + 1] : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
}
