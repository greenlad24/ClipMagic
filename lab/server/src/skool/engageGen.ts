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
 *
 * ⚠️⚠️ CAPITALISATION IS NOW OVERRIDDEN FOR POSTS TOO, ON JAKE'S INSTRUCTION
 * (2026-08-06: "for posts it should have regular formatting, not all
 * lowercase"). His RULE 1 is "start every sentence with a LOWERCASE letter.
 * Always" — and three drafts obeyed it exactly where it hurt most, dropping
 * into lowercase for the caveat near the end while the rest of the post,
 * learned from the examples, stayed sentence-cased. The override names RULE 1
 * explicitly rather than hinting, because an unnamed contradiction gets
 * resolved differently every run. It is grounded, not invented: 95% of the
 * lines in his own 70 posts start with a capital.
 */
import { aiConfig } from "../ai/config.js";
import { claudeJSONForPurposeWithUsage } from "../ai/claude.js";
import { classroomOutline, retrieve, type Retrieved } from "./knowledge.js";
import { youtubeUrl } from "./channelVideos.js";

/**
 * Something the composer attaches to a post, beyond its words.
 *
 * Jake, 2026-08-07: "add a YouTube video, GIF or a poll when it fits." GIFs were
 * dropped by his call the same day and put back in scope on 2026-08-08, once the
 * picker turned out to be perfectly drivable — the grid is CSS
 * `background-image`, not `<img>`, which is the only reason it read as
 * unreadable. What has NOT changed is the reason he dropped it: the image is
 * whatever Giphy returns for a search term, and nobody sees it before 65 members
 * do. So the model supplies a SEARCH TERM, the first result is taken, and the
 * chosen URL is written to the step log — that log is the only record of what
 * actually went out.
 */
export type Attachment =
  | {
      kind: "video";
      /** An id from Jake's OWN uploads. Validated against the catalogue, never trusted. */
      videoId: string;
      title: string;
      url: string;
    }
  | {
      kind: "poll";
      /** 2–4 short answers. Skool has no question field — the body asks it. */
      options: string[];
    }
  | {
      kind: "gif";
      /**
       * What to search Giphy for. NOT a URL — the model never names an image,
       * because it cannot see one; it names a search, and the first result is
       * taken so that a retry attaches the same thing.
       */
      query: string;
    };

export interface Draft {
  title: string;
  body: string;
  category: string | null;
  /** What to attach, when the model judged one fitted. Null is the common case. */
  attachment: Attachment | null;
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
      ? `Shape: {"title": string, "body": string, "category": string, "cited": string[], "attach": null | {"kind":"video","videoId":string} | {"kind":"poll","options":string[]} | {"kind":"gif","query":string}}`
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
 *
 * ⚠️⚠️ THIS NOTE USED TO DESCRIBE THE FORMAT, HAVING NEVER READ ONE OF JAKE'S
 * POSTS. Measured against 70 of them (2026-08-06) it was half right, which is
 * the dangerous kind:
 *  - RIGHT about markdown — his posts contain zero bold, zero headings and zero
 *    list markers. Structure is emoji markers and blank lines.
 *  - WRONG about the shape. "Opens by saying what the member gets… no sign-off"
 *    describes neither end of a real post: they open on a conversational hook
 *    ("Alright… this one is wild.") and EVERY ONE closes on a question to the
 *    community with a "drop it below 👇".
 *
 * So the format is no longer asserted here — it is SHOWN, by his own posts, in
 * `styleBlock`. A half-right description is worse than none, because the wrong
 * half is indistinguishable from the right half at the point of reading it.
 */
const POST_FORMAT_NOTE = [
  "THIS IS A POST IN JAKE'S OWN SKOOL COMMUNITY — not a YouTube reply.",
  "The voice rules above (banned words, no hype, no invented claims) apply in",
  "full. The rules written for the COMMENT BOX are about a different surface:",
  "",
  "- CAPITALISATION: RULE 1 above says to start every sentence with a lowercase",
  "  letter, always. THAT IS A COMMENT-BOX RULE AND IT DOES NOT APPLY HERE.",
  "  A post uses normal sentence capitalisation. This is not a judgement call:",
  "  across 70 of Jake's own posts, 95% of lines start with a capital letter.",
  "  Write posts the same way — normal capitalisation throughout, including the",
  "  short asides and caveats near the end, which are the places this slips.",
  "  The rest of RULE 1 still holds: the words it says to capitalise, and \"I\".",
  "- REPLY LENGTH: a post is longer than a comment. The examples show the length.",
  "- FORMATTING: the comment-box rules forbid formatting because a YouTube",
  "  comment cannot render it. A Skool post can, and Jake's do. Follow the",
  "  examples, not the comment rules, on anything to do with layout.",
  "",
  "",
  "The examples below are the spec for how a post is written. Match them.",
].join("\n");

/**
 * What may be stapled to a post, and the far more important question of when.
 *
 * ⚠️ "WHEN IT FITS" HAS TO BE SPELLED OUT, BECAUSE A MODEL ASKED WHETHER TO ADD
 * SOMETHING ALMOST ALWAYS SAYS YES. Left as "attach a video or a poll when it
 * fits", nearly every post gets one — and an attachment on every post is how a
 * feature meant to add variety becomes noise. So the default is stated as null,
 * and each option carries a condition it must actually meet.
 */
function attachmentNote(candidates: { videoId: string; title: string }[]): string {
  const lines = [
    "",
    "==========================================",
    "ATTACHMENTS — usually none",
    "==========================================",
    "",
    'Set "attach" to null unless the post is genuinely better with one. Most',
    "posts are not. Do not attach something to every post.",
    "",
    'A POLL — {"kind":"poll","options":[...]} — only when the post already asks',
    "the reader a question with a small number of concrete answers. The post's",
    "closing question IS the poll question; Skool has no separate field for it.",
    "2 to 4 options, each a few words, and they must be real alternatives",
    "somebody would choose between — not yes/no padding.",
  ];

  if (candidates.length === 0) {
    lines.push(
      "",
      "A VIDEO: not available for this post — there are no candidates.",
      'Do not write a videoId. "attach" may only be null or a poll.',
    );
  } else {
    lines.push(
      "",
      'A VIDEO — {"kind":"video","videoId":"..."} — only when one of the videos',
      "below is genuinely about what this post is about. Not merely the same",
      "broad topic: a member who clicks it must land on the thing the post just",
      "told them about. If none is a real match, do not attach one.",
      "",
      "⚠️ PICK AN ID FROM THIS LIST EXACTLY. Never write a YouTube URL, never",
      "adjust an id. Anything not on this list is discarded.",
      "",
      ...candidates.map((c) => `- ${c.videoId} — ${c.title}`),
    );
  }
  lines.push(
    "",
    'A GIF — {"kind":"gif","query":"..."} — a Giphy SEARCH TERM, never a URL.',
    "Two or three words, at most four. The first result is what gets attached,",
    "and nobody sees it before the community does, so pick a term whose obvious",
    "first result is safe and on-topic: \"typing fast\", not a person, a brand, a",
    "meme with words in it, or anything you would not want under Jake's name.",
    "Use this rarely — a gif suits a light, celebratory post and nothing else.",
    "",
    "Never attach more than one. One or neither.",
  );
  return lines.join("\n");
}


/**
 * Undo what SKOOL did to the text, so the examples show what JAKE typed.
 *
 * ⚠️⚠️ THE FEED RETURNS STORED MARKDOWN, NOT AUTHORED MARKDOWN, AND THE
 * DIFFERENCE IS NOT COSMETIC — IT IS THREE STYLE RULES THAT WOULD BE LEARNED
 * WRONG. Measured over 70 of his posts (2026-08-06):
 *
 *  - 116 markdown links, and every single one is Skool's auto-linker. 80 have
 *    anchor text identical to the href; of the 36 that differ, the tells are
 *    conclusive — `Make.com`, `Monday.com`, and best of all `platform. You`
 *    stored as `[platform. You](http://platform.You)`. Nobody hand-writes a
 *    link on "platform. You". He types a bare URL; Skool wraps it.
 *  - 124 escaped `\(` and `\)` plus 9 escaped `\[` `\]` — Skool escaping his
 *    literal punctuation on save, not something he pressed backslash for.
 *  - ZERO `**bold**`, zero `#` headings, zero `-` or numbered list markers. His
 *    structure is emoji markers and blank lines, nothing else.
 *
 * A drafter shown the raw payload learns to write `[url](url)` and literal
 * backslashes into a composer that will escape them AGAIN. The first attempt at
 * this instead added a prompt rule telling the model to imitate the link form —
 * chasing an artifact of the reader, and it correctly ignored it twice.
 */
function asAuthored(body: string): string {
  return body
    // The anchor text is what he actually typed, in every observed case.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\([()[\]])/g, "$1");
}

/**
 * Jake's own posts, shown rather than described.
 *
 * ⚠️ THIS IS NOT A HOUSE STYLE BEING ADDED IN BREACH OF THE RULE AT THE TOP OF
 * THIS FILE. That rule exists so nothing here competes with Jake's own words —
 * and this block is nothing BUT his own words, published under his own name.
 * Describing his style in prose would be me competing with it; handing over the
 * posts themselves is the opposite.
 *
 * ⚠️ AND IT IS WHY THE FIRST DRAFT READ WRONG. The one draft ever reviewed came
 * out in comment-reply register — all-lowercase openings, no formatting — which
 * was correct obedience to a prompt written for YouTube comment boxes. Nothing
 * in the request had ever shown the model what a post of his looks like.
 */
function styleBlock(examples: { title: string; body: string }[]): string {
  if (!examples.length) return "";
  return [
    "",
    "==========================================",
    "HOW YOUR POSTS ARE WRITTEN — MATCH THIS",
    "==========================================",
    "",
    "These are your OWN most recent posts in this community, exactly as they were",
    "published. They are the specification for the body: the opening, the rhythm,",
    "the line breaks, the emoji, how links are written, and how a post ends.",
    "",
    "Take their SHAPE and their VOICE. Do not reuse their subjects, their links or",
    "their phrasing, and do not write about what they are about.",
    "",
    ...examples.map((e, i) => `--- your post ${i + 1}: ${e.title}\n${e.body}`),
  ].join("\n\n");
}

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

/**
 * Turn whatever the model returned into an attachment, or nothing.
 *
 * ⚠️ THIS IS A GATE, NOT A PARSER, AND IT IS THE ONLY THING STANDING BETWEEN A
 * HALLUCINATED ID AND A DEAD EMBED IN FRONT OF THE COMMUNITY. It is the same
 * bargain `citedFrom` makes for lesson links: the model may only choose from
 * what it was shown, and anything else silently becomes "no attachment" — which
 * is always a safe post, where a wrong video is not.
 */
function attachmentFrom(raw: unknown, candidates: { videoId: string; title: string }[]): Attachment | null {
  if (!raw || typeof raw !== "object") return null;
  const a: any = raw;

  if (a.kind === "video") {
    const id = String(a.videoId ?? "").trim();
    const known = candidates.find((c) => c.videoId === id);
    // Not on the list it was given: drop it. No repair, no nearest match.
    if (!known) return null;
    return { kind: "video", videoId: known.videoId, title: known.title, url: youtubeUrl(known.videoId) };
  }

  if (a.kind === "poll") {
    const options = (Array.isArray(a.options) ? a.options : [])
      .map((o: unknown) => String(o ?? "").trim())
      .filter((o: string) => o.length > 0 && o.length <= 80)
      .slice(0, 4);
    // A one-option poll is not a poll, and Skool renders three empty boxes by
    // default — publishing with fewer than two is a broken post, not a quiet
    // degradation, so it becomes no attachment instead.
    const unique: string[] = [...new Set<string>(options)];
    if (unique.length < 2) return null;
    return { kind: "poll", options: unique };
  }

  if (a.kind === "gif") {
    // ⚠️ A SEARCH TERM, AND A SHORT ONE. Giphy matches loosely, so a long
    // sentence returns whatever it feels like — which on this surface means an
    // arbitrary image emailed to the community. A term that reads like a
    // sentence is dropped rather than sent, on the same "no attachment is
    // always safe" rule as the video.
    const query = String(a.query ?? "").trim().replace(/\s+/g, " ");
    if (!query || query.length > 40 || query.split(" ").length > 4) return null;
    return { kind: "gif", query };
  }

  return null;
}

/** Map the model's cited URLs back to the lessons that were actually offered. */
function citedFrom(cited: unknown, hits: Retrieved[]): { title: string; url: string }[] {
  const urls = Array.isArray(cited) ? cited.map(String) : [];
  return hits.filter((h) => urls.includes(h.url)).map((h) => ({ title: h.title, url: h.url }));
}

/** "lesson" = the classroom post; "mcp" = Tuesday's automation idea. */
export type PostKind = "lesson" | "mcp";

export interface PostRequest {
  communityUrl: string;
  voicePrompt: string;
  /**
   * Which of the two post shapes to write.
   *
   * ⚠️ NOT COSMETIC. "mcp" adds MCP_NOTE, which imposes a fixed four-part
   * structure — what the automation does, the services with their links, a
   * numbered tutorial, then cost and limits. Sending a video announcement or a
   * pinned subject through it produces a post fighting its own instructions.
   */
  kind: PostKind;
  /** What to write about. Chosen by the caller so the same subject is not reused. */
  subject: string;
  /** Titles of recent posts, so the draft does not repeat one. */
  recentTitles: string[];
  /**
   * Jake's own recent posts, in full, as the style reference for the body.
   *
   * Passed in rather than read here because the caller has already loaded the
   * feed to get `recentTitles` — and a second read means a second headless
   * browser cycle on a box where that is the expensive part.
   *
   * Empty is allowed and is NOT silently equivalent: with no examples the
   * drafter falls back to a prompt written for YouTube comment boxes, which is
   * exactly how the first draft came out in the wrong register.
   */
  styleExamples: { title: string; body: string }[];
  categories: string[];
  preferredCategory: string | null;
  /**
   * Jake's own uploads the draft may attach one of, or none.
   *
   * ⚠️ THE MODEL PICKS AN ID FROM THIS LIST — IT NEVER WRITES A URL. Whatever it
   * returns is checked back against these ids and dropped if it is not one of
   * them, so a hallucinated or half-remembered id becomes "no attachment"
   * instead of a dead embed in front of the whole community.
   */
  videoCandidates?: { videoId: string; title: string }[];
}

/**
 * How many of his own posts to show. Four is enough to establish a shape and
 * cheap enough not to matter — measured at roughly 2,000 characters each
 * against a draft that already costs ~9,000 tokens.
 */
const STYLE_EXAMPLE_COUNT = 4;

/** A body shorter than this teaches nothing about the shape of a post. */
const STYLE_EXAMPLE_MIN_CHARS = 600;

/**
 * Pick the style exemplars out of a feed read.
 *
 * ⚠️ `byMe` IS LOAD-BEARING, NOT TIDINESS. There are two "Jake Dawson" accounts
 * in this community — the pinned "Start here" post belongs to the other one —
 * so a filter on the display name would quietly teach the agent to write like
 * whoever else posts here. Recency order is the feed's own.
 *
 * Shared by both callers so the scheduled post and the manual draft bench are
 * shown the same thing. Two selections would mean "what does it sound like?"
 * answered a different question from the one that actually posts.
 */
export function styleExamplesFrom(
  posts: { title: string; body: string; byMe: boolean }[],
  count = STYLE_EXAMPLE_COUNT,
): { title: string; body: string }[] {
  const seen = new Set<string>();
  const out: { title: string; body: string }[] = [];
  for (const p of posts) {
    if (!p.byMe) continue;
    const body = asAuthored((p.body ?? "").trim());
    const title = (p.title ?? "").trim();
    if (body.length < STYLE_EXAMPLE_MIN_CHARS) continue;
    // A pinned post is listed twice on page one under two different ids.
    if (seen.has(title)) continue;
    seen.add(title);
    out.push({ title, body });
    if (out.length >= count) break;
  }
  return out;
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
    styleBlock(req.styleExamples),
    mechanics("post", req.kind === "mcp" ? `${POST_FORMAT_NOTE}\n\n${MCP_NOTE}` : POST_FORMAT_NOTE),
    attachmentNote(req.videoCandidates ?? []),
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
      attachment: attachmentFrom(parsed.attach, req.videoCandidates ?? []),
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
