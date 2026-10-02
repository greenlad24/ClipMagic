/**
 * Deal Organizer — client for the app's server functions (POST /api/deals/<fn>).
 *
 * Every export keeps the name and the input/output shape of the original Zite
 * endpoint caller (`zitejs/api`), so the ported pages call them unchanged.
 * Types live in ./apiTypes.ts (generated from the original zod schemas).
 *
 * Streaming endpoints (chatAI, scanGmail, syncThreadIndex, runAgentNow) answer
 * with NDJSON: `{"chunk": X}` lines, then `{"result": Y}` or
 * `{"error": {"message"}}`. Iterate the returned object for the chunks, then
 * `await s.result` — the same contract as Zite's `createStreamingCaller`.
 */
import type * as T from './apiTypes';

export * from './apiTypes';

function signIn(): never {
  window.location.href = '/auth/google';
  throw new Error('Sign-in required');
}

function errorMessage(data: any, fallback: string): string {
  const e = data?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return fallback;
}

export async function call<R = any>(fn: string, input?: unknown): Promise<R> {
  const res = await fetch(`/api/deals/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input ?? {}),
    credentials: 'include',
  });
  if (res.status === 401) signIn();
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(data, `${fn} failed (${res.status})`));
  return data as R;
}

/** A progress stream: `for await (const chunk of s)`, then `await s.result`. */
export interface ProgressStream<C, R> extends AsyncIterable<C> {
  result: Promise<R>;
}

/** Raw NDJSON streamer: yields each `chunk` value exactly as the server sent it. */
export function streamingCall<C = unknown, R = unknown>(fn: string, input?: unknown): ProgressStream<C, R> {
  const queue: C[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let resolveResult!: (r: R) => void;
  let rejectResult!: (e: Error) => void;
  const result = new Promise<R>((res, rej) => { resolveResult = res; rejectResult = rej; });
  result.catch(() => {}); // surfaced through iteration too; never unhandled

  const push = (c: C) => { queue.push(c); wake?.(); };
  const finish = () => { finished = true; wake?.(); };

  (async () => {
    try {
      const res = await fetch(`/api/deals/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
        credentials: 'include',
      });
      if (res.status === 401) signIn();
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(errorMessage(data, `${fn} failed (${res.status})`));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let settled = false;
      const handle = (line: string) => {
        if (!line) return;
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg && 'chunk' in msg) push(msg.chunk as C);
        else if (msg && 'result' in msg) { settled = true; resolveResult(msg.result as R); }
        else if (msg && 'error' in msg) { settled = true; throw new Error(errorMessage(msg, `${fn} failed`)); }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      handle(buf.trim());
      if (!settled) throw new Error(`${fn} ended without a result`);
    } catch (e) {
      rejectResult(e instanceof Error ? e : new Error(String(e)));
    } finally {
      finish();
    }
  })();

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (finished) break;
        await new Promise<void>((r) => { wake = r; });
        wake = null;
      }
      await result; // rethrows a failure inside the caller's for-await
    },
  };
}

/**
 * Zite-compatible text stream: the original pages treat every chunk as text
 * (chatAI appends it; syncThreadIndex splits it on newlines and JSON-parses
 * each line). A chunk the server sends as an object is turned back into one
 * JSON line so that parsing keeps working.
 */
function textStream<R>(fn: string, input: unknown): ProgressStream<string, R> {
  const raw = streamingCall<unknown, R>(fn, input);
  return {
    result: raw.result,
    async *[Symbol.asyncIterator]() {
      for await (const c of raw) {
        yield typeof c === 'string' ? c : JSON.stringify(c) + '\n';
      }
    },
  };
}

const caller = <I, O>(fn: string) => (input: I) => call<O>(fn, input);

