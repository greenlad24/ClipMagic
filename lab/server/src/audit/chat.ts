/**
 * Talking to a finished audit — and re-aiming it.
 *
 * A report is a snapshot of a catalogue, and a catalogue is a history. The
 * channel this was built against spent 2024 on scraping tutorials and now makes
 * AI tool reviews; 69 of its 117 videos predate the change. The era-relative
 * baseline handles a channel that GREW, but nothing in it handles a channel
 * that CHANGED — so every pattern, every topic and every "what wins here" is
 * weighted toward work the operator has already moved on from.
 *
 * Only the person who made the videos knows that. Hence a chat: they say what
 * changed, and the report is recomputed against the part of the catalogue that
 * still represents them.
 *
 * WHAT A REFOCUS DOES AND DOES NOT COST. The correlations, the pattern tables
 * and the ranks are pure arithmetic over data already on disk — recomputing
 * them over a subset is free and instant. Only the written verdicts need the
 * model again. So re-aiming a report is one call, not a re-run: no quota, no
 * thumbnails re-read, no competitors re-scanned.
 */
import { claudeJSONWithModel } from "../ai/claude.js";
import {
  titlePatternPerformance,
  titleStructureCorrelations,
  thumbnailCorrelations,
  splitWinnersLosers,
  evidencePool,
  marketRanks,
} from "./analysis.js";
import { ageCurve, median } from "./baseline.js";
import { writeReport } from "./ai.js";
import type { AuditFindings, AuditFocus, AuditRunResult, AuditVideo } from "./types.js";

/**
 * Explicitly Opus 5, not the director tier.
 *
 * The rest of the audit runs on the configured tiers. This one call reasons
 * over an entire finished report at once and is invoked a handful of times per
 * audit rather than per video, so it is the one place where the strongest model
 * is worth its price.
 */
export const CHAT_MODEL = "claude-opus-5";

const clip = (s: string, n: number) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

const CHAT_SYSTEM = `You are discussing a finished YouTube channel audit with the person it is about. You have the whole report and the underlying numbers.

Answer from the data you are given. If they ask something the audit did not measure, say so plainly rather than estimating — they will act on this, and a confident guess is worse than "the audit does not show that".

You can also RE-AIM the report. Channels change: a catalogue full of 2024 tutorials describes a channel that may no longer exist, and only the operator knows that. When they tell you the focus has moved, return an action and the findings are recomputed over just the part of the catalogue that still represents them. This is free and takes seconds — no quota, nothing re-scanned — so offer it whenever their answer implies the report is looking at the wrong videos.

You can also ADD A SECTION to the report. When they ask for something the report does not currently cover — "add a part about my Shorts", "I want a section on posting frequency vs the market" — return the add-section action. A separate pass then measures it against their real data, draws the charts and writes it into the report. It costs a couple of Opus calls, and sometimes a little YouTube quota if it has to go and fetch data nobody has pulled yet.

A section CAN compare this channel against ANOTHER NAMED CHANNEL — a URL, an @handle or a channel id — even one that is not in the audit's market. That channel is fetched whole (its most recent 300 uploads, scored against its own eras exactly as this one is) and measured beside this channel like for like. Costs a few quota units. When they ask for that, put the channel reference in the request verbatim so the fetch knows who to get.

Return JSON:
{
  "reply": "your answer, in plain prose",
  "action": null | {
    "kind": "refocus",
    "sinceDays": number | null,      // only judge videos published within this many days
    "includeTopics": string[] | null, // only these topic labels, as named in the report
    "excludeTopics": string[] | null,
    "note": "one line describing the new focus, shown on the report"
  } | {
    "kind": "add-section",
    "request": "one sentence stating what the section should measure and answer"
  }
}

Rules:
- Propose a refocus only when it follows from what they said. Do not re-aim a report because they asked a question.
- Prefer topics over dates when they name a subject, and dates when they name a period. Both together is fine.
- Say in the reply what the refocus will do and roughly how many videos it will leave, so they can stop you if that is too few.
- Add a section when they ask for the REPORT to cover something. If they just want to know a fact, answer it in the reply instead — a section is a permanent part of the document, not a way to reply.
- NEVER say you are adding, have added, or will add a section unless you return the add-section action in the SAME reply. Prose is not an action: a reply that says "adding it" while returning action null promises something that will never happen, and they will come back later to find nothing there. If you are not returning the action, say plainly what you are doing instead.
- When you add a section, keep the "request" specific about what to measure. "A section on Shorts" is weak; "how Shorts perform against long-form on this channel, and whether the market's Shorts do better" is what produces a good one.
- Never invent a number. Every figure you quote must be one you were given.
- Plain language. No hype.`;

