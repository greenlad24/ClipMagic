/**
 * The Slack loop (#8, #27, #40, #43, #44, #46, #72): post a question with the
 * thread's context + what the agent proposes, store it, and on later runs read
 * the replies in that Slack thread, record Jake's answer, and hand the thread
 * back to the pipeline so it drafts WITH the answer. Answers that state a
 * general rule also become lessons.
 */
import { slackPost, slackThreadReplies, slackWhoAmI } from "../integrations/slack.js";
import { answerQuestion, insertLesson, openLiveQuestions, type QuestionRow } from "./store.js";
import { aiJSON, triageModel, clip, errMsg } from "./util.js";

let teamId: string | null = null;

export async function slackPermalink(channel: string, ts: string): Promise<string | null> {
  try {
    if (!teamId) teamId = (await slackWhoAmI()).team_id ?? null;
    if (!teamId) return null;
    return `https://app.slack.com/client/${teamId}/${channel}/thread/${channel}-${ts}`;
  } catch {
    return null;
  }
}

export function formatQuestion(q: {
  kind: "question" | "flag";
  subject: string;
  from: string;
  brand: string | null;
  stage: string;
  goal: string;
  question: string;
  proposal: string | null;
  rule: string;
  gmailUrl: string;
}): string {
  const head = q.kind === "flag" ? ":triangular_flag_on_post: *Flag — no reply will be drafted*" : ":raising_hand: *Question — I need your call before I draft*";
  return [
    head,
    `*${q.subject || "(no subject)"}* — from ${q.from}`,
    `Brand: ${q.brand ?? "?"} · Stage: ${q.stage}${q.rule ? ` · Rule ${q.rule}` : ""}`,
    `What they want: ${clip(q.goal, 400)}`,
    "",
    `*${q.kind === "flag" ? "Why" : "Question"}:* ${q.question}`,
    q.proposal ? `*What I propose:* ${clip(q.proposal, 1500)}` : "",
    `<${q.gmailUrl}|Open the thread in Gmail>`,
    q.kind === "question"
      ? "_Reply in this Slack thread — I'll confirm within a minute and act 10 minutes after your last message (edit it until then and I'll use the latest version)._"
      : "_Want me to do something with it? Reply in this thread — I'll confirm within a minute and act 10 minutes after your last message._",
  ].filter(Boolean).join("\n");
}

export async function postToSlack(text: string): Promise<{ channel: string; ts: string; permalink: string | null }> {
  const r = await slackPost(text);
  return { ...r, permalink: await slackPermalink(r.channel, r.ts) };
}

/**
 * Set by the Slack answer watcher (slackWatcher.ts) while it runs: it then owns
 * every reply in the agent's threads, and the scheduled run's collection pass
 * below steps aside so an answer is never picked up twice.
 */
let watcherOwnsReplies = false;
export function setWatcherOwnsReplies(v: boolean): void {
  watcherOwnsReplies = v;
}

/**
 * Read replies for every open live question. Returns the questions that were
 * answered in this pass (their threads get re-processed with the answer).
 */
export async function collectAnswers(log: (m: string) => void): Promise<QuestionRow[]> {
  const answered: QuestionRow[] = [];
  if (watcherOwnsReplies) {
    log("Slack answers are handled by the live Slack watcher (acts 10 minutes after Jake's last reply) — skipping the collection pass.");
    return answered;
  }
  for (const q of openLiveQuestions()) {
    try {
      const replies = await slackThreadReplies(q.slackChannel!, q.slackTs!);
      const human = replies.filter((r) => !r.bot && r.text.trim());
      if (!human.length) continue;
      const answer = human.map((r) => r.text.trim()).join("\n");
      answerQuestion(q.id, answer);
      answered.push({ ...q, answer });
      log(`Slack answer received for "${q.subject}": ${clip(answer, 160)}`);
      await learnFromAnswer(q, answer, log);
    } catch (e) {
      log(`Could not read Slack replies for "${q.subject}": ${errMsg(e)}`);
    }
  }
  return answered;
}

export async function learnFromAnswer(q: QuestionRow, answer: string, log: (m: string) => void): Promise<void> {
  try {
    const r = await aiJSON<any>({
      model: triageModel(),
      purpose: "deals-agent-slack",
      system: "You turn Jake's answer to the email agent's question into reusable lessons. Only extract a lesson when the answer states something that applies beyond this one email (a general rule, a policy for this brand, a preference). A one-off decision ('yes send it', 'use this link') is NOT a lesson.",
      user: [
        `Brand: ${q.brand ?? "?"} · Stage: ${q.stage ?? "?"}`,
        `Agent's question: ${q.question}`,
        q.proposal ? `Agent's proposal: ${q.proposal}` : "",
        `Jake's answer: ${answer}`,
        `Return JSON: {"lessons":[{"lesson": string /* one imperative sentence */, "scope": "brand"|"stage"|"general"}]}  (empty list if none)`,
      ].filter(Boolean).join("\n"),
    });
    for (const l of (r?.lessons ?? []).slice(0, 2)) {
      if (!l?.lesson) continue;
      insertLesson({
        brand: l.scope === "brand" ? q.brand : null,
        stage: l.scope === "stage" ? q.stage : null,
        lesson: String(l.lesson),
        source: "slack",
        ref: q.id,
      });
      log(`Lesson learned from Slack: ${l.lesson}`);
    }
  } catch (e) {
    log(`Lesson extraction from Slack answer failed: ${errMsg(e)}`);
  }
}
