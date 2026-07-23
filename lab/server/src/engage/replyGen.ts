/**
 * Engagement Manager — reply generation (Phase 3).
 *
 * Drafts ONE reply to ONE inbound comment/DM, in Jake's voice, on the director
 * tier (Opus). The voice itself is NOT in this file and not in the repo: it's
 * `engage_settings.reply_prompt_md`, supplied by Jake through the UI — the same
 * lesson as the Meta token, keep the operator's content out of the image. With
 * no prompt stored, generation is INERT and every item is skipped, so the reply
 * path cannot invent a voice of its own.
 *
 * The model is also the first safety gate: it decides whether an item deserves
 * a reply at all. Spam, self-promotion, abuse, and anything asking for a
 * commitment Jake hasn't authorized come back as `shouldReply: false` with a
 * reason, and are recorded as skipped rather than answered.
 */
import { claudeJSONForPurposeWithUsage, anthropicConfigured } from "../ai/claude.js";
import { ANTHROPIC_RATES, tokenCost, roundUsd } from "../ai/pricing.js";
import type { InboxItem, Platform } from "./types.js";

/** Per-platform reply length ceiling (characters), tuned to each UI's norms. */
const MAX_REPLY_CHARS: Record<Platform, number> = {
  youtube: 500,
  instagram: 300,
  facebook: 400,
  tiktok: 150,
};

export interface ReplyDraft {
  /** The reply text, or null when we decided not to reply. */
  text: string | null;
  /** Always populated — why we replied, or why we didn't. */
  reason: string;
  /** Whether this item should get a reply at all. */
  shouldReply: boolean;
  /** Real cost of this generation in USD (0 when the model isn't priced). */
  costUsd: number;
  /** Model that produced it. */
  model: string | null;
}

export interface GenerateReplyInput {
  /** The comment/DM being answered. */
  item: InboxItem;
  /** The rest of the thread (chronological), for context. */
  thread: InboxItem[];
  /** Display name of the channel replying (Jake's account on that platform). */
  channelName: string | null;
  /** The operator-supplied voice prompt (engage_settings.reply_prompt_md). */
  replyPromptMd: string;
}

/** True when replies can be generated at all (creds + a stored voice prompt). */
export function replyGenReady(replyPromptMd: string | null): boolean {
  return anthropicConfigured() && !!replyPromptMd && replyPromptMd.trim().length > 0;
}

/**
 * The non-negotiable half of the system prompt. Jake's prompt supplies the
 * VOICE; this supplies the RULES, and it is appended after his so the operating
 * limits can't be talked out of the model by the voice prompt.
 */
function guardrails(platform: Platform, maxChars: number): string {
  return `
# Operating rules (these override any style guidance above)

You are replying as the channel owner to a real comment on ${platform}. Your
output is posted publicly, automatically, with nobody reviewing it first.

- Write ONE reply. Plain text. No markdown, no quotes around it, no signature.
- Hard limit: ${maxChars} characters. Shorter is almost always better.
- Never invent facts: no dates, prices, specs, numbers, or features you were not
  given in the thread. If a question needs information you don't have, reply
  warmly without answering the specific and don't guess.
- Never promise anything on the channel owner's behalf — no "I'll send you...",
  no "DM me and I'll...", no commitments to review, refund, collaborate, or meet.
- Never give financial, legal, medical, or safety advice.
- No links, no email addresses, no phone numbers, no @-mentions of other accounts.
- Never claim to be a human when asked directly whether this is automated;
  in that case set shouldReply=false and let a person answer.

Set shouldReply=false (and leave reply empty) when the comment is:
spam or self-promotion; abusive, hateful, or harassing; a complaint, refund
request, or anything needing a real decision; a question you cannot answer
without inventing something; sensitive (health, money, legal, personal crisis);
in a language you cannot reply to naturally; already answered by the channel
owner elsewhere in this thread; or simply not worth a reply (a bare emoji or
a one-word "nice" doesn't need one every time).

Respond with ONLY this JSON object:
{"shouldReply": boolean, "reply": string, "reason": string}
"reason" is one short sentence explaining the decision, for the human reviewing
the queue. When shouldReply is false, "reply" must be an empty string.`.trim();
}

