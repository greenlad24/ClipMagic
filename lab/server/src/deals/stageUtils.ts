/**
 * Deal Organizer — stage system. A straight port of the original
 * `src/api/stageUtils.ts`: the default stage table, `loadStageConfig()` (seeds
 * the defaults into an empty table only — a deleted stage stays deleted) and
 * `persistRenameStage()`.
 *
 * Deals store the stage DISPLAY NAME; `fromDB` / `toDB` translate between that
 * and the frontend stage key.
 */
import { db } from "../db/index.js";
import { stageConfig, type StageConfigRecord } from "./db.js";

/**
 * Default stage configuration — displayName MUST match what's stored in Deals.stage.
 * Auto-seeded into the StageConfig DB table on first use.
 */
export const DEFAULT_STAGE_CONFIG: Array<{
  stageKey: string; displayName: string; shortName: string;
  cssVariable: string; sortOrder: number; isProductionStage: boolean;
}> = [
  { stageKey: 'rejected',                       displayName: 'Rejected',                                 shortName: 'Rejected',      cssVariable: 'rejected',        sortOrder: 1,  isProductionStage: false },
  { stageKey: 'poor_fit_now',                   displayName: 'Poor Fit Now',                             shortName: 'Poor Fit',      cssVariable: 'poor-fit',        sortOrder: 2,  isProductionStage: false },
  { stageKey: 'to_follow_up_with',              displayName: 'To Follow Up With',                        shortName: 'Follow Up',     cssVariable: 'follow-up',       sortOrder: 3,  isProductionStage: false },
  { stageKey: 'new_requests',                   displayName: 'New Requests',                             shortName: 'New',           cssVariable: 'new-requests',    sortOrder: 4,  isProductionStage: false },
  { stageKey: 'potential_future_collaboration', displayName: 'Potential Future Collaboration',            shortName: 'Future Collab', cssVariable: 'future-collab',   sortOrder: 5,  isProductionStage: false },
  { stageKey: 'started_negotiation_no_answer',  displayName: 'Started Negotiation (But Did Not Answer)', shortName: 'No Answer',     cssVariable: 'no-answer',       sortOrder: 6,  isProductionStage: false },
  { stageKey: 'contract_negotiation',           displayName: 'Date/Contract Negotiation',                shortName: 'Negotiation',   cssVariable: 'negotiation',     sortOrder: 7,  isProductionStage: false },
  { stageKey: 'waiting_for_invoice',            displayName: 'Waiting For Invoice',                      shortName: 'Invoice',       cssVariable: 'invoice',         sortOrder: 8,  isProductionStage: false },
  { stageKey: 'waiting_for_payment',            displayName: 'Waiting For Payment',                      shortName: 'Payment',       cssVariable: 'payment',         sortOrder: 9,  isProductionStage: false },
  { stageKey: 'contract_signed',                displayName: 'Contract Signed',                          shortName: 'Signed',        cssVariable: 'contract-signed', sortOrder: 10, isProductionStage: true  },
  { stageKey: 'invoice_created_sent',           displayName: 'Created Invoice & Sent',                   shortName: 'Invoice Sent',  cssVariable: 'invoice-sent',    sortOrder: 11, isProductionStage: true  },
  { stageKey: 'in_research',                    displayName: 'In Research',                              shortName: 'Research',      cssVariable: 'research',        sortOrder: 12, isProductionStage: true  },
  { stageKey: 'need_to_script',                 displayName: 'Need To Script',                           shortName: 'To Script',     cssVariable: 'scripting',       sortOrder: 13, isProductionStage: true  },
  { stageKey: 'script_in_review',               displayName: 'Script In Review',                         shortName: 'Script Review', cssVariable: 'script-review',   sortOrder: 14, isProductionStage: true  },
  { stageKey: 'script_fixes',                   displayName: 'Script Fixes',                             shortName: 'Script Fixes',  cssVariable: 'script-fixes',    sortOrder: 15, isProductionStage: true  },
  { stageKey: 'need_to_film',                   displayName: 'Need To Film (Script Confirmed)',           shortName: 'To Film',       cssVariable: 'filming',         sortOrder: 16, isProductionStage: true  },
  { stageKey: 'in_video_editing',               displayName: 'In Video Editing',                         shortName: 'Editing',       cssVariable: 'video-editing',   sortOrder: 17, isProductionStage: true  },
  { stageKey: 'video_draft_submitted',          displayName: 'Video Draft Submitted',                    shortName: 'Draft',         cssVariable: 'draft',           sortOrder: 18, isProductionStage: true  },
  { stageKey: 'reviewed_require_fixes',         displayName: 'Reviewed & Require Fixes',                 shortName: 'Need Fixes',    cssVariable: 'need-fixes',      sortOrder: 19, isProductionStage: true  },
  { stageKey: 'video_fixed_sent',               displayName: 'Video Fixed Sent',                         shortName: 'Fix Sent',      cssVariable: 'video-fixed',     sortOrder: 20, isProductionStage: true  },
  { stageKey: 'second_review',                  displayName: '2nd Review',                               shortName: '2nd Review',    cssVariable: 'second-review',   sortOrder: 21, isProductionStage: true  },
  { stageKey: 'video_ready_publish',            displayName: 'Video Ready For Publish',                  shortName: 'Ready',         cssVariable: 'ready-publish',   sortOrder: 22, isProductionStage: true  },
  { stageKey: 'second_invoice_sent',            displayName: '2nd Invoice Sent',                         shortName: '2nd Invoice',   cssVariable: 'second-invoice',  sortOrder: 23, isProductionStage: true  },
  { stageKey: 'second_invoice_paid',            displayName: '2nd Invoice Paid',                         shortName: '2nd Paid',      cssVariable: 'second-paid',     sortOrder: 24, isProductionStage: true  },
  { stageKey: 'completed',                      displayName: 'Completed',                                shortName: 'Completed',     cssVariable: 'completed',       sortOrder: 25, isProductionStage: true  },
];

