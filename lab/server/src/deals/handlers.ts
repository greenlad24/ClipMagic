/**
 * Deal Organizer — Phase 1 endpoints: stages, deals CRUD, merge, production,
 * comments and actions.
 *
 * Each handler is a port of the same-named file in the original app's
 * `src/api/`, with the SAME input schema (zod, as the original declared it) and
 * output shape. Bug-fix pass (2026-09-30, SPEC/server.md §12):
 *   #10 updateDeal clears: "" clears a text field, null clears text/number
 *       fields; absent keys are untouched (partial update).
 *   #11 mergeDeals re-links the duplicate's comments + actions to the kept deal
 *       (one transaction) and records `merged_into` on the duplicate.
 *   #20 one not-archived filter (db.ts NOT_ARCHIVED, NULL = not archived).
 *   #21 deleteStage reassigns EVERY deal in the stage; createStage auto-suffixes
 *       a colliding stageKey and rejects a duplicate display name.
 *   Bookkeeping for the scanner's guards: stage_source / stage_changed_at when a
 *   stage is set through here ('board'), human_touched_at on every edit, move,
 *   comment (non-machine author), action and production move.
 * Additive output fields on a deal (toFE): last_follow_up_sent_at,
 * last_follow_up_drafted_at, review_flag, merged_into.
 */
import { z } from "zod";
import { db } from "../db/index.js";
import {
  deals,
  dealComments,
  dealActions,
  stageConfig,
  deadlineProjects,
  NOT_ARCHIVED,
  MACHINE_AUTHORS,
  markDealTouched,
  type DealRecord,
} from "./db.js";
import { loadStageConfig, persistRenameStage, buildFallbackResult } from "./stageUtils.js";
// Analytics redesign (additive): the AI/human analytics fields on every deal response;
// stage events + won_at/lost_at are written by the db.ts trigger on ANY stage change.
import { readDealFields, readDealFieldsMany, applyHumanFields, type DealFields } from "./dealFields.js";
// Card autofill (2026-09-30): typed card fields win over the AI; free-text deadline → deadline_date.
import { markHumanCardFields, markActionHuman } from "./dealAutofill.js";
import { refreshDeadlineDate } from "./deadlineParse.js";

/** toFE + the analytics fields (agreed_price, slot_month, lost_reason, deal_type, won_at, lost_at, fields_source…). */
function withFields<T extends { id: string }>(fe: T, f?: DealFields): T & DealFields {
  return { ...fe, ...(f ?? readDealFields(fe.id)) };
}

export type Handler = (input: any) => Promise<unknown> | unknown;

/** Zite's ZiteError({code}) → an HTTP status the router understands. */
function ziteError(code: "NOT_FOUND" | "BAD_REQUEST", message: string): Error {
  return Object.assign(new Error(message), { status: code === "NOT_FOUND" ? 404 : 400, code });
}

/** Validate `input` against the original endpoint's inputSchema (400 on failure). */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw Object.assign(new Error(msg), { status: 400 });
  }
  return r.data;
}


/* ── getDeals.ts: FALLBACK_STAGE_FROM_DB + toFE ───────────────────────────── */

// Fallback mapping for cases where stage config isn't loaded (keeps backward compat)
export const FALLBACK_STAGE_FROM_DB: Record<string, string> = {
  'Rejected': 'rejected', 'Poor Fit Now': 'poor_fit_now',
  'To Follow Up With': 'to_follow_up_with', 'New Requests': 'new_requests',
  'Potential Future Collaboration': 'potential_future_collaboration',
  'Started Negotiation (But Did Not Answer)': 'started_negotiation_no_answer',
  'Date/Contract Negotiation': 'contract_negotiation',
  'Waiting For Invoice': 'waiting_for_invoice', 'Waiting For Payment': 'waiting_for_payment',
  'Contract Signed': 'contract_signed', 'Created Invoice & Sent': 'invoice_created_sent',
  'In Research': 'in_research', 'Need To Script': 'need_to_script',
  'Script In Review': 'script_in_review', 'Script Fixes': 'script_fixes',
  'Need To Film (Script Confirmed)': 'need_to_film', 'In Video Editing': 'in_video_editing',
  'Video Draft Submitted': 'video_draft_submitted',
  'Reviewed & Require Fixes': 'reviewed_require_fixes',
  'Video Fixed Sent': 'video_fixed_sent', '2nd Review': 'second_review',
  'Video Ready For Publish': 'video_ready_publish',
  '2nd Invoice Sent': 'second_invoice_sent', '2nd Invoice Paid': 'second_invoice_paid',
  'Completed': 'completed',
};

