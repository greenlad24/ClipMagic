/**
 * Deal Organizer — client for the Emails-page / chat redesign endpoints
 * (server: deals/handlersInbox.ts). Uses api.ts's `call` / `streamingCall`.
 *
 * Page loads here make ZERO Gmail and ZERO AI calls server-side: listInbox,
 * getInboxStatus, getInboxThread (one repair fetch at most) and the chat
 * session reads are SQL. AI runs only on a chat message or an "AI Draft" click.
 */
import { call, streamingCall, type GetFollowUpDraftsOutputType, type GetThreadOutputType } from './api';

/* ── inbox ────────────────────────────────────────────────────────────────── */

export type InboxView = 'needs_reply' | 'agent_drafted' | 'asked' | 'waiting' | 'done' | 'all' | 'brands';
export type DealState = 'open' | 'production' | 'lost' | 'done';

export interface InboxDeal { id: string; name: string; stage: string; stageKey: string | null; state: DealState; matchedBy: 'thread' | 'email' | 'domain' }
export interface InboxAgent {
  itemId: string; decision: string; reason: string; draftText: string | null; checksOk: boolean | null;
  gmailDraftId: string | null; createdAt: string; forLatest: boolean; sent: boolean;
}
export interface InboxQuestion { id: string; question: string; proposal: string | null; askedAt: string; slackPermalink: string | null }
export interface InboxThread {
  threadId: string;
  subject: string;
  counterpart: { name: string; email: string };
  brand: string | null;
  isAgency: boolean;
  snippet: string;
  lastAt: string | null;
  lastFromMe: boolean;
  lastInboundAt: string | null;
  waitingDays: number | null;
  messageCount: number;
  unread: boolean;
  hasGmailDraft: boolean;
  labels: string[];
  junk: boolean;
  automated: boolean;
  deal: InboxDeal | null;
  agent: InboxAgent | null;
  question: InboxQuestion | null;
  markedDone: boolean;
  doneReason: string | null;
  gmailUrl: string;
}
export interface BrandGroup { brand: string; domain: string; threadCount: number; lastAt: string | null; threadIds: string[]; deal: InboxDeal | null; isAgency: boolean; needsReply: number }

export interface InboxRefreshRecord {
  id: string; trigger: string; startedAt: string; finishedAt: string | null; ok: boolean | null; skipped: string | null;
  counts: Record<string, number>; error: string | null;
}
export interface InboxStatus {
  lastOk: InboxRefreshRecord | null;
  lastAttempt: InboxRefreshRecord | null;
  gmailCallsToday: number;
  refreshesToday: number;
  everyMinutes: number;
  nextRefreshAt: string | null;
  running: boolean;
}
export interface InboxList {
  view: InboxView;
  counts: Record<Exclude<InboxView, 'brands'>, number>;
  olderNeedsReply: number;
  threads: InboxThread[];
  brands: BrandGroup[];
  total: number;
  myEmail: string;
  refresh: InboxStatus;
}

export const listInbox = (input: { view?: InboxView; q?: string; brand?: string; includeOld?: boolean; limit?: number }) => call<InboxList>('listInbox', input);
export const getInboxStatus = () => call<InboxStatus>('getInboxStatus', {});
export const refreshInbox = () => call<{ ok: boolean; skipped: string | null; error: string | null; counts: Record<string, number>; status: InboxStatus }>('refreshInbox', {});

export type InboxThreadDetail = GetThreadOutputType & {
  gmailUrl: string;
  inbox: InboxThread | null;
  dealInfo: (GetThreadOutputType['dealInfo'] & { stageName?: string; matchedBy?: 'thread' | 'email' }) | null;
};
export const getInboxThread = (threadId: string) => call<InboxThreadDetail>('getInboxThread', { threadId });
export const markInboxDone = (threadId: string, done = true, note?: string) => call<{ ok: boolean }>('markInboxDone', { threadId, done, note });
export const linkThreadToDeal = (threadId: string, dealId: string) => call<{ ok: boolean; dealId: string }>('linkThreadToDeal', { threadId, dealId });

/* ── the agent drafter (preview; nothing saved) ───────────────────────────── */

export interface DraftCheck { name: string; ok: boolean; detail: string }
export interface DraftReplyResult {
  threadId: string;
  action: 'draft' | 'ask' | 'no_reply';
  draftText: string | null;
  body: string;
  checks: DraftCheck[];
  checksPassed: boolean;
  redrafted: boolean;
  ask: { question: string; proposal: string; rule: string } | null;
  summary: string;
  stage: string;
  edgeCase: string | null;
  goal: string;
  brand: string | null;
  product: string | null;
  fit: { verdict: 'fit' | 'partial' | 'none'; angle: string | null; notes: string } | null;
  suggestedBoardStage: string | null;
  dealValueUsd: number | null;
  deal: { id: string; stage: string; name: string } | null;
  warnings: string[];
  reply: { toEmail: string; cc: string | null; subject: string; lastMessageId: string; lastReferences: string; dealId: string };
  costUsd: number;
  models: { draft: string; triage: string };
}
/** NDJSON: `{ type: 'progress', message }` chunks, result = the draft (≈ $0.10–0.25, Opus 5.5 + checks). */
export const draftReply = (threadId: string, instructions?: string) =>
  streamingCall<{ type: 'progress'; message: string }, DraftReplyResult>('draftReply', { threadId, instructions: instructions?.trim() || undefined });

/** getFollowUpDrafts limited to some deals (additive server input). */
export type FollowUpDeal = GetFollowUpDraftsOutputType['deals'][number] & {
  classification?: 'follow_up' | 'low_baller' | 'skip';
  classificationReason?: string;
  suggestedStage?: string | null;
};
export const getFollowUpDraftsFor = (dealIds?: string[]) =>
  call<{ deals: FollowUpDeal[]; autoMoved: GetFollowUpDraftsOutputType['autoMoved']; scanned: number }>('getFollowUpDrafts', dealIds?.length ? { dealIds } : {});

/* ── chat ─────────────────────────────────────────────────────────────────── */

export interface ChatRef { type: 'deal' | 'thread'; id: string; label: string; url: string; gmailUrl?: string }
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'done' | 'error'; label: string; summary?: string }
  | { kind: 'card'; card: string; data: any };
export type ChatChunk =
  | { type: 'session'; sessionId: string; title: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; status: 'running' | 'done' | 'error'; label: string; summary?: string }
  | { type: 'card'; kind: string; data: any }
  | { type: 'refs'; refs: ChatRef[] }
  | { type: 'usage'; rounds: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
export interface ChatTurnResult { sessionId: string; turnId: string; text: string; parts: ChatPart[]; refs: ChatRef[]; costUsd: number; rounds: number }

export const chatAgent = (input: { sessionId?: string; message: string }) => streamingCall<ChatChunk, ChatTurnResult>('chatAgent', input);

export interface ChatSessionSummary { id: string; title: string; createdAt: string; updatedAt: string; costUsd: number; turns: number }
export interface ChatTurnView { id: string; seq: number; userText: string; text: string; parts: ChatPart[]; refs: ChatRef[]; costUsd: number; createdAt: string }
export const listChatSessions = (limit = 30) => call<{ sessions: ChatSessionSummary[] }>('listChatSessions', { limit });
export const getChatSession = (id: string) => call<{ session: ChatSessionSummary; turns: ChatTurnView[] }>('getChatSession', { id });
export const deleteChatSession = (id: string) => call<{ deleted: boolean }>('deleteChatSession', { id });