export type StageConfigResult = {
  /** Maps displayName (stored in Deals.stage) → stageKey (frontend key like 'contract_signed') */
  fromDB: Record<string, string>;
  /** Maps stageKey → displayName (what to write to Deals.stage) */
  toDB: Record<string, string>;
  /** Set of displayNames that are production stages */
  prodDbNames: Set<string>;
  /** Array of current displayNames — for AI prompts / validation */
  stagesForAI: string[];
  /** Full records sorted by sortOrder */
  records: StageConfigRecord[];
};

/** Build a hardcoded fallback result (used when DB is unavailable) */
export function buildFallbackResult(): StageConfigResult {
  const fallbackRecords: StageConfigRecord[] = DEFAULT_STAGE_CONFIG.map((d, i) => ({
    id: `fallback-${i}`,
    stageKey: d.stageKey,
    displayName: d.displayName,
    shortName: d.shortName,
    cssVariable: d.cssVariable,
    sortOrder: d.sortOrder,
    isProductionStage: d.isProductionStage,
  }));
  return buildResult(fallbackRecords);
}

function buildResult(records: StageConfigRecord[]): StageConfigResult {
  const sorted = [...records].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  const fromDB: Record<string, string> = {};
  const toDB: Record<string, string> = {};
  const prodDbNames = new Set<string>();
  const stagesForAI: string[] = [];

  for (const r of sorted) {
    if (!r.stageKey || !r.displayName) continue;
    fromDB[r.displayName] = r.stageKey;
    toDB[r.stageKey] = r.displayName;
    stagesForAI.push(r.displayName);
    if (r.isProductionStage) prodDbNames.add(r.displayName);
  }

  return { fromDB, toDB, prodDbNames, stagesForAI, records: sorted };
}

/**
 * Load stage configuration from the database.
 * On first call (empty table), auto-seeds with defaults.
 * ALWAYS returns a valid result — falls back to hardcoded defaults if DB fails.
 */
export async function loadStageConfig(): Promise<StageConfigResult> {
  try {
    let records = stageConfig.all(100);

    // Seed the defaults only into an EMPTY table. The original re-seeded any
    // missing default on every load, so a stage Jake deleted came straight back.
    const existingKeys = new Set(records.map(r => r.stageKey).filter(Boolean));
    const missingStages = records.length === 0 ? DEFAULT_STAGE_CONFIG.filter(d => !existingKeys.has(d.stageKey)) : [];

    if (missingStages.length > 0) {
      try {
        stageConfig.upsertMany(missingStages.map(d => ({ ...d })), ['stageKey']);
        records = stageConfig.all(100);
      } catch {
        // Partial seeding failed — continue with what we have + fallback for missing
        const fallback = buildFallbackResult();
        if (records.length === 0) return fallback;
        // Merge: use DB records as base, fill gaps with fallback
        const merged = [...records];
        for (const d of DEFAULT_STAGE_CONFIG) {
          if (!existingKeys.has(d.stageKey)) {
            merged.push({ id: `fallback-${d.stageKey}`, ...d });
          }
        }
        return buildResult(merged);
      }
    }

    if (records.length > 0) {
      return buildResult(records);
    }
  } catch {
    // DB unavailable — use hardcoded fallback
  }

  return buildFallbackResult();
}

/**
 * Rename a stage: updates StageConfig AND bulk-updates all Deals with that stage.
 * Returns the count of Deals records updated.
 */
export async function persistRenameStage(stageKey: string, newDisplayName: string): Promise<number> {
  const existing = stageConfig.where('stage_key = ? ORDER BY created_at, rowid LIMIT 1', stageKey)[0];

  if (!existing) {
    stageConfig.insert({ stageKey, displayName: newDisplayName, isProductionStage: false, sortOrder: 100 });
    return 0;
  }

  const oldDisplayName = existing.displayName ?? '';
  if (oldDisplayName === newDisplayName) return 0;

  stageConfig.update(existing.id, { displayName: newDisplayName });

  // Every deal in the stage (archived too) — the original stopped at 2,000.
  return db.prepare('UPDATE deals_deals SET stage = ?, updated_at = ? WHERE stage = ?')
    .run(newDisplayName, new Date().toISOString(), oldDisplayName).changes;
}
