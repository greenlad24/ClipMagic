/**
 * Learning from Jake's edits (#9): for every thread where the agent saved a
 * draft and Jake has since SENT a reply, compare the draft with what actually
 * went out and keep a short, reusable lesson (per brand and/or stage). The
 * lessons are fed into every future drafting prompt.
 */
import { getThread } from "../integrations/gmail.js";
import { itemsAwaitingLearning, markLearned, insertLesson } from "./store.js";
import { aiJSON, triageModel, parseGmailMessage, normalizeWs, clip, errMsg } from "./util.js";

function similarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

export async function learnFromEdits(myEmail: string, signature: string, log: (m: string) => void): Promise<number> {
  let learned = 0;
  for (const item of itemsAwaitingLearning(15)) {
    try {
      const t = await getThread(item.thread_id);
      const created = Date.parse(item.created_at);
      const sent = (t.messages ?? [])
        .map((m: any) => parseGmailMessage(m, myEmail))
        .filter((m: any) => m.isFromMe && !m.isDraft && m.labels.includes("SENT") && m.date.getTime() > created);
      if (!sent.length) {
        if (Date.now() - created > 14 * 86_400_000) markLearned(item.id, "no reply sent within 14 days");
        continue;
      }
      const actual = normalizeWs(sent[0].fresh.replace(signature, "").replace(/\n(Best( regards)?|Regards),?[\s\S]*$/i, ""));
      const drafted = normalizeWs(String(item.draft_text ?? "").replace(signature, ""));
      const sim = similarity(actual, drafted);
      if (sim > 0.93) {
        markLearned(item.id, `sent as drafted (${sim.toFixed(2)})`);
        continue;
      }
      const r = await aiJSON<any>({
        model: triageModel(),
        purpose: "deals-agent-learn",
        system: "Jake edited (or replaced) a reply draft written by his email agent before sending it. Compare the two and extract at most 2 short, reusable lessons that would make the agent's NEXT draft closer to what Jake sends. Focus on substance (what was added/removed/changed and why it matters: facts, prices, dates, tone, length, what to ask for). Ignore trivial wording. Each lesson is one imperative sentence. Scope: 'brand' if it's about how to treat this particular brand, 'stage' if it's about this kind of email, 'general' otherwise.",
        user: [
          `Brand: ${item.brand ?? "?"} · Stage: ${item.stage}`,
          `What the sender wanted: ${item.goal ?? "?"}`,
          "",
          "=== AGENT'S DRAFT ===",
          clip(drafted, 4000),
          "",
          "=== WHAT JAKE ACTUALLY SENT ===",
          clip(actual, 4000),
          "",
          `Return JSON: {"lessons":[{"lesson": string, "scope": "brand"|"stage"|"general"}]} (empty if the changes teach nothing reusable)`,
        ].join("\n"),
      });
      for (const l of (r?.lessons ?? []).slice(0, 2)) {
        if (!l?.lesson) continue;
        insertLesson({ brand: l.scope === "brand" ? item.brand : null, stage: l.scope === "stage" ? item.stage : null, lesson: String(l.lesson), source: "edit", ref: item.id });
        learned++;
        log(`Lesson learned from Jake's edit (${item.brand ?? item.subject}): ${l.lesson}`);
      }
      markLearned(item.id, `edited (${sim.toFixed(2)})`);
    } catch (e) {
      log(`Learning check failed for thread ${item.thread_id}: ${errMsg(e)}`);
    }
  }
  return learned;
}

/**
 * Jake answered the agent's Slack question but had ALREADY replied in Gmail
 * himself (Jake 2026-10-01: "do nothing if it's already replied — but learn
 * from the message I sent him"). Nothing is drafted; instead the email he
 * actually sent is compared with the agent's question/proposal and his Slack
 * answer, and at most 2 reusable lessons are kept.
 */
export async function learnFromJakeReply(input: {
  brand: string | null;
  stage: string | null;
  subject: string;
  questions: Array<{ id: string; question: string; proposal: string | null; answer: string | null }>;
  sent: string[];
  signature: string;
  log: (m: string) => void;
}): Promise<number> {
  const sent = input.sent
    .map((t) => normalizeWs(t.replace(input.signature, "").replace(/\n(Best( regards)?|Regards),?[\s\S]*$/i, "")))
    .filter(Boolean);
  if (!sent.length) return 0;
  let learned = 0;
  try {
    const r = await aiJSON<any>({
      model: triageModel(),
      purpose: "deals-agent-learn",
      system: "Jake's email agent asked him a question on Slack about a sponsor thread. Before the agent acted, Jake replied to the sponsor himself. Compare what the agent asked and proposed with the email Jake actually sent, and extract at most 2 short, reusable lessons that would make the agent's NEXT reply in a similar situation match what Jake does (prices, terms, what he agrees to or refuses, what he asks for, tone, length). Do not repeat what his Slack answer already states as a rule; focus on what the sent email adds. Ignore one-off details. Each lesson is one imperative sentence. Scope: 'brand' for this brand only, 'stage' for this kind of email, 'general' otherwise.",
      user: [
        `Brand: ${input.brand ?? "?"} · Stage: ${input.stage ?? "?"} · Subject: ${input.subject}`,
        ...input.questions.flatMap((q) => [
          "",
          `=== AGENT'S QUESTION ===`,
          clip(q.question, 1200),
          q.proposal ? `=== AGENT'S PROPOSAL ===\n${clip(q.proposal, 2500)}` : "",
          q.answer ? `=== JAKE'S SLACK ANSWER ===\n${clip(q.answer, 1200)}` : "",
        ]),
        "",
        "=== WHAT JAKE ACTUALLY SENT ===",
        clip(sent.join("\n\n---\n\n"), 4000),
        "",
        `Return JSON: {"lessons":[{"lesson": string, "scope": "brand"|"stage"|"general"}]} (empty if nothing reusable)`,
      ].filter(Boolean).join("\n"),
    });
    for (const l of (r?.lessons ?? []).slice(0, 2)) {
      if (!l?.lesson) continue;
      insertLesson({ brand: l.scope === "brand" ? input.brand : null, stage: l.scope === "stage" ? input.stage : null, lesson: String(l.lesson), source: "edit", ref: input.questions[0]?.id });
      learned++;
      input.log(`Lesson learned from the reply Jake sent himself (${input.brand ?? input.subject}): ${l.lesson}`);
    }
  } catch (e) {
    input.log(`Learning from Jake's own reply failed: ${errMsg(e)}`);
  }
  return learned;
}
