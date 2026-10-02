/**
 * Deal Organizer — storage.
 *
 * A port of the Zite "Deal Pipeline Kanban" app's tables onto the Lab's shared
 * SQLite database. One `deals_*` table per original table; columns are the
 * original fields in snake_case, and records are handed to the ported logic in
 * the ORIGINAL camelCase shape (`clientName`, `stage`, `isProductionStage`…)
 * so the endpoint code stays line-for-line comparable with the Zite source.
 *
 * Deliberate choices that keep the port exact:
 *   - `deals_deals.stage` stores the stage DISPLAY NAME ("New Requests"), as the
 *     original did — `stageUtils` maps it to/from the frontend stage key.
 *   - `confidence` ("High"/"Medium"/"Low") and action `status` ("Pending"/
 *     "In Progress"/"Done") are stored as their labels.
 *   - The link fields become foreign keys (`deal_id`); the inverse arrays on a
 *     deal (dealComments/dealActions) are not stored — they're counted.
 *   - Upsert keys match the original `bulkCreate({matchOn})` keys (UNIQUE).
 *   - `created_at` / `updated_at` are ISO strings, preserved from the import.
 *
 * Booleans are stored as 0/1 and returned as true/false; NULL columns are
 * omitted from the record (Zite returned unset fields as absent too).
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";

db.exec(`
CREATE TABLE IF NOT EXISTS deals_deals (
  id TEXT PRIMARY KEY,
  client_name TEXT,
  client_email TEXT,
  project_name TEXT,
  description TEXT,
  estimated_value REAL,
  currency TEXT DEFAULT 'USD',
  stage TEXT,
  confidence TEXT,
  source TEXT DEFAULT 'manual',
  source_email_id TEXT,
  source_thread_id TEXT,
  archived INTEGER,
  about TEXT,
  opportunity TEXT,
  key_details TEXT,
  contact_info TEXT,
  links TEXT,
  files TEXT,
  next_steps TEXT,
  thread_link TEXT,
  last_scanned_at TEXT,
  deadline TEXT,
  in_production INTEGER,
  last_follow_up_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_deals_stage ON deals_deals (stage);
CREATE INDEX IF NOT EXISTS deals_deals_client_email ON deals_deals (client_email);
CREATE INDEX IF NOT EXISTS deals_deals_source_thread ON deals_deals (source_thread_id);

CREATE TABLE IF NOT EXISTS deals_deal_comments (
  id TEXT PRIMARY KEY,
  content TEXT,
  author TEXT DEFAULT 'You',
  deal_id TEXT REFERENCES deals_deals(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_deal_comments_deal ON deals_deal_comments (deal_id);

CREATE TABLE IF NOT EXISTS deals_deal_actions (
  id TEXT PRIMARY KEY,
  content TEXT,
  status TEXT DEFAULT 'Pending',
  deal_id TEXT REFERENCES deals_deals(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_deal_actions_deal ON deals_deal_actions (deal_id);

CREATE TABLE IF NOT EXISTS deals_stage_config (
  id TEXT PRIMARY KEY,
  stage_key TEXT UNIQUE,
  display_name TEXT,
  short_name TEXT,
  css_variable TEXT,
  sort_order REAL,
  is_production_stage INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_deadline_projects (
  id TEXT PRIMARY KEY,
  deal_name TEXT,
  client_name TEXT,
  value REAL,
  deadline TEXT,
  status TEXT DEFAULT 'In Research',
  completed INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_emails (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  account_email TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  to_email TEXT,
  date TEXT,          -- raw Date header, exactly as the original stored it
  date_iso TEXT,      -- the same instant parsed to ISO (NULL if unparseable)
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  labels TEXT,        -- JSON array text
  attachments TEXT,   -- JSON array text
  urls TEXT,          -- JSON array text (original field: urLs)
  is_read INTEGER,
  is_from_me INTEGER,
  history_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS deals_emails_account_message ON deals_emails (account_email, message_id);
CREATE INDEX IF NOT EXISTS deals_emails_thread ON deals_emails (thread_id);

CREATE TABLE IF NOT EXISTS deals_email_accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  provider TEXT,
  refresh_token TEXT,
  access_token TEXT,
  history_id TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_thread_index (
  id TEXT PRIMARY KEY,
  thread_id TEXT UNIQUE,
  account_email TEXT,
  subject TEXT,
  sender_name TEXT,
  sender_email TEXT,
  recipient_email TEXT,
  snippet TEXT,
  last_date TEXT,
  labels TEXT,
  message_count REAL,
  is_read INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_thread_index_account ON deals_thread_index (account_email);

CREATE TABLE IF NOT EXISTS deals_thread_brands (
  id TEXT PRIMARY KEY,
  thread_id TEXT UNIQUE,
  brand_name TEXT,
  sender_domain TEXT,
  sender_email TEXT,
  sender_name TEXT,
  subject TEXT,
  last_date TEXT,
  account_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_company_research_cache (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  research_data TEXT,
  cached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_ai_config (
  id TEXT PRIMARY KEY,
  key TEXT,
  value TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

/* ── additive columns (bug-fix pass, 2026-09-30) ──────────────────────────── */

