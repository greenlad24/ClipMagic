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
import { youtubeUrl, videosForSubject } from "./channelVideos.js";

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
    "",
    "⚠️ IF YOU SAY THEY WILL LEARN SOMETHING, LINK WHERE. Jake, 2026-08-09.",
    "Any sentence that points at classroom material — \"you'll learn X and Y\",",
    "\"the AI Agents track covers this\", \"there's a lesson on it\", \"start with\" —",
    "must carry the exact URL of the page that teaches it, from the list below.",
    "Naming a topic or a track with no link is the failure this rule exists to",
    "stop: the member is told something exists and not told where it is, in a",
    "classroom with 143 pages.",
    "- One link per thing you named. Name two topics, that is two links.",
    "- Link the PAGE, not the course. The list gives page URLs for exactly this.",
    "- If nothing in the list actually teaches what you named, do not point at",
    "  the classroom for it at all — say it plainly without the pointer.",
    "",
    "⚠️ THE LINKS GO IN THE BODY, WHERE MEMBERS READ THEM. `cited` is a record of",
    "what you used and is NOT published — a URL that appears only in `cited` is a",
    "link nobody can click. Write it into the body as a bare URL on its own line,",
    "the way the examples do, and list it in `cited` as well.",
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

/**
 * What a Skool reply is allowed to be, against a voice prompt written for a
 * YouTube comment box.
 *
 * ⚠️⚠️ THE OVERRIDES NAME THE RULES THEY OVERRIDE, and that is the whole
 * technique — this file's founding lesson is that an unnamed contradiction gets
 * resolved differently on every run. `POST_FORMAT_NOTE` had to do exactly this
 * for RULE 1 when three posts in a row obeyed a lowercase rule written for
 * Instagram. The same prompt is the ONLY voice source here, so the same fix
 * applies, aimed at two different rules.
 *
 * ⚠️ AND MOST OF THE VOICE PROMPT IS KEPT ON PURPOSE. Unlike a post, a Skool
 * comment or DM IS the register those rules were written for — lowercase
 * openings, contractions, no markdown, Jake's banned words. Jake, 2026-08-20:
 * "still in the Jake Dawson voice". Only length and deflection change.
 */
/**
 * What a Skool reply is allowed to be, against a voice prompt written for a
 * YouTube comment box.
 *
 * ⚠️⚠️ EVERY OVERRIDE NAMES THE RULE IT OVERRIDES, and that is the whole
 * technique. This file's founding lesson is that an unnamed contradiction gets
 * resolved differently on every run — `POST_FORMAT_NOTE` had to name RULE 1
 * after three posts in a row obeyed a lowercase rule written for Instagram.
 *
 * ⚠️ IT IS NOW FIVE OVERRIDES DEEP, WHICH IS THE ARGUMENT FOR A SKOOL-SPECIFIC
 * VOICE PROMPT. `replyPromptMd` is a YouTube/IG comment-box guide and it is the
 * ONLY voice source both agents have. Each override here is correct and each
 * one widens the gap between what the prompt says and what actually runs.
 *
 * ⚠️ AND MOST OF THE PROMPT IS STILL KEPT ON PURPOSE — Jake, 2026-08-20:
 * "still in the Jake Dawson voice". RULE 2 (sentence length), 5 (contractions),
 * 6 (sentence starters), 7 (no markdown, the emoji limit) and 8/9 (the words
 * and phrases he never uses) are the voice, and none of them are touched.
 */
/**
 * Strip the citation markup web search leaves in the model's prose.
 *
 * ⚠️⚠️ THIS IS A HARD STRIP, NOT A PROMPT RULE, AND IT EXISTS BECAUSE THE FIRST
 * SEARCH-BACKED DRAFT WOULD HAVE POSTED THIS TO A MEMBER VERBATIM:
 *
 *   look at <cite index="3-0">Synthesia — it turns text into video</cite>
 *
 * With the `web_search` tool on, Claude marks which sentences came from which
 * result using `<cite index="…">` tags around the borrowed text. That is correct
 * behaviour for a research answer and it is unreadable in a Skool comment. It
 * appeared in the very first draft after search was enabled, in three separate
 * sentences, and nothing else in the pipeline would have caught it — the JSON
 * parsed, the length was right, the links were real.
 *
 * A prompt line asking for no citation markup is added as well, but the strip is
 * what makes it safe: a rule the model merely obeys most of the time is not a
 * defence when nobody reads the output before the community does.
 *
 * The INNER TEXT IS KEPT — it is the sentence, not decoration. Only the tags go.
 */