// ── Original endpoints (same names, same shapes) ─────────────────────────────
export const addAction = caller<T.AddActionInputType, T.AddActionOutputType>('addAction');
export const addComment = caller<T.AddCommentInputType, T.AddCommentOutputType>('addComment');
export const addDealToProduction = caller<T.AddDealToProductionInputType, T.AddDealToProductionOutputType>('addDealToProduction');
export const chatAI = (input: T.ChatAIInputType) => textStream<T.ChatAIOutputType>('chatAI', input);
export const clearThreadBrandsCache = caller<T.ClearThreadBrandsCacheInputType, T.ClearThreadBrandsCacheOutputType>('clearThreadBrandsCache');
export const createDeadlineProject = caller<T.CreateDeadlineProjectInputType, T.CreateDeadlineProjectOutputType>('createDeadlineProject');
export const createDeal = caller<T.CreateDealInputType, T.CreateDealOutputType>('createDeal');
export const createStage = caller<T.CreateStageInputType, T.CreateStageOutputType>('createStage');
export const deleteStage = caller<T.DeleteStageInputType, T.DeleteStageOutputType>('deleteStage');
export const generateReply = caller<T.GenerateReplyInputType, T.GenerateReplyOutputType>('generateReply');
/** The Lab's one connected mailbox (connect/disconnect live under /api/deals-oauth/gmail/*). */
export const getAccounts = caller<T.GetAccountsInputType, T.GetAccountsOutputType>('getAccounts');
export const getActions = caller<T.GetActionsInputType, T.GetActionsOutputType>('getActions');
export const getAnalytics = caller<T.GetAnalyticsInputType, T.GetAnalyticsOutputType>('getAnalytics');
export const getComments = caller<T.GetCommentsInputType, T.GetCommentsOutputType>('getComments');
export const getDeadlineProjects = caller<T.GetDeadlineProjectsInputType, T.GetDeadlineProjectsOutputType>('getDeadlineProjects');
export const getDeal = caller<T.GetDealInputType, T.GetDealOutputType>('getDeal');
export const getDeals = caller<T.GetDealsInputType, T.GetDealsOutputType>('getDeals');
export const getEmailAttachment = caller<T.GetEmailAttachmentInputType, T.GetEmailAttachmentOutputType>('getEmailAttachment');
export const getFollowUpDrafts = caller<T.GetFollowUpDraftsInputType, T.GetFollowUpDraftsOutputType>('getFollowUpDrafts');
export const getStages = caller<T.GetStagesInputType, T.GetStagesOutputType>('getStages');
export const getThread = caller<T.GetThreadInputType, T.GetThreadOutputType>('getThread');
export const listCompanies = caller<T.ListCompaniesInputType, T.ListCompaniesOutputType>('listCompanies');
export const listThreads = caller<T.ListThreadsInputType, T.ListThreadsOutputType>('listThreads');
export const lookupThread = caller<T.LookupThreadInputType, T.LookupThreadOutputType>('lookupThread');
export const mergeDeals = caller<T.MergeDealsInputType, T.MergeDealsOutputType>('mergeDeals');
export const renameStage = caller<T.RenameStageInputType, T.RenameStageOutputType>('renameStage');
export const reorderStages = caller<T.ReorderStagesInputType, T.ReorderStagesOutputType>('reorderStages');
/** Long job — streamed. Iterate for progress chunks (optional), then `await .result`. */
export const scanGmail = (input: T.ScanGmailInputType) => streamingCall<unknown, T.ScanGmailOutputType>('scanGmail', input);
export const syncEmails = caller<T.SyncEmailsInputType, T.SyncEmailsOutputType>('syncEmails');
export const syncThreadIndex = (input: T.SyncThreadIndexInputType) => textStream<T.SyncThreadIndexOutputType>('syncThreadIndex', input);
export const updateActionStatus = caller<T.UpdateActionStatusInputType, T.UpdateActionStatusOutputType>('updateActionStatus');
export const updateDeadlineProject = caller<T.UpdateDeadlineProjectInputType, T.UpdateDeadlineProjectOutputType>('updateDeadlineProject');
export const updateDeal = caller<T.UpdateDealInputType, T.UpdateDealOutputType>('updateDeal');

/**
 * Default: the reply / follow-up is saved as a Gmail DRAFT. `mode: 'send'` =
 * Jake clicked Send in the Lab → it is SENT (manual only — automated processes
 * can never send; the server enforces it). `sendGmailDraft` sends a draft that
 * is already saved in Gmail (the agent's), exactly as it is there.
 */