/** Compact the run into something worth reasoning over without sending everything. */
function contextFor(run: AuditRunResult): string {
  const f = run.findings;
  const judged = evidencePool(run.videos, "long");
  const top = [...judged].sort((a, b) => b.eraMultiple - a.eraMultiple).slice(0, 20);
  const worst = [...judged].sort((a, b) => a.eraMultiple - b.eraMultiple).slice(0, 10);

  const lines = (vs: AuditVideo[]) =>
    vs
      .map((v) => `  ${v.eraMultiple.toFixed(1)}x ${String(v.views).padStart(7)} ${new Date(v.publishedAt).toISOString().slice(0, 10)} ${clip(v.title, 80)}`)
      .join("\n");

  return `CHANNEL: ${run.subject?.title} — ${run.subject?.subscriberCount?.toLocaleString() ?? "?"} subscribers
MARKET: ${run.approved?.niche ?? run.proposal?.niche ?? "unknown"}
CATALOGUE: ${run.videos.length} videos, ${judged.length} judged long-form
${run.focus ? `CURRENT FOCUS FILTER: ${run.focus.note} (${run.focus.videoCount} videos)` : "NO FOCUS FILTER — the report covers the whole catalogue"}

SUMMARY: ${f?.summary ?? "(none)"}

TOPICS (label | videos | median multiple):
${(f?.content.topics ?? []).map((t) => `  ${t.topic} | ${t.count} | ${t.medianMultiple}x`).join("\n") || "  (none)"}

TITLE PATTERNS THAT WIN: ${JSON.stringify(f?.titles.winning ?? [])}
TITLE PATTERNS THAT LOSE: ${JSON.stringify(f?.titles.losing ?? [])}
THUMBNAIL CORRELATIONS: ${JSON.stringify(f?.thumbnails.correlations ?? [])}
MARKET GAPS: ${JSON.stringify(f?.content.gaps ?? [])}
POSITION: rank ${f?.position.subscriberRank} of ${(f?.position.competitorCount ?? 0) + 1} by subscribers, ${f?.position.medianViewsRank} by median views
GROWTH AREAS: ${JSON.stringify(f?.growth ?? [])}

BEST 20 (era multiple, views, date, title):
${lines(top)}

WORST 10:
${lines(worst)}`;
}

/** A refocus narrows the existing report; a section appends a new part to it. */
export type ChatAction =
  | (AuditFocus & { kind: "refocus" })
  | { kind: "add-section"; request: string };

export interface ChatResult {
  reply: string;
  action: ChatAction | null;
}

/**
 * Catch a reply that PROMISES a section while returning no action.
 *
 * This is not hypothetical. Asked to "add a comparison with @Jake.Dawson", the
 * chat answered "Adding it. The section will fetch Jake Dawson's catalogue…"
 * and returned action null — so nothing ran, nothing was added, and the only
 * record was a reply saying the opposite. The prompt now forbids it; this makes
 * the failure visible even when the prompt is ignored, because a promise the
 * operator believes is worse than a refusal they can act on.
 */
