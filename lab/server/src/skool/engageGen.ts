/**
 * Drafting: community posts, comment replies, DM replies.
 *
 * ⚠️⚠️ THE VOICE IS THE OPERATOR'S PROMPT, PASSED VERBATIM, AND NOTHING HERE
 * COMPETES WITH IT. This is the Engagement Manager's hardest-won lesson, and it
 * was learned by breaking it: `replyGen`'s appended block had grown its own
 * skip-list and its own length rules on top of Jake's, and the result was
 * replies clipped to three sentences and drafts silently binned for containing
 * a link his own prompt told them to include. Jake's instruction afterwards was
 * "I want my prompt used word by word". So the block below is MECHANICS ONLY —
 * the output envelope, what may be cited, and the surface's own hard limits.
 * If it is voice, it belongs in his prompt. Do not add rules here.
 *
 * ⚠️ ONE HONEST MISMATCH, FLAGGED RATHER THAN QUIETLY PATCHED. His prompt opens
 * "You are Jake Dawson replying to comments on your own YouTube channel" and
 * caps every reply at 5–10 sentences with zero markdown. That is right for a
 * comment and wrong for a weekly post that he has asked to carry a step-by-step
 * tutorial. Rather than edit his words or ignore his cap, the post prompt states
 * the surface plainly and treats the length/formatting rules as belonging to the
 * comment box they were written for — and `POST_FORMAT_NOTE` says so in the
 * prompt itself, so the model is not left to reconcile a contradiction silently.
 */
import { aiConfig } from "../ai/config.js";
import { claudeJSONForPurposeWithUsage } from "../ai/claude.js";
import { classroomOutline, retrieve, type Retrieved } from "./knowledge.js";

export interface Draft {
  title: string;
  body: string;
  category: string | null;
  /** Lessons the draft was grounded in, for the audit trail and the read-back. */
  cited: { title: string; url: string }[];
  /**
   * Tokens, not dollars. These calls spend the Max subscription, so their cost
   * is zero by construction — what is actually scarce is the 5-hour window,
   * which is measured in tokens and SHARED with Jake's own sessions.
   */
  tokens: number | null;
  model: string;
}

export interface ReplyDraft {
  text: string;
  /** A reply the model chose not to send, with its reason — never a silent skip. */
  skip: string | null;
  cited: { title: string; url: string }[];
  tokens: number | null;
}

/**
 * The envelope and the limits. Everything in here exists because nothing reads
 * these drafts before the community does — Jake chose full autonomy — so each
 * line is a thing that cannot be recovered from after the fact.
 */
function mechanics(kind: "post" | "reply", extra: string): string {
  return [
    "",
    "==========================================",
    "MECHANICS (not style — the style guide above governs voice completely)",
    "==========================================",
    "",
    "Return ONE JSON object and nothing else.",
    kind === "post"
      ? `Shape: {"title": string, "body": string, "category": string, "cited": string[]}`
      : `Shape: {"text": string, "skip": string|null, "cited": string[]}`,
    "",
    "GROUNDING — what you may state as fact:",
    "- the classroom lessons and video transcripts quoted below,",
    "- what the member actually wrote, and",
    "- current, well-established facts about tools you are confident about (see STALENESS).",
    "No invented numbers, no invented results, no promises about what someone",
    "will earn or how long something takes. If you are not sure, say less.",
    "If a lesson covers it, link that lesson by its exact URL from the list.",
    "Never invent a URL — a link that 404s in your own community is worse than no link.",
    "`cited` lists the URLs you actually used.",
    "",
    "==========================================",
    "STALENESS — THE COURSE MATERIAL CAN BE OUT OF DATE, AND YOU FIX IT",
    "==========================================",
    "",
    "The lessons and especially the VIDEO TRANSCRIPTS were recorded months or",
    "years ago, in a subject that changes every few weeks. Model names, prices,",
    "free tiers, menu locations and product names all move.",
    "",
    "So: ANSWER WITH WHAT IS TRUE NOW, not with what the video said then.",
    "- If a video names a model, tool or price that has since been superseded,",
    "  give the current one. Do not repeat the old specific as if it still holds.",
    "- Teach the METHOD from the lesson — that is what lasts — and update the",
    "  specifics around it.",
    "- Where it matters that the video looks different from what they will see,",
    "  say so plainly and briefly. A member following along and finding a",
    "  different screen assumes they did something wrong.",
    "- If you are NOT confident whether something has changed, do not guess in",
    "  either direction: say what the lesson shows and tell them to check the",
    "  current version.",
    "",
    "⚠️ THIS IS NOT LICENCE TO INVENT. Correcting a stale model name is fixing a",
    "fact. Inventing a feature, a price or a result is not, and it is worse here",
    "than being out of date, because these are Jake's own paying members.",
    "",
    "⚠️ TRANSCRIPTS CONTAIN SPONSOR READS AND AFFILIATE SEGMENTS. Never reproduce",
    "a promo, a discount code, a partner offer or an income claim you found in a",
    "transcript. Teach the technique; do not carry the advertisement.",
    "",
    extra,
  ].join("\n");
}

