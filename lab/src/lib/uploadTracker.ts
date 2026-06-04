/**
 * Client-side upload tracker.
 *
 * File uploads are direct browser→server HTTP requests, not server-side queue
 * jobs, so they never appear in `listJobs`. This tiny pub/sub store records each
 * in-flight upload and its progress so the global Background Jobs panel can show
 * them live alongside real render/analyze jobs. `uploadBlobToZite` registers a
 * transfer here and reports progress; the panel subscribes via `useTransfers`.
 */
import { useEffect, useState } from 'react';

export interface Transfer {
  id: string;
  title: string;
  /** 0..1 of bytes sent. */
  progress: number;
  status: 'uploading' | 'done' | 'failed' | 'canceled';
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type Listener = (transfers: Transfer[]) => void;

const transfers = new Map<string, Transfer>();
const listeners = new Set<Listener>();

function snapshot(): Transfer[] {
  return [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
}
function emit(): void {
  const s = snapshot();
  for (const l of listeners) l(s);
}

export function subscribeTransfers(l: Listener): () => void {
  listeners.add(l);
  l(snapshot());
  return () => {
    listeners.delete(l);
  };
}

let seq = 0;
export function startTransfer(title: string): string {
  const id = `up_${Date.now()}_${seq++}`;
  const now = Date.now();
  transfers.set(id, { id, title, progress: 0, status: 'uploading', createdAt: now, updatedAt: now });
  emit();
  return id;
}

export function updateTransfer(id: string, progress: number): void {
  const t = transfers.get(id);
  if (!t || t.status !== 'uploading') return;
  t.progress = Math.max(0, Math.min(1, progress));
  t.updatedAt = Date.now();
  emit();
}

export function finishTransfer(id: string, status: 'done' | 'failed' | 'canceled', error?: string): void {
  const t = transfers.get(id);
  if (!t) return;
  t.status = status;
  if (status === 'done') t.progress = 1;
  if (error) t.error = error;
  t.updatedAt = Date.now();
  emit();
  // Keep terminal transfers visible briefly in the panel's "Recent" section,
  // then drop them so the store doesn't grow unbounded.
  setTimeout(() => {
    transfers.delete(id);
    emit();
  }, 8000);
}

/** React hook: the live list of transfers, newest first. */
export function useTransfers(): Transfer[] {
  const [list, setList] = useState<Transfer[]>(snapshot);
  useEffect(() => subscribeTransfers(setList), []);
  return list;
}