function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}
function addColumn(table: string, column: string, type: string): void {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
/**
 * deals_deals bookkeeping the fixes need (all nullable; NULL on every legacy row):
 *   stage_source               who last set `stage`: 'board' (updateDeal/createDeal/
 *                              addDealToProduction — the UI or the agent), 'scan'
 *                              (scanGmail), 'followup' (getFollowUpDrafts low-baller move)
 *   stage_changed_at           when `stage` last changed
 *   human_touched_at           last edit/move/comment/action through the board API
 *   last_reviewed_at           last time scanGmail re-read this deal (Pass 2 rotation)
 *   last_follow_up_drafted_at  a follow-up DRAFT was saved (sendFollowUp)
 *   review_flag                why the scanner wants a human to look (instead of auto-archiving)
 *   merged_into                id of the deal this one was merged into (mergeDeals)
 */
for (const [col, type] of [
  ["stage_source", "TEXT"],
  ["stage_changed_at", "TEXT"],
  ["human_touched_at", "TEXT"],
  ["last_reviewed_at", "TEXT"],
  ["last_follow_up_drafted_at", "TEXT"],
  ["review_flag", "TEXT"],
  ["merged_into", "TEXT"],
] as const) addColumn("deals_deals", col, type);

/**
 * THE archived filter (bug 20): one definition for every query. NULL counts as
 * not archived (Zite's `{ archived: { not: true } }`).
 */
export const NOT_ARCHIVED = "(archived IS NULL OR archived = 0)";

/** Comment authors that are machines, not Jake — they don't count as "a human touched this deal". */
export const MACHINE_AUTHORS = new Set(["Agent", "System", "Scanner"]);

/* ── generic column <-> field mapping (as news/db.ts) ─────────────────────── */

type Kind = "text" | "num" | "bool";
type Columns = Record<string, [column: string, kind: Kind]>;

const TIMESTAMPS: Columns = { createdAt: ["created_at", "text"], updatedAt: ["updated_at", "text"] };

function rowToRecord<T>(row: any, cols: Columns): T {
  if (!row) return row;
  const out: Record<string, unknown> = { id: row.id };
  for (const [field, [col, kind]] of Object.entries({ ...cols, ...TIMESTAMPS })) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    out[field] = kind === "bool" ? v === 1 || v === true : v;
  }
  return out as T;
}

function toColumnValues(record: Record<string, unknown>, cols: Columns): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    const spec = cols[field];
    if (!spec) continue;
    const [col, kind] = spec;
    if (value === undefined) continue;
    if (value === null) out[col] = null;
    else if (kind === "bool") out[col] = value ? 1 : 0;
    else if (kind === "num") out[col] = Number(value);
    else out[col] = String(value);
  }
  return out;
}

const nowIso = () => new Date().toISOString();

/** Options for an insert that must preserve an imported row's identity. */
export interface InsertMeta { id?: string; createdAt?: string; updatedAt?: string }