export function stripSearchMarkup(text: string): string {
  return String(text ?? "")
    // <cite index="3-0">the sentence</cite> → the sentence
    .replace(/<\/?cite\b[^>]*>/gi, "")
    // Bare reference markers some responses use instead: [1], [2, 3] on their
    // own — but NOT a markdown link's [label](url), which is why the lookahead
    // refuses a following paren.
    .replace(/\[\d+(?:\s*,\s*\d+)*\](?!\()/g, "")
    // The strip can leave a doubled space or a space before punctuation.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
}

/**
 * Today's date, and the instruction that makes the search worth running.
 *
 * ⚠️⚠️ WITHOUT THIS THE MODEL ANSWERS FROM ITS TRAINING AND THE SEARCH BECOMES
 * DECORATION. Jake, 2026-08-20: a member asked about video tools and the reply
 * recommended Runway, Pika, Kling and Veo — a reasonable list, and out of date:
 * "Seedance 2.5 was the right answer". Web search was ON for that reply. It had
 * no reason to look, because nothing told it that what it already knew might be
 * stale, or even what day it is.
 *
 * Lifted from `researchDateBlock` in the script generator, which learned the
 * same thing the expensive way — a script that tells a hundred thousand people
 * to click a button that no longer exists.
 */
function replyDateBlock(today: string): string {
  return [
    `TODAY'S DATE IS ${today}.`,
    "",
    "⚠️ YOUR TRAINING IS OLDER THAN TODAY AND THIS FIELD MOVES EVERY FEW WEEKS.",
    "The best tool for a job changes, models get replaced by better ones, prices",
    "and free tiers change, and products get discontinued. A name you are",
    "confident about may have been superseded since you last saw it.",
    "",
    "So before you recommend ANY tool, model or price: SEARCH FOR WHAT IS",
    "CURRENT TODAY. Not what was best when you learned it — what somebody would",
    "actually be told to use this week.",
    "- If the thing you were about to recommend has been overtaken, say what has",
    "  overtaken it and recommend that instead.",
    "- Name versions where versions matter. \"the latest\" ages; a version number",
    "  and a date does not.",
    "- If a search cannot confirm something, say you could not confirm it. A gap",
    "  you flag is useful. A gap you fill from memory is how a member is sent to",
    "  a product that no longer exists.",
  ].join("\n");
}

/**
 * Jake's own recent uploads, offered so a reply can point at his video.
 *
 * ⚠️ HIS OWN VIDEO BEATS A THIRD-PARTY LINK AND THE FIRST VERSION COULD NOT SEE
 * ONE. Jake, 2026-08-20, about the same video-tools reply: "I did a video about
 * it (Higgsfield video)." The classroom index is the 15 rebuilt courses, which
 * is months of work behind the channel — so a tool he covered last week is
 * invisible to retrieval and visible here.
 *
 * ⚠️ OFFERED, NOT INSTRUCTED. The matcher is word overlap on titles and it
 * deliberately includes a few of the newest even when nothing matches, so the
 * list routinely contains videos that have nothing to do with the question. The
 * prompt has to say that plainly or the model will reach for one anyway.
 */
function ownVideosBlock(videos: { title: string; url: string; publishedAt: number }[]): string {
  if (!videos.length) return "";
  const fmt = (ms: number): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "date unknown");
  return [
    "==========================================",
    "JAKE'S OWN RECENT YOUTUBE VIDEOS — link one ONLY if it really covers this",
    "==========================================",
    ...videos.map((v) => `- ${v.title}  (${fmt(v.publishedAt)})  ${v.url}`),
    "",
    "If one of these actually covers what the member asked, say so in your own",
    "voice and paste the bare URL on its own line — his own video is a better",
    "answer than a link to somebody else's tool page.",
    "⚠️ THIS LIST INCLUDES RECENT VIDEOS THAT MATCH NOTHING, on purpose, so that a",
    "subject his titles do not name can still find its video. Most of the time",
    "the honest answer is that none of them covers it. Linking a video that does",
    "not is the same failure as linking a lesson that does not — see above.",
  ].join("\n");
}

/**
 * The name to greet somebody by.
 *
 * ⚠️ FIRST TOKEN, AND NOTHING CLEVERER. Skool gives DMs a real `memberFirstName`
 * and gives comments only a display name, so this is the fallback for the
 * comment surface. It deliberately does not try to parse titles, particles or
 * reversed name orders: an empty string is a supported answer here — the rule
 * greets without a name rather than with a wrong one.
 */