export interface SendOptions { mode?: 'draft' | 'send'; cc?: string }
export interface SavedDraft { draftId: string; gmailUrl: string; savedAsDraft: boolean; sent?: boolean }
export const sendReply = caller<T.SendReplyInputType & SendOptions, T.SendReplyOutputType & SavedDraft>('sendReply');
export const sendFollowUp = caller<T.SendFollowUpInputType & SendOptions, T.SendFollowUpOutputType & SavedDraft>('sendFollowUp');
export const sendGmailDraft = caller<{ threadId: string; draftId: string; dealId?: string }, { success: boolean; gmailMessageId?: string; gmailUrl: string; sent: true }>('sendGmailDraft');

// ── Gmail connection (owned by the Lab; full-page navigations) ───────────────
export const GMAIL_CONNECT_URL = '/api/deals-oauth/gmail/start';
export const GMAIL_DISCONNECT_URL = '/api/deals-oauth/gmail/disconnect';

// ── Connections (Gmail / YouTube Analytics / Slack) ──────────────────────────
export interface IntegrationsStatus {
  gmail: { configured: boolean; connected: boolean; email?: string | null; scope?: string; redirectUri?: string };
  youtube: { configured: boolean; connected: boolean };
  slack: { configured: boolean; hasTarget: boolean; target?: string | null; [k: string]: unknown };
}
export interface AudienceSnapshot {
  countries: { country: string; share: number }[];
  ageGroups: { ageGroup: string; percent: number }[];
  gender: { gender: string; percent: number }[];
  totalViews: number;
  from: string;
  to: string;
}
export const getIntegrationsStatus = () => call<IntegrationsStatus>('getIntegrationsStatus', {});
export const testGmail = () => call<{ email: string; messagesTotal: number; recent: string[] }>('testGmail', {});
export const getAudienceSnapshot = (input: { days?: number }) => call<AudienceSnapshot>('getAudienceSnapshot', input);
export const saveSlackSettings = (input: { botToken?: string; target?: string }) => call<{ ok: boolean }>('saveSlackSettings', input);
export const testSlack = () => call<{ team: string; bot: string }>('testSlack', {});

// ── Sponsorship email agent ──────────────────────────────────────────────────
export interface AgentRunCounts {
  threads: number; drafted: number; skipped: number; spam: number; flagged: number; asked: number;
  /** Follow-up drafts and auto-closed / parked deals in this run (also counted in drafted / skipped). */
  followUps?: number; closed?: number;
}
/** Follow-up cadence + auto-close settings (server agent/settings.ts). */
export interface FollowUpSettings {
  followUpsEnabled: boolean;
  perRunCap: number;
  cadence: { A: number[]; B: number[]; C: number[] };
  autoCloseEnabled: boolean;
  closeAfterDays: number;
  backlogDays: number;
  backlogCloseAfterDays: number;
  closuresPerRunCap: number;
  focusPerRunCap: number;
}
export interface RunSummary {
  id: string;
  trigger: 'schedule' | 'manual';
  preview: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  counts: AgentRunCounts;
  error: string | null;
}
export type AgentDecision = 'draft' | 'skip' | 'spam' | 'flag' | 'ask';
export interface AgentCheck { name: string; ok: boolean; detail: string }
export interface AgentItem {
  id: string;
  threadId: string;
  gmailUrl: string;
  subject: string;
  from: string;
  brand: string | null;
  stage: string;
  edgeCase: string | null;
  decision: AgentDecision;
  reason: string;
  fit: { verdict: 'fit' | 'partial' | 'none'; angle: string | null; notes: string } | null;
  draftText: string | null;
  checks: AgentCheck[];
  gmailDraftId: string | null;
  slackPermalink: string | null;
  dealId: string | null;
  createdAt: string;
}
export interface AgentStatus {
  enabled: boolean;
  saveToGmail: boolean;
  postToSlack: boolean;
  times: string[];
  timezone: string;
  lastRun: RunSummary | null;
  nextRunAt: string | null;
  running: boolean;
  signature: string;
  followUps?: FollowUpSettings;
}
export interface AgentQuestion {
  id: string;
  threadId: string;
  subject: string;
  question: string;
  askedAt: string;
  slackPermalink: string | null;
  answer: string | null;
  answeredAt: string | null;
}
export interface AgentLesson { id: string; brand: string | null; stage: string | null; lesson: string; source: 'edit' | 'slack'; createdAt: string }
export type AgentChunk = { type: 'progress'; message: string } | { type: 'item'; item: AgentItem };

