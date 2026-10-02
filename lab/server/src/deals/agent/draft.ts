/**
 * The drafter: one Opus call that sees EVERYTHING — the rulebook (verbatim),
 * the whole thread, the deal's history, the live availability, the fit check,
 * how similar requests were answered before, Jake's lessons and Slack answers —
 * and either writes the reply in Jake's voice or says it must ask Jake first.
 *
 * Plain text out (the HTML part for Gmail is generated from it). The signature
 * is appended by code, never written by the model, so it is identical every time.
 */
import { loadRulebook, oldStageGuidance, channelContext } from "./rulebook.js";
import { aiJSON, draftModel } from "./util.js";

export interface DraftContext {
  todayLine: string;
  subject: string;
  latestFromName: string;
  transcript: string;
  firstReply: boolean;
  stage: string;
  edgeCase: string | null;
  goal: string;
  brand: string | null;
  product: string | null;
  triageFlags: string;
  dealContext: string;
  brandHistory: string;
  availabilityText: string;
  fitText: string;
  pastThreads: string;
  voiceSamples: string[];
  lessons: string[];
  jakeAnswers: string;
  audienceSnapshot: string;
  extraInstructions: string;
  boardStages: string[];
}

export interface DraftResult {
  action: "draft" | "ask" | "no_reply";
  body: string;
  ask: { question: string; proposal: string; rule: string } | null;
  boardStage: string | null;
  dealValueUsd: number | null;
  summary: string;
}

/** Shared by every draft call — cached once per run (prompt cache), whatever the stage. */
function systemPrompt(): string {
  return [
    "You write reply drafts for Jake Dawson's sponsorship inbox (jakedawsonbusiness@gmail.com). Jake is a YouTube creator: AI tools tutorials for solopreneurs and small-business owners. Drafts are NEVER sent by you — Jake or his team review and send them.",
    "",
    "HOW TO WORK",
    "1. Read the WHOLE thread and the deal record first. Work out the sender's real GOAL in their latest email and answer exactly that — misreading the goal is the most common failure.",
    "2. Follow the rulebook below to the letter. It is the only source of truth for prices, terms, availability, formats and routing. Where Jake answered a question on Slack for this thread, his answer wins for this thread.",
    "3. Past threads show how similar requests were answered — reuse the approach and wording, NEVER their prices (historical $5,500/$5,000 era).",
    "4. If the reply needs something only Jake has or decides (a link — invoice, video draft, contract, payment link; a date he hasn't committed to; a price below the floor; an exclusivity request; a big/long-term deal; a production/scheduling/contract conflict; a contract review), DO NOT draft with a gap. Return action \"ask\" with one clear question and what you propose. Never write placeholders or brackets.",
    "5. If the latest email needs no answer — a pure acknowledgement, 'thanks', 'I'll check and get back to you', an emoji — return action \"no_reply\". Don't send filler or nudges nobody asked for.",
    "6. If the rulebook says no reply at all (suspicious sender, reputation/legal risk, Miscellaneous), return action \"no_reply\".",
    "",
    "HOW THE EMAIL READS",
    "- Plain text. Start with \"Hi <first name>,\" (their real first name from the thread; if unknown, \"Hi there,\"). No filler openers (no \"I hope this email finds you well\").",
    "- As short as possible without dropping any detail the email needs (#47). Short paragraphs; a light numbered list only when it helps (e.g. the package, or what we need from them).",
    "- Relaxed, confident, premium, polite. Write as a company with a policy (\"we\", \"our current rate\"), never as \"just a creator\". Never apologise for prices, never plant doubts (\"will you be ok if…\").",
    "- Use the brand's name. Don't gush (\"thrilled\", \"perfect fit\").",
    "- Concrete dates: when you give a date, write it out (e.g. \"November 14\"); months for booking windows (\"from mid-November\"). Dates must agree with earlier replies in the thread and with the availability block.",
    "- Never mention our own paid ads, the floor (in a first reply), PayPal, past sponsors' results, or anything internal (board, agent, rulebook, Slack).",
    "- Do NOT write a sign-off or signature — end on your last sentence. The standard signature block is appended automatically.",
    "",
    "PACKAGE WORDING (when the offer needs stating — first reply to a new brand, or when asked; prices/terms come from the rulebook, which wins if it ever differs from this summary)",
    "Dedicated YouTube video: $6,500 — 8–15 minutes: a practical review, feature overview and real-world use cases.",
    "Payment: offer the best step of the ladder the brand will accept (#25) — normally \"100% upfront for priority scheduling, or 50% upfront and 50% on final draft approval\". Bank transfer via Wise (Stripe if they can't).",
    "Availability: from the availability block — never a fixed lead time.",
    "",
    "=== RULEBOOK (source of truth) ===",
    loadRulebook(),
    "",
    "=== CHANNEL CONTEXT (who Jake and the audience are) ===",
    channelContext("draft"),
  ].join("\n");
}