export function firstNameOf(fullName: string): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  // A handle like "ai_automations" or an emoji display name is not a name to
  // greet. Letters only, and long enough to be one.
  if (first.length < 2 || !/^\p{L}[\p{L}'’-]*$/u.test(first)) return "";
  return first;
}

function skoolReplyNote(firstName: string): string {
  const greeting = firstName
    ? `The first line begins exactly "Hey ${firstName}," and carries straight on`
    : 'This member\'s first name is not known, so open with "Hey," and carry straight on';
  return [
    "==========================================",
    "OVERRIDES TO THE STYLE GUIDE ABOVE — SKOOL ONLY",
    "==========================================",
    "",
    "The style guide still governs your VOICE. Keep the sentence length, the",
    "contractions, the sentence patterns, the plain formatting, the emoji limit,",
    "and every word and phrase it tells you Jake never uses. The rules below are",
    "named one by one, and only those named are withdrawn.",
    "",
    "⚠️ OVERRIDE 1 — `RULE 3: REPLY LENGTH` DOES NOT APPLY. Jake, 2026-08-20:",
    '"I want the answers to be complete (but still in the Jake Dawson voice) not',
    'just surface level replies."',
    "That rule caps every reply at 5-10 sentences. It was written for a YouTube",
    "comment box where nobody reads more. This is his own paid community: the",
    "member asked because they are stuck, and half an answer sends them somewhere",
    "else to find the rest.",
    "- Answer the WHOLE question — every part of it they asked.",
    "- Give the specifics: the actual tool, the actual setting, the actual steps",
    "  in the order they would do them. `RULE 7`'s plain numbered lines are the",
    "  format, and the four-step limit under COMMENT TYPES does not apply either.",
    "- Say what it costs, what the free tier does and where it breaks, when those",
    "  are part of a real answer.",
    "- Length is decided by the question, not by a cap. A one-line question still",
    "  gets a one-line answer. Padding a short answer to look thorough is the",
    "  opposite of what this asks for.",
    "",
    "⚠️ OVERRIDE 2 — NEVER DEFLECT SOMETHING FOR BEING OFF-TOPIC. Jake,",
    '2026-08-20: "for things that are outside of the scope of the skool community',
    '— always do research and help (never say sorry this is not what I do here)."',
    "The guide tells you to answer ON-TOPIC questions and, when you do not know,",
    'to say "not sure off the top of my head" and point at the docs. Both are',
    "withdrawn.",
    "- A member asking about a tool the classroom never covers still gets a real",
    "  answer. Research it and answer it.",
    '- Never write any version of "that\'s outside what I cover", "I\'d check their',
    '  docs", "not really my area", or "not sure off the top of my head".',
    "- You have web search. USE IT whenever the answer depends on something you",
    "  are not certain is still true — a price, a free tier, a menu path, a limit,",
    "  whether a product still exists. Search first, then answer.",
    "- ⚠️ NEVER PUT CITATION MARKUP IN THE REPLY. No `<cite>` tags, no [1] style",
    "  reference markers, no \"according to their site\" framing. This is a message",
    "  to one person, not a research write-up: state what you found in Jake's own",
    "  words. If a source is worth handing over, paste the bare URL on its own",
    "  line, the way the classroom links are written.",
    "",
    "⚠️ OVERRIDE 3 — `RULE 1: CAPITALIZATION` DOES NOT APPLY. Jake, 2026-08-20:",
    '"make the first letter of a sentence an uppercase."',
    'RULE 1 says start every sentence with a lowercase letter, always. Write',
    "normal sentence case instead: every sentence, and every numbered step,",
    "starts with a capital letter.",
    "- The rest of RULE 1 stands: \"I\" is always uppercase, and the product and",
    "  proper names it lists keep their real capitalisation.",
    "- This does NOT make the voice formal. Short sentences, contractions and the",
    "  same word choices — just capitalised the way anyone writes.",
    "",
    "⚠️ OVERRIDE 4 — OPEN WITH A GREETING BY NAME. Jake, 2026-08-20: \"start each",
    'reply with Hey {name}".',
    greeting + " into the answer on the SAME line — not a greeting paragraph of",
    "its own, and no \"hope you're well\".",
    "- Their FIRST name only. Never the full name, never a nickname you invented.",
    "- It replaces whatever opener PATTERN A/B/C or COMMENT TYPES would have",
    "  chosen. Even a one-fragment praise reply gets it.",
    "",
    "⚠️ OVERRIDE 5 — DO NOT OPEN WITH THE SAME WORD EVERY TIME. Jake,",
    '2026-08-20: "not every time say yeah as the first word."',
    "`PATTERN A` is [short acknowledgment] — [the actual content], and that",
    'acknowledgment collapses to "yeah" on nearly every reply, which reads as a',
    "tic rather than a voice. It is a real word in this voice; it is not the only",
    "one.",
    "- The word after the comma must vary from reply to reply. Often the cleanest",
    "  opener is no acknowledgment at all — go straight at the answer.",
    '- Never let "yeah" become the default. If it is the honest reaction, use it;',
    "  if it is filler, cut it.",
    '- Do NOT swap one tic for another. "Ah", "right", "so", "honestly" on every',
    "  reply is the same failure wearing a different word.",
    "",
    "⚠️ WHAT DOES NOT CHANGE, and it is what makes the overrides safe:",
    "- No invented numbers, prices, limits or results. If a search did not",
    "  confirm it, say what you do know and say plainly what they should check.",
    "- No earnings claims and no time-to-result promises, ever, from any source.",
    "- The classroom-link rule stands exactly as written. Off-topic means ANSWER",
    "  it, not invent a lesson for it — if nothing in the list teaches it, answer",
    "  in plain words with no classroom pointer at all.",
    "",
    "⚠️⚠️ A REAL URL UNDER A FALSE PROMISE IS THE FAILURE TO WATCH FOR, AND IT HAS",
    "ALREADY HAPPENED ONCE. A reply explained system prompts, formatting",
    'instructions and temperature, then wrote "that lesson walks through it" over',
    'a link to "Finding Your First AI Win" — a real page, in the list, that scores',
    "your recurring tasks and mentions none of those three things. Nothing caught",
    "it: the URL was genuine, so the never-invent-a-URL rule was satisfied while",
    "the sentence around it was not.",
    "- Before you attach a link, check the PAGE actually teaches the SPECIFIC",
    "  thing the sentence just named. Close subject, same course, sounds related —",
    "  none of those are the test. Does it teach that?",
    "- If it does not, say the thing in plain words and attach nothing. A member",
    "  who clicks and finds something else has been told the classroom covers",
    "  something it does not, which is worse than never being pointed anywhere.",
    "- ⚠️ OVERRIDE 2 MAKES THIS MORE LIKELY, NOT LESS. Being told to help with",
    "  anything creates pressure to find somewhere in the classroom to point for",
    "  everything. Answering off-topic well means answering it in plain words —",
    "  it does not mean finding the nearest lesson.",
    "- `skip` is still for what needs Jake HIMSELF — money owed, refunds,",
    "  complaints, anything legal or personal — and for spam. Those are about WHO",
    "  should answer, not about what the question is about.",
  ].join("\n");
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
 * The ask post: a question to the community, opening on the week's new members.
 *
 * ⚠️⚠️ THE @MENTIONS ARE NOT WRITTEN BY THE MODEL, AND THIS NOTE'S MAIN JOB IS
 * TO SAY SO. A mention only notifies when it is a real ProseMirror node, and the
 * body arrives in the composer as ONE PASTE — so `@Claudia Garcia` written into
 * the draft would be grey text linking to nobody, which is the exact opposite of
 * the point. The publisher types the chips itself, first, and the body is pasted
 * after them (`typeMentions` in mentions.ts). The drafter's job is therefore to
 * write a first sentence that reads correctly with a list of names already
 * standing in front of it.
 *
 * ⚠️ AND THE QUESTION IS THE POST, NOT THE GARNISH. Asked for "a post that
 * welcomes the new members and asks a question", a model writes four paragraphs
 * of welcome and one limp question at the end — which is a welcome post, and
 * gets the engagement a welcome post gets. The proportions are stated here as
 * numbers for that reason.
 */
function askNote(
  newMembers: { firstName: string; displayName: string }[],
  welcomeMessage: string,
): string {
  const lines = [
    "THIS IS THE WEEKLY ASK POST, AND ITS JOB IS TO GET REPLIES.",
    "",
    "It is SHORT — much shorter than a lesson post. Well under half the length",
    "of the examples above. Nobody answers a question they had to scroll to.",
    "",
    "It must:",
    "- ask ONE question, and only one. Two questions get zero answers.",
    "- ask something a member can answer from their own experience in a",
    "  sentence or two — what they are building, what is in their way, what",
    "  they tried that worked. Never a quiz with a right answer, never",
    "  something they would need to go and look up.",
    "- be specific enough to be answerable. \"What are your AI goals?\" is not a",
    "  question, it is a survey. \"What is the one task you keep doing by hand",
    "  that you know a machine could take?\" is a question.",
    "- say something real before the question — one short observation, from the",
    "  subject below, that gives the question a reason to exist today. Two or",
    "  three sentences, not a lesson.",
    "- close by asking for the answer in the comments, in Jake's own way.",
    "",
    "⚠️ PREFER NO POLL. This post exists to collect REPLIES, and a poll gives",
    "people a way to take part without writing one. Attach a poll only if the",
    "honest answers really are a short list of options — if the question invites",
    "a sentence, the answer belongs in the comments.",
    "",
    "Do NOT teach a lesson here. Do NOT list steps. Do NOT link a lesson unless",
    "the question genuinely needs it — this post asks, it does not explain.",
  ];

  // ⚠️⚠️ THE WELCOME MESSAGE IS TWO INSTRUCTIONS, AND THE SECOND IS THE ONE
  // NOTHING ELSE IN THIS SYSTEM COULD SUPPLY. Every new member has ALREADY been
  // asked a question, privately, by a Skool auto-DM this code cannot see — and
  // the post is about to @mention those exact people. Without this block it will
  // cheerfully ask them the same thing again within days of the DM, and the only
  // witness is the member.
  //
  // It is also the voice spec for the greeting. `styleBlock` shows how Jake
  // writes a POST; this shows how he greets a PERSON, which is a different and
  // shorter register, and the greeting is the one line of this post that has to
  // sound like it.
  if (welcomeMessage.trim()) {
    lines.push(
      "",
      "==========================================",
      "WHAT THEY HAVE ALREADY BEEN SENT",
      "==========================================",
      "",
      "Every new member gets this message from Jake privately when they join:",
      "",
      welcomeMessage.trim(),
      "",
      "TWO THINGS FOLLOW FROM IT, AND BOTH ARE HARD RULES:",
      "",
      "1. ⚠️ DO NOT ASK WHAT IT ALREADY ASKS. These people have had that",
      "   question put to them personally, days ago. Asking it again in public",
      "   reads as not having noticed they answered. Ask something ELSE — and if",
      "   the subject below is close to it, go at a different angle.",
      "",
      "2. THIS IS THE VOICE FOR THE GREETING. Warm, direct, plain. It asks ONE",
      "   thing. It lets the reader off the hook rather than putting them on the",
      "   spot. Match that register in the opening line — the examples further up",
      "   show how Jake writes a POST, this shows how he greets a PERSON.",
      "   ⚠️ BUT USE FEWER EMOJI THAN IT DOES. Jake, 2026-08-27: that voice,",
      "   \"just not too many emojis\". Copy the warmth, not the decoration.",
      "",
      "   ⚠️⚠️ AND BE PRECISE ABOUT WHICH ONES, OR THIS RULE GETS OVERRULED AND",
      "   NOTHING SAYS SO. Two emoji are HOUSE STYLE and are not what he means:",
      "   the single marker at the front of the TITLE, and the 👇 on the closing",
      "   line. Every post in the examples above has both, and dropping them",
      "   would make this post look like it came from somebody else.",
      "   What to cut is emoji in the BODY PROSE — the 🥳 and 😅 sprinkled through",
      "   the welcome message. Zero of those. So: one in the title, one 👇 at the",
      "   end, and none anywhere in between.",
    );
  }

  if (newMembers.length) {
    const names = newMembers.map((m) => m.firstName || m.displayName).filter(Boolean);
    lines.push(
      "",
      "==========================================",
      "THE OPENING — IT IS ALREADY WRITTEN. DO NOT WRITE IT AGAIN.",
      "==========================================",
      "",
      `${names.length} ${names.length === 1 ? "person" : "people"} joined this week: ${names.join(", ")}.`,
      "",
      "Their @mentions are placed at the very start of the post BEFORE your text,",
      "automatically, as real Skool mention chips. Your body is added straight",
      "after them, on the same line.",
      "",
      "So your FIRST WORDS continue that line. Write them to follow a list of",
      "names — an em dash and a welcome, then straight into why you are asking",
      "them in particular.",
      "",
      "⚠️ THE FIRST LINE MUST NOT START WITH \"-\" OR \"*\". Those are list markers:",
      "the body is rendered as markdown, so a leading dash becomes a BULLET on its",
      "own line and the greeting stops following the names. Use an em dash — like",
      "this one — or no dash at all.",
      "",
      "⚠️ DO NOT WRITE ANY NAME OR ANY @ YOURSELF. Not at the start, not later,",
      "not \"welcome Claudia and Denise\". A name you type is plain text that",
      "notifies nobody, and it would appear twice — once as your text and once as",
      "the real mention. Refer to them as a group if you need to: \"you three\".",
      "",
      "Address the question to them FIRST — they are the reason it is being asked",
      "today — then invite everybody else to answer it too, in one line. Both",
      "halves matter: a question only the newcomers can answer gets four replies,",
      "and a question that ignores them wastes the welcome.",
    );
  } else {
    lines.push(
      "",
      "Nobody new joined this week, so there is no welcome and no mention. Open",
      "straight on the observation and go to the question. Do not invent a",
      "greeting for members who are not there.",
    );
  }

  return lines.join("\n");
}

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

/**
 * "lesson" = the classroom post; "mcp" = Tuesday's automation idea;
 * "ask" = Thursday's question to the community.
 *
 * ⚠️ EACH ONE SWITCHES IN A DIFFERENT SET OF INSTRUCTIONS, so a kind that does
 * not match its SUBJECT produces a post fighting its own prompt — see the note
 * on `PostRequest.kind`, which is where that has actually happened.
 */
export type PostKind = "lesson" | "mcp" | "ask";

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
  /**
   * The members the ask post opens by greeting — names only, for the prompt.
   *
   * ⚠️ THE DRAFTER IS TOLD ABOUT THEM SO IT DOES NOT WRITE THEM. The chips are
   * typed into the composer by the publisher before the body is pasted, because
   * a pasted @mention is inert text. Passing the names lets the first sentence
   * be written to follow them; `askNote` spends most of its length forbidding
   * the model from writing them itself.
   *
   * Ignored unless `kind` is "ask". Empty is a normal week.
   */
  newMembers?: { firstName: string; displayName: string }[];
  /**
   * The welcome message every new member already receives, verbatim.
   *
   * Ignored unless `kind` is "ask". Empty means the drafter is not told what
   * they have already been asked — which is a worse post, not a broken one.
   */
  welcomeMessage?: string;
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

/**
 * Make an ask post's first line safe to sit behind a row of mention chips.
 *
 * ⚠️⚠️ A LEADING "- " IS A BULLET, NOT A DASH, AND THE FIRST DRAFT EVER WRITTEN
 * OPENED WITH ONE. Asked for "a dash and a welcome", the model wrote
 * `- welcome in, glad you made it here.` — which is exactly what it was told to
 * write, and which the markdown renderer turns into a list item on its own line.
 * The chips would then sit alone above a bullet, and the sentence written to
 * follow them would not.
 *
 * The prompt now says so, but a prompt is a request. This is the guarantee, and
 * it is deliberately narrow: only the FIRST line, only when there are chips to
 * follow, and only a marker that begins it. A genuine bulleted list later in the
 * post is untouched.
 */
export function openingForMentions(body: string): string {
  const nl = body.indexOf("\n");
  const first = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? "" : body.slice(nl);
  // "- welcome in" → "— welcome in". An em dash is what the line wanted to be,
  // so the sentence survives intact rather than losing its opening beat.
  const fixed = first.replace(/^\s*[-*+]\s+/, "— ");
  return fixed === first ? body : fixed + rest;
}

export async function draftPost(req: PostRequest): Promise<{ draft: Draft | null; error: string | null }> {
  if (!req.voicePrompt.trim()) {
    // Same refusal as the Engagement Manager: with no voice stored, generation
    // is INERT rather than falling back to a house style nobody approved.
    return { draft: null, error: "No voice prompt is stored, so nothing was drafted." };
  }

  // The ask post retrieves as few lessons as the MCP one: it is not built out of
  // the classroom, it only needs enough of it to have something true to say
  // before the question. Six hits would invite it to teach, which askNote is
  // otherwise busy forbidding.
  const { hits } = retrieve(req.communityUrl, req.subject, req.kind === "lesson" ? 6 : 4);
  const outline = classroomOutline(req.communityUrl);

  const extra =
    req.kind === "mcp"
      ? `${POST_FORMAT_NOTE}\n\n${MCP_NOTE}`
      : req.kind === "ask"
        ? `${POST_FORMAT_NOTE}\n\n${askNote(req.newMembers ?? [], req.welcomeMessage ?? "")}`
        : POST_FORMAT_NOTE;

  const system = [
    req.voicePrompt,
    styleBlock(req.styleExamples),
    mechanics("post", extra),
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

  const body = String(parsed.body).trim();

  return {
    draft: {
      title: String(parsed.title).trim(),
      // Only an ask post that actually has chips in front of it: on every other
      // post the first line stands on its own and a bullet there is the author's
      // choice.
      body: req.kind === "ask" && (req.newMembers?.length ?? 0) > 0 ? openingForMentions(body) : body,
      category,
      attachment: attachmentFrom(parsed.attach, req.videoCandidates ?? []),
      cited: citedFrom(parsed.cited, hits),
      tokens: totalTokens(usage),
      model,
    },
    error: null,
  };
}

/**
 * One automation idea for a Tuesday post.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE TUESDAY WAS ASKING FOR A SHAPE ITS SUBJECT COULD NOT
 * CARRY. `chooseSubject` picks from the LESSON index — the only subject source
 * there was — and `kindForSlot` then forced `kind: "mcp"`, so the drafter got
 * "write about Why Small Businesses Fail at AI" and "this is the Tuesday post,
 * write one MCP automation idea" in the same prompt. Measured 2026-08-09: it
 * resolves the contradiction by silently dropping the MCP half and writing a
 * lesson post. Nobody had ever seen it because every slot ever opened was
 * `kind: lesson` — the hardcode was only lifted the day before.
 *
 * An automation idea is not in the classroom index, so it cannot be retrieved;
 * it has to be proposed. What keeps that honest is the same rule the MCP post
 * itself runs under — only services that certainly exist — plus the fact that
 * the SUBJECT is only a direction. The four-part body still has to stand up on
 * its own, and `MCP_NOTE` governs it.
 *
 * ⚠️ IT REFUSES RATHER THAN INVENTS, and the caller falls back to a lesson
 * subject with `kind: "lesson"`. A Tuesday that posts a good lesson beats a
 * Tuesday that posts a tutorial for an MCP server that does not exist — that
 * one is not recoverable, because members will go and try it.
 */
export async function chooseMcpSubject(req: {
  communityUrl: string;
  /** Subjects already used, so Tuesday does not propose the same automation twice. */
  usedSubjects: string[];
}): Promise<{ subject: string; error: string | null }> {
  const outline = classroomOutline(req.communityUrl);

  const system = [
    "You propose ONE automation idea for a weekly post in an AI automation community.",
    "",
    "Return ONE JSON object and nothing else.",
    `Shape: {"subject": string, "why": string}`,
    "",
    "`subject` is a single sentence naming the automation, the services it joins,",
    "and who it is for. It is a brief for the writer, not the post.",
    "",
    "HARD RULES:",
    "- ONLY name services and MCP servers you are CERTAIN exist today. If you are",
    "  not certain, propose a different automation. An invented MCP server sends",
    "  members chasing something that is not there, and they will say so.",
    "- It must be genuinely useful to a small business or solo operator, and",
    "  doable in an afternoon. Not a platform, not a startup idea.",
    "- It must fit a four-part write-up: what it does and who for, every service",
    "  it touches, a step-by-step a beginner can follow, then cost and limits.",
    "- Prefer the tools this community already teaches, listed below.",
    "- Do NOT repeat any automation already used. They are listed below.",
  ].join("\n");

  const user = [
    "THE CLASSROOM — the tools and subjects these members already know:",
    outline.outline.slice(0, 4000),
    "",
    req.usedSubjects.length
      ? `ALREADY USED — do not propose these again:\n${req.usedSubjects.map((s) => `- ${s}`).join("\n")}`
      : "Nothing has been posted yet.",
  ].join("\n");

  const { json } = await claudeJSONForPurposeWithUsage({
    tier: "director",
    purpose: "skool-post",
    system,
    messages: [{ role: "user", content: user }],
    auth: aiConfig.skoolEngageAuth,
  });

  // ⚠️ `json` IS THE RAW STRING, NOT A PARSED OBJECT — the same `parseDraft`
  // step `draftPost` runs. Reading `.subject` straight off it yields undefined,
  // which is indistinguishable from the model declining to answer: the first
  // version of this reported "the model did not propose an automation" while
  // the model had proposed a perfectly good one.
  const parsed = parseDraft(json);
  const subject = typeof parsed?.subject === "string" ? parsed.subject.trim() : "";
  if (!subject) return { subject: "", error: "The model did not propose an automation." };
  return { subject, error: null };
}

/**
 * One question for the weekly ask post.
 *
 * ⚠️ THE LESSON INDEX IS THE WRONG SOURCE FOR THIS, THE SAME WAY IT WAS WRONG
 * FOR TUESDAY. `chooseSubject` returns "Finding Your First AI Win (from the
 * course …)", which is a thing to TEACH; the ask post needs a thing to ASK. Fed
 * a lesson title, the drafter resolves the mismatch the way it always does —
 * quietly, by writing a lesson post with a question stapled on the end, which is
 * the shape this post was added to stop producing.
 *
 * ⚠️ IT REFUSES RATHER THAN INVENTS, and the caller falls back to a lesson
 * subject while KEEPING `kind: "ask"` — deliberately unlike Tuesday, which falls
 * back to `kind: "lesson"`. The MCP shape cannot survive a lesson subject (it
 * demands services, links and a tutorial); the ask shape can, because "ask the
 * community a question about X" works whatever X is. A Thursday that asks a
 * slightly duller question still gets replies; a Thursday that quietly becomes a
 * fourth lesson post does not.
 */
export async function chooseAskSubject(req: {
  communityUrl: string;
  /** Subjects already used, so it does not ask the same thing twice. */
  usedSubjects: string[];
  /** How many people joined this week, so the question can be aimed at them. */
  newMemberCount: number;
  /**
   * The welcome message they have already been sent.
   *
   * ⚠️ NEEDED HERE AS WELL AS IN THE DRAFTER, AND NOT REDUNDANTLY. If the
   * SUBJECT is the duplicate question, telling the writer "do not ask this"
   * leaves it with a brief it has been forbidden to carry out — and the way that
   * gets resolved is the way every contradiction here gets resolved: silently,
   * badly, and only visible once it is on the feed.
   */
  welcomeMessage: string;
}): Promise<{ subject: string; error: string | null }> {
  const outline = classroomOutline(req.communityUrl);

  const system = [
    "You propose ONE question for a weekly engagement post in an AI automation",
    "community for beginners.",
    "",
    "Return ONE JSON object and nothing else.",
    `Shape: {"subject": string, "why": string}`,
    "",
    "`subject` is a single sentence: the question to ask, plus the one thing",
    "worth saying before it. It is a brief for the writer, not the post.",
    "",
    "HARD RULES:",
    "- It must be answerable from the member's OWN experience, in a sentence or",
    "  two, with no research and no right answer. If it could be graded, it is",
    "  the wrong question.",
    "- It must be specific. A question that could be asked of any community on",
    "  any week is one nobody answers.",
    "- A beginner must be able to answer it. Most of these members are early —",
    "  a question that assumes a running pipeline excludes the people it is",
    "  most meant for.",
    "- Do NOT repeat a question or subject already used. They are listed below.",
    "- It may lean on what the classroom teaches, listed below, but it must not",
    "  require having done a lesson.",
    req.newMemberCount > 0
      ? `- ${req.newMemberCount} member(s) joined this week and will be greeted at the top of ` +
        "the post, so the question should be one a brand-new member can answer on " +
        "their first day, while still being worth answering for someone who has " +
        "been here a year."
      : "- Nobody new joined this week, so the question is for the whole community.",
    req.welcomeMessage.trim()
      ? [
          "",
          "⚠️ EVERY NEW MEMBER HAS ALREADY BEEN ASKED THIS, PRIVATELY, WHEN THEY",
          "JOINED. Do not propose it again, and do not propose a rephrasing of it:",
          "",
          req.welcomeMessage.trim(),
        ].join("\n")
      : "",
  ].join("\n");

  const user = [
    "THE CLASSROOM — what these members are here to learn:",
    outline.outline.slice(0, 4000),
    "",
    req.usedSubjects.length
      ? `ALREADY USED — do not propose these again:\n${req.usedSubjects.map((s) => `- ${s}`).join("\n")}`
      : "Nothing has been posted yet.",
  ].join("\n");

  const { json } = await claudeJSONForPurposeWithUsage({
    tier: "director",
    purpose: "skool-post",
    system,
    messages: [{ role: "user", content: user }],
    auth: aiConfig.skoolEngageAuth,
  });

  // ⚠️ `json` IS THE RAW STRING — the same trap `chooseMcpSubject` documents.
  // Reading `.subject` off it yields undefined, which is indistinguishable from
  // the model declining.
  const parsed = parseDraft(json);
  const subject = typeof parsed?.subject === "string" ? parsed.subject.trim() : "";
  if (!subject) return { subject: "", error: "The model did not propose a question." };
  return { subject, error: null };
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
  /**
   * Their first name, for the greeting.
   *
   * ⚠️ PASSED IN RATHER THAN LEFT TO THE MODEL TO SPLIT. "Hey Jason," is right
   * and "Hey Jason Davies," is not — but guessing which half of a two-word
   * handle is the given name is not something to do on a live message. The DM
   * payload already carries a real `memberFirstName`, so the caller supplies
   * what it knows, and an empty string means "greet without a name" rather
   * than "invent one".
   */
  authorFirstName: string;
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
        skoolReplyNote(req.authorFirstName),
        "",
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

  // His own uploads that might cover the question. Read live (memoised 30 min,
  // 2 quota units) rather than from the classroom index, which is months behind
  // the channel by design. A failure here costs the video suggestion and must
  // not cost the reply.
  const ownVideos = await videosForSubject(`${req.text} ${req.context}`.slice(0, 400), 8).catch(() => []);

  const user = [
    replyDateBlock(new Date().toISOString().slice(0, 10)),
    "",
    `${req.authorName} wrote:`,
    req.text,
    "",
    req.context ? `CONTEXT — the post this sits under:\n${req.context.slice(0, 2500)}` : "",
    "",
    groundingBlock(hits),
    "",
    ownVideosBlock(ownVideos),
  ].join("\n");

  // ⚠️ WEB SEARCH IS ON FOR REPLIES AND OFF FOR POSTS, AND THE ASYMMETRY IS THE
  // POINT. A post is written about a lesson that is already in the index, so
  // there is nothing to look up. A reply answers whatever a member happened to
  // ask — Jake, 2026-08-20: "for things that are outside of the scope of the
  // skool community - always do research and help". Without a real search that
  // instruction can only be obeyed from memory, which is exactly how a
  // confidently wrong price or menu path reaches a member.
  const ask = (webSearch: boolean) =>
    claudeJSONForPurposeWithUsage({
      tier: "director",
      purpose: "skool-engage-reply",
      system,
      messages: [{ role: "user", content: user }],
      auth: aiConfig.skoolEngageAuth,
      webSearch,
    });

  let { json, usage } = await ask(true);
  let parsed = parseDraft(json);
  if (!parsed) {
    // ⚠️ ONE RETRY, WITHOUT SEARCH — and this is a deliberate exception to the
    // "one attempt, never a second" rule that governs the scriptgen research
    // call. That rule protects a single very expensive pipeline stage. Here the
    // failure being caught is specific and new: `jsonMode` combined with the
    // search tool, where the JSON has to survive a response that also carries
    // tool_result blocks. The alternative to retrying is that a member with an
    // off-topic question is never answered at all, silently, because nothing
    // records a draft that was never produced.
    console.warn("[skool] reply JSON was unusable with web search — asking again without it");
    ({ json, usage } = await ask(false));
    parsed = parseDraft(json);
  }
  if (!parsed) return { reply: null, error: "The model's reply was not usable JSON, with or without web search." };

  const skip = parsed.skip ? String(parsed.skip) : null;
  const body = String(parsed.text ?? "").trim();
  if (!skip && !body) return { reply: null, error: "The model returned neither a reply nor a reason to skip." };

  return {
    reply: {
      // ⚠️ STRIPPED HERE, NOT AT THE WRITE PATH. Both surfaces and the manual
      // draft bench go through this return, so one strip covers all three;
      // doing it in `replyToComment` and `sendDm` separately is two places to
      // forget when a third surface arrives.
      text: stripSearchMarkup(body),
      skip,
      cited: citedFrom(parsed.cited, hits),
      tokens: totalTokens(usage),
    },
    error: null,
  };
}