/**
 * ⚠️ THE POST SURFACE, STATED. Without this the model is handed a prompt about
 * replying to YouTube comments and asked to write a community post, and the
 * contradiction resolves differently every run.
 */
const POST_FORMAT_NOTE = [
  "THIS IS A POST IN JAKE'S OWN SKOOL COMMUNITY — not a YouTube reply.",
  "The voice rules above (capitalisation, contractions, banned words, sentence",
  "starters, punctuation, no hype) apply in full and without exception.",
  "The rules written for the comment box do not fit this surface:",
  "- REPLY LENGTH: a post is longer than a comment. Write what the subject needs.",
  "- FORMATTING: plain numbered lines and short paragraphs are fine here.",
  "  Still no markdown bold, italics, headers or bullet characters.",
  "",
  "A post opens by saying what the member gets, gives it, and stops.",
  "No 'in this post I will', no sign-off, no 'hope this helps'.",
].join("\n");

const MCP_NOTE = [
  "THIS IS THE TUESDAY POST AND IT HAS A FIXED JOB: one MCP automation idea.",
  "",
  "It must contain, in this order:",
  "1. what the automation does, in plain english, and who it is for",
  "2. every service it touches, each with its real link",
  "3. a step-by-step tutorial in words — numbered plain lines, enough that a",
  "   member can follow it start to finish without watching anything",
  "4. what it costs and what it cannot do",
  "",
  "⚠️ ONLY NAME SERVICES AND MCP SERVERS YOU ARE CERTAIN EXIST, and only link",
  "their real homepages. If you are not certain of a URL, name the service and",
  "give no link. An invented MCP server sends members chasing something that",
  "does not exist, and they will say so in the comments.",
].join("\n");

/**
 * The classroom lessons, rendered for a prompt.
 *
 * ⚠️ ONLY REBUILT LESSONS GET A URL. The legacy courses are still full of real
 * teaching, so their text is offered as knowledge — but Jake deletes those
 * courses by hand and intends to, and a link this agent publishes to one
 * becomes a 404 in his own community the day he does. Knowledge and citation
 * are two different permissions here.
 */
