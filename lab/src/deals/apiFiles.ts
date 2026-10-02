/**
 * Deal Organizer — client for the deal "Files & threads" endpoints
 * (server: deals/handlersFiles.ts + dealFiles.ts).
 *
 * getDealFiles / getDealFileCounts / link / unlink / search are SQL on the
 * server — ZERO Gmail calls. Only refreshDealFiles (the "Check Gmail for
 * missing files" button) reads Gmail: ≤1 threads.list + ≤10 threads.get.
 */
import { useEffect, useState } from 'react';
import { call } from './api';

export type FileKind = 'contract' | 'brief' | 'invoice' | 'deck' | 'script' | 'other';
export type MatchedBy = 'source' | 'manual' | 'contact' | 'domain+brand' | 'platform';

export interface DealFileVersion {
  key: string; name: string; mimeType: string; size: number; kind: FileKind;
  threadId: string; messageId: string; attachmentId: string;
  from: string; fromName: string; isFromMe: boolean; date: string | null; subject: string;
}
export interface DealFile extends DealFileVersion {
  versions: number;
  /** Older versions of the same document, newest first. */
  older: DealFileVersion[];
}
export interface DealLink {
  url: string; host: string; kind: string; title: string | null;
  from: string; fromName: string; isFromMe: boolean; date: string | null; threadId: string; subject: string; mentions: number;
}
export interface DealThread {
  threadId: string; subject: string; participants: Array<{ email: string; name: string }>;
  matchedBy: MatchedBy; via: string | null; brand: string | null; lastAt: string | null;
  messageCount: number; gmailCount: number; synced: boolean; fileCount: number; gmailUrl: string;
}
export interface DealFilesResult {
  dealId: string; brand: string | null; accountEmail: string;
  threads: DealThread[]; files: DealFile[]; links: DealLink[];
  counts: { threads: number; files: number; links: number; byKind: Record<FileKind, number> };
}
export interface DealFilesRefresh extends DealFilesResult {
  refresh: { fetched: number; discovered: number; gmailCalls: number; errors: string[] };
}
export interface DealThreadSearchHit {
  threadId: string; subject: string; counterpart: { name: string; email: string }; brand: string | null;
  lastAt: string | null; messageCount: number; linked: boolean; dealName: string | null;
}

export const getDealFiles = (input: { dealId: string }) => call<DealFilesResult>('getDealFiles', input);
export const refreshDealFiles = (input: { dealId: string }) => call<DealFilesRefresh>('refreshDealFiles', input);
export const linkDealThread = (input: { dealId: string; threadId: string }) => call<DealFilesResult>('linkDealThread', input);
export const unlinkDealThread = (input: { dealId: string; threadId: string }) => call<DealFilesResult>('unlinkDealThread', input);
export const searchDealThreads = (input: { dealId: string; q?: string }) => call<{ threads: DealThreadSearchHit[] }>('searchDealThreads', input);
export const getDealFileCounts = () => call<Record<string, number>>('getDealFileCounts', {});

/* ── board badge: one batch call per board load, shared by every card ───── */

let counts: Record<string, number> = {};
let inflight: Promise<void> | null = null;
let loadedOnce = false;
const listeners = new Set<() => void>();

/** Called by the board on every load (and after a sync); cards read it via useDealFileCount. */
export function loadDealFileCounts(): Promise<void> {
  if (inflight) return inflight;
  inflight = getDealFileCounts()
    .then((c) => { counts = c ?? {}; loadedOnce = true; listeners.forEach((l) => l()); })
    .catch(() => { /* the badge is optional */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Update one deal's count after its workspace loaded fresher numbers. */
export function setDealFileCount(dealId: string, n: number): void {
  if (counts[dealId] === n) return;
  counts = { ...counts, [dealId]: n };
  listeners.forEach((l) => l());
}

export function useDealFileCount(dealId: string): number {
  const [n, setN] = useState(() => counts[dealId] ?? 0);
  useEffect(() => {
    const l = () => setN(counts[dealId] ?? 0);
    listeners.add(l);
    l();
    if (!loadedOnce) loadDealFileCounts();
    return () => { listeners.delete(l); };
  }, [dealId]);
  return n;
}
