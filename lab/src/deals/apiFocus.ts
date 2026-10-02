/**
 * Deal Organizer — client for the agent's FOCUS scores + follow-up cadence
 * (server: deals/agent/focus.ts + followups.ts, via agent/handlers.ts).
 *
 *   getAgentFocusMap     dealId → { grade, score, reason }   (kanban badge; SQL only)
 *   listAgentFocus       every open deal: score, reasons, follow-up status (SQL only)
 *   runFollowUpsPreview  NDJSON: preview of the focus + follow-up + auto-close step
 *   runFocusBackfill     NDJSON: (re)score open deals (AI — costs money)
 *   updateAgentSettings({ followUps }) — the cadence settings (see FollowUpSettings)
 */
import { useEffect, useState } from 'react';
import { call, streamingCall, type AgentStatus, type AgentItem, type RunSummary, type FollowUpSettings } from './api';

export type { FollowUpSettings };

export type FocusGrade = 'A' | 'B' | 'C';
export type FollowUpAction = 'followup' | 'reengage' | 'close' | 'wait' | 'blocked' | 'none';

export interface FocusReasons {
  fit: string; price: string; ease: string; offered: string; pending: string;
  followUpOk: boolean; followUpWhy: string; demands: string[]; lastQuotedUsd: number | null;
  outcome?: { state: string; lostReason: string | null; why: string };
}

export interface FocusListRow {
  dealId: string;
  dealName: string;
  clientEmail: string;
  stage: string;
  grade: FocusGrade | null;
  score: number | null;
  fit: string | null;
  price: string | null;
  ease: string | null;
  reasons: FocusReasons | null;
  computedAt: string | null;
  followUp: {
    action: FollowUpAction; status: string; n: number; total: number; sent: number;
    dueAt: string | null; lastJakeAt: string | null; daysSilent: number | null; threadId: string | null;
    closeKind: string | null; toStageKey: string | null; lostReason: string | null;
  };
}


export const listAgentFocus = () =>
  call<{ rows: FocusListRow[]; settings: FollowUpSettings; counts: Record<string, number> }>('listAgentFocus', {});
export const getAgentFocusMap = () =>
  call<{ focus: Record<string, { grade: FocusGrade; score: number; reason: string; computedAt: string }> }>('getAgentFocusMap', {});
export const updateFollowUpSettings = (followUps: Partial<FollowUpSettings>) =>
  call<AgentStatus>('updateAgentSettings', { followUps });
export const runFollowUpsPreview = () =>
  streamingCall<{ type: 'progress'; message: string } | { type: 'item'; item: AgentItem }, RunSummary & { costUsd: number }>('runFollowUpsPreview', {});

/* ── kanban badge cache (one request per board load, shared by every card) ── */

type FocusBadge = { grade: FocusGrade; score: number; reason: string };
let map: Record<string, FocusBadge> = {};
let inflight: Promise<void> | null = null;
let loadedOnce = false;
const listeners = new Set<() => void>();

export function loadDealFocus(): Promise<void> {
  if (inflight) return inflight;
  inflight = getAgentFocusMap()
    .then((r) => { map = r?.focus ?? {}; loadedOnce = true; listeners.forEach((l) => l()); })
    .catch(() => { loadedOnce = true; /* the badge is optional */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useDealFocus(dealId: string): FocusBadge | null {
  const [f, setF] = useState<FocusBadge | null>(() => map[dealId] ?? null);
  useEffect(() => {
    const l = () => setF(map[dealId] ?? null);
    listeners.add(l);
    l();
    if (!loadedOnce) loadDealFocus();
    return () => { listeners.delete(l); };
  }, [dealId]);
  return f;
}
