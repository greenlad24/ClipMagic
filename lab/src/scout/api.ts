/**
 * UX Scout — client for /api/scout/* (server: lab/server/src/scout/routes.ts).
 */
import type { ScreenshotRef } from 'zite-endpoints-sdk';

async function call<T>(fn: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/api/scout/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Request failed (${r.status})`);
  return j as T;
}

export interface ScoutTool { slug: string; name: string; homeUrl: string; note: string | null; loggedInAt: string | null; createdAt: string }
export type ScoutStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface ScoutKeyShot { file: string; caption: string; url: string | null; ref?: ScreenshotRef }
export interface ScoutJob {
  id: string; runId: string | null; toolSlug: string; goal: string; context: string | null; status: ScoutStatus;
  cancelRequested: boolean; report: string | null; summary: string | null; keyShots: ScoutKeyShot[]; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; lastEventAt: string | null;
}
export interface ScoutEvent { seq: number; at: string; kind: 'note' | 'action' | 'shot' | 'key_shot' | 'error' | 'status'; text: string; file: string | null; url: string | null }
export interface ScoutJobView { job: ScoutJob; tool: { slug: string; name: string; homeUrl: string } | null; events: ScoutEvent[]; steps: number; latestShotUrl: string | null }
export interface ConsoleResult { ok: boolean; message: string; url: string | null; title: string | null; image: string | null }

export type ConsoleAct =
  | { action: 'screenshot' } | { action: 'goto'; url: string } | { action: 'back' } | { action: 'reload' }
  | { action: 'click_frac'; xFrac: number; yFrac: number } | { action: 'type'; text: string }
  | { action: 'key'; combo: string } | { action: 'scroll'; direction: 'up' | 'down'; amount?: number };

export const listTools = () => call<{ tools: ScoutTool[] }>('listTools');
export const addTool = (name: string, homeUrl: string) => call<{ tool: ScoutTool }>('addTool', { name, homeUrl });
export const removeTool = (slug: string) => call<{ ok: true }>('removeTool', { slug });
export const importSession = (slug: string, cookies: string, storage: string) => call<{ cookies: number; storageKeys: number; origin: string | null; result: ConsoleResult }>('importSession', { slug, cookies, storage });
export const markLoggedIn = (slug: string) => call<{ tool: ScoutTool }>('markLoggedIn', { slug });
export const consoleAct = (slug: string, act: ConsoleAct) => call<ConsoleResult>('console', { slug, act });

export const createJob = (input: { toolSlug: string; goal: string; context?: string; runId?: string; assets?: { name: string; dataBase64: string }[] }) =>
  call<ScoutJobView>('createJob', input);
export const getJob = (id: string, afterSeq = 0) => call<ScoutJobView>('getJob', { id, afterSeq });
export const listJobs = (runId?: string) => call<{ jobs: ScoutJob[] }>('listJobs', { runId });
export const cancelJob = (id: string) => call<{ job: ScoutJob }>('cancelJob', { id });
export const attachToRun = (runId: string, jobId: string | null) => call<{ attached: boolean }>('attachToRun', { runId, jobId });
