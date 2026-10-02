/**
 * ONE agent run. Never throws; one run at a time (in-flight guard).
 *
 * Per thread:
 *   parse whole thread → existing unsent draft? (#73: skip) → deterministic
 *   pre-screen (automated → skip #17, crypto/WhatsApp pay → spam #69) →
 *   triage (stage, edge case, GOAL, hard routes) → spam / skip / reputation-legal
 *   flag (#72) → fit check for new products (#41) or standout check for
 *   service providers (#44) → draft (Opus, full context) or ask Jake (#8 #23
 *   #27 #40 #43 #46) → code checks + checker model (#73) → one redraft on
 *   failure → still failing → flagged, no draft → apply: Gmail label + board
 *   move/create (#13), Gmail DRAFT (#15), Slack question/flag.
 *
 * PREVIEW (safe default — both switches off, or preview:true): everything is
 * computed and stored in the Lab; nothing is written to Gmail, Slack or the
 * board. Gmail is only READ.
 */
import { withUsageScope, type ScopedCall } from "../../ai/usageScope.js";
import { HANDLERS as DEAL_HANDLERS } from "../handlers.js";
import { loadStageConfig } from "../stageUtils.js";
import { gmailConnected, gmailSlackThreadUrl, listThreads, getThread, getDraft, listLabels, ensureLabel, modifyThread, markThreadSpam, createReplyDraft } from "../integrations/gmail.js";
import { slackStatus } from "../integrations/slack.js";
import { fetchAudienceSnapshot } from "../../audit/analytics.js";
import { getSettings, type AgentSettings } from "./settings.js";
import {
  createRun, updateRun, getRun, lastRun, closeStaleRuns, insertItem, toItem, isHandled, markHandled, insertQuestion,
  setQuestionItem, answeredUnused, answersForThread, markQuestionUsed, pendingQuestionFor, relevantLessons, gmailUrl,
  watcherHoldsThread, agentDraftIdsForThread,
  emptyCounts, type AgentItem, type Check, type Counts, type Decision, type Fit, type RunSummary, type QuestionRow,
} from "./store.js";
import { prescreen, triageThread, type Triage } from "./triage.js";
import { checkFit } from "./fit.js";
import { computeAvailability, type Availability } from "./availability.js";
import { similarThreads, formatPastThreads, jakeVoiceSamples } from "./history.js";
import { writeDraft, toHtml, type DraftContext, type DraftResult } from "./draft.js";
import { codeChecks, modelCheck } from "./checks.js";
import { collectAnswers, formatQuestion, postToSlack } from "./slackLoop.js";
import { learnFromEdits, learnFromJakeReply } from "./learn.js";
import { runFollowUpStep } from "./followups.js";
import { findDeals, primaryDeal, dealContextText, brandHistoryText, transcriptOf } from "./context.js";
import {
  ACCOUNT_FALLBACK, parseGmailMessage, domainOf, rootDomain, longDate, errMsg, clip, priceCalls, modelNotes, draftModel, triageModel,
  type ParsedMessage,
} from "./util.js";

/* ── pre-run hooks (the integrator plugs the app's Gmail sync in here) ───── */

/** #73: the most unsent drafts a thread may hold before the agent stops adding one (Jake 2026-10-01: "up to 2 drafts is ok"). */
const MAX_DRAFTS_PER_THREAD = 2;

type PreRunStep = (log: (m: string) => void) => Promise<unknown>;
const preRunSteps: PreRunStep[] = [];
/** Run the registered pre-run steps (the centralized Gmail sync) on their own — used when the agent is disabled. */

export async function runPreRunSteps(log: (m: string) => void): Promise<void> {
  for (const step of preRunSteps) {
    try { await step(log); } catch (e) { log(`Pre-run step failed: ${errMsg(e)}`); }
  }
}
export function registerPreRunStep(fn: PreRunStep): void {
  if (!preRunSteps.includes(fn)) preRunSteps.push(fn);
}

/* ── in-flight guard ──────────────────────────────────────────────────────── */

let inFlight: { id: string; promise: Promise<RunSummary> } | null = null;
export function isRunning(): boolean {
  return inFlight !== null;
}

/* ── per-thread lock (additive 2026-10-01) ─────────────────────────────────
 * The scheduled/manual run and the Slack answer watcher (slackWatcher.ts) both
 * process threads; the same Gmail thread is never processed by both at once. */
const threadLocks = new Map<string, Promise<void>>();
export async function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadLocks.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const mine = prev.then(() => gate);
  threadLocks.set(threadId, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (threadLocks.get(threadId) === mine) threadLocks.delete(threadId);
  }
}

export interface RunOptions {
  trigger: "schedule" | "manual";
  forcePreview?: boolean;
  onProgress?: (message: string) => void;
  onItem?: (item: AgentItem) => void;
  /** Internal/testing: override the thread-selection window (hours back from now). */
  sinceHours?: number;
}

/** Gmail label per stage (the existing folder names; RateNegotiation/TimelinePush/DealAcceptance were never filed before → IN Negotiation). */
export const STAGE_LABEL: Record<string, string> = {
  Collaboration: "Jake - New Collab",
  Questions: "General Questions",
  CoachingInquiry: "General Questions",
  Reply: "IN Negotiation",
  RateNegotiation: "IN Negotiation",
  TimelinePush: "IN Negotiation",
  BriefReceived: "IN Negotiation",
  DealAcceptance: "IN Negotiation",
  ContractReceived: "IN Negotiation",
  GiftedProduct: "IN Negotiation",
  Editing: "Video Editing Offers",
  ReturningBrand: "Returning Client",
  PaymentConfirmed: "Started Production",
  AffiliatePitch: "Rejected",
  ConflictOfInterest: "Rejected",
  NicheMismatch: "Rejected",
  HighValueDeal: "High Value Negotiation",
  LongTermPartnership: "High Value Negotiation",
};

const NON_DEAL_STAGES = new Set(["Questions", "CoachingInquiry", "Editing", "Miscellaneous"]);
/** Routes the rulebook sends to Jake no matter what the drafter thinks. */
const ALWAYS_ASK = new Set(["#23", "#43"]);

