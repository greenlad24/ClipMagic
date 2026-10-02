/**
 * Deal Organizer — analytics endpoints (analytics redesign, 2026-09-30).
 * Wire into routes.ts: `...HANDLERS_ANALYTICS`.
 *
 *   getAnalytics          (also in HANDLERS2 — same function) the page's one call
 *   getDealFields {id}    the analytics fields of one deal + which were AI-filled
 *   getDealFieldsStatus   extraction coverage, queue, last runs, total AI cost
 *   runDealFieldsBackfill {limit?, includeExtracted?, cards?, ids?}
 *                         starts the one-time AI backfill in the background
 *                         (returns at once; poll getDealFieldsStatus).
 *                         cards: true = the one-time CARD refresh (every live deal
 *                         whose card was never auto-filled); ids = exactly these deals
 *   runDeadlineBackfill {aiCap?}  parse every free-text deadline into deadline_date
 *                         (deterministic; AI only for ambiguous ones, ≤ aiCap). Awaited.
 *   getStageEvents {id}   the deal's stage history
 */
import { z } from "zod";
import { db } from "../db/index.js";
import { parse } from "./common.js";
import { getAnalytics } from "./analytics.js";
import { readDealFields, dealFieldsStatus, backfillDealFields } from "./dealFields.js";
import { syncDeadlineDates } from "./deadlineParse.js";

type Handler = (input: any) => Promise<unknown> | unknown;

const backfillLog: string[] = [];

export const HANDLERS_ANALYTICS: Record<string, Handler> = {
  getAnalytics: (input) => getAnalytics(input),

  getDealFields: (raw) => {
    const { id } = parse(z.object({ id: z.string() }), raw);
    return { id, fields: readDealFields(id) };
  },

  getDealFieldsStatus: () => ({ ...dealFieldsStatus(), log: backfillLog.slice(-50) }),

  runDealFieldsBackfill: (raw) => {
    const input = parse(z.object({ limit: z.number().int().positive().optional(), includeExtracted: z.boolean().optional(), cards: z.boolean().optional(), ids: z.array(z.string()).max(100).optional() }), raw);
    if (dealFieldsStatus().running) throw Object.assign(new Error("A deal-fields run is already in progress"), { status: 400 });
    backfillLog.length = 0;
    const log = (m: string) => { backfillLog.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (backfillLog.length > 500) backfillLog.shift(); console.log(`[deals] ${m}`); };
    void backfillDealFields({ limit: input.limit, includeExtracted: input.includeExtracted, cards: input.cards, ids: input.ids, log }).catch((e) => log(`backfill failed — ${e?.message ?? e}`));
    return { started: true };
  },

  runDeadlineBackfill: async (raw) => {
    const input = parse(z.object({ aiCap: z.number().int().min(0).max(200).optional() }), raw);
    const lines: string[] = [];
    const r = await syncDeadlineDates({ aiCap: input.aiCap ?? 60, log: (m) => lines.push(m) });
    return { ...r, log: lines };
  },

  getStageEvents: (raw) => {
    const { id } = parse(z.object({ id: z.string() }), raw);
    return { events: db.prepare(`SELECT from_stage AS fromStage, to_stage AS toStage, at, source FROM deals_stage_events WHERE deal_id = ? ORDER BY at, id`).all(id) };
  },
};