const ADD_PROMISE =
  /\b(adding it|i'?m adding|i'?ll add|i will add|i'?ve added|i have added|added it|will be added|re-?issuing|kicking it off|handing (?:it|that) off|requesting it)\b/i;

/**
 * Is this message asking for the REPORT to change, rather than asking a
 * question about it?
 *
 * Used to decide whether an answer with no action is a failure worth retrying.
 * Deliberately narrow: a question that merely mentions a comparison is not a
 * request to add one, and re-asking the model costs a call.
 */
export function asksForASection(message: string): boolean {
  return (
    /\b(add|include|append|write|put)\b[^.?!]{0,60}\b(section|comparison|part|chapter|breakdown|chart)\b/i.test(message) ||
    /\bsection\b[^.?!]{0,40}\b(about|on|comparing|covering|for)\b/i.test(message)
  );
}

export function correctEmptyPromise(reply: string, action: ChatAction | null): string {
  if (action || !ADD_PROMISE.test(reply)) return reply;
  return (
    `${reply}\n\n(Correction: nothing was actually added — no section pass ran, so the report is unchanged. ` +
    `Tell me what you want it to measure and I will add it properly.)`
  );
}

export async function chatAboutAudit(
  run: AuditRunResult,
  history: { role: "user" | "assistant"; content: string }[],
  message: string,
): Promise<ChatResult> {
  const first = await askOnce(run, history, message);
  // ── the rut ───────────────────────────────────────────────────────────────
  // A thread that once answered a section request with prose instead of an
  // action keeps doing it: the scrollback then contains the model promising to
  // add something and later saying it cannot tell whether it did, and the next
  // turn copies that shape. Observed on a real report — three consecutive
  // "adding it" replies, no action, nothing added.
  //
  // So an add-request that produced no action is asked ONCE more with the
  // history dropped. The report itself is the context that matters; the
  // scrollback is what poisoned the answer.
  if (!first.action && history.length && asksForASection(message)) {
    const retry = await askOnce(run, [], message);
    if (retry.action) {
      console.log("[audit] chat returned no action for a section request; retried without history and got one");
      return retry;
    }
  }
  return first;
}

async function askOnce(
  run: AuditRunResult,
  history: { role: "user" | "assistant"; content: string }[],
  message: string,
): Promise<ChatResult> {
  const raw = await claudeJSONWithModel({
    model: CHAT_MODEL,
    purpose: "audit-chat",
    system: CHAT_SYSTEM,
    messages: [
      { role: "user", content: `Here is the audit.\n\n${contextFor(run)}` },
      { role: "assistant", content: "Read. What would you like to know?" },
      // Trimmed: the report itself is the context that matters, and a long
      // scrollback would crowd it out of the window.
      ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ],
  });

  let got: any = {};
  try {
    got = JSON.parse(raw);
  } catch {
    return { reply: raw.trim() || "I could not read that answer — try asking again.", action: null };
  }

  const a = got?.action;
  let action: ChatAction | null = null;
  if (a && a.kind === "refocus") {
    action = {
      kind: "refocus" as const,
      sinceDays: Number.isFinite(Number(a.sinceDays)) ? Number(a.sinceDays) : null,
      includeTopics: Array.isArray(a.includeTopics) ? a.includeTopics.map(String) : null,
      excludeTopics: Array.isArray(a.excludeTopics) ? a.excludeTopics.map(String) : null,
      note: String(a.note ?? "Refocused"),
      videoCount: 0, // set once applied
    };
  } else if (a && a.kind === "add-section") {
    // Fall back to the operator's own words when the model returns the action
    // without a usable request — their sentence is better than none, and an
    // empty request would design a section about nothing.
    const request = String(a.request ?? "").trim() || message.trim();
    if (request) action = { kind: "add-section" as const, request };
  }

  const reply = String(got?.reply ?? "").trim() || "(no answer)";
  return { reply: correctEmptyPromise(reply, action), action };
}

/** Which videos survive a focus filter. */
export function applyFocusFilter(
  videos: AuditVideo[],
  focus: AuditFocus,
  topicsByVideo: Map<string, string>,
  now = Date.now(),
): AuditVideo[] {
  return videos.filter((v) => {
    // A null or 0 window means "no date filter" — not "keep nothing published
    // more than zero days ago", which would empty the report.
    if (focus.sinceDays && focus.sinceDays > 0 && (now - v.publishedAt) / 86_400_000 > focus.sinceDays) return false;
    const topic = topicsByVideo.get(v.videoId);
    if (focus.includeTopics?.length && (!topic || !focus.includeTopics.includes(topic))) return false;
    if (focus.excludeTopics?.length && topic && focus.excludeTopics.includes(topic)) return false;
    return true;
  });
}

/**
 * Recompute the findings over a subset, then rewrite the verdicts.
 *
 * Everything except the prose is pure arithmetic over data already on disk, so
 * this costs one model call and no quota. The videos themselves are untouched —
 * a focus narrows what counts as EVIDENCE, it does not delete anything, and
 * clearing it restores the full report.
 */
export async function refocusReport(
  run: AuditRunResult,
  focus: AuditFocus,
): Promise<{ findings: AuditFindings; focus: AuditFocus; membershipKnown: boolean }> {
  const topicsByVideo = new Map<string, string>();
  let membershipKnown = false;
  for (const t of run.findings?.content.topics ?? []) {
    if (t.videoIds?.length) {
      membershipKnown = true;
      for (const id of t.videoIds) topicsByVideo.set(id, t.topic);
    } else {
      // Runs recorded before membership was persisted only have three example
      // titles per topic. Matching on those is what produced a 12-video report
      // out of 127 — so it is used only as a last resort, and the caller is
      // told the topic filter cannot be trusted for this run.
      for (const title of t.examples) {
        const v = run.videos.find((x) => x.title === title);
        if (v) topicsByVideo.set(v.videoId, t.topic);
      }
    }
  }

  const kept = applyFocusFilter(run.videos, focus, topicsByVideo);
  const pool = evidencePool(kept, "long");
  const patterns = titlePatternPerformance(pool);
  const { winning, losing } = splitWinnersLosers(patterns);

  // Topics are kept as labelled but re-counted over the kept videos only, so a
  // topic that has fallen out of the focus reads as empty rather than stale.
  const topics = (run.findings?.content.topics ?? [])
    .map((t) => {
      const vs = pool.filter((v) => topicsByVideo.get(v.videoId) === t.topic);
      return {
        topic: t.topic,
        count: vs.length,
        medianMultiple: vs.length ? Math.round(median(vs.map((v) => v.eraMultiple)) * 100) / 100 : 0,
        examples: vs.slice(0, 3).map((v) => v.title),
      };
    })
    .filter((t) => t.count > 0);

  const computed = {
    ageCurve: ageCurve(kept, "long"),
    titles: {
      winning,
      losing,
      // The market analysis is about the MARKET, so narrowing which of the
      // subject's videos count as evidence does not change it. Carrying it
      // through keeps the strongest sample in the report after a refocus
      // instead of silently dropping it.
      market: run.findings?.titles.market ?? null,
      verdict: "",
    },
    thumbnails: {
      correlations: [...thumbnailCorrelations(pool), ...titleStructureCorrelations(pool)],
      outlierProfile: run.findings?.thumbnails.outlierProfile ?? [],
      verdict: "",
    },
    content: { topics, gaps: run.findings?.content.gaps ?? [], verdict: "" },
    position: run.findings?.position ?? {
      subscriberRank: 1,
      medianViewsRank: 1,
      competitorCount: 0,
      strengths: [],
      weaknesses: [],
      verdict: "",
    },
  };

  const written = await writeReport({
    channel: run.subject!,
    niche: `${run.approved?.niche ?? ""} — refocused: ${focus.note}`,
    mode: run.input.mode,
    computed,
  });

  return {
    membershipKnown,
    findings: {
      ...computed,
      titles: { ...computed.titles, verdict: written.verdicts.titles },
      thumbnails: { ...computed.thumbnails, verdict: written.verdicts.thumbnails },
      content: { ...computed.content, verdict: written.verdicts.content },
      position: {
        ...computed.position,
        strengths: written.strengths,
        weaknesses: written.weaknesses,
        verdict: written.verdicts.position,
      },
      growth: written.growth,
      summary: written.summary,
    },
    focus: { ...focus, videoCount: kept.length },
  };
}