export function toFE(r: DealRecord, fromDB?: Record<string, string>) {
  const stageMap = fromDB ?? FALLBACK_STAGE_FROM_DB;
  const ca = r.dealComments, aa = r.dealActions;
  return {
    id: r.id,
    client_name: r.clientName ?? '',
    client_email: r.clientEmail ?? '',
    project_name: r.projectName ?? null,
    description: r.description ?? null,
    estimated_value: r.estimatedValue ?? null,
    currency: r.currency ?? 'USD',
    stage: stageMap[r.stage ?? ''] ?? r.stage ?? 'new_requests',
    confidence: r.confidence ? r.confidence.toLowerCase() : null,
    source: r.source ?? null,
    source_email_id: r.sourceEmailId ?? null,
    source_thread_id: r.sourceThreadId ?? null,
    archived: r.archived ?? false,
    comment_count: Array.isArray(ca) ? ca.length : (ca ? 1 : 0),
    action_count: Array.isArray(aa) ? aa.length : (aa ? 1 : 0),
    about: r.about ?? null,
    opportunity: r.opportunity ?? null,
    key_details: r.keyDetails ?? null,
    contact_info: r.contactInfo ?? null,
    links_text: r.links ?? null,
    files_text: r.files ?? null,
    next_steps: r.nextSteps ?? null,
    thread_link: r.threadLink ?? null,
    last_scanned_at: r.lastScannedAt ?? null,
    deadline: r.deadline ?? null,
    // Additive (2026-09-30): the date parsed from the free-text deadline (YYYY-MM-DD) —
    // sort / group / count down on this, show `deadline` as the label.
    deadline_date: r.deadlineDate ?? null,
    deadline_parsed_from: r.deadlineParsedFrom ?? null, // the text deadline_date was read from
    card_asof: r.cardAsof ?? null,            // latest email the auto-filled card is based on
    card_filled_at: r.cardFilledAt ?? null,
    in_production: r.inProduction ?? false,
    // Added in the bug-fix pass (additive):
    last_follow_up_sent_at: r.lastFollowUpSentAt ?? null,     // a follow-up was SEEN sent in the thread
    last_follow_up_drafted_at: r.lastFollowUpDraftedAt ?? null, // a follow-up draft was saved (not sent)
    review_flag: r.reviewFlag ?? null,                          // scanner asks a human to look (e.g. "looks like a non-deal")
    merged_into: r.mergedInto ?? null,                          // set on a duplicate archived by mergeDeals
  };
}

/** Promise.allSettled over sync-or-async thunks (a throwing DB read → rejected). */
const settle = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn);

/* ── stageUtils (endpoint) ────────────────────────────────────────────────── */

const stageUtils: Handler = async (input) => {
  parse(z.object({}), input);
  const result = await loadStageConfig();
  return { count: result.records.length };
};

/* ── getStages ────────────────────────────────────────────────────────────── */

const getStages: Handler = async (input) => {
  parse(z.object({}), input);
  const { records } = await loadStageConfig();
  return {
    stages: records.map(r => ({
      key: r.stageKey ?? '',
      displayName: r.displayName ?? '',
      shortName: r.shortName ?? '',
      cssVariable: r.cssVariable ?? '',
      sortOrder: r.sortOrder ?? 0,
      isProduction: r.isProductionStage ?? false,
    })),
  };
};

/* ── createStage ──────────────────────────────────────────────────────────── */