function makeTable<T extends { id: string }>(table: string, cols: Columns) {
  const get = (id: string): T | undefined =>
    rowToRecord<T>(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), cols);
  const insert = (record: Record<string, unknown>, meta: InsertMeta = {}): T => {
    const id = meta.id ?? randomUUID();
    const now = nowIso();
    const values: Record<string, unknown> = {
      ...toColumnValues(record, cols),
      created_at: meta.createdAt ?? now,
      updated_at: meta.updatedAt ?? meta.createdAt ?? now,
    };
    const names = ["id", ...Object.keys(values)];
    db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((n) => "@" + n).join(", ")})`).run({ id, ...values });
    return get(id)!;
  };
  const update = (id: string, record: Record<string, unknown>): void => {
    const values = toColumnValues(record, cols);
    const names = Object.keys(values);
    if (!names.length) return;
    db.prepare(`UPDATE ${table} SET ${names.map((n) => `${n} = @${n}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
      .run({ id, ...values, updated_at: nowIso() });
  };
  const remove = (id: string): void => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  };
  /** `sql` is the tail after WHERE (may include ORDER BY / LIMIT). */
  const where = (sql: string, ...params: unknown[]): T[] =>
    (db.prepare(`SELECT * FROM ${table} WHERE ${sql}`).all(...params) as any[]).map((r) => rowToRecord<T>(r, cols));
  /** Zite `findAll` — insertion order (created_at, then rowid), capped. */
  const all = (limit: number): T[] => where(`1 = 1 ORDER BY created_at, rowid LIMIT ?`, limit);
  const count = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  /**
   * Zite `bulkCreate({ matchOn: [field] })`: insert, or update the row whose
   * `matchOn` column equals the record's value. One transaction.
   */
  const upsertMany = db.transaction((records: Record<string, unknown>[], matchOn: string[]) => {
    for (const r of records) {
      const conds = matchOn.map((f) => `${cols[f][0]} = ?`).join(" AND ");
      const existing = db.prepare(`SELECT id FROM ${table} WHERE ${conds}`).get(...matchOn.map((f) => r[f])) as { id: string } | undefined;
      if (existing) update(existing.id, r);
      else insert(r);
    }
  });
  return { insert, get, update, remove, where, all, count, upsertMany, table, cols };
}

/* ── record types (the original Zite field names) ─────────────────────────── */

export interface DealRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  clientName?: string;
  clientEmail?: string;
  projectName?: string;
  description?: string;
  estimatedValue?: number;
  currency?: string;
  stage?: string;
  confidence?: string;
  source?: string;
  sourceEmailId?: string;
  sourceThreadId?: string;
  archived?: boolean;
  about?: string;
  opportunity?: string;
  keyDetails?: string;
  contactInfo?: string;
  links?: string;
  files?: string;
  nextSteps?: string;
  threadLink?: string;
  lastScannedAt?: string;
  deadline?: string;
  inProduction?: boolean;
  lastFollowUpSentAt?: string;
  stageSource?: string;
  stageChangedAt?: string;
  humanTouchedAt?: string;
  lastReviewedAt?: string;
  lastFollowUpDraftedAt?: string;
  reviewFlag?: string;
  mergedInto?: string;
  /** Card autofill (deadlineParse.ts / dealAutofill.ts, 2026-09-30). */
  deadlineDate?: string;
  deadlineParsedFrom?: string;
  cardFilledAt?: string;
  cardAsof?: string;
  /** Inverse link arrays (not stored — filled by `withLinks`). */
  dealComments?: string[];
  dealActions?: string[];
}

export interface DealCommentRecord { id: string; createdAt?: string; updatedAt?: string; content?: string; author?: string; deal?: string }
export interface DealActionRecord { id: string; createdAt?: string; updatedAt?: string; content?: string; status?: string; deal?: string; source?: string; statusBy?: string }

export interface StageConfigRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  stageKey?: string;
  displayName?: string;
  shortName?: string;
  cssVariable?: string;
  sortOrder?: number;
  isProductionStage?: boolean;
}

export interface DeadlineProjectRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  dealName?: string;
  clientName?: string;
  value?: number;
  deadline?: string;
  status?: string;
  completed?: boolean;
}

export interface EmailRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  messageId?: string;
  threadId?: string;
  accountEmail?: string;
  subject?: string;
  fromEmail?: string;
  fromName?: string;
  toEmail?: string;
  date?: string;
  dateIso?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  labels?: string;
  attachments?: string;
  urLs?: string;
  isRead?: boolean;
  isFromMe?: boolean;
  historyId?: string;
}

export interface EmailAccountRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  email?: string;
  displayName?: string;
  provider?: string;
  refreshToken?: string;
  accessToken?: string;
  historyId?: string;
  lastSyncedAt?: string;
}

export interface ThreadIndexRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  threadId?: string;
  accountEmail?: string;
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipientEmail?: string;
  snippet?: string;
  lastDate?: string;
  labels?: string;
  messageCount?: number;
  isRead?: boolean;
}

export interface ThreadBrandRecord {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  threadId?: string;
  brandName?: string;
  senderDomain?: string;
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  lastDate?: string;
  accountEmail?: string;
}

export interface CompanyResearchRecord { id: string; createdAt?: string; updatedAt?: string; companyName?: string; researchData?: string; cachedAt?: string }
export interface AiConfigRecord { id: string; createdAt?: string; updatedAt?: string; key?: string; value?: string; description?: string }
export interface UserRecord { id: string; createdAt?: string; updatedAt?: string; email?: string; firstName?: string; lastName?: string }

/* ── tables ───────────────────────────────────────────────────────────────── */

const dealsTable = makeTable<DealRecord>("deals_deals", {
  clientName: ["client_name", "text"],
  clientEmail: ["client_email", "text"],
  projectName: ["project_name", "text"],
  description: ["description", "text"],
  estimatedValue: ["estimated_value", "num"],
  currency: ["currency", "text"],
  stage: ["stage", "text"],
  confidence: ["confidence", "text"],
  source: ["source", "text"],
  sourceEmailId: ["source_email_id", "text"],
  sourceThreadId: ["source_thread_id", "text"],
  archived: ["archived", "bool"],
  about: ["about", "text"],
  opportunity: ["opportunity", "text"],
  keyDetails: ["key_details", "text"],
  contactInfo: ["contact_info", "text"],
  links: ["links", "text"],
  files: ["files", "text"],
  nextSteps: ["next_steps", "text"],
  threadLink: ["thread_link", "text"],
  lastScannedAt: ["last_scanned_at", "text"],
  deadline: ["deadline", "text"],
  inProduction: ["in_production", "bool"],
  lastFollowUpSentAt: ["last_follow_up_sent_at", "text"],
  stageSource: ["stage_source", "text"],
  stageChangedAt: ["stage_changed_at", "text"],
  humanTouchedAt: ["human_touched_at", "text"],
  lastReviewedAt: ["last_reviewed_at", "text"],
  lastFollowUpDraftedAt: ["last_follow_up_drafted_at", "text"],
  reviewFlag: ["review_flag", "text"],
  mergedInto: ["merged_into", "text"],
  // Card autofill (columns added by deadlineParse.ts / dealAutofill.ts):
  deadlineDate: ["deadline_date", "text"],
  deadlineParsedFrom: ["deadline_parsed_from", "text"],
  cardFilledAt: ["card_filled_at", "text"],
  cardAsof: ["card_asof", "text"],
});

export const dealComments = makeTable<DealCommentRecord>("deals_deal_comments", {
  content: ["content", "text"],
  author: ["author", "text"],
  deal: ["deal_id", "text"],
});

export const dealActions = makeTable<DealActionRecord>("deals_deal_actions", {
  content: ["content", "text"],
  status: ["status", "text"],
  deal: ["deal_id", "text"],
  source: ["source", "text"],       // 'auto' = dealAutofill.ts (column added there)
  statusBy: ["status_by", "text"],  // 'human' | 'auto'
});

/**
 * Attach the inverse link arrays Zite returned on every deal record
 * (`dealComments` / `dealActions` = ids of the linked rows), so `toFE`'s
 * comment_count / action_count come out exactly as before.
 */
function withLinks(records: DealRecord[]): DealRecord[] {
  if (!records.length) return records;
  const ids = records.map((r) => r.id);
  const byDeal = (table: string) => {
    const map = new Map<string, string[]>();
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const rows = db
        .prepare(`SELECT id, deal_id FROM ${table} WHERE deal_id IN (${slice.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
        .all(...slice) as { id: string; deal_id: string }[];
      for (const r of rows) {
        const list = map.get(r.deal_id) ?? [];
        list.push(r.id);
        map.set(r.deal_id, list);
      }
    }
    return map;
  };
  const c = byDeal("deals_deal_comments");
  const a = byDeal("deals_deal_actions");
  return records.map((r) => ({ ...r, dealComments: c.get(r.id) ?? [], dealActions: a.get(r.id) ?? [] }));
}

export const deals = {
  ...dealsTable,
  get: (id: string): DealRecord | undefined => {
    const r = dealsTable.get(id);
    return r ? withLinks([r])[0] : undefined;
  },
  where: (sql: string, ...params: unknown[]): DealRecord[] => withLinks(dealsTable.where(sql, ...params)),
  all: (limit: number): DealRecord[] => withLinks(dealsTable.all(limit)),
  insert: (record: Record<string, unknown>, meta?: InsertMeta): DealRecord => withLinks([dealsTable.insert(record, meta)])[0],
};

export const stageConfig = makeTable<StageConfigRecord>("deals_stage_config", {
  stageKey: ["stage_key", "text"],
  displayName: ["display_name", "text"],
  shortName: ["short_name", "text"],
  cssVariable: ["css_variable", "text"],
  sortOrder: ["sort_order", "num"],
  isProductionStage: ["is_production_stage", "bool"],
});

export const deadlineProjects = makeTable<DeadlineProjectRecord>("deals_deadline_projects", {
  dealName: ["deal_name", "text"],
  clientName: ["client_name", "text"],
  value: ["value", "num"],
  deadline: ["deadline", "text"],
  status: ["status", "text"],
  completed: ["completed", "bool"],
});

export const emails = makeTable<EmailRecord>("deals_emails", {
  messageId: ["message_id", "text"],
  threadId: ["thread_id", "text"],
  accountEmail: ["account_email", "text"],
  subject: ["subject", "text"],
  fromEmail: ["from_email", "text"],
  fromName: ["from_name", "text"],
  toEmail: ["to_email", "text"],
  date: ["date", "text"],
  dateIso: ["date_iso", "text"],
  snippet: ["snippet", "text"],
  bodyText: ["body_text", "text"],
  bodyHtml: ["body_html", "text"],
  labels: ["labels", "text"],
  attachments: ["attachments", "text"],
  urLs: ["urls", "text"],
  isRead: ["is_read", "bool"],
  isFromMe: ["is_from_me", "bool"],
  historyId: ["history_id", "text"],
});

export const emailAccounts = makeTable<EmailAccountRecord>("deals_email_accounts", {
  email: ["email", "text"],
  displayName: ["display_name", "text"],
  provider: ["provider", "text"],
  refreshToken: ["refresh_token", "text"],
  accessToken: ["access_token", "text"],
  historyId: ["history_id", "text"],
  lastSyncedAt: ["last_synced_at", "text"],
});

export const threadIndex = makeTable<ThreadIndexRecord>("deals_thread_index", {
  threadId: ["thread_id", "text"],
  accountEmail: ["account_email", "text"],
  subject: ["subject", "text"],
  senderName: ["sender_name", "text"],
  senderEmail: ["sender_email", "text"],
  recipientEmail: ["recipient_email", "text"],
  snippet: ["snippet", "text"],
  lastDate: ["last_date", "text"],
  labels: ["labels", "text"],
  messageCount: ["message_count", "num"],
  isRead: ["is_read", "bool"],
});

export const threadBrands = makeTable<ThreadBrandRecord>("deals_thread_brands", {
  threadId: ["thread_id", "text"],
  brandName: ["brand_name", "text"],
  senderDomain: ["sender_domain", "text"],
  senderEmail: ["sender_email", "text"],
  senderName: ["sender_name", "text"],
  subject: ["subject", "text"],
  lastDate: ["last_date", "text"],
  accountEmail: ["account_email", "text"],
});

export const companyResearchCache = makeTable<CompanyResearchRecord>("deals_company_research_cache", {
  companyName: ["company_name", "text"],
  researchData: ["research_data", "text"],
  cachedAt: ["cached_at", "text"],
});

export const aiConfig = makeTable<AiConfigRecord>("deals_ai_config", {
  key: ["key", "text"],
  value: ["value", "text"],
  description: ["description", "text"],
});

export const users = makeTable<UserRecord>("deals_users", {
  email: ["email", "text"],
  firstName: ["first_name", "text"],
  lastName: ["last_name", "text"],
});

/** Stamp "a human (or the agent, via the board API) touched this deal" — see isHumanTouched in scan.ts. */
export function markDealTouched(dealId: string | undefined | null): void {
  if (!dealId) return;
  db.prepare(`UPDATE deals_deals SET human_touched_at = ? WHERE id = ?`).run(nowIso(), dealId);
}

/** Every Deal Organizer table, children before parents (safe delete order). */
export const ALL_TABLES = [
  dealComments, dealActions, dealsTable, stageConfig, deadlineProjects, emails,
  emailAccounts, threadIndex, threadBrands, companyResearchCache, aiConfig, users,
];

/** Parse an email Date header (RFC 2822 or ISO) to ISO, or undefined. */
export function toIsoDate(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/* ── analytics fields + stage history (analytics redesign, 2026-09-30) ────── */

/**
 * New deal fields the Analytics page runs on. All nullable. The AI extraction
 * (dealFields.ts) fills them silently from the deal's email thread; a value a
 * human typed is never overwritten — `fields_source` is a JSON object
 * `{ "<field>": "ai" | "human" }` per field.
 *   agreed_price        USD the brand agreed in writing (whole deal, Shorts included)
 *   slot_month          YYYY-MM the video publishes (revenue counts in this month)
 *   lost_reason         price_below_4k | budget | no_fit | ghosted | timing_capacity |
 *                       format_not_sold | duplicate | not_a_sponsorship | other
 *   deal_type           dedicated | shorts | service_vendor | other
 *   won_at / lost_at    when the deal entered a production / lost stage (trigger below;
 *                       the one-time backfill estimates them from the thread)
 *   fields_dirty        1 = queued for AI extraction (set by the stage trigger + new deals)
 *   fields_extracted_at last AI extraction
 *   fields_evidence     the AI's one-line reason (shown on hover in the workspace)
 */
for (const [col, type] of [
  ["agreed_price", "REAL"],
  ["slot_month", "TEXT"],
  ["lost_reason", "TEXT"],
  ["deal_type", "TEXT"],
  ["won_at", "TEXT"],
  ["lost_at", "TEXT"],
  ["fields_source", "TEXT"],
  ["fields_dirty", "INTEGER"],
  ["fields_extracted_at", "TEXT"],
  ["fields_evidence", "TEXT"],
] as const) addColumn("deals_deals", col, type);

/**
 * Card autofill (2026-09-30) — free-text deadline + its parsed date, and the
 * auto-filled card bookkeeping (see deadlineParse.ts / dealAutofill.ts).
 */
for (const [table, col] of [
  ["deals_deals", "deadline_date"],        // YYYY-MM-DD parsed from `deadline`
  ["deals_deals", "deadline_parsed_from"], // the `deadline` text that date came from
  ["deals_deals", "card_filled_at"],       // last card autofill (NULL = never)
  ["deals_deals", "card_asof"],            // latest email date that fill was based on
  ["deals_deal_actions", "source"],        // 'auto' = written by the autofill
  ["deals_deal_actions", "status_by"],     // 'human' | 'auto'
] as const) addColumn(table, col, "TEXT");

db.exec(`
CREATE TABLE IF NOT EXISTS deals_stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT,
  at TEXT NOT NULL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS deals_stage_events_deal ON deals_stage_events (deal_id, at);

CREATE TABLE IF NOT EXISTS deals_analytics_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week TEXT UNIQUE,
  note TEXT,
  model TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals_fields_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  deals INTEGER,
  filled INTEGER,
  failed INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  note TEXT
);

-- Every stage change, from ANY writer (board, agent via updateDeal, scanner, stage
-- delete/rename sweeps): record it, stamp won_at / lost_at, queue the deal for
-- AI field extraction. Stage groups come from the stage table: production flag =
-- won; the two lost stages are identified by their stable KEYS (display names
-- can be renamed). Entering production clears lost_at; won_at is kept once set.
CREATE TRIGGER IF NOT EXISTS deals_stage_event_on_update
AFTER UPDATE OF stage ON deals_deals
WHEN OLD.stage IS NOT NEW.stage
BEGIN
  INSERT INTO deals_stage_events (deal_id, from_stage, to_stage, at, source)
  VALUES (NEW.id, OLD.stage, NEW.stage, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(NEW.stage_source, 'unknown'));
  UPDATE deals_deals SET
    fields_dirty = 1,
    won_at = CASE
      WHEN won_at IS NULL AND EXISTS (SELECT 1 FROM deals_stage_config WHERE display_name = NEW.stage AND is_production_stage = 1)
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE won_at END,
    lost_at = CASE
      WHEN EXISTS (SELECT 1 FROM deals_stage_config WHERE display_name = NEW.stage AND is_production_stage = 1) THEN NULL
      WHEN lost_at IS NULL AND EXISTS (SELECT 1 FROM deals_stage_config WHERE display_name = NEW.stage AND stage_key IN ('rejected', 'poor_fit_now'))
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE lost_at END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS deals_stage_event_on_insert
AFTER INSERT ON deals_deals
BEGIN
  INSERT INTO deals_stage_events (deal_id, from_stage, to_stage, at, source)
  VALUES (NEW.id, NULL, NEW.stage, COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), COALESCE(NEW.stage_source, NEW.source, 'unknown'));
  UPDATE deals_deals SET fields_dirty = 1 WHERE id = NEW.id;
END;
`);