export function runAgent(opts: RunOptions): Promise<RunSummary> {
  if (inFlight) {
    opts.onProgress?.("A run is already in progress — attaching to it.");
    return inFlight.promise;
  }
  closeStaleRuns();
  const settings = getSettings();
  const live = { gmail: !opts.forcePreview && settings.saveToGmail, slack: !opts.forcePreview && settings.postToSlack };
  const preview = !live.gmail && !live.slack;
  const run = createRun(opts.trigger, preview);
  const promise = (async () => {
    const calls: ScopedCall[] = [];
    try {
      return await withUsageScope({ calls }, () => runInner(run, settings, live, opts, calls));
    } catch (e) {
      updateRun(run.id, { status: "failed", error: errMsg(e), finished: true, costUsd: priceCalls(calls).usd });
      return getRun(run.id)!;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = { id: run.id, promise };
  return promise;
}

async function runInner(run: RunSummary, settings: AgentSettings, live: { gmail: boolean; slack: boolean }, opts: RunOptions, calls: ScopedCall[]): Promise<RunSummary> {
  const log: string[] = [];
  const progress = (m: string) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
    log.push(line);
    try { opts.onProgress?.(m); } catch { /* a closed stream never stops the run */ }
  };
  const counts: Counts = emptyCounts();
  progress(`Run started (${opts.trigger}) — ${live.gmail ? "Gmail drafts/labels/board ON" : "Gmail/board: preview only"}, ${live.slack ? "Slack ON" : "Slack: preview only"}. Models: draft/check ${draftModel()}, triage ${triageModel()}.`);

  const conn = gmailConnected();
  if (!conn.connected) throw new Error("Gmail is not connected — connect it on the Deal Organizer connections page.");
  const myEmail = (conn.email ?? ACCOUNT_FALLBACK).toLowerCase();

  for (const step of preRunSteps) {
    try { await step(progress); } catch (e) { progress(`Pre-run step failed (continuing): ${errMsg(e)}`); }
  }

  // Learn from what Jake sent since the last run (#9) and pick up his Slack answers.
  try { await learnFromEdits(myEmail, settings.signature, progress); } catch (e) { progress(`Learning step failed: ${errMsg(e)}`); }
  if (slackStatus().configured) {
    try { await collectAnswers(progress); } catch (e) { progress(`Slack read failed: ${errMsg(e)}`); }
  }

  const availability = computeAvailability();
  const stageCfg = await loadStageConfig();
  const labelIds = new Map<string, string>();
  try {
    const { labels = [] } = await listLabels();
    for (const l of labels) labelIds.set(l.name, l.id);
  } catch (e) { progress(`Could not list Gmail labels: ${errMsg(e)}`); }

  // ── work list ──
  const work: Array<{ threadId: string; answered?: QuestionRow[] }> = [];
  for (const q of answeredUnused(false)) {
    if (!work.some((w) => w.threadId === q.threadId)) work.push({ threadId: q.threadId, answered: [q] });
  }
  const sinceRun = opts.trigger === "manual" && !live.gmail ? null : lastRun({ preview: !live.gmail });
  const since = opts.sinceHours ? new Date(Date.now() - opts.sinceHours * 3600_000)
    : sinceRun ? new Date(Date.parse(sinceRun.startedAt) - 5 * 60_000) : new Date(Date.now() - 24 * 3600_000);
  progress(`Looking for inbound threads since ${since.toISOString()} (${opts.sinceHours ? `${opts.sinceHours}h override` : sinceRun ? "last comparable run" : "last 24h"}).`);
  const candidates: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const r = await listThreads(`in:inbox after:${Math.floor(since.getTime() / 1000)}`, 50, pageToken);
    for (const t of r.threads ?? []) candidates.push(t.id);
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  const loaded = new Map<string, any>();
  let automated = 0;
  for (const id of candidates) {
    if (work.length - automated >= settings.maxThreadsPerRun) break;
    if (work.some((w) => w.threadId === id)) continue;
    try {
      const t = await getThread(id);
      const msgs = (t.messages ?? []).map((m: any) => parseGmailMessage(m, myEmail)).filter((m: ParsedMessage) => !m.isDraft);
      const latest = msgs[msgs.length - 1];
      if (!latest || latest.isFromMe) continue;
      if (latest.date < since) continue;
      if (isHandled(id, latest.id)) continue;
      if (watcherHoldsThread(id, latest.id)) continue; // the Slack watcher is about to act on (or just asked about) this thread
      const pq = pendingQuestionFor(id);
      if (pq && pq.messageId === latest.id) continue; // still waiting for Jake
      loaded.set(id, t);
      work.push({ threadId: id });
      if (prescreen(latest, msgs)?.kind === "skip") automated++; // free skips don't use up the cap
    } catch (e) {
      progress(`Could not read thread ${id}: ${errMsg(e)}`);
    }
  }
  progress(`${work.length} thread(s) to handle (${automated} automated; cap ${settings.maxThreadsPerRun} real threads).`);

  // ── process, 3 at a time ──
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const w = work[next++];
      const item = await withThreadLock(w.threadId, () => processThread({
        runId: run.id, threadId: w.threadId, thread: loaded.get(w.threadId), answered: w.answered ?? [], myEmail, settings, live,
        availability, stageCfg, labelIds, progress,
      }));
      if (!item) continue;
      counts.threads++;
      const k: Record<Decision, keyof Counts> = { draft: "drafted", skip: "skipped", spam: "spam", flag: "flagged", ask: "asked" };
      counts[k[item.decision]]++;
      updateRun(run.id, { counts, log });
      try { opts.onItem?.(item); } catch { /* ignore */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // ── focus scores → follow-up cadence → auto-close (agent/followups.ts; additive 2026-09-30) ──
  try {
    await runFollowUpStep({
      runId: run.id, live, myEmail, signature: settings.signature, progress, counts,
      onItem: (it) => { try { opts.onItem?.(it); } catch { /* ignore */ } },
      saveCounts: () => updateRun(run.id, { counts, log }),
    });
  } catch (e) { progress(`Follow-up step failed: ${errMsg(e)}`); }

  const cost = priceCalls(calls);
  if (counts.followUps || counts.closed) progress(`Follow-ups: ${counts.followUps ?? 0} drafted, ${counts.closed ?? 0} deal(s) auto-closed as ghosted.`);
  progress(`Done. ${counts.threads} threads: ${counts.drafted} drafted, ${counts.asked} asked, ${counts.flagged} flagged, ${counts.spam} spam, ${counts.skipped} skipped. AI cost ≈ $${cost.usd.toFixed(3)} (${Object.entries(cost.byModel).map(([m, v]) => `${m} $${v.toFixed(3)}`).join(", ")}).`);
  for (const n of modelNotes.splice(0)) progress(`Model note: ${n}`);
  updateRun(run.id, { counts, status: "done", finished: true, costUsd: cost.usd, log });
  return getRun(run.id)!;
}

/* ── one thread ───────────────────────────────────────────────────────────── */

interface ThreadJob {
  runId: string;
  threadId: string;
  thread?: any;
  answered: QuestionRow[];
  myEmail: string;
  settings: AgentSettings;
  live: { gmail: boolean; slack: boolean };
  availability: Availability;
  stageCfg: Awaited<ReturnType<typeof loadStageConfig>>;
  labelIds: Map<string, string>;
  progress: (m: string) => void;
  /** Slack watcher only: extra instruction appended for the drafter. */
  note?: string;
  /** Slack watcher only: Gmail message ids of the agent's OWN earlier unsent drafts — they don't block a new draft (#73). */
  ownDraftMsgIds?: Set<string>;
  /** Slack watcher only: instead of posting a new top-level Slack question/flag, hand it back to be said in the existing thread. */
  slackSink?: (kind: "question" | "flag", q: { question: string; proposal: string | null; rule: string }) => void;
}

async function processThread(job: ThreadJob): Promise<AgentItem | null> {
  const { threadId, progress, live, settings } = job;
  let thread = job.thread;
  try {
    if (!thread) thread = await getThread(threadId);
  } catch (e) {
    progress(`Could not load thread ${threadId}: ${errMsg(e)}`);
    return null;
  }
  const all: ParsedMessage[] = (thread.messages ?? []).map((m: any) => parseGmailMessage(m, job.myEmail));
  const msgs = all.filter((m) => !m.isDraft);
  const latest = msgs[msgs.length - 1];
  if (!latest) return null;
  const subject = msgs[0]?.subject || latest.subject || "(no subject)";
  const from = latest.from || latest.fromEmail;

  const base = {
    runId: job.runId, preview: !live.gmail, threadId, messageId: latest.id, subject, from,
    brand: null as string | null, stage: "Miscellaneous", edgeCase: null as string | null, goal: null as string | null,
    fit: null as Fit | null, draftText: null as string | null, checks: [] as Check[], gmailDraftId: null as string | null,
    slackPermalink: null as string | null, dealId: null as string | null, label: null as string | null, boardStage: null as string | null,
    applied: [] as string[],
  };
  const finish = (decision: Decision, reason: string, extra: Partial<typeof base> = {}): AgentItem => {
    const applied = [...base.applied, ...(extra.applied ?? [])];
    const row = { ...base, ...extra, decision, reason: applied.length ? `${reason} · ${applied.join("; ")}` : reason };
    const id = insertItem(row);
    const errored = reason.startsWith("Agent error");
    if (live.gmail && decision !== "ask" && !errored) markHandled(threadId, latest.id, job.runId, id, decision);
    for (const q of job.answered) {
      setQuestionItem(q.id, id);
      if (live.gmail && !errored) markQuestionUsed(q.id);
    }
    progress(`[${decision.toUpperCase()}] ${clip(subject, 70)} — ${clip(row.reason, 240)}`);
    return toItem({
      id, thread_id: threadId, subject, from_addr: from, brand: row.brand, stage: row.stage, edge_case: row.edgeCase, decision, reason: row.reason,
      fit: row.fit ? JSON.stringify(row.fit) : null, draft_text: row.draftText, checks: JSON.stringify(row.checks), gmail_draft_id: row.gmailDraftId,
      slack_permalink: row.slackPermalink, deal_id: row.dealId, created_at: new Date().toISOString(),
    });
  };

  try {
    // #73 (Jake 2026-10-01): up to MAX_DRAFTS_PER_THREAD unsent drafts per thread — ours, Jake's or the old automation's
    // all count. One waiting draft → the agent may add a second; Jake chooses which to delete.
    if (all.filter((m) => m.isDraft).length >= MAX_DRAFTS_PER_THREAD) {
      return finish("skip", `${MAX_DRAFTS_PER_THREAD} unsent drafts are already waiting in this thread (#73) — delete one and the agent can draft again.`);
    }

    const pre = prescreen(latest, msgs);
    if (pre?.kind === "skip") return finish("skip", pre.why);
    if (pre?.kind === "spam") {
      if (live.gmail) { await markThreadSpam(threadId); base.applied.push("marked spam"); }
      else base.applied.push("(preview) would mark spam");
      return finish("spam", pre.why);
    }

    const transcript = transcriptOf(msgs);
    const senderEmails = msgs.filter((m) => !m.isFromMe).map((m) => m.fromEmail);
    const deals = findDeals(threadId, senderEmails);
    let deal = primaryDeal(deals);
    const dealContext = dealContextText(deals);
    const brandHistory = brandHistoryText(threadId, latest.fromEmail);
    const jakeHasReplied = msgs.some((m) => m.isFromMe);
    const answers = answersForThread(threadId);
    const jakeAnswers = answers.map((a) => `Q: ${a.question}\nJake: ${a.answer}`).join("\n\n");

    const tri: Triage = await triageThread({ transcript, subject, latestFrom: from, dealContext, brandHistory, jakeHasReplied });
    Object.assign(base, { brand: tri.brand, stage: tri.stage, edgeCase: tri.edgeCase, goal: tri.goal });
    deal = primaryDeal(deals, tri.brand);
    base.dealId = deal?.id ?? null;

    // Model-judged spam needs HIGH confidence, and never on a thread Jake has already engaged in
    // (a real conversation is not a cold scam). Lower-confidence doubts are passed to the drafter/reason.
    const spamOk = tri.suspicious.is && tri.suspicious.confidence === "high" && !jakeHasReplied && !deal;
    if (tri.suspicious.is && !spamOk) progress(`Sender doubt NOT treated as spam (${tri.suspicious.confidence}${jakeHasReplied ? ", Jake already replied" : ""}${deal ? ", known deal" : ""}): ${clip(tri.suspicious.why, 160)}`);
    if (spamOk) {
      if (live.gmail) { await markThreadSpam(threadId); base.applied.push("marked spam"); }
      else base.applied.push("(preview) would mark spam");
      return finish("spam", `Suspicious sender (#69): ${tri.suspicious.why} — marked spam, no reply, no Slack.`);
    }
    if (tri.stage === "Miscellaneous" || tri.category === "automated" || tri.category === "personal") {
      return finish("skip", `Miscellaneous (#17): ${tri.goal || "no reply needed"}`);
    }
    // Jake replied to a flag on Slack (watcher) → his reply is the instruction; the drafter follows it.
    const flagInstruction = job.answered.some((q) => q.kind === "flag");
    if (tri.reputationLegalRisk.is && !flagInstruction) {
      const perm = await slackOut(job, "flag", { subject, from, brand: tri.brand, stage: tri.stage, goal: tri.goal, question: `Reputation / legal risk (#72): ${tri.reputationLegalRisk.why}. I have not replied.`, proposal: null, rule: "#72", messageId: latest.id });
      return finish("flag", `Reputation/legal risk (#72): ${tri.reputationLegalRisk.why} — no reply; flagged on Slack.`, { slackPermalink: perm });
    }

    // ── fit (#41) / standout (#44) ──
    const urls = [...new Set(msgs.filter((m) => !m.isFromMe).flatMap((m) => (m.fresh.match(/https?:\/\/[^\s)>\]"]+/g) ?? [])))].slice(0, 10);
    const senderDomain = rootDomain(domainOf(latest.fromEmail));
    const productDomain = tri.productUrl ? (() => { try { return new URL(tri.productUrl!).hostname.replace(/^www\./, ""); } catch { return null; } })() : null;
    let fit: (Fit & { standout?: boolean }) | null = null;
    const newProduct = tri.category === "sponsor" && (tri.isNewBrand || ["Collaboration", "HighValueDeal", "LongTermPartnership", "NicheMismatch", "GiftedProduct", "AffiliatePitch", "ReturningBrand"].includes(tri.stage));
    if (tri.stage === "Editing" || tri.category === "service") {
      fit = await checkFit({ kind: "service", brand: tri.brand || latest.fromName, product: tri.product, domain: productDomain || senderDomain, urls, emailSummary: tri.goal, log: progress });
    } else if (newProduct && (tri.brand || tri.product)) {
      fit = await checkFit({ kind: "product", brand: tri.brand || tri.product!, product: tri.product, domain: productDomain, urls, emailSummary: tri.goal, log: progress });
    }
    base.fit = fit ? { verdict: fit.verdict, angle: fit.angle, notes: fit.notes } : null;

    if (fit?.standout && !answers.length) {
      return await askJake(job, base, finish, tri, latest, {
        question: `A service provider with a genuinely standout portfolio (#44): ${fit.notes} Do you want to review them before I send the usual polite no?`,
        proposal: "Otherwise I'll draft the standard polite decline.", rule: "#44",
      }, null);
    }

    // ── audience data (#66) ──
    let audience = "";
    if (tri.asks.audienceData) {
      try {
        const s = await fetchAudienceSnapshot(90);
        audience = [
          `Last 90 days (${s.from} → ${s.to}), ${s.totalViews.toLocaleString("en-US")} views.`,
          `Top countries: ${s.countries.slice(0, 5).map((c) => `${c.country} ${c.share}%`).join(", ")}`,
          `Age: ${s.ageGroups.map((a) => `${a.ageGroup} ${a.percent.toFixed(1)}%`).join(", ")}`,
          `Gender: ${s.gender.map((g) => `${g.gender} ${g.percent.toFixed(1)}%`).join(", ")}`,
        ].join("\n");
      } catch (e) { progress(`Audience snapshot unavailable: ${errMsg(e)}`); }
    }

    // ── draft ──
    const firstReply = !jakeHasReplied;
    const lessons = relevantLessons(tri.brand, tri.stage).map((l) => `${l.brand ? `[${l.brand}] ` : l.stage ? `[${l.stage}] ` : ""}${l.lesson}`);
    const past = similarThreads({ threadId, stage: tri.stage, edgeCase: tri.edgeCase, goal: tri.goal, brand: tri.brand, domain: senderDomain, subject });
    const flags: string[] = [];
    if (tri.minor.is) flags.push(`MINOR (#72): ${tri.minor.why} — no paid offer of any kind, keep it short and helpful.`);
    if (tri.needsJake.length) flags.push(`Triage thinks Jake must decide: ${tri.needsJake.map((n) => `${n.rule} ${n.why}`).join("; ")}. If you agree (or anything else needs Jake), return action "ask". If Jake's Slack answers already settle it, draft.`);
    if (tri.asks.counterOfferUsd) flags.push(`Their counter-offer: $${tri.asks.counterOfferUsd}. Apply #19/#27 (below $4,000 → hold $6,500; $4,000+ → come down to $6,000; below $6,000 for a great fit with next month at ${job.availability.nextMonthBookings} booking(s) → ask Jake).`);
    if (tri.asks.audienceData && !audience) flags.push("They asked for audience data but the live snapshot is unavailable — ask Jake.");
    if (tri.asks.audienceData) flags.push("If they ask for the share of business owners: we have no such figure — ask Jake rather than inventing one. Screenshots can't be attached by you; give the key numbers in the text.");
    if (tri.asks.shorts) flags.push("They asked about Shorts: $2,500 per Short, never discounted, can be sold on their own (#21).");
    if (fit?.verdict === "none") flags.push("Fit check says NO FIT (#41) — politely decline (unless the thread shows Jake already accepted this brand).");
    if (fit?.verdict === "partial" && fit.angle) flags.push(`Partial fit (#41): make the paid offer and say openly which angle we need: ${fit.angle}`);
    if (tri.reputationLegalRisk.is && flagInstruction) flags.push(`Reputation / legal risk (#72) was flagged to Jake: ${tri.reputationLegalRisk.why}. Jake replied on Slack (see his answers) — follow his instruction exactly; if he says not to reply, return no_reply.`);

    const ctx: DraftContext = {
      todayLine: `Today is ${longDate(new Date())} (Bangkok).`,
      subject, latestFromName: latest.fromName, transcript, firstReply, stage: tri.stage, edgeCase: tri.edgeCase, goal: tri.goal,
      brand: tri.brand, product: tri.product, triageFlags: flags.join("\n"), dealContext, brandHistory,
      availabilityText: job.availability.text,
      fitText: fit ? `${fit.verdict.toUpperCase()}${fit.angle ? ` — angle: ${fit.angle}` : ""}. ${fit.notes}` : "",
      pastThreads: formatPastThreads(past),
      voiceSamples: jakeVoiceSamples(past.map((p) => p.threadId)),
      lessons, jakeAnswers, audienceSnapshot: audience,
      extraInstructions: [
        job.answered.length ? `Jake has just answered your Slack question about this thread (see his answers above). Now write the reply using his answer — do not ask the same thing again.` : "",
        job.note ?? "",
      ].filter(Boolean).join("\n"),
      boardStages: job.stageCfg.stagesForAI,
    };

    let d: DraftResult = await writeDraft(ctx);
    const forced = tri.needsJake.find((n) => ALWAYS_ASK.has(`#${n.rule.replace(/[^0-9]/g, "")}`));
    if (d.action === "draft" && forced && !answers.length) {
      d = { ...d, action: "ask", ask: { question: `${forced.why} (rule ${forced.rule} — every such request goes to you).`, proposal: `Draft I'd send if you agree:\n${d.body}`, rule: forced.rule } };
    }
    if (d.action === "no_reply") {
      return finish("skip", `No reply needed: ${d.summary} (board and labels left unchanged — any card move mentioned is a suggestion for Jake)`);
    }
    if (d.action === "ask") {
      return await askJake(job, base, finish, tri, latest, d.ask ?? { question: d.summary || "How should I answer this one?", proposal: "", rule: "" }, d);
    }

    // ── checks (#73) — one redraft on failure ──
    const inboundText = msgs.filter((m) => !m.isFromMe).map((m) => m.fresh).join("\n");
    const earlierJakeText = msgs.filter((m) => m.isFromMe).map((m) => m.fresh).join("\n");
    const approvedOverrides = answers.map((a) => a.answer ?? "").join("\n");
    const runChecks = async (body: string): Promise<Check[]> => {
      const full = `${body}\n\n${settings.signature}`;
      const code = codeChecks({ body: full, signature: settings.signature, firstReply, inboundText, approvedOverrides, earlierJakeText, fitVerdict: answers.length ? null : fit?.verdict ?? null });
      let model: Check[] = [];
      try {
        model = await modelCheck({
          draft: full, transcript, triageGoal: tri.goal, availabilityText: job.availability.text, jakeAnswers, firstReply, todayLine: ctx.todayLine,
          facts: [ctx.fitText ? `Product fit (#41): ${ctx.fitText}` : "", audience ? `Live audience snapshot (#66):\n${audience}` : "", dealContext ? `Board record:\n${dealContext}` : ""].filter(Boolean).join("\n\n"),
        });
      } catch (e) {
        model = [{ name: "model_check", ok: false, detail: `Checker model failed: ${errMsg(e)}` }];
      }
      return [...code, ...model];
    };
    let checks = await runChecks(d.body);
    if (checks.some((c) => !c.ok)) {
      const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
      progress(`Redrafting "${clip(subject, 60)}" — ${clip(problems.join(" | "), 240)}`);
      const d2 = await writeDraft(ctx, { previous: d.body, problems });
      if (d2.action === "ask") return await askJake(job, base, finish, tri, latest, d2.ask ?? { question: d2.summary, proposal: "", rule: "" }, d2);
      if (d2.action === "no_reply") return finish("skip", `No reply needed: ${d2.summary}`);
      d = d2;
      checks = await runChecks(d.body);
    }
    const draftText = `${d.body}\n\n${settings.signature}`;
    base.checks = checks;
    base.draftText = draftText;
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      return finish("flag", `Draft failed the pre-save checks twice — not saved: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`);
    }

    // ── apply: label + board + draft (live) ──
    await applyLabelAndBoard(job, base, tri, deal, d, latest);
    if (live.gmail) {
      // Re-check right before writing: a draft may have appeared since we read the thread.
      const fresh = await getThread(threadId);
      if ((fresh.messages ?? []).filter((m: any) => (m.labelIds ?? []).includes("DRAFT")).length >= MAX_DRAFTS_PER_THREAD) {
        return finish("skip", `Drafts appeared in this thread while the agent was working — ${MAX_DRAFTS_PER_THREAD} are already waiting (#73), not writing another.`);
      }
      const r = await createReplyDraft({
        threadId,
        to: latest.replyTo || latest.from,
        cc: ccFor(latest, job.myEmail),
        subject,
        body: draftText,
        html: toHtml(draftText),
        inReplyTo: latest.messageIdHeader || undefined,
        references: [latest.references, latest.messageIdHeader].filter(Boolean).join(" ") || undefined,
      });
      base.gmailDraftId = r?.id ?? null;
      base.applied.push("Gmail draft saved");
    } else {
      base.applied.push("(preview) draft stored in the Lab only");
    }

    if (tri.minor.is) {
      const perm = await slackOut(job, "flag", { subject, from, brand: tri.brand, stage: tri.stage, goal: tri.goal, question: `Minor (#72): ${tri.minor.why}. I drafted a short, helpful reply with no paid offer${live.gmail ? " (saved as a Gmail draft)" : ""}.`, proposal: null, rule: "#72", messageId: latest.id });
      return finish("flag", `Minor (#72) — short helpful reply drafted, no paid offer; flagged on Slack. ${d.summary}`, { slackPermalink: perm });
    }
    return finish("draft", d.summary || `Drafted a ${tri.stage} reply.`);
  } catch (e) {
    return finish("flag", `Agent error on this thread — nothing written: ${errMsg(e)}`);
  }
}

function ccFor(latest: ParsedMessage, myEmail: string): string | undefined {
  const all = [latest.to, latest.cc].join(",").split(",").map((s) => s.trim()).filter(Boolean);
  const reply = (latest.replyTo || latest.from).toLowerCase();
  const keep = all.filter((a) => {
    const e = a.toLowerCase();
    return !e.includes(myEmail) && !reply.includes(e.replace(/.*</, "").replace(/>.*/, ""));
  });
  return keep.length ? [...new Set(keep)].join(", ") : undefined;
}

async function slackOut(
  job: ThreadJob,
  kind: "question" | "flag",
  q: { subject: string; from: string; brand: string | null; stage: string; goal: string; question: string; proposal: string | null; rule: string; messageId: string },
): Promise<string | null> {
  if (job.slackSink) {
    job.slackSink(kind, { question: q.question, proposal: q.proposal, rule: q.rule });
    return null;
  }
  const text = formatQuestion({ kind, ...q, gmailUrl: gmailSlackThreadUrl(job.threadId) });
  let channel: string | null = null, ts: string | null = null, permalink: string | null = null;
  if (job.live.slack) {
    try {
      const r = await postToSlack(text);
      channel = r.channel; ts = r.ts; permalink = r.permalink;
    } catch (e) {
      job.progress(`Slack post failed for "${q.subject}": ${errMsg(e)}`);
    }
  }
  insertQuestion({
    runId: job.runId, preview: !job.live.slack, threadId: job.threadId, messageId: q.messageId, itemId: null, subject: q.subject,
    brand: q.brand, stage: q.stage, kind, question: q.question, proposal: q.proposal, slackChannel: channel, slackTs: ts, slackPermalink: permalink,
  });
  return permalink;
}

async function askJake(
  job: ThreadJob,
  base: any,
  finish: (d: Decision, reason: string, extra?: any) => AgentItem,
  tri: Triage,
  latest: ParsedMessage,
  ask: { question: string; proposal: string; rule: string },
  d: DraftResult | null,
): Promise<AgentItem> {
  if (d) await applyLabelAndBoard(job, base, tri, primaryDeal(findDeals(job.threadId, [latest.fromEmail]), tri.brand), d, latest);
  const perm = await slackOut(job, "question", {
    subject: base.subject, from: base.from, brand: tri.brand, stage: tri.stage, goal: tri.goal, question: ask.question, proposal: ask.proposal || null, rule: ask.rule, messageId: latest.id,
  });
  if (!job.live.slack) base.applied.push("(preview) Slack question stored in the Lab only");
  return finish("ask", `Asked Jake${ask.rule ? ` (${ask.rule})` : ""}: ${ask.question}${ask.proposal ? ` — proposal: ${clip(ask.proposal, 300)}` : ""}`, { slackPermalink: perm });
}

/* ── labels + board (#13) ─────────────────────────────────────────────────── */

async function applyLabelAndBoard(job: ThreadJob, base: any, tri: Triage, deal: ReturnType<typeof primaryDeal>, d: DraftResult, latest: ParsedMessage): Promise<void> {
  const declined = d.boardStage === "Rejected" || d.boardStage === "Poor Fit Now";
  const label = declined && tri.category === "sponsor" ? "Rejected" : STAGE_LABEL[tri.stage] ?? null;
  base.label = label;
  if (label) {
    if (job.live.gmail) {
      try {
        const id = job.labelIds.get(label) ?? (await ensureLabel(label));
        job.labelIds.set(label, id);
        await modifyThread(job.threadId, [id], []);
        base.applied.push(`label "${label}"`);
      } catch (e) { job.progress(`Label failed: ${errMsg(e)}`); }
    } else base.applied.push(`(preview) would label "${label}"`);
  }

  if (NON_DEAL_STAGES.has(tri.stage) || tri.category !== "sponsor") return;
  const cfg = job.stageCfg;
  const order = new Map(cfg.records.map((r) => [r.displayName ?? "", r.sortOrder ?? 0]));
  const DECLINE = new Set(["Rejected", "Poor Fit Now", "Potential Future Collaboration"]);
  const byStage: Record<string, string> = {
    Collaboration: "New Requests", HighValueDeal: "New Requests", LongTermPartnership: "New Requests", GiftedProduct: "New Requests", ReturningBrand: "New Requests",
    RateNegotiation: "Date/Contract Negotiation", TimelinePush: "Date/Contract Negotiation", BriefReceived: "Date/Contract Negotiation",
    DealAcceptance: "Date/Contract Negotiation", ContractReceived: "Date/Contract Negotiation", Reply: "Date/Contract Negotiation",
    ConflictOfInterest: "Date/Contract Negotiation", AffiliatePitch: "Date/Contract Negotiation", NicheMismatch: "Poor Fit Now",
  };
  // The drafter may only pick a DECLINE column (it knows when it declined); otherwise the column follows the stage.
  let wanted: string | null = d.boardStage && DECLINE.has(d.boardStage) && order.has(d.boardStage) ? d.boardStage : byStage[tri.stage] ?? null;
  if (!wanted || !order.has(wanted)) return;
  // Pre-production deals only move FORWARD (or to a decline column): never back from Waiting For Payment to Negotiation.
  if (deal && !cfg.prodDbNames.has(deal.stage) && !DECLINE.has(wanted) && (order.get(wanted) ?? 0) < (order.get(deal.stage) ?? 0) && !DECLINE.has(deal.stage)) wanted = deal.stage;
  // Guards: the agent never moves a deal INTO production (contract signed by both sides is a human fact),
  // and never moves a production deal backwards or out of production.
  if (cfg.prodDbNames.has(wanted) && !(deal && cfg.prodDbNames.has(deal.stage))) {
    job.progress(`Board: not moving "${tri.brand}" into production column "${wanted}" — production starts only when both sides signed; leaving it for Jake.`);
    return;
  }
  if (deal && cfg.prodDbNames.has(deal.stage) && (!cfg.prodDbNames.has(wanted) || (order.get(wanted) ?? 0) < (order.get(deal.stage) ?? 0))) return;
  base.boardStage = wanted;
  const key = cfg.fromDB[wanted];
  if (!job.live.gmail) {
    base.applied.push(deal ? (deal.stage === wanted ? `(preview) deal stays in "${wanted}"` : `(preview) would move deal "${deal.projectName || deal.clientName}" "${deal.stage}" → "${wanted}"`) : `(preview) would create a deal in "${wanted}"`);
    return;
  }
  try {
    if (deal) {
      if (deal.stage !== wanted) {
        await DEAL_HANDLERS.updateDeal({ id: deal.id, updates: { stage: key, ...(d.dealValueUsd ? { estimated_value: d.dealValueUsd } : {}) } });
        base.applied.push(`moved deal "${deal.stage}" → "${wanted}"`);
      }
      await DEAL_HANDLERS.addComment({ dealId: deal.id, content: `Agent: ${d.summary}`, author: "Agent" });
    } else {
      const r: any = await DEAL_HANDLERS.createDeal({
        client_name: tri.brand || latest.fromName,
        client_email: latest.fromEmail,
        project_name: tri.product || tri.brand || null,
        description: clip(tri.goal, 500),
        estimated_value: d.dealValueUsd,
        stage: key,
        source: "agent",
        source_email_id: latest.id,
        source_thread_id: job.threadId,
      });
      base.dealId = r?.deal?.id ?? null;
      base.applied.push(`created deal in "${wanted}"`);
    }
  } catch (e) {
    job.progress(`Board update failed: ${errMsg(e)}`);
  }
}

/* ── ONE answered thread, now (the Slack answer watcher; additive 2026-10-01) ──
 *
 * The same path the scheduled run takes for an answered question — the full
 * processThread pipeline (triage → fit → draft → checks → label/board → Gmail
 * draft), with the live switches read fresh — for ONE thread, right away.
 * Recorded as its own run row with trigger "slack" (which never moves the
 * scheduled run's inbox window). Differences, all opt-in via ThreadJob:
 *   - the agent's OWN earlier unsent draft does not block a new one (#73
 *     still blocks any draft that isn't ours). The allow-list has no draft
 *     update/delete, so the old one stays and `ownDraftLeftBehind` says so;
 *   - a follow-up question / flag is returned (`slackNotes`) for the caller to
 *     say in the existing Slack thread instead of opening a new one.
 * Never throws for thread-level problems (they come back as the item).
 */
export interface AnsweredThreadResult {
  runId: string | null;
  live: { gmail: boolean; slack: boolean };
  item: AgentItem | null;
  /** Set when nothing was processed, with the reason. */
  skipped: string | null;
  slackNotes: Array<{ kind: "question" | "flag"; question: string; proposal: string | null; rule: string }>;
  /** A new draft was saved while the agent's earlier unsent draft is still in the thread. */
  ownDraftLeftBehind: boolean;
  costUsd: number;
}

export async function reprocessAnsweredThread(input: {
  threadId: string;
  answered: QuestionRow[];
  note?: string;
  progress?: (m: string) => void;
}): Promise<AnsweredThreadResult> {
  const settings = getSettings();
  const live = { gmail: settings.saveToGmail, slack: settings.postToSlack };
  const empty = (skipped: string): AnsweredThreadResult => ({ runId: null, live, item: null, skipped, slackNotes: [], ownDraftLeftBehind: false, costUsd: 0 });
  if (!settings.enabled) return empty("the agent is switched off");
  const conn = gmailConnected();
  if (!conn.connected) throw new Error("Gmail is not connected — connect it on the Deal Organizer connections page.");
  const myEmail = (conn.email ?? ACCOUNT_FALLBACK).toLowerCase();

  const run = createRun("slack", !live.gmail && !live.slack);
  const log: string[] = [];
  const progress = (m: string) => {
    log.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
    try { input.progress?.(m); } catch { /* ignore */ }
  };
  const calls: ScopedCall[] = [];
  const slackNotes: AnsweredThreadResult["slackNotes"] = [];
  try {
    return await withUsageScope({ calls }, async () => {
      const counts = emptyCounts();
      const r = await withThreadLock(input.threadId, async (): Promise<AnsweredThreadResult> => {
        const thread = await getThread(input.threadId);
        const all: ParsedMessage[] = (thread.messages ?? []).map((m: any) => parseGmailMessage(m, myEmail));
        const latest = all.filter((m) => !m.isDraft).pop();
        if (latest?.isFromMe) {
          for (const q of input.answered) if (live.gmail) markQuestionUsed(q.id);
          // Jake 2026-10-01: do nothing in Gmail, but learn from the email he sent himself.
          const askedAt = Math.min(...input.answered.map((q) => Date.parse(q.askedAt)).filter(Number.isFinite));
          const sentByJake = all.filter((m) => m.isFromMe && !m.isDraft && (!Number.isFinite(askedAt) || m.date.getTime() >= askedAt - 6 * 3_600_000));
          const lessons = await learnFromJakeReply({
            brand: input.answered[0]?.brand ?? null, stage: input.answered[0]?.stage ?? null, subject: input.answered[0]?.subject ?? latest.subject ?? "",
            questions: input.answered.map((q) => ({ id: q.id, question: q.question, proposal: q.proposal, answer: q.answer })),
            sent: (sentByJake.length ? sentByJake : [latest]).map((m) => m.fresh), signature: settings.signature, log: progress,
          });
          return { ...empty(`you had already replied in this Gmail thread, so I left it as it is${lessons ? ` and learned ${lessons === 1 ? "a lesson" : `${lessons} lessons`} from what you sent` : ""}`), runId: run.id };
        }
        // The agent's own unsent drafts (draft id → current message id); a deleted/sent one just 404s.
        const own = new Set<string>();
        for (const id of agentDraftIdsForThread(input.threadId)) {
          try { const d = await getDraft(id); if (d?.message?.id) own.add(d.message.id); } catch { /* gone */ }
        }
        const ownBefore = all.some((m) => m.isDraft && own.has(m.id));
        const labelIds = new Map<string, string>();
        try {
          const { labels = [] } = await listLabels();
          for (const l of labels) labelIds.set(l.name, l.id);
        } catch (e) { progress(`Could not list Gmail labels: ${errMsg(e)}`); }
        const item = await processThread({
          runId: run.id, threadId: input.threadId, thread, answered: input.answered, myEmail, settings, live,
          availability: computeAvailability(), stageCfg: await loadStageConfig(), labelIds, progress,
          note: input.note, ownDraftMsgIds: own, slackSink: (kind, q) => slackNotes.push({ kind, ...q }),
        });
        return { runId: run.id, live, item, skipped: null, slackNotes, ownDraftLeftBehind: Boolean(ownBefore && item?.gmailDraftId), costUsd: 0 };
      });
      if (r.item) {
        counts.threads++;
        const k: Record<Decision, keyof Counts> = { draft: "drafted", skip: "skipped", spam: "spam", flag: "flagged", ask: "asked" };
        counts[k[r.item.decision]]++;
      } else if (r.skipped) progress(`Nothing processed: ${r.skipped}`);
      const cost = priceCalls(calls);
      updateRun(run.id, { counts, status: "done", finished: true, costUsd: cost.usd, log });
      return { ...r, costUsd: cost.usd };
    });
  } catch (e) {
    updateRun(run.id, { status: "failed", error: errMsg(e), finished: true, costUsd: priceCalls(calls).usd, log });
    throw e;
  }
}

/**
 * TESTING ONLY — replay historical threads as if they had just arrived, cut
 * right after inbound message `cut` (0-based index into the non-draft
 * messages). Always a preview: nothing is written anywhere but the Lab tables.
 */
export async function previewHistorical(cases: Array<{ threadId: string; cut: number }>, onProgress?: (m: string) => void): Promise<RunSummary> {
  const settings = getSettings();
  const live = { gmail: false, slack: false };
  const run = createRun("manual", true);
  const calls: ScopedCall[] = [];
  return withUsageScope({ calls }, async () => {
    const progress = (m: string) => onProgress?.(m);
    const conn = gmailConnected();
    const myEmail = (conn.email ?? ACCOUNT_FALLBACK).toLowerCase();
    const availability = computeAvailability();
    const stageCfg = await loadStageConfig();
    const counts = emptyCounts();
    for (const c of cases) {
      const t = await getThread(c.threadId);
      const nonDraft = (t.messages ?? []).filter((m: any) => !(m.labelIds ?? []).includes("DRAFT"));
      const thread = { ...t, messages: nonDraft.slice(0, c.cut + 1) };
      const item = await processThread({ runId: run.id, threadId: c.threadId, thread, answered: [], myEmail, settings, live, availability, stageCfg, labelIds: new Map(), progress });
      if (!item) continue;
      counts.threads++;
      const k: Record<Decision, keyof Counts> = { draft: "drafted", skip: "skipped", spam: "spam", flag: "flagged", ask: "asked" };
      counts[k[item.decision]]++;
    }
    updateRun(run.id, { counts, status: "done", finished: true, costUsd: priceCalls(calls).usd });
    progress(`historical preview cost ≈ $${priceCalls(calls).usd}`);
    return getRun(run.id)!;
  });
}

/* ── PREVIEW DRAFT for one thread (additive, 2026-09-30) ──────────────────────
 *
 * The agent's per-thread pipeline — triage → fit → context → writeDraft →
 * codeChecks + modelCheck with one redraft — for ONE thread, on demand (the
 * Deal Organizer chat and Emails page, via deals/draftService.ts). Same models,
 * same rulebook, same checks, same signature as processThread above.
 *
 * PURE PREVIEW: nothing is written anywhere — no agent item, no "handled"
 * ledger, no Gmail draft / label / spam mark, no board move, no Slack. The
 * only Gmail call is one threads.get (read). The fit check may fill its own
 * 30-day cache (a cache, not a decision). processThread and runAgent are NOT
 * changed by this addition; the scheduled agent behaves exactly as before.
 *
 * Differences from processThread, because Jake himself asked for this draft:
 *   - hard routes (existing draft #73, automated/spam pre-screen, suspicious
 *     sender, reputation/legal, Miscellaneous) come back as `warnings` and the
 *     draft is still attempted — Jake decides;
 *   - `instructions` (Jake's own words) are binding for the drafter and are
 *     treated like a Slack answer by the price check;
 *   - an "ask" is returned to Jake as a question (with the proposal), not
 *     posted to Slack;
 *   - the reply headers needed to save the draft (sendReply) are returned.
 */
export interface PreviewDraftResult {
  threadId: string;
  action: "draft" | "ask" | "no_reply";
  /** Full email text incl. the standard signature (null unless action is "draft"). */
  draftText: string | null;
  body: string;
  checks: Check[];
  checksPassed: boolean;
  redrafted: boolean;
  ask: { question: string; proposal: string; rule: string } | null;
  summary: string;
  stage: string;
  edgeCase: string | null;
  goal: string;
  brand: string | null;
  product: string | null;
  fit: (Fit & { standout?: boolean }) | null;
  /** The board column the drafter thinks this deal belongs in — a SUGGESTION, nothing is moved. */
  suggestedBoardStage: string | null;
  dealValueUsd: number | null;
  deal: { id: string; stage: string; name: string } | null;
  warnings: string[];
  reply: { toEmail: string; cc: string | null; subject: string; lastMessageId: string; lastReferences: string; dealId: string };
  costUsd: number;
  models: { draft: string; triage: string };
}

export async function previewDraftForThread(opts: { threadId: string; instructions?: string; onProgress?: (m: string) => void }): Promise<PreviewDraftResult> {
  const calls: ScopedCall[] = [];
  const progress = (m: string) => { try { opts.onProgress?.(m); } catch { /* ignore */ } };
  return withUsageScope({ calls }, async () => {
    const settings = getSettings();
    const conn = gmailConnected();
    if (!conn.connected) throw new Error("Gmail is not connected — connect it on the Deal Organizer connections page.");
    const myEmail = (conn.email ?? ACCOUNT_FALLBACK).toLowerCase();
    const threadId = opts.threadId;
    const instructions = (opts.instructions ?? "").trim();
    const warnings: string[] = [];

    progress("Reading the thread…");
    const thread = await getThread(threadId);
    const all: ParsedMessage[] = (thread.messages ?? []).map((m: any) => parseGmailMessage(m, myEmail));
    const msgs = all.filter((m) => !m.isDraft);
    const latest = msgs[msgs.length - 1];
    if (!latest) throw new Error("This thread has no messages to reply to.");
    const subject = msgs[0]?.subject || latest.subject || "(no subject)";
    const from = latest.from || latest.fromEmail;
    const lastInbound = [...msgs].reverse().find((m) => !m.isFromMe) ?? null;
    const replyTarget = lastInbound ?? latest;

    if (all.some((m) => m.isDraft)) warnings.push("An unsent draft is already waiting in this thread (#73) — saving another one creates a second draft.");
    if (latest.isFromMe) warnings.push("Jake's message is the latest in this thread — this is a follow-up, not a reply.");
    const pre = prescreen(latest, msgs);
    if (pre) warnings.push(`Pre-screen: ${pre.why}`);

    const transcript = transcriptOf(msgs);
    const senderEmails = msgs.filter((m) => !m.isFromMe).map((m) => m.fromEmail);
    const deals = findDeals(threadId, senderEmails);
    const dealContext = dealContextText(deals);
    const brandHistory = brandHistoryText(threadId, replyTarget.fromEmail);
    const jakeHasReplied = msgs.some((m) => m.isFromMe);
    const answers = answersForThread(threadId);
    const jakeAnswers = answers.map((a) => `Q: ${a.question}\nJake: ${a.answer}`).join("\n\n");

    progress("Triage (goal, stage, routes)…");
    const tri: Triage = await triageThread({ transcript, subject, latestFrom: from, dealContext, brandHistory, jakeHasReplied });
    const deal = primaryDeal(deals, tri.brand);
    if (tri.suspicious.is) warnings.push(`Sender doubt (${tri.suspicious.confidence}): ${tri.suspicious.why}`);
    if (tri.reputationLegalRisk.is) warnings.push(`Reputation / legal risk (#72): ${tri.reputationLegalRisk.why}`);
    if (tri.stage === "Miscellaneous" || tri.category === "automated" || tri.category === "personal") warnings.push(`Triage says Miscellaneous (#17): ${tri.goal || "no reply needed"}`);
    for (const n of tri.needsJake) warnings.push(`Needs your decision (${n.rule}): ${n.why}`);

    // ── fit (#41) / standout (#44) — same selection as processThread ──
    const urls = [...new Set(msgs.filter((m) => !m.isFromMe).flatMap((m) => (m.fresh.match(/https?:\/\/[^\s)>\]"]+/g) ?? [])))].slice(0, 10);
    const senderDomain = rootDomain(domainOf(replyTarget.fromEmail));
    const productDomain = tri.productUrl ? (() => { try { return new URL(tri.productUrl!).hostname.replace(/^www\./, ""); } catch { return null; } })() : null;
    let fit: (Fit & { standout?: boolean }) | null = null;
    const newProduct = tri.category === "sponsor" && (tri.isNewBrand || ["Collaboration", "HighValueDeal", "LongTermPartnership", "NicheMismatch", "GiftedProduct", "AffiliatePitch", "ReturningBrand"].includes(tri.stage));
    if (tri.stage === "Editing" || tri.category === "service") {
      progress("Checking the service provider (#44)…");
      fit = await checkFit({ kind: "service", brand: tri.brand || replyTarget.fromName, product: tri.product, domain: productDomain || senderDomain, urls, emailSummary: tri.goal, log: progress });
    } else if (newProduct && (tri.brand || tri.product)) {
      progress(`Checking product fit for ${tri.brand || tri.product} (#41)…`);
      fit = await checkFit({ kind: "product", brand: tri.brand || tri.product!, product: tri.product, domain: productDomain, urls, emailSummary: tri.goal, log: progress });
    }
    if (fit?.standout) warnings.push(`Standout service provider (#44): ${fit.notes}`);

    // ── audience data (#66) ──
    let audience = "";
    if (tri.asks.audienceData) {
      try {
        const s = await fetchAudienceSnapshot(90);
        audience = [
          `Last 90 days (${s.from} → ${s.to}), ${s.totalViews.toLocaleString("en-US")} views.`,
          `Top countries: ${s.countries.slice(0, 5).map((c) => `${c.country} ${c.share}%`).join(", ")}`,
          `Age: ${s.ageGroups.map((a) => `${a.ageGroup} ${a.percent.toFixed(1)}%`).join(", ")}`,
          `Gender: ${s.gender.map((g) => `${g.gender} ${g.percent.toFixed(1)}%`).join(", ")}`,
        ].join("\n");
      } catch (e) { warnings.push(`Audience snapshot unavailable: ${errMsg(e)}`); }
    }

    const availability = computeAvailability();
    const stageCfg = await loadStageConfig();
    const firstReply = !jakeHasReplied;
    const lessons = relevantLessons(tri.brand, tri.stage).map((l) => `${l.brand ? `[${l.brand}] ` : l.stage ? `[${l.stage}] ` : ""}${l.lesson}`);
    const past = similarThreads({ threadId, stage: tri.stage, edgeCase: tri.edgeCase, goal: tri.goal, brand: tri.brand, domain: senderDomain, subject });
    const flags: string[] = [];
    if (tri.minor.is) flags.push(`MINOR (#72): ${tri.minor.why} — no paid offer of any kind, keep it short and helpful.`);
    if (tri.needsJake.length) flags.push(`Triage thinks Jake must decide: ${tri.needsJake.map((n) => `${n.rule} ${n.why}`).join("; ")}. If you agree (or anything else needs Jake) AND Jake's instructions below don't settle it, return action "ask". If Jake's Slack answers or instructions settle it, draft.`);
    if (tri.asks.counterOfferUsd) flags.push(`Their counter-offer: $${tri.asks.counterOfferUsd}. Apply #19/#27 (below $4,000 → hold $6,500; $4,000+ → come down to $6,000; below $6,000 for a great fit with next month at ${availability.nextMonthBookings} booking(s) → ask Jake).`);
    if (tri.asks.audienceData && !audience) flags.push("They asked for audience data but the live snapshot is unavailable — ask Jake.");
    if (tri.asks.audienceData) flags.push("If they ask for the share of business owners: we have no such figure — ask Jake rather than inventing one. Screenshots can't be attached by you; give the key numbers in the text.");
    if (tri.asks.shorts) flags.push("They asked about Shorts: $2,500 per Short, never discounted, can be sold on their own (#21).");
    if (fit?.verdict === "none") flags.push("Fit check says NO FIT (#41) — politely decline (unless the thread shows Jake already accepted this brand).");
    if (fit?.verdict === "partial" && fit.angle) flags.push(`Partial fit (#41): make the paid offer and say openly which angle we need: ${fit.angle}`);

    const extra = [
      "Jake is asking for this draft himself, right now, from the Deal Organizer (he reviews it before anything is saved).",
      latest.isFromMe ? "The latest message in the thread is Jake's own — the other side has not answered yet. Write the follow-up Jake would send (short, specific, one clear next step), unless his instructions say otherwise." : "",
      instructions ? `JAKE'S INSTRUCTIONS FOR THIS DRAFT (binding — they come from Jake himself and override the rulebook defaults where they conflict):\n${instructions}` : "",
    ].filter(Boolean).join("\n");

    const ctx: DraftContext = {
      todayLine: `Today is ${longDate(new Date())} (Bangkok).`,
      subject, latestFromName: replyTarget.fromName, transcript, firstReply, stage: tri.stage, edgeCase: tri.edgeCase, goal: tri.goal,
      brand: tri.brand, product: tri.product, triageFlags: flags.join("\n"), dealContext, brandHistory,
      availabilityText: availability.text,
      fitText: fit ? `${fit.verdict.toUpperCase()}${fit.angle ? ` — angle: ${fit.angle}` : ""}. ${fit.notes}` : "",
      pastThreads: formatPastThreads(past),
      voiceSamples: jakeVoiceSamples(past.map((p) => p.threadId)),
      lessons, jakeAnswers, audienceSnapshot: audience,
      extraInstructions: extra,
      boardStages: stageCfg.stagesForAI,
    };

    progress(`Drafting with ${draftModel()} + the rulebook…`);
    let d: DraftResult = await writeDraft(ctx);
    const forced = tri.needsJake.find((n) => ALWAYS_ASK.has(`#${n.rule.replace(/[^0-9]/g, "")}`));
    if (forced && !answers.length && !instructions) warnings.push(`Rule ${forced.rule}: ${forced.why} — the agent always asks you about this; review the draft carefully.`);

    const inboundText = msgs.filter((m) => !m.isFromMe).map((m) => m.fresh).join("\n");
    const earlierJakeText = msgs.filter((m) => m.isFromMe).map((m) => m.fresh).join("\n");
    const approvedOverrides = [...answers.map((a) => a.answer ?? ""), instructions].filter(Boolean).join("\n");
    const runChecks = async (body: string): Promise<Check[]> => {
      const full = `${body}\n\n${settings.signature}`;
      const code = codeChecks({ body: full, signature: settings.signature, firstReply, inboundText, approvedOverrides, earlierJakeText, fitVerdict: answers.length || instructions ? null : fit?.verdict ?? null });
      let model: Check[] = [];
      try {
        model = await modelCheck({
          draft: full, transcript, triageGoal: tri.goal, availabilityText: availability.text,
          jakeAnswers: [jakeAnswers, instructions ? `Jake's instructions for this draft:\n${instructions}` : ""].filter(Boolean).join("\n\n"),
          firstReply, todayLine: ctx.todayLine,
          facts: [ctx.fitText ? `Product fit (#41): ${ctx.fitText}` : "", audience ? `Live audience snapshot (#66):\n${audience}` : "", dealContext ? `Board record:\n${dealContext}` : ""].filter(Boolean).join("\n\n"),
        });
      } catch (e) {
        model = [{ name: "model_check", ok: false, detail: `Checker model failed: ${errMsg(e)}` }];
      }
      return [...code, ...model];
    };

    let checks: Check[] = [];
    let redrafted = false;
    if (d.action === "draft") {
      progress("Pre-save checks (code + checker model)…");
      checks = await runChecks(d.body);
      if (checks.some((c) => !c.ok)) {
        const problems = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
        progress(`Redrafting once — ${clip(problems.join(" | "), 200)}`);
        const d2 = await writeDraft(ctx, { previous: d.body, problems });
        redrafted = true;
        if (d2.action === "draft") {
          d = d2;
          checks = await runChecks(d.body);
        } else {
          d = { ...d2, body: d2.body || d.body };
          checks = [];
        }
      }
    }

    const cost = priceCalls(calls);
    const failed = checks.filter((c) => !c.ok);
    const toRaw = replyTarget.isFromMe ? (replyTarget.to || "") : (replyTarget.replyTo || replyTarget.from);
    const toEmail = (toRaw.match(/<([^>]+)>/)?.[1] ?? toRaw.split(",")[0] ?? "").trim();
    return {
      threadId,
      action: d.action,
      draftText: d.action === "draft" ? `${d.body}\n\n${settings.signature}` : null,
      body: d.body,
      checks,
      checksPassed: d.action === "draft" && failed.length === 0,
      redrafted,
      ask: d.action === "ask" ? (d.ask ?? { question: d.summary || "How should I answer this one?", proposal: "", rule: "" }) : null,
      summary: d.summary,
      stage: tri.stage,
      edgeCase: tri.edgeCase,
      goal: tri.goal,
      brand: tri.brand,
      product: tri.product,
      fit,
      suggestedBoardStage: d.boardStage,
      dealValueUsd: d.dealValueUsd,
      deal: deal ? { id: deal.id, stage: deal.stage, name: deal.projectName || deal.clientName } : null,
      warnings,
      reply: {
        toEmail,
        cc: replyTarget.isFromMe ? null : ccFor(replyTarget, myEmail) ?? null,
        subject: replyTarget.subject || subject,
        lastMessageId: latest.messageIdHeader,
        lastReferences: latest.references,
        dealId: deal?.id ?? "",
      },
      costUsd: cost.usd,
      models: { draft: draftModel(), triage: triageModel() },
    };
  });
}