const createStage: Handler = async (raw) => {
  const input = parse(z.object({ name: z.string(), isProduction: z.boolean(), atIndex: z.number() }), raw);
  const name = input.name.trim();
  if (!name) throw ziteError('BAD_REQUEST', 'Stage name is required');

  // Get existing records (all groups) — needed for the collision checks below
  const records = stageConfig.all(1000);

  // Deals store the stage DISPLAY NAME, so two stages with one name would share their deals.
  if (records.some(r => (r.displayName ?? '').trim().toLowerCase() === name.toLowerCase())) {
    throw ziteError('BAD_REQUEST', `A stage named "${name}" already exists`);
  }
  // stageKey collision (bug 21): auto-suffix _2, _3, … (the key is internal; the name is what the user sees)
  const baseKey = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'stage';
  const takenKeys = new Set(records.map(r => r.stageKey).filter(Boolean));
  let stageKey = baseKey;
  for (let n = 2; takenKeys.has(stageKey); n++) stageKey = `${baseKey}_${n}`;

  const groupRecords = records
    .filter(r => r.isProductionStage === input.isProduction)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

  // Compute a fractional sortOrder to insert at atIndex
  let newSortOrder: number;
  if (groupRecords.length === 0) {
    newSortOrder = 10;
  } else if (input.atIndex <= 0) {
    newSortOrder = (groupRecords[0].sortOrder ?? 10) - 5;
  } else if (input.atIndex >= groupRecords.length) {
    newSortOrder = (groupRecords[groupRecords.length - 1].sortOrder ?? 10) + 10;
  } else {
    const before = groupRecords[input.atIndex - 1].sortOrder ?? 0;
    const after = groupRecords[input.atIndex].sortOrder ?? before + 20;
    newSortOrder = (before + after) / 2;
  }

  const record = stageConfig.insert({
    stageKey,
    displayName: name,
    shortName: name,
    cssVariable: 'custom',
    sortOrder: newSortOrder,
    isProductionStage: input.isProduction,
  });

  // Normalize sortOrder for the whole group to clean integers
  const allGroupRecords = [
    ...groupRecords.filter(r => r.stageKey !== stageKey),
    record,
  ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));

  allGroupRecords.forEach((r, idx) => stageConfig.update(r.id, { sortOrder: (idx + 1) * 10 }));

  return {
    stage: {
      key: record.stageKey ?? stageKey,
      displayName: record.displayName ?? name,
      shortName: record.shortName ?? name,
      cssVariable: record.cssVariable ?? 'custom',
      sortOrder: (allGroupRecords.findIndex(r => r.stageKey === stageKey) + 1) * 10,
      isProduction: record.isProductionStage ?? input.isProduction,
    },
  };
};

/* ── renameStage ──────────────────────────────────────────────────────────── */

const renameStage: Handler = async (raw) => {
  const input = parse(z.object({ stageKey: z.string(), newDisplayName: z.string() }), raw);
  const clash = stageConfig.all(1000).find(r =>
    r.stageKey !== input.stageKey && (r.displayName ?? '').trim().toLowerCase() === input.newDisplayName.trim().toLowerCase());
  // Renaming onto another stage's name would silently merge the two stages' deals.
  if (clash) throw ziteError('BAD_REQUEST', `Another stage is already named "${clash.displayName}"`);
  const updatedDealsCount = await persistRenameStage(input.stageKey, input.newDisplayName);
  return { updatedDealsCount };
};

/* ── reorderStages ────────────────────────────────────────────────────────── */

const reorderStages: Handler = async (raw) => {
  const input = parse(z.object({ orderedKeys: z.array(z.string()) }), raw);
  const records = stageConfig.all(200);
  const recordMap = new Map(records.map(r => [r.stageKey, r]));

  input.orderedKeys.forEach((key, idx) => {
    const record = recordMap.get(key);
    if (record) stageConfig.update(record.id, { sortOrder: (idx + 1) * 10 });
  });

  return { success: true };
};

/* ── deleteStage ──────────────────────────────────────────────────────────── */

