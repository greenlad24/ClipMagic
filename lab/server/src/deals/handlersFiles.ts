/**
 * Deal Organizer — "Files & threads" endpoints (deal workspace + board badge).
 * Wired by the integrator in routes.ts: `...HANDLERS_FILES`.
 *
 * ZERO Gmail and ZERO AI calls unless noted:
 *   getDealFiles       { dealId } → DealFilesResult  { dealId, brand, accountEmail, threads[], files[], links[], counts }
 *                      (resolves + persists the deal's auto thread links; see dealFiles.ts)
 *   getDealFileCounts  {} → { [dealId]: files + document links }   (live deals; one call per board load)
 *   linkDealThread     { dealId, threadId } → DealFilesResult   (manual link; clears an exclusion)
 *   unlinkDealThread   { dealId, threadId } → DealFilesResult   (removes + excludes, never auto re-added)
 *   searchDealThreads  { dealId, q? } → { threads: [{ threadId, subject, counterpart, brand, lastAt, messageCount, linked, dealName }] }
 *   refreshDealFiles   { dealId } → DealFilesResult + { refresh: { fetched, discovered, gmailCalls, errors } }
 *                      Gmail READ only: ≤1 threads.list + ≤10 threads.get (explicit button)
 */
import { z } from "zod";
import { parse, connectedAccount, FALLBACK_MY_EMAIL, type Handler } from "./common.js";
import { getDealFilesData, dealFileCounts, linkDealThread, unlinkDealThread, relatedThreadsForDeal, refreshDealFilesData } from "./dealFiles.js";
import { searchThreadsLocal } from "./inbox.js";
import { markDealTouched } from "./db.js";

const threadId = z.string().regex(/^[A-Za-z0-9]+$/).max(64);
const dealId = z.string().min(1).max(100);
const myEmail = () => (connectedAccount()?.email ?? FALLBACK_MY_EMAIL).toLowerCase();

export const HANDLERS_FILES: Record<string, Handler> = {
  getDealFiles: (raw) => {
    const input = parse(z.object({ dealId }), raw);
    return getDealFilesData(input.dealId);
  },

  getDealFileCounts: (raw) => {
    parse(z.object({}), raw);
    return dealFileCounts();
  },

  linkDealThread: (raw) => {
    const input = parse(z.object({ dealId, threadId }), raw);
    linkDealThread(input.dealId, input.threadId);
    markDealTouched(input.dealId);
    return getDealFilesData(input.dealId);
  },

  unlinkDealThread: (raw) => {
    const input = parse(z.object({ dealId, threadId }), raw);
    unlinkDealThread(input.dealId, input.threadId);
    markDealTouched(input.dealId);
    return getDealFilesData(input.dealId);
  },

  searchDealThreads: (raw) => {
    const input = parse(z.object({ dealId, q: z.string().max(200).optional() }), raw);
    const linked = new Set(relatedThreadsForDeal(input.dealId).map((r) => r.threadId));
    const threads = searchThreadsLocal(myEmail(), input.q ?? "", 20).map((t) => ({
      threadId: t.threadId, subject: t.subject, counterpart: t.counterpart, brand: t.brand, lastAt: t.lastAt,
      messageCount: t.messageCount, linked: linked.has(t.threadId), dealName: t.deal?.name ?? null,
    }));
    return { threads };
  },

  refreshDealFiles: async (raw) => {
    const input = parse(z.object({ dealId }), raw);
    return refreshDealFilesData(input.dealId);
  },
};