/** Render the thread as context, oldest first, marking the item being answered. */
function threadContext(item: InboxItem, thread: InboxItem[], channelName: string | null): string {
  const ordered = [...thread].sort((a, b) => (a.postedAt ?? 0) - (b.postedAt ?? 0));
  const lines = ordered.map((t) => {
    const who = t.authorName || t.authorHandle || "someone";
    const isOwner = channelName && who.toLowerCase() === channelName.toLowerCase();
    const tag = t.id === item.id ? "  <-- REPLY TO THIS ONE" : "";
    return `${who}${isOwner ? " (you, the channel owner)" : ""}: ${t.text}${tag}`;
  });
  if (!ordered.some((t) => t.id === item.id)) {
    const who = item.authorName || item.authorHandle || "someone";
    lines.push(`${who}: ${item.text}  <-- REPLY TO THIS ONE`);
  }
  return lines.join("\n");
}

/**
 * Generate one reply. NEVER throws — an API failure comes back as
 * shouldReply=false with the error as the reason, so the worker records a skip
 * and moves on instead of stalling the queue.
 */
export async function generateReply(input: GenerateReplyInput): Promise<ReplyDraft> {
  const { item, thread, channelName, replyPromptMd } = input;
  const maxChars = MAX_REPLY_CHARS[item.platform] ?? 300;

  if (!replyGenReady(replyPromptMd)) {
    return {
      text: null,
      shouldReply: false,
      reason: "No reply prompt configured (or no Anthropic credentials) — generation is inert.",
      costUsd: 0,
      model: null,
    };
  }

  const system = `${replyPromptMd.trim()}\n\n${guardrails(item.platform, maxChars)}`;
  const context = [
    item.targetTitle ? `The post/video this is on: "${item.targetTitle}"` : null,
    item.kind === "dm" ? "This is a private direct message, not a public comment." : null,
    "",
    "Thread (oldest first):",
    threadContext(item, thread, channelName),
  ]
    .filter((l) => l !== null)
    .join("\n");

  let raw: string;
  let costUsd = 0;
  let model: string | null = null;
  try {
    const out = await claudeJSONForPurposeWithUsage({
      tier: "director",
      purpose: "engagement-reply",
      system,
      messages: [{ role: "user", content: context }],
    });
    raw = out.json;
    model = out.model;
    const rate = ANTHROPIC_RATES[out.model];
    if (rate && out.usage) {
      costUsd = roundUsd(
        tokenCost(
          rate,
          out.usage.input_tokens ?? 0,
          out.usage.output_tokens ?? 0,
          out.usage.cache_creation_input_tokens ?? 0,
          out.usage.cache_read_input_tokens ?? 0,
        ),
      );
    }
  } catch (e) {
    return {
      text: null,
      shouldReply: false,
      reason: `Generation failed: ${e instanceof Error ? e.message : String(e)}`,
      costUsd: 0,
      model: null,
    };
  }

  let parsed: { shouldReply?: unknown; reply?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      text: null,
      shouldReply: false,
      reason: "Model returned unparseable JSON.",
      costUsd,
      model,
    };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.";
  if (parsed.shouldReply !== true) {
    return { text: null, shouldReply: false, reason, costUsd, model };
  }

  const text = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  // Belt-and-braces on the model's own rules: an empty or over-long reply, or
  // one that smuggled in a link, is treated as a skip rather than posted.
  if (!text) {
    return { text: null, shouldReply: false, reason: "Model said reply but returned empty text.", costUsd, model };
  }
  if (text.length > maxChars) {
    return {
      text: null,
      shouldReply: false,
      reason: `Draft exceeded the ${maxChars}-character limit for ${item.platform} (${text.length}).`,
      costUsd,
      model,
    };
  }
  if (/https?:\/\/|www\.|\b\S+@\S+\.\S+\b/i.test(text)) {
    return { text: null, shouldReply: false, reason: "Draft contained a link or email address.", costUsd, model };
  }

  return { text, shouldReply: true, reason, costUsd, model };
}