const deleteStage: Handler = async (raw) => {
  const input = parse(z.object({ stageKey: z.string() }), raw);
  // Find the stage record to delete
  const allStages = stageConfig.all(200);
  const target = allStages.find(r => r.stageKey === input.stageKey);
  if (!target) throw new Error(`Stage "${input.stageKey}" not found`);

  // Find the fallback stage — first stage in the same group (excluding the one being deleted)
  const sameGroup = allStages
    .filter(r => r.isProductionStage === target.isProductionStage && r.stageKey !== input.stageKey)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  const fallback = sameGroup[0] ?? null;

  // Load stage config to convert stageKey to DB display name
  const stageConfigResult = await loadStageConfig().catch(() => null);
  const toDB = stageConfigResult?.toDB ?? {};

  // Reassign EVERY deal in this stage (bug 21: was the first 500 active ones) —
  // archived deals too, so none is left pointing at a stage that no longer exists.
  const dbStageValue = toDB[input.stageKey] ?? target.displayName ?? input.stageKey;
  const inStage = (db.prepare(`SELECT COUNT(*) AS n FROM deals_deals WHERE stage = ?`).get(dbStageValue) as { n: number }).n;
  if (!fallback && inStage > 0) {
    throw ziteError('BAD_REQUEST', `Cannot delete the last ${target.isProductionStage ? 'production' : 'pipeline'} stage while ${inStage} deal(s) are in it`);
  }
  let reassignedCount = 0;
  db.transaction(() => {
    if (fallback && inStage > 0) {
      const fallbackDbValue = toDB[fallback.stageKey ?? ''] ?? fallback.displayName ?? fallback.stageKey ?? '';
      const now = new Date().toISOString();
      reassignedCount = db.prepare(`UPDATE deals_deals SET stage = ?, stage_changed_at = ?, updated_at = ? WHERE stage = ?`)
        .run(fallbackDbValue, now, now, dbStageValue).changes;
    }
    // Delete the stage config record
    stageConfig.remove(target.id);
  })();

  return {
    success: true,
    reassignedCount,
    fallbackStageKey: fallback?.stageKey ?? null,
  };
};

/* ── getDeals ─────────────────────────────────────────────────────────────── */

const getDeals: Handler = async (input) => {
  parse(z.object({}), input);
  // Use allSettled so a stageConfig failure never blocks deal loading
  const [stageResult, dealsResult] = await Promise.allSettled([
    loadStageConfig(),
    // (was LIMIT 500 oldest-first: past 500 active deals the newest never showed)
    settle(() => deals.where(`${NOT_ARCHIVED} ORDER BY created_at, rowid LIMIT 10000`)),
  ]);
  const fromDB = stageResult.status === 'fulfilled' ? stageResult.value.fromDB : FALLBACK_STAGE_FROM_DB;
  const records = dealsResult.status === 'fulfilled' ? dealsResult.value : [];
  const fields = readDealFieldsMany(records.map(r => r.id));
  return { deals: records.map(r => withFields(toFE(r, fromDB), fields.get(r.id))) };
};

/* ── getDeal ──────────────────────────────────────────────────────────────── */

const getDeal: Handler = async (raw) => {
  const input = parse(z.object({ id: z.string() }), raw);
  const [stageResult, r] = await Promise.allSettled([
    loadStageConfig(),
    settle(() => deals.get(input.id)),
  ]);
  const fromDB = stageResult.status === 'fulfilled' ? stageResult.value.fromDB : FALLBACK_STAGE_FROM_DB;
  const record = r.status === 'fulfilled' ? r.value : undefined;
  if (!record) throw new Error('Deal not found');
  return { deal: withFields(toFE(record, fromDB)) };
};

/* ── createDeal ───────────────────────────────────────────────────────────── */

const createDeal: Handler = async (raw) => {
  const input = parse(z.object({
    client_name: z.string(),
    client_email: z.string(),
    project_name: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    estimated_value: z.number().nullable().optional(),
    currency: z.string().optional(),
    stage: z.string().optional(),
    confidence: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    source_email_id: z.string().nullable().optional(),
    source_thread_id: z.string().nullable().optional(),
  }), raw);
  const stageResult = await loadStageConfig().catch(() => null);
  const toDB = stageResult?.toDB ?? {};
  const fromDB = stageResult?.fromDB ?? FALLBACK_STAGE_FROM_DB;
  const stageKey = input.stage ?? 'new_requests';
  const record = deals.insert({
    clientName: input.client_name,
    clientEmail: input.client_email,
    projectName: input.project_name ?? undefined,
    description: input.description ?? undefined,
    estimatedValue: input.estimated_value ?? undefined,
    currency: input.currency ?? 'USD',
    stage: toDB[stageKey] ?? 'New Requests',
    confidence: input.confidence ? (input.confidence.charAt(0).toUpperCase() + input.confidence.slice(1)) : undefined,
    source: input.source ?? 'manual',
    sourceEmailId: input.source_email_id ?? undefined,
    sourceThreadId: input.source_thread_id ?? undefined,
    archived: false,
    stageSource: 'board',
    stageChangedAt: new Date().toISOString(),
    // A deal made by hand is human-curated; the agent's / scanner's own creations are not.
    ...(['agent', 'gmail'].includes(input.source ?? 'manual') ? {} : { humanTouchedAt: new Date().toISOString() }),
  });
  return { deal: toFE(record, fromDB) };
};