function groundingBlock(hits: Retrieved[]): string {
  if (!hits.length) return "CLASSROOM LESSONS: none matched. Say less rather than inventing.";
  return [
    "CLASSROOM LESSONS. Link ONLY the ones that carry a URL:",
    ...hits.map((h, i) =>
      [
        `--- lesson ${i + 1} — ${h.title} (course: ${h.courseTitle})`,
        h.rebuilt
          ? `URL: ${h.url}`
          : "URL: none — this course is being retired. Use what it teaches, but do not link it.",
        // The date is here so the STALENESS rule has something to act on. A
        // model cannot judge whether a specific has moved on if it cannot see
        // how long ago it was written.
        h.updatedAt ? `LAST UPDATED: ${h.updatedAt.slice(0, 10)}` : "LAST UPDATED: unknown — treat as old",
        h.excerpt,
        h.videoExcerpt
          ? [
              "",
              `FROM THE VIDEO ON THIS PAGE (transcript${h.videoUrl ? ` — ${h.videoUrl}` : ""}).`,
              "Spoken, older than the page, and the most likely thing to be out of date:",
              h.videoExcerpt,
            ].join("\n")
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

function parseDraft(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Map the model's cited URLs back to the lessons that were actually offered. */
function citedFrom(cited: unknown, hits: Retrieved[]): { title: string; url: string }[] {
  const urls = Array.isArray(cited) ? cited.map(String) : [];
  return hits.filter((h) => urls.includes(h.url)).map((h) => ({ title: h.title, url: h.url }));
}

export interface PostRequest {
  communityUrl: string;
  voicePrompt: string;
  /** "lesson" = the Sunday/Thursday classroom post; "mcp" = Tuesday's. */
  kind: "lesson" | "mcp";
  /** What to write about. Chosen by the caller so the same subject is not reused. */
  subject: string;
  /** Titles of recent posts, so the draft does not repeat one. */
  recentTitles: string[];
  categories: string[];
  preferredCategory: string | null;
}

export async function draftPost(req: PostRequest): Promise<{ draft: Draft | null; error: string | null }> {
  if (!req.voicePrompt.trim()) {
    // Same refusal as the Engagement Manager: with no voice stored, generation
    // is INERT rather than falling back to a house style nobody approved.
    return { draft: null, error: "No voice prompt is stored, so nothing was drafted." };
  }

  const { hits } = retrieve(req.communityUrl, req.subject, req.kind === "mcp" ? 4 : 6);
  const outline = classroomOutline(req.communityUrl);

  const system = [
    req.voicePrompt,
    mechanics("post", req.kind === "mcp" ? `${POST_FORMAT_NOTE}\n\n${MCP_NOTE}` : POST_FORMAT_NOTE),
    "",
    `CATEGORY: choose exactly one of: ${req.categories.join(" · ")}`,
    req.preferredCategory ? `Prefer "${req.preferredCategory}" unless the subject clearly belongs elsewhere.` : "",
  ].join("\n");

  const user = [
    `SUBJECT: ${req.subject}`,
    "",
    groundingBlock(hits),
    "",
    "THE CLASSROOM, so you know what already exists and can point at it:",
    outline.outline.slice(0, 6000),
    "",
    req.recentTitles.length
      ? `ALREADY POSTED RECENTLY — do not repeat these:\n${req.recentTitles.map((t) => `- ${t}`).join("\n")}`
      : "",
  ].join("\n");

  const { json, usage, model } = await claudeJSONForPurposeWithUsage({
    tier: "director",
    purpose: "skool-post",
    system,
    messages: [{ role: "user", content: user }],
    // `SKOOL_AI_AUTH` — API credits by default. The agent posts on days the
    // community has been promised, so it cannot depend on the Max window being
    // open; see `skoolEngageAuth` in ai/config.ts.
    auth: aiConfig.skoolEngageAuth,
  });

  const parsed = parseDraft(json);
  if (!parsed?.title || !parsed?.body) {
    return { draft: null, error: "The model's reply was not a usable post draft." };
  }

  const category =
    req.categories.find((c) => c.toLowerCase() === String(parsed.category ?? "").toLowerCase()) ??
    req.preferredCategory ??
    null;

  return {
    draft: {
      title: String(parsed.title).trim(),
      body: String(parsed.body).trim(),
      category,
      cited: citedFrom(parsed.cited, hits),
      tokens: totalTokens(usage),
      model,
    },
    error: null,
  };
}

/** Input + output tokens for one call, when the provider reported them. */
function totalTokens(usage: { input_tokens?: number; output_tokens?: number } | undefined): number | null {
  if (!usage) return null;
  return Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
}

export interface ReplyRequest {
  communityUrl: string;
  voicePrompt: string;
  surface: "comment" | "dm";
  /** Who wrote it, and what they wrote. */
  authorName: string;
  text: string;
  /** The post the comment sits under, when there is one. */
  context: string;
}

export async function draftReply(req: ReplyRequest): Promise<{ reply: ReplyDraft | null; error: string | null }> {
  if (!req.voicePrompt.trim()) {
    return { reply: null, error: "No voice prompt is stored, so nothing was drafted." };
  }

  const { hits } = retrieve(req.communityUrl, `${req.text} ${req.context}`, 4);

  const surfaceNote =
    req.surface === "comment"
      ? [
          "THIS IS A COMMENT ON A POST IN JAKE'S OWN SKOOL COMMUNITY.",
          "Close enough to a YouTube comment that the rules above apply as written,",
          "including reply length. These are his own members, not strangers.",
        ].join("\n")
      : [
          "THIS IS A DIRECT MESSAGE IN SKOOL, one-to-one.",
          "The rules above apply as written. It is a private message, so no",
          "broadcast phrasing — answer the person.",
        ].join("\n");

  const system = [
    req.voicePrompt,
    mechanics(
      "reply",
      [
        surfaceNote,
        "",
        "SET `skip` (and leave `text` empty) rather than replying at all when:",
        "- the message needs Jake himself — money owed, refunds, complaints, anything legal or personal",
        "- answering would need a fact you do not have",
        "- it is spam",
        "The style guide above decides everything else, including what deserves no reply.",
      ].join("\n"),
    ),
  ].join("\n");

  const user = [
    `${req.authorName} wrote:`,
    req.text,
    "",
    req.context ? `CONTEXT — the post this sits under:\n${req.context.slice(0, 2500)}` : "",
    "",
    groundingBlock(hits),
  ].join("\n");

  const { json, usage } = await claudeJSONForPurposeWithUsage({
    tier: "director",
    purpose: "skool-engage-reply",
    system,
    messages: [{ role: "user", content: user }],
    auth: aiConfig.skoolEngageAuth,
  });

  const parsed = parseDraft(json);
  if (!parsed) return { reply: null, error: "The model's reply was not usable JSON." };

  const skip = parsed.skip ? String(parsed.skip) : null;
  const body = String(parsed.text ?? "").trim();
  if (!skip && !body) return { reply: null, error: "The model returned neither a reply nor a reason to skip." };

  return {
    reply: { text: body, skip, cited: citedFrom(parsed.cited, hits), tokens: totalTokens(usage) },
    error: null,
  };
}