export const getAgentStatus = () => call<AgentStatus>('getAgentStatus', {});
export const updateAgentSettings = (input: Partial<Pick<AgentStatus, 'enabled' | 'saveToGmail' | 'postToSlack' | 'times' | 'signature'>>) =>
  call<AgentStatus>('updateAgentSettings', input);
export const runAgentNow = (input: { preview?: boolean }) => streamingCall<AgentChunk, RunSummary>('runAgentNow', input);
export const listAgentRuns = (input: { limit?: number }) => call<{ runs: RunSummary[] }>('listAgentRuns', input);
export const getAgentRun = (input: { id: string }) => call<{ run: RunSummary; items: AgentItem[] }>('getAgentRun', input);
export const listAgentQuestions = (input: { status?: 'open' | 'answered' }) => call<{ questions: AgentQuestion[] }>('listAgentQuestions', input);
export const listAgentLessons = (input: { limit?: number }) => call<{ lessons: AgentLesson[] }>('listAgentLessons', input);
export const updateAgentLesson = (input: { id: string; lesson: string }) => call<{ lesson: AgentLesson | null }>('updateAgentLesson', input);
export const deleteAgentLesson = (input: { id: string }) => call<{ ok: true }>('deleteAgentLesson', input);

// ── Jake's own rules (Teach the agent — Lab + Slack "rule:") ─────────────────
export type RuleScope = 'general' | 'brand' | 'stage';
export interface ProposedRule { rule: string; scope: RuleScope; brand: string | null; stage: string | null; overrides: string | null }
export interface AgentRule extends ProposedRule { id: string; source: 'lab' | 'slack'; raw: string | null; status: 'active' | 'retired'; createdAt: string; updatedAt: string }
export const understandAgentRules = (input: { text: string }) => call<{ summary: string; rules: ProposedRule[]; unclear: string[] }>('understandAgentRules', input);
export const saveAgentRules = (input: { text?: string; rules: ProposedRule[] }) => call<{ rules: AgentRule[] }>('saveAgentRules', input);
export const listAgentRules = () => call<{ rules: AgentRule[] }>('listAgentRules', {});
export const updateAgentRule = (input: { id: string; rule?: string; scope?: RuleScope; brand?: string | null; stage?: string | null }) => call<{ rule: AgentRule }>('updateAgentRule', input);
export const retireAgentRule = (input: { id: string }) => call<{ ok: true }>('retireAgentRule', input);

// ── The one Gmail sync (server job: twice a day with the agent, or "Sync now") ─
// Thread index → recent email bodies → brand extraction → AI deal scan, run as
// ONE server-side job. Pages never start a scan themselves; they read the
// status, offer "Sync now", and reload their data when a run finishes.
export interface SyncStepResult {
  step?: string;               // threadIndex | emails | brands | scan
  ok: boolean | null;
  counts?: Record<string, number>;
  ms?: number;
  message?: string;
  error?: string | null;
}
export interface SyncRun {
  id?: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'schedule' | 'manual';
  ok: boolean | null;          // null while running
  /** An array of step results (current server); a name-keyed map is accepted too. */
  steps: SyncStepResult[] | Record<string, SyncStepResult>;
  summary: string;
}
export interface SyncStatus { running: boolean; current?: SyncRun | null; last: SyncRun | null; nextRunAt: string | null }
export type SyncChunk = { step: string; message: string };

/** A run's steps as a list, whichever shape the server sent. */
export function syncSteps(run: SyncRun | null | undefined): (SyncStepResult & { step: string })[] {
  if (!run?.steps) return [];
  if (Array.isArray(run.steps)) return run.steps.map((s, i) => ({ ...s, step: s.step ?? `step${i + 1}` }));
  return Object.entries(run.steps).map(([name, s]) => ({ ...s, step: s.step ?? name }));
}

export const getSyncStatus = () => call<SyncStatus>('getSyncStatus', {});
/** NDJSON: `{ step, message }` chunks; the result is the finished run's record. Joins a run already in progress. */
export const runSyncNow = () => streamingCall<SyncChunk, SyncStatus | SyncRun>('runSyncNow', {});