/* ── updateDeal ───────────────────────────────────────────────────────────── */

/**
 * Partial-update semantics (bug 10): an ABSENT key leaves the field alone; ""
 * (or whitespace) and null CLEAR it; anything else is stored trimmed.
 * (The original skipped "" — so a field could never be emptied.)
 */
const fieldVal = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v.trim() === '') return null;
  return v.trim();
};

const updateDeal: Handler = async (raw) => {
  const input = parse(z.object({
    id: z.string(),
    updates: z.object({
      client_name: z.string().optional(),
      client_email: z.string().optional(),
      project_name: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      estimated_value: z.number().nullable().optional(),
      currency: z.string().optional(),
      stage: z.string().optional(),
      confidence: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      archived: z.boolean().optional(),
      about: z.string().nullable().optional(),
      opportunity: z.string().nullable().optional(),
      key_details: z.string().nullable().optional(),
      contact_info: z.string().nullable().optional(),
      links_text: z.string().nullable().optional(),
      files_text: z.string().nullable().optional(),
      next_steps: z.string().nullable().optional(),
      thread_link: z.string().nullable().optional(),
      last_scanned_at: z.string().nullable().optional(),
      deadline: z.string().nullable().optional(),
      in_production: z.boolean().optional(),
      review_flag: z.string().nullable().optional(), // additive: "" / null dismisses the scanner's flag
      // Analytics fields (additive). Typed here = "human": the AI never overwrites them.
      agreed_price: z.number().nullable().optional(),
      slot_month: z.string().nullable().optional(),
      lost_reason: z.string().nullable().optional(),
      deal_type: z.string().nullable().optional(),
    }),
  }), raw);
  const stageResult = await loadStageConfig().catch(() => null);
  const toDB = stageResult?.toDB ?? {};
  const fromDB = stageResult?.fromDB ?? FALLBACK_STAGE_FROM_DB;
  const current = deals.get(input.id);
  if (!current) throw ziteError('NOT_FOUND', 'Deal not found');
  const u = input.updates;
  const record: Record<string, unknown> = {};
  const set = (field: string, v: string | null | undefined) => { if (v !== undefined) record[field] = v; };

  // Text fields: absent = untouched, "" / null = cleared.
  set('clientName', fieldVal(u.client_name));
  set('clientEmail', fieldVal(u.client_email));
  set('currency', fieldVal(u.currency));
  set('projectName', fieldVal(u.project_name));
  set('source', fieldVal(u.source));
  set('description', fieldVal(u.description));
  set('about', fieldVal(u.about));
  set('opportunity', fieldVal(u.opportunity));
  set('keyDetails', fieldVal(u.key_details));
  set('contactInfo', fieldVal(u.contact_info));
  set('links', fieldVal(u.links_text));
  set('files', fieldVal(u.files_text));
  set('nextSteps', fieldVal(u.next_steps));
  set('threadLink', fieldVal(u.thread_link));
  set('deadline', fieldVal(u.deadline));
  set('lastScannedAt', fieldVal(u.last_scanned_at));
  set('reviewFlag', fieldVal(u.review_flag));
  // Numbers: null clears.
  if (u.estimated_value !== undefined) record.estimatedValue = u.estimated_value;
  // Confidence: "" / null clears; otherwise capitalised as before.
  if (u.confidence !== undefined) {
    const c = fieldVal(u.confidence);
    record.confidence = c ? c.charAt(0).toUpperCase() + c.slice(1) : null;
  }
  if (u.stage !== undefined && u.stage.trim() !== '') {
    const next = toDB[u.stage] ?? u.stage;
    record.stage = next;
    if (next !== current.stage) {
      record.stageSource = 'board';
      record.stageChangedAt = new Date().toISOString();
    }
  }
  if (u.archived !== undefined) record.archived = u.archived;
  if (u.in_production !== undefined) record.inProduction = u.in_production;
  // Every edit through the board (the UI, or the agent's board move) marks the deal as curated.
  record.humanTouchedAt = new Date().toISOString();

  applyHumanFields(input.id, { agreed_price: u.agreed_price, slot_month: u.slot_month, lost_reason: u.lost_reason, deal_type: u.deal_type }); // validates first (400)
  deals.update(input.id, record);
  // Card fields typed here are the human's from now on (the autofill never overwrites them).
  markHumanCardFields(input.id, u as Record<string, unknown>);
  // A changed deadline text → its date now (deterministic); an ambiguous one is refined by AI in the background.
  if (u.deadline !== undefined && (record.deadline ?? null) !== (current.deadline ?? null)) {
    try { refreshDeadlineDate(input.id, { typed: true, log: (m) => console.log(`[deals] ${m}`) }); }
    catch (e: any) { console.warn(`[deals] deadline parse failed: ${e?.message ?? e}`); }
  }
  const updated = deals.get(input.id);
  return { deal: withFields(toFE(updated!, fromDB)) };
};