/** The per-stage part, sent after the cached prefix so it doesn't split the cache by stage. */
function stageTail(stage: string): string {
  return [
    `=== OLD GUIDANCE FOR THE "${stage}" STAGE (structure/tone reference only — superseded by the rulebook wherever they differ, esp. prices, floor, shorts, exclusivity, ads, payment, availability) ===`,
    oldStageGuidance(stage) || "(none)",
  ].join("\n");
}

export async function writeDraft(ctx: DraftContext, fix?: { previous: string; problems: string[] }): Promise<DraftResult> {
  const user = [
    ctx.todayLine,
    `Subject: ${ctx.subject}`,
    `Is this Jake's FIRST reply in the thread: ${ctx.firstReply ? "YES — quote $6,500 for a dedicated video, never mention $6,000 or any floor" : "no"}`,
    `Stage (baseline): ${ctx.stage}${ctx.edgeCase ? ` — edge case: ${ctx.edgeCase}` : ""}`,
    `Brand: ${ctx.brand ?? "?"}${ctx.product ? ` — product: ${ctx.product}` : ""}`,
    `What the sender wants (triage — verify it yourself against the thread): ${ctx.goal}`,
    ctx.triageFlags ? `Triage notes: ${ctx.triageFlags}` : "",
    "",
    "=== JAKE'S ANSWERS ON SLACK FOR THIS THREAD (binding) ===",
    ctx.jakeAnswers || "(none)",
    "",
    "=== LESSONS FROM JAKE'S EDITS AND ANSWERS (apply them) ===",
    ctx.lessons.length ? ctx.lessons.map((l) => `- ${l}`).join("\n") : "(none yet)",
    "",
    "=== AVAILABILITY (live pipeline) ===",
    ctx.availabilityText,
    "",
    "=== PRODUCT FIT (#41) ===",
    ctx.fitText || "(not checked — not a new product)",
    "",
    ctx.audienceSnapshot ? `=== AUDIENCE SNAPSHOT (live YouTube Analytics — the only audience numbers you may quote; there is NO 'share of business owners' figure) ===\n${ctx.audienceSnapshot}\n` : "",
    "=== DEAL ORGANIZER RECORD ===",
    ctx.dealContext || "(no deal on the board for this sender)",
    "",
    "=== EARLIER THREADS WITH THIS SENDER'S DOMAIN ===",
    ctx.brandHistory || "(none)",
    "",
    "=== HOW SIMILAR REQUESTS WERE ANSWERED BEFORE (prices are historical — never copy them) ===",
    ctx.pastThreads,
    "",
    "=== JAKE'S VOICE — real replies he sent (style only; prices in them are outdated) ===",
    ctx.voiceSamples.map((s, i) => `--- sample ${i + 1} ---\n${s}`).join("\n") || "(none)",
    "",
    "=== THE WHOLE THREAD (oldest first; [JAKE] = sent by Jake's side) ===",
    ctx.transcript,
    "",
    ctx.extraInstructions ? `=== EXTRA INSTRUCTIONS ===\n${ctx.extraInstructions}\n` : "",
    fix ? `=== YOUR PREVIOUS DRAFT FAILED THE PRE-SAVE CHECKS — fix every problem, change nothing else that was fine ===\nPrevious draft:\n${fix.previous}\n\nProblems:\n${fix.problems.map((p) => `- ${p}`).join("\n")}\n` : "",
    `Board columns you may choose for boardStage: ${JSON.stringify(ctx.boardStages)}`,
    "",
    `Return JSON exactly:
{"action":"draft"|"ask"|"no_reply",
 "body": string /* the email text WITHOUT sign-off/signature; "" unless action is "draft" */,
 "ask": null | {"question": string /* one clear question for Jake */, "proposal": string /* what you'd do / the reply you'd send once he answers */, "rule": "#NN"},
 "boardStage": string|null /* the column this deal belongs in after this email, from the list; null if not a deal */,
 "dealValueUsd": number|null /* the deal value now on the table, if any */,
 "summary": string /* one line for the log: what you did and why */}`,
  ].filter((x) => x !== "").join("\n");

  const r = await aiJSON<any>({ model: draftModel(), purpose: "deals-agent-draft", system: systemPrompt(), systemTail: stageTail(ctx.stage), user });
  const action = r?.action === "ask" || r?.action === "no_reply" ? r.action : "draft";
  let body = String(r?.body ?? "").replace(/\r\n/g, "\n").trim();
  // Belt and braces: drop any sign-off the model wrote anyway (the real signature is appended by code).
  body = body.replace(/\n+(best( regards)?|kind regards|regards|cheers|thanks|thank you|warm regards),?\s*\n+\s*(jake( dawson)?|the jake dawson team)[\s\S]*$/i, "").trim();
  return {
    action,
    body,
    ask: r?.ask && r.ask.question ? { question: String(r.ask.question), proposal: String(r.ask.proposal ?? ""), rule: String(r.ask.rule ?? "") } : null,
    boardStage: r?.boardStage ? String(r.boardStage) : null,
    dealValueUsd: typeof r?.dealValueUsd === "number" ? r.dealValueUsd : null,
    summary: String(r?.summary ?? ""),
  };
}

