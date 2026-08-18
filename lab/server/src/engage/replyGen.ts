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
 * The operator's prompt is used VERBATIM and it is the authority: voice, length,
 * and which comments get answered at all are its call, not ours. What we append
 * is deliberately small — the JSON envelope the queue needs, the platform's own
 * character cap, and three limits that exist because nobody reads these replies
 * before they go out (don't state facts you weren't given, don't commit the
 * operator to anything, don't use links the prompt didn't provide).
 *
 * An earlier version appended a second, competing style guide — its own list of
 * what to skip and a blanket link ban — which overrode the operator's playbooks
 * and silently binned any reply their rules made long. Resist re-adding rules
 * here: if a behaviour belongs to the voice, it belongs in their prompt.
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

/**
 * DMs get more room than comments. The comment ceilings above are about what
 * reads well in a public thread, not what the API accepts; a private message
 * answering a real question is allowed to be a message.
 */
const MAX_DM_CHARS = 900;

export interface ReplyDraft {
  /** The reply text, or null when we decided not to reply. */
  text: string | null;
  /** Always populated — why we replied, or why we didn't. */
  reason: string;
  /** Whether this item should get a reply at all. */
  shouldReply: boolean;
  /**
   * The draft broke one of the mechanical limits (too long for the platform, or
   * it carried a link that isn't in the style guide). The text is KEPT and the
   * reply is held for a human instead of being posted — silently binning a
   * finished draft loses work and hides the problem, which is exactly what the
   * old blanket rejection did to every reply over the character limit.
   */
  forceReview: boolean;
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
 * Links the operator put in their OWN prompt, which are approved by definition —
 * Jake's voice prompt tells the model to drop his Skool link for template asks
 * and off-topic questions, and a blanket link ban would silently reject exactly
 * those replies. Anything NOT in this list is still refused: the risk we're
 * guarding against is the model inventing a URL, not the operator using theirs.
 */
export function allowedLinks(replyPromptMd: string): string[] {
  const found = replyPromptMd.match(/https?:\/\/[^\s)"'<>]+/gi) ?? [];
  // Trim trailing punctuation that belongs to the prose, not the URL.
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, "")))];
}

/** Does `text` contain a link or email beyond the operator's approved ones? */
function hasUnapprovedLink(text: string, approved: string[]): boolean {
  let remaining = text;
  for (const link of approved) {
    remaining = remaining.split(link).join(" ");
  }
  return /https?:\/\/|www\.|\b\S+@\S+\.\S+\b/i.test(remaining);
}

/**
 * The mechanics appended after the operator's prompt. Keep this SHORT and keep
 * it subordinate — it says so in the text, because the model will otherwise
 * treat a long trailing block as the real instruction set and drift off the
 * voice above it.
 */
function guardrails(platform: Platform, maxChars: number, approvedLinks: string[], isDm: boolean): string {
  const linkRule = approvedLinks.length
    ? `- The only links that may appear are the ones in the style guide above
  (${approvedLinks.join(", ")}), used where it says to use them. No other link,
  email address or phone number.`
    : `- No links, email addresses or phone numbers.`;
  return `
# Mechanics

Everything above is the style guide. It governs the reply completely — the
voice, the length, the punctuation, and which comments get answered at all.
Nothing here changes any of that. This section only covers the mechanics of
posting the reply automatically.

- ${
    isDm
      ? `The reply is sent as a private ${platform} direct message, from your
  account, with nobody reading it first. One person sees it — write to them,
  not to an audience.`
      : `The reply is posted publicly on ${platform}, as you, with nobody reading it
  first.`
  }
- Keep it under ${maxChars} characters.
- Don't state facts you weren't given — prices, dates, specs, version numbers.
  Where the style guide has no honest answer, answer in voice without the
  specific rather than guessing at it.
- Don't commit yourself to anything you'd have to do later: sending something,
  reviewing something, refunding, meeting.
${linkRule}

Respond with ONLY this JSON object:
{"shouldReply": boolean, "reply": string, "reason": string}

Set shouldReply to false when the style guide above says to leave a message
alone (its spam rule, for example), or when answering would mean breaking one
of the points in this section. "reason" is one short sentence for whoever
reviews the queue. When shouldReply is false, "reply" must be an empty string.`.trim();
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
  const isDm = item.kind === "dm";
  const maxChars = isDm ? MAX_DM_CHARS : (MAX_REPLY_CHARS[item.platform] ?? 300);

  if (!replyGenReady(replyPromptMd)) {
    return {
      text: null,
      shouldReply: false,
      forceReview: false,
      reason: "No reply prompt configured (or no Anthropic credentials) — generation is inert.",
      costUsd: 0,
      model: null,
    };
  }

  const approved = allowedLinks(replyPromptMd);
  const system = `${replyPromptMd.trim()}\n\n${guardrails(item.platform, maxChars, approved, isDm)}`;
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
      forceReview: false,
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
      forceReview: false,
      reason: "Model returned unparseable JSON.",
      costUsd,
      model,
    };
  }

  const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.";
  if (parsed.shouldReply !== true) {
    return { text: null, shouldReply: false, forceReview: false, reason, costUsd, model };
  }

  const text = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  // Belt-and-braces on the model's own rules: an empty or over-long reply, or
  // one that smuggled in a link, is treated as a skip rather than posted.
  if (!text) {
    return {
      text: null,
      shouldReply: false,
      forceReview: false,
      reason: "Model said reply but returned empty text.",
      costUsd,
      model,
    };
  }
  if (text.length > maxChars) {
    return {
      text,
      shouldReply: true,
      forceReview: true,
      reason: `Too long for ${item.platform} — ${text.length} characters against a ${maxChars} limit. Held for you to trim.`,
      costUsd,
      model,
    };
  }
  if (hasUnapprovedLink(text, approved)) {
    return {
      text,
      shouldReply: true,
      forceReview: true,
      reason: "Contains a link or email address that isn't in your reply prompt. Held for you to check.",
      costUsd,
      model,
    };
  }

  return { text, shouldReply: true, forceReview: false, reason, costUsd, model };
}