/* ── mergeDeals ───────────────────────────────────────────────────────────── */

// Pick the most complete text: prefer the longer non-empty value
function bestText(a: string | undefined | null, b: string | undefined | null): string | undefined {
  const av = (a ?? '').trim();
  const bv = (b ?? '').trim();
  if (!av && !bv) return undefined;
  if (!av) return bv;
  if (!bv) return av;
  // Prefer the longer (more detailed) value
  return av.length >= bv.length ? av : bv;
}

// Merge two list-style fields (links, files) — combine and deduplicate lines/entries
function mergeListField(a: string | undefined | null, b: string | undefined | null): string | undefined {
  const av = (a ?? '').trim();
  const bv = (b ?? '').trim();
  if (!av && !bv) return undefined;
  if (!av) return bv;
  if (!bv) return av;
  // Split on newlines or commas, deduplicate, rejoin
  const splitRe = /[\n,]+/;
  const entries = [
    ...av.split(splitRe),
    ...bv.split(splitRe),
  ]
    .map(s => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const e of entries) {
    const key = e.toLowerCase();
    if (!seen.has(key)) { seen.add(key); unique.push(e); }
  }
  return unique.join('\n');
}

const mergeDeals: Handler = async (raw) => {
  const input = parse(z.object({
    keepId: z.string(),  // deal to keep (the one the user has open)
    mergeId: z.string(), // duplicate deal to archive
  }), raw);
  const keep = deals.get(input.keepId);
  const dupe = deals.get(input.mergeId);

  if (!keep) throw ziteError('NOT_FOUND', 'Primary deal not found');
  if (!dupe) throw ziteError('NOT_FOUND', 'Duplicate deal not found');
  if (input.keepId === input.mergeId) throw ziteError('BAD_REQUEST', 'Cannot merge a deal with itself');

  const mergedRecord = {
    // Identity — prefer keep, fall back to dupe
    clientName:  keep.clientName  || dupe.clientName,
    clientEmail: keep.clientEmail || dupe.clientEmail,
    projectName: bestText(keep.projectName, dupe.projectName),
    description: bestText(keep.description, dupe.description),

    // Value — keep the larger of the two (more likely to be accurate/final)
    estimatedValue: (() => {
      const kv = keep.estimatedValue ?? 0;
      const dv = dupe.estimatedValue ?? 0;
      return (kv >= dv ? kv : dv) || undefined;
    })(),
    currency: keep.currency || dupe.currency,

    // Stage / confidence — ALWAYS keep the keep deal's values (user-managed)
    stage:      keep.stage      || dupe.stage,
    confidence: keep.confidence || dupe.confidence,

    // Source metadata — keep wins; fill from dupe if missing
    source:         keep.source         || dupe.source,
    sourceEmailId:  keep.sourceEmailId  || dupe.sourceEmailId,
    sourceThreadId: keep.sourceThreadId || dupe.sourceThreadId,

    // Structured text fields — pick the most complete (longer) version
    about:       bestText(keep.about,       dupe.about),
    opportunity: bestText(keep.opportunity, dupe.opportunity),
    keyDetails:  bestText(keep.keyDetails,  dupe.keyDetails),
    contactInfo: bestText(keep.contactInfo, dupe.contactInfo),
    nextSteps:   bestText(keep.nextSteps,   dupe.nextSteps),
    threadLink:  keep.threadLink || dupe.threadLink,

    // Links & files — COMBINE both (deduplicated)
    links: mergeListField(keep.links, dupe.links),
    files: mergeListField(keep.files, dupe.files),

    // Deadline — keep's value is protected; only fill if keep has none
    deadline: keep.deadline || dupe.deadline,

    lastScannedAt: new Date().toISOString(),

    // Production flag — keep if either was in production
    inProduction: keep.inProduction || dupe.inProduction,
  };

  // One transaction: update the kept deal, move the duplicate's comments and
  // actions onto it (bug 11), note the duplicate's thread if it differs, and
  // archive the duplicate with `merged_into` (so analytics can tell a merge
  // from a lost deal). Emails / thread index / brands are not linked to deals
  // by id (only by thread / address), so there is nothing else to re-link.
  const now = new Date().toISOString();
  db.transaction(() => {
    deals.update(input.keepId, { ...mergedRecord, humanTouchedAt: now });
    db.prepare(`UPDATE deals_deal_comments SET deal_id = ?, updated_at = ? WHERE deal_id = ?`).run(input.keepId, now, input.mergeId);
    db.prepare(`UPDATE deals_deal_actions SET deal_id = ?, updated_at = ? WHERE deal_id = ?`).run(input.keepId, now, input.mergeId);
    if (dupe.sourceThreadId && dupe.sourceThreadId !== mergedRecord.sourceThreadId) {
      dealComments.insert({
        content: `Merged in "${dupe.projectName || dupe.clientName || 'duplicate'}" (${dupe.clientEmail || 'no email'}). Its thread: ${dupe.threadLink || `https://mail.google.com/mail/u/0/#all/${dupe.sourceThreadId}`}`,
        author: 'System',
        deal: input.keepId,
      });
    }
    deals.update(input.mergeId, { archived: true, mergedInto: input.keepId });
  })();

  const [stageResult, updated] = await Promise.allSettled([
    loadStageConfig(),
    settle(() => deals.get(input.keepId)),
  ]);
  const fromDB = stageResult.status === 'fulfilled' ? stageResult.value.fromDB : FALLBACK_STAGE_FROM_DB;
  const record = updated.status === 'fulfilled' ? updated.value : undefined;
  return { deal: toFE(record!, fromDB) };
};