/** Plain text → minimal HTML (paragraphs, line breaks, links) for the Gmail draft's HTML part. */
/**
 * Jake 2026-10-01: EVERY email ends with the full footer (Website / Email /
 * YouTube / Partner). Appends the signature when the footer's first link line
 * is missing; when the text already ends with the sign-off ("Best regards,
 * Jake Dawson"), only the footer lines are added so the sign-off isn't doubled.
 */
export function ensureSignature(text: string, signature: string): string {
  const sig = signature.trim();
  if (!sig) return text;
  const lines = sig.split("\n");
  const footerStart = lines.findIndex((l) => /<(https?:|mailto:|[\w.+-]+@)/.test(l));
  const marker = footerStart >= 0 ? lines[footerStart].trim() : sig;
  const body = text.replace(/\s+$/, "");
  if (body.includes(marker)) return body;
  if (footerStart > 0) {
    const signOff = lines.slice(0, footerStart).map((l) => l.trim()).join("\n");
    if (body.replace(/[ \t]+\n/g, "\n").endsWith(signOff)) return `${body}\n${lines.slice(footerStart).join("\n")}`;
  }
  return `${body}\n\n${sig}`;
}

export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linkify = (s: string) =>
    esc(s)
      // "Label <https://…>" (signature style) → <a href>Label</a>
      .replace(/([A-Za-z][A-Za-z ]{0,30}) &lt;((?:https?:\/\/|mailto:)[^&\s]+)&gt;/g, '<a href="$2">$1</a>')
      .replace(/([A-Za-z][A-Za-z ]{0,30}) &lt;([\w.+-]+@[\w.-]+\.\w+)&gt;/g, '<a href="mailto:$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>');
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.split("\n").map(linkify).join("<br>")}</p>`)
    .join("\n");
}