/* ── addDealToProduction ──────────────────────────────────────────────────── */

const addDealToProduction: Handler = async (raw) => {
  const input = parse(z.object({ dealId: z.string() }), raw);
  const [stageResult, dealResult] = await Promise.allSettled([
    loadStageConfig(),
    settle(() => deals.get(input.dealId)),
  ]);
  const { prodDbNames, toDB, fromDB } = stageResult.status === 'fulfilled'
    ? stageResult.value
    : buildFallbackResult();
  const current = dealResult.status === 'fulfilled' ? dealResult.value : undefined;
  if (!current) throw ziteError('NOT_FOUND', 'Deal not found');

  const now = new Date().toISOString();
  const record: Record<string, unknown> = { inProduction: true, humanTouchedAt: now };
  // Default to "In Research" if not already in a production stage
  if (!prodDbNames.has(current.stage ?? '')) {
    record.stage = toDB['in_research'] ?? 'In Research';
    record.stageSource = 'board';
    record.stageChangedAt = now;
  }

  deals.update(input.dealId, record);
  const updated = deals.get(input.dealId);
  return { deal: toFE(updated!, fromDB) };
};

/* ── getDeadlineProjects (reads DEALS in production, not deadline_projects) ─ */

const getDeadlineProjects: Handler = async (input) => {
  parse(z.object({}), input);
  const [stageResult, dealsResult] = await Promise.allSettled([
    loadStageConfig(),
    settle(() => deals.where(`in_production = 1 AND ${NOT_ARCHIVED} ORDER BY created_at, rowid LIMIT 10000`)),
  ]);
  const fromDB = stageResult.status === 'fulfilled' ? stageResult.value.fromDB : FALLBACK_STAGE_FROM_DB;
  const records = dealsResult.status === 'fulfilled' ? dealsResult.value : [];
  return { deals: records.map(r => toFE(r, fromDB)) };
};

/* ── createDeadlineProject / updateDeadlineProject ────────────────────────── */

const createDeadlineProject: Handler = async (raw) => {
  const input = parse(z.object({
    dealName: z.string(),
    clientName: z.string().optional(),
    value: z.number().optional(),
    deadline: z.string().optional(),
    status: z.string().optional(),
  }), raw);
  const record = deadlineProjects.insert({
    dealName: input.dealName,
    clientName: input.clientName,
    value: input.value,
    deadline: input.deadline,
    status: input.status ?? 'In Research',
    completed: false,
  });
  return {
    id: record.id,
    dealName: record.dealName ?? input.dealName,
    clientName: record.clientName,
    value: record.value,
    deadline: record.deadline,
    status: record.status ?? 'In Research',
    completed: false,
  };
};

const updateDeadlineProject: Handler = async (raw) => {
  const input = parse(z.object({
    id: z.string(),
    dealName: z.string().optional(),
    clientName: z.string().optional(),
    value: z.number().optional(),
    deadline: z.string().optional(),
    status: z.string().optional(),
    completed: z.boolean().optional(),
  }), raw);
  const { id, ...fields } = input;
  const record: Record<string, any> = {};
  if (fields.dealName !== undefined) record.dealName = fields.dealName;
  if (fields.clientName !== undefined) record.clientName = fields.clientName;
  if (fields.value !== undefined) record.value = fields.value;
  if (fields.deadline !== undefined) record.deadline = fields.deadline;
  if (fields.status !== undefined) record.status = fields.status;
  if (fields.completed !== undefined) record.completed = fields.completed;
  deadlineProjects.update(id, record);
  return { success: true };
};

/* ── comments ─────────────────────────────────────────────────────────────── */

const addComment: Handler = async (raw) => {
  const input = parse(z.object({ dealId: z.string(), content: z.string(), author: z.string().optional() }), raw);
  const record = dealComments.insert({ content: input.content, author: input.author ?? 'You', deal: input.dealId });
  if (!MACHINE_AUTHORS.has(record.author ?? 'You')) markDealTouched(input.dealId);
  return { comment: { id: record.id, content: record.content ?? '', author: record.author ?? 'You' } };
};

const getComments: Handler = async (raw) => {
  const input = parse(z.object({ dealId: z.string() }), raw);
  const records = dealComments.where('deal_id = ? ORDER BY created_at, rowid LIMIT 200', input.dealId);
  return {
    comments: records.map(r => ({
      id: r.id,
      content: r.content ?? '',
      author: r.author ?? 'You',
    })),
  };
};

/* ── actions ──────────────────────────────────────────────────────────────── */

const STATUS_FROM_DB: Record<string, string> = { Pending: 'pending', 'In Progress': 'in_progress', Done: 'done' };
const STATUS_TO_DB: Record<string, string> = { pending: 'Pending', in_progress: 'In Progress', done: 'Done' };

const addAction: Handler = async (raw) => {
  const input = parse(z.object({ dealId: z.string(), content: z.string() }), raw);
  const record = dealActions.insert({ content: input.content, status: 'Pending', deal: input.dealId });
  markDealTouched(input.dealId);
  return { action: { id: record.id, content: record.content ?? '', status: 'pending' } };
};

const getActions: Handler = async (raw) => {
  const input = parse(z.object({ dealId: z.string() }), raw);
  const records = dealActions.where('deal_id = ? ORDER BY created_at, rowid LIMIT 200', input.dealId);
  return {
    actions: records.map(r => ({
      id: r.id,
      content: r.content ?? '',
      status: STATUS_FROM_DB[r.status ?? ''] ?? 'pending',
      // Additive: 'auto' = kept by the email autofill (dealAutofill.ts); statusBy 'auto' = it ticked it.
      source: r.source ?? null,
      status_by: r.statusBy ?? null,
      updated_at: r.updatedAt ?? null,
    })),
  };
};

const updateActionStatus: Handler = async (raw) => {
  const input = parse(z.object({ id: z.string(), status: z.enum(['pending', 'in_progress', 'done']) }), raw);
  dealActions.update(input.id, { status: STATUS_TO_DB[input.status] ?? 'Pending' });
  markActionHuman(input.id); // the autofill never changes a status Jake set
  markDealTouched(dealActions.get(input.id)?.deal);
  return { success: true };
};

export const HANDLERS: Record<string, Handler> = {
  stageUtils,
  getStages,
  createStage,
  renameStage,
  reorderStages,
  deleteStage,
  getDeals,
  getDeal,
  createDeal,
  updateDeal,
  mergeDeals,
  addDealToProduction,
  getDeadlineProjects,
  createDeadlineProject,
  updateDeadlineProject,
  addComment,
  getComments,
  addAction,
  getActions,
  updateActionStatus,
};
