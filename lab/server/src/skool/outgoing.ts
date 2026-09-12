/**
 * THE LAST THING READ BEFORE THE COMMUNITY READS IT.
 *
 * Jake, 2026-08-28, asked for pre-send checks on everything the Skool agent
 * writes: a price, an income or results claim, an unknown link, a leaked
 * placeholder, an @mention of somebody who is not in the conversation, or a
 * runaway length. This is that gate.
 *
 * ⚠️⚠️ IT IS A CHECK ON THE TEXT, NOT AN INSTRUCTION TO THE MODEL, AND THAT IS
 * THE WHOLE POINT. Every rule below is already stated somewhere in a prompt —
 * "❌ NEVER: a price", "only name services you are certain exist", "never
 * reproduce a sponsor read, discount code or income claim". Prompts are how
 * this agent is asked; they are not how it is bound. Three separate defects in
 * this project's history were a model quietly resolving a contradiction its own
 * way (RULE 1's lowercase leaking into a post, the MCP half being dropped from
 * a lesson subject, links written into `cited` where nobody could click them),
 * and none of them were fixable by asking harder. A structural check is the
 * only kind that holds when nothing reads the output before 73 members do.
 *
 * ⚠️ IT RUNS IN TWO PLACES ON PURPOSE, AND THEY ARE NOT THE SAME CHECK.
 *  - At DRAFT time (`attemptSlot`, `draftOne`) the grounding set is still in
 *    hand, so `allowedUrls` can be passed and a fabricated classroom link is
 *    caught exactly.
 *  - At SEND time (`createPost`, `replyToComment`, `sendDm`) there is no
 *    grounding set, so it runs the rules that need no context — and it runs
 *    there because that is the only door every caller goes through. A guard the
 *    scheduler calls is a guard the endpoints, the retry path and the UI's
 *    Publish button can all walk past.
 *
 * ⚠️ MONEY IS THREE RULES, NOT ONE, AND THE DIFFERENCE IS WHAT KEEPS IT USABLE.
 * An EARNINGS claim ("made $5k a month", "saves you 20 hours a week") is refused
 * outright — the agent may never say what a member will get. A price on JAKE'S
 * OWN side (the community, the paid tier) is refused too: the upgrade nudge's
 * own rules open with "❌ NEVER: a price". And a third-party tool price is
 * refused only when nothing near it says the number may have moved, because
 * Jake, 2026-08-28: "Don't state tool pricing or feature claims as fact. That
 * data goes stale weekly and members will hold the channel to it." The Tuesday
 * MCP post is still required to say what an automation costs — it just has to
 * send people to the tool's own pricing page for the current number.
 *
 * ⚠️ WHAT IT CANNOT DO, AND `safety.ts` HAS TO: judge a subject. A regex catches
 * "I'll cover that next week"; it cannot catch a fluent, well-grounded, kindly
 * worded answer that should never have been written because of WHO asked it or
 * WHAT it is about. That decision is made before the drafter runs, not after.
 */

export type OutgoingSurface = "post" | "comment" | "dm";

export type OutgoingRule =
  | "placeholder"
  | "earnings"
  | "offer-price"
  | "discount"
  | "link"
  | "mention"
  | "length"
  | "commitment"
  | "confidential"
  | "tool-price";

export interface OutgoingViolation {
  rule: OutgoingRule;
  /** What is wrong, in a sentence a human can act on. */
  detail: string;
  /** The offending fragment with a little context either side. */
  excerpt: string;
}

export interface OutgoingContext {
  surface: OutgoingSurface;
  /** The community this is going into. Used to tell our own links from anyone else's. */
  communityUrl?: string;
  /**
   * Every URL the drafter was shown or cited.
   *
   * ⚠️ UNDEFINED AND `[]` MEAN OPPOSITE THINGS, the same way `allowedCourseSlugs`
   * does in `access.ts`. Undefined = the caller has no grounding set (the
   * send-time backstop), so community links are not gated. `[]` = the caller
   * has one and it is empty, so no community link may appear at all.
   */
  allowedUrls?: string[];
  /** Names this text may @mention — the person being answered, and nobody else. */
  allowedMentions?: string[];
  /** Override the surface ceiling. */
  maxChars?: number;
}

export interface OutgoingCheck {
  ok: boolean;
  violations: OutgoingViolation[];
  /** One line, for a log line, a `last_error` column or a skip reason. */
  detail: string;
}

/**
 * Runaway ceilings, NOT style limits.
 *
 * Jake's own posts run 880–2,300 characters and `RULE 3: REPLY LENGTH` is
 * explicitly overridden for replies, which he wants long and step-by-step. So
 * these sit far above anything intended — they exist to catch a generation that
 * has come apart, not to police how much he says.
 */
const CEILING: Record<OutgoingSurface, number> = {
  post: 5000,
  comment: 4000,
  dm: 4000,
};

/** Handles that are always Jake's own to write. */
const OWN_HANDLES = ["jake", "jakedawson", "jake.dawson", "jakedaw", "jake_dawson"];

/**
 * Link shapes that are wrong wherever they appear.
 *
 * The shorteners are here because a shortened link is one nobody — including
 * this check — can see the destination of, and the affiliate markers because
 * Jake's sponsor rule ("teach the technique, name the tool, reproduce no promo,
 * no offer") has governed every lesson in the classroom.
 */
const SHORTENER_HOSTS = [
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "rebrand.ly",
  "lnkd.in", "amzn.to", "rb.gy", "cutt.ly", "shorturl.at", "s.id", "is.gd", "linktr.ee",
];

/** Domains that only ever appear in an example, never in something being sent. */
const PLACEHOLDER_HOSTS = [
  "example.com", "example.org", "example.net", "yourdomain.com", "yoursite.com",
  "mysite.com", "domain.com", "website.com", "test.com", "localhost",
];

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The fragment that tripped a rule, with enough either side to recognise it. */
function excerptAt(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 40);
  const to = Math.min(text.length, index + length + 40);
  return (from > 0 ? "…" : "") + norm(text.slice(from, to)) + (to < text.length ? "…" : "");
}

/* ────────────────────────── placeholders ────────────────────────── */

/**
 * Template scaffolding that reached the text.
 *
 * ⚠️ `{{title}}` IS NOT HYPOTHETICAL HERE. The recipe replayer substitutes
 * placeholders into the composer, and its own rule is that a missing value is
 * FATAL rather than empty — precisely because typing `{{title}}` into a live
 * post is worse than refusing. This is the same rule one layer up, for the case
 * where the model writes the braces itself.
 */
const PLACEHOLDER_PATTERNS: { re: RegExp; why: string; demoOk?: boolean }[] = [
  { re: /\{\{\s*[\w .-]{1,40}\s*\}\}/g, why: "a {{placeholder}} that was never filled in", demoOk: true },
  {
    re: /\[\s*(?:insert|your|their|name|link|url|topic|tool|lesson)\b[^\]\n]{0,40}\]/gi,
    why: "a [placeholder] that was never filled in",
    demoOk: true,
  },
  { re: /\b(?:TODO|TBD|FIXME|XXX)\b:?/g, why: "an unfinished note left in the text" },
  { re: /\blorem ipsum\b/gi, why: "placeholder copy" },
  { re: /\bas an? (?:AI|language model|assistant)\b/gi, why: "the model talking about itself — this is signed Jake Dawson" },
  { re: /\bI(?:'m| am) (?:an? )?(?:AI|Claude|a language model|a bot)\b/gi, why: "the model talking about itself — this is signed Jake Dawson" },
  // ⚠️⚠️ THE DRAFTER SECOND-GUESSING ITSELF, INSIDE THE POST. Measured
  // 2026-09-06: the repaired video announcement came back reading
  // "…it'll make the video land harder: 👉 https://www.skool.com/… Wait — that
  // lesson link isn't one I ca…". It noticed mid-sentence that the link was not
  // in its grounding and typed the realisation into the body instead of starting
  // the sentence again. Only the LINK rule caught that draft — a version that
  // dropped the URL and kept the sentence would have published as written.
  //
  // Deliberately narrow. These are shapes that only occur when the text is
  // talking about its own drafting; "I can't link you to it" is a real sentence
  // and is not matched.
  { re: /\b(?:wait|hold on|actually)\s*[—–,-]+\s*that\s+(?:\w+\s+){0,2}(?:link|url)\b/gi, why: "the drafter arguing with its own draft" },
  { re: /\b(?:link|url|lesson)\s+(?:isn't|is not|wasn't|was not)\s+(?:one\s+)?I\s+(?:can|could|was|should)\b/gi, why: "the drafter arguing with its own draft" },
  { re: /\b(?:in|from|outside) (?:my|the) grounding\b/gi, why: "the drafter arguing with its own draft" },
  { re: /\bthe (?:pre-send |outgoing )?check (?:refused|flagged|blocked|rejected)\b/gi, why: "the drafter arguing with its own draft" },
];

/**
 * Where a blank is the content rather than a defect.
 *
 * ⚠️⚠️ THIS RULE REFUSED A GOOD REPLY AND LEFT IT FOR JAKE. On 2026-09-01 a
 * member asked how to stop hand-scraping Craigslist; the answer showed him what
 * to type at an agentic browser — `"go to Craigslist, search [your terms] in
 * [your city], give me title, price and link"` — and the placeholder rule
 * refused the whole message for containing the two blanks that make a
 * demonstrated prompt reusable. Jake, 2026-09-02: **"placeholders are ok when
 * you demonstrate a prompt."**
 *
 * A demonstration is text the reader is meant to copy, and there are exactly two
 * ways this agent marks that: quotation marks and backticks. Outside them the
 * words are Jake speaking, where an unfilled blank is still what it always was —
 * scaffolding that escaped.
 *
 * ⚠️ EVERY SPAN IS BOUNDED, AND THE BOUND IS THE SAFETY. An unmatched opening
 * quote would otherwise run to the end of the message and disarm the rule for
 * the entire text — the one failure that would turn a narrowing into a hole. A
 * span therefore ends at its closing mark, at a blank line, or at
 * MAX_DEMO_SPAN characters, whichever comes first.
 *
 * ⚠️ IT NARROWS THE TEMPLATE RULES ONLY (`demoOk`). "TODO", "lorem ipsum" and
 * the model talking about itself are never demonstrations of anything, so
 * quoting them does not make them sendable.
 */
const MAX_DEMO_SPAN = 600;

const DEMO_SPAN_PATTERNS: RegExp[] = [
  // Fenced block, then inline code — fences first so a fence's inner backticks
  // are already consumed and cannot open a span of their own.
  /```[\s\S]{0,600}?```/g,
  /`[^`\n]{1,600}`/g,
  // Straight and curly double quotes. Single quotes are deliberately absent:
  // an apostrophe would open a span on every other line.
  /"[^"\n]{1,600}"/g,
  /“[^”\n]{1,600}”/g,
];

/** Character ranges of every demonstration span in the text, as [start, end). */
function demoSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of DEMO_SPAN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const body = m[0];
      // A blank line means the opening mark was never closed and this match has
      // run across paragraphs to find a later one. Not a demonstration.
      if (/\n\s*\n/.test(body)) continue;
      if (body.length > MAX_DEMO_SPAN) continue;
      spans.push([start, start + body.length]);
    }
  }
  return spans;
}

const insideSpan = (spans: Array<[number, number]>, index: number, length: number): boolean =>
  spans.some(([from, to]) => index >= from && index + length <= to);

/* ────────────────────────── money ────────────────────────── */

/**
 * Money, hours and multiples — the three shapes a claim arrives in.
 *
 * ⚠️ FINDING THE NUMBER IS THE EASY HALF. Whether it is a CLAIM depends on what
 * sits beside it, and the two ways of asking that both fail: a wide keyword
 * window refuses honest prose ("Make Images with AI covers this. ChatGPT Plus
 * is $20 a month" has "Make" 60 characters from "$20"), and a tight one reports
 * clean — which is the sponsor-scan failure, the one that gets believed. So the
 * verb is required to POINT AT the amount, within a few words, and the wide
 * window is reserved for nouns that can only mean earnings.
 */
const MONEY_RE = /(?:[$£€]\s?[\d,]+(?:\.\d+)?\s*(?:k\b|m\b|million|billion)?|\b[\d,]+(?:\.\d+)?\s?[kK]\s*(?:\/|per\s+|a\s+)(?:mo\b|month|week|day|year)|\b(?:six|seven|6|7)[- ]figures?\b)/g;

/** "saved 20 hours this week" is a results claim wearing a clock. */
const HOURS_RE = /\b\d{1,3}\s*(?:hours?|hrs?)\b/g;

/** "10x your revenue" — a multiple is only a claim when it multiplies a result. */
const MULTIPLE_RE = /\b\d{1,3}x\b/g;

/** A verb of earning, pointing at an amount a few words later. */
const EARNING_BEFORE =
  /\b(?:make|makes|made|making|earn|earns|earned|earning|charge|charges|charged|charging|bill|billed|billing|pulled? in|pulling in|bring in|bringing in|brought in|generate[sd]?|generating|paid|pays|paying|banked|took home|worth)\s+(?:\w+\s+){0,3}$/i;

/** Nouns that cannot mean anything but money coming in. */
const EARNING_NOUN = /\b(?:revenue|profit|profits|income|mrr|arr|turnover|commission|payout|guarantee[ds]?|guaranteed)\b/i;

/** A verb of saving, pointing at a block of hours. */
const SAVING_BEFORE = /\b(?:sav(?:e|es|ed|ing)|win(?:s|ning)? back|get(?:s|ting)? back|freed? up)\s+(?:\w+\s+){0,3}$/i;

/** Words that mean the money is about Jake's own offer rather than a tool. */
const OFFER_NEAR =
  /\b(?:this community|the community|membership|members(?:hip)? area|plans page|paid side|paid tier|upgrade|upgrading|my course|my courses|the course|coaching|mentorship|mastermind|program|inner circle|subscription to)\b/i;

const DISCOUNT_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b\d{1,3}\s?%\s?(?:off|discount)\b/gi, why: "a discount" },
  { re: /\b(?:discount|promo|coupon)\s?code\b/gi, why: "a discount code" },
  { re: /\buse\s+code\s+[A-Z0-9]{3,}\b/g, why: "a discount code" },
  { re: /\b(?:limited time|limited spots?|only today|today only|act now|last chance|don't miss out|spots? (?:are )?(?:left|filling)|closes (?:tonight|today|soon)|ends (?:tonight|today|soon))\b/gi, why: "urgency language" },
];

/* ────────────────────────── commitments and confidences ────────────────────────── */

/**
 * The things Jake listed on 2026-08-28 that the agent may never commit him to.
 *
 * ⚠️ EACH ONE IS A SENTENCE THAT READS PERFECTLY AND COSTS SOMETHING REAL. "I'll
 * cover that next week" is a promise about a production schedule the agent
 * cannot see. "Send it over and I'll take a look" is Jake's Saturday. Neither
 * looks like a mistake in the draft; both are only wrong from outside.
 */
const COMMITMENT_PATTERNS: { re: RegExp; why: string }[] = [
  {
    re: /\b(?:i'?ll|i will|we'?ll|i'?m going to|i am going to)\b[^.!?\n]{0,70}\b(?:next week|next video|next month|coming (?:weeks?|days?)|soon|later this (?:week|month)|upcoming|in the next one)\b/gi,
    why: "a promise about future content",
  },
  {
    re: /\b(?:new video|a video|tutorial|lesson)\b[^.!?\n]{0,40}\b(?:is )?(?:coming|dropping|out next|on the way)\b/gi,
    why: "a promise about future content",
  },
  {
    re: /\bi(?:'?ll| will| can)\s+(?:take a look|have a look|look at (?:it|that|yours)|build (?:it|that|you)|set (?:it|that) up for you|fix (?:it|that)|review (?:it|that|yours)|write (?:it|that) for you)\b/gi,
    why: "an offer to do the work for a member",
  },
  {
    re: /\bhappy to (?:build|set (?:it|that) up|take a look|have a look|review|fix|write it)\b/gi,
    why: "an offer to do the work for a member",
  },
  {
    re: /\b(?:send|dm|share)\s+(?:it|them|me|over)\b[^.!?\n]{0,50}\b(?:i'?ll|and i(?:'| w)|so i can)\b/gi,
    why: "an offer to do the work for a member",
  },
  {
    re: /\b(?:i'?ll (?:refund|comp|let you in|give you (?:free )?access)|free access|no charge|on the house|i'?ll waive)\b/gi,
    why: "a refund, comp or free access",
  },
  {
    re: /\b(?:guarantee[ds]?|i promise|you'?re guaranteed|will definitely (?:work|make|get))\b/gi,
    why: "a guarantee",
  },
];

/**
 * Subjects that do not exist in the agent's answers at all.
 *
 * ⚠️ NOT SECRETS TO BE HINTED AT. "I can't say who edits for me" is still an
 * answer about who edits, so the rule is on the subject, not on the disclosure.
 */
const CONFIDENTIAL_PATTERNS: { re: RegExp; why: string }[] = [
  {
    re: /\b(?:my (?:editor|team|assistant|videographer|agency|accountant)|our team|the team behind|who (?:edits|writes) (?:for me|the)|my (?:llc|ltd|company structure))\b/gi,
    why: "how the channel or the business is run",
  },
  {
    re: /\b(?:sponsor(?:ship)? (?:rate|fee|deal|money|pipeline)|(?:is|was|are) sponsored|paid me to|brand deal|affiliate commission|revenue split|profit share)\b/gi,
    why: "sponsorship or money arrangements",
  },
  {
    re: /\b(?:another member|someone else|a member) (?:said|told me|dm(?:'?ed|ed) me|messaged me|asked me)\b/gi,
    why: "repeating what another member said",
  },
  {
    re: /\b(?:your (?:billing|payment|card|subscription) (?:shows|says|is)|i can see your (?:account|payment|billing))\b/gi,
    why: "implying access to a member's billing",
  },
];

/**
 * A price with nothing hedging it.
 *
 * Jake, 2026-08-28: "Don't state tool pricing or feature claims as fact. That
 * data goes stale weekly and members will hold the channel to it."
 *
 * ⚠️ SO THE RULE IS NOT "NO PRICES" — IT IS "NO PRICES AS FACT". The Tuesday
 * MCP post is required by its own instructions to say what an automation costs,
 * and "the free tier covers this" is exactly the kind of true, useful sentence
 * this community runs on. What is refused is a bare number with nothing near it
 * saying it might have moved.
 */
const PRICE_HEDGE =
  /\b(?:check (?:their|the|its) (?:current )?(?:pricing|plans?|price|site|page|website)|last (?:i|I) checked|at the time of writing|prices? (?:change|move|shift)|may have changed|might have changed|don'?t quote me|as of (?:today|now|this week))\b/i;

/* ────────────────────────── links ────────────────────────── */

/**
 * Every link in the text, with where it starts.
 *
 * ⚠️ SCHEMELESS LINKS COUNT. Jake writes a bare URL after a 👉 and Skool
 * auto-links it, so "skool.com/…" with no https is a link a member clicks, and
 * a check that only understood `https://` would read straight past the one
 * shape his own posts actually use.
 */
export function linksIn(text: string): { url: string; index: number }[] {
  const out: { url: string; index: number }[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>()"'\]]+|\b[a-z0-9][a-z0-9-]{0,60}\.(?:com|net|org|io|ai|co|app|dev|me|xyz|to|gg|so)\b(?:\/[^\s<>()"'\]]*)?/gi;
  for (const m of text.matchAll(re)) {
    // Trailing sentence punctuation is not part of the URL.
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!url) continue;
    // A bare domain with no path is a NAME, not a link — "we teach Make.com" is
    // a sentence, not something a member clicks. Only gate what has a path or a
    // scheme, or the check starts refusing prose for mentioning a tool.
    const hasScheme = /^(?:https?:\/\/|www\.)/i.test(url);
    const hasPath = /\.[a-z]{2,}\/[^\s]/i.test(url);
    if (!hasScheme && !hasPath) continue;
    out.push({ url, index: m.index ?? 0 });
  }
  return out;
}

function hostOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return (u.pathname + u.search).toLowerCase();
  } catch {
    return "";
  }
}

/** Same URL, comparably: no scheme, no www, no trailing slash, lower case. */
export function normaliseUrl(url: string): string {
  const host = hostOf(url);
  if (!host) return url.trim().toLowerCase().replace(/\/+$/, "");
  return `${host}${pathOf(url)}`.replace(/\/+$/, "");
}

/**
 * The community's own path prefix, e.g. "/ai-automation-mastery".
 *
 * A skool.com link outside it is another community — which is both an invented
 * link and an advert for somebody else, and neither belongs in a post signed
 * Jake Dawson.
 */
function communityPrefix(communityUrl: string | undefined): string {
  if (!communityUrl) return "";
  const p = pathOf(communityUrl).split("?")[0].replace(/\/+$/, "");
  return p === "/" ? "" : p;
}

/* ────────────────────────── mentions ────────────────────────── */

/**
 * ⚠️ AN @MENTION IN GENERATED TEXT IS ALWAYS A MISTAKE, EVEN A CORRECT ONE.
 * Mentions on Skool only work as CHIPS typed through the autocomplete —
 * `typeMentions` exists because "a pasted @Name is grey text that links to
 * nobody and notifies nobody". So an @handle in a body or a reply is at best
 * inert and at worst somebody else's name in a stranger's conversation.
 */
function mentionsIn(text: string): { handle: string; index: number }[] {
  const out: { handle: string; index: number }[] = [];
  for (const m of text.matchAll(/(^|[\s(])@([A-Za-z][\w.-]{1,30})/g)) {
    out.push({ handle: m[2], index: (m.index ?? 0) + m[1].length });
  }
  return out;
}

const handleKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The spans between matching quotation marks.
 *
 * Straight and curly doubles only — apostrophes make single quotes useless for
 * this, and "don't" would open a span that swallows the rest of the paragraph.
 */
export function quotedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let open: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "\u201c" || c === "\u201d") {
      if (open === null) open = i;
      else {
        spans.push([open, i + 1]);
        open = null;
      }
    }
  }
  return spans;
}

/* ────────────────────────── the check ────────────────────────── */

/**
 * Read a piece of outgoing text and say whether it may be sent.
 *
 * Pure, total and never throws: it is called immediately before a browser write
 * and a checker that can crash there would take the send with it.
 */
export function checkOutgoing(text: string, ctx: OutgoingContext): OutgoingCheck {
  const violations: OutgoingViolation[] = [];
  const add = (rule: OutgoingRule, detail: string, index: number, length: number): void => {
    // One violation per rule per fragment is enough; ten copies of the same
    // finding buries the other rules in the sentence a human reads.
    if (violations.length >= 12) return;
    violations.push({ rule, detail, excerpt: excerptAt(text, index, length) });
  };

  const body = text ?? "";

  // Computed once for the whole text: a demonstrated prompt is usually the only
  // reason a bracket is in here at all, and the spans are the same for every rule.
  const demo = demoSpans(body);
  for (const { re, why, demoOk } of PLACEHOLDER_PATTERNS) {
    for (const m of body.matchAll(re)) {
      const index = m.index ?? 0;
      if (demoOk && insideSpan(demo, index, m[0].length)) continue;
      add("placeholder", `The text contains ${why}.`, index, m[0].length);
    }
  }

  // Two windows, because the two questions are different: what POINTS AT this
  // number (a few words before it) and what SURROUNDS it (a sentence either
  // side). Using one window for both is what makes a money check either
  // trigger-happy or useless.
  const before = (at: number): string => body.slice(Math.max(0, at - 70), at);
  const around = (at: number, len: number): string =>
    body.slice(Math.max(0, at - 90), Math.min(body.length, at + len + 90));

  for (const m of body.matchAll(MONEY_RE)) {
    const at = m.index ?? 0;
    // "six figures" needs no verb beside it — the phrase has one meaning.
    const figures = /figures?$/i.test(m[0]);
    if (figures || EARNING_BEFORE.test(before(at)) || EARNING_NOUN.test(around(at, m[0].length))) {
      add("earnings", "That reads as an income or results claim, which this agent may never make.", at, m[0].length);
    } else if (OFFER_NEAR.test(around(at, m[0].length))) {
      // ⚠️ A THIRD-PARTY PRICE IS FINE AND IS NOT THIS. "ChatGPT Plus is $20 a
      // month" is true, useful and everywhere in a beginners' community, and
      // the Tuesday MCP post is required to say what an automation costs. What
      // is refused is a price on Jake's OWN side of the paywall — the plans
      // nudge's own list of what it may never contain opens with "a price".
      add("offer-price", "That puts a price on the community or the paid side. The upgrade nudge names one course and the link, never a price.", at, m[0].length);
    }
  }

  // ⚠️ HOURS ARE CHECKED AGAINST *SAVING* ALONE. "I made this in 3 hours" is an
  // ordinary sentence in Jake's voice and must not be refused; "saves you 20
  // hours a week" is the ZAMS sponsor's claim, which has been kept out of every
  // lesson in the classroom.
  for (const m of body.matchAll(HOURS_RE)) {
    const at = m.index ?? 0;
    if (SAVING_BEFORE.test(before(at))) {
      add("earnings", "That reads as a time-saved claim, which this agent may never make.", at, m[0].length);
    }
  }

  for (const m of body.matchAll(MULTIPLE_RE)) {
    const at = m.index ?? 0;
    if (/\b(?:income|revenue|sales|results|leads|traffic|profit|business|conversions?|followers)\b/i.test(around(at, m[0].length))) {
      add("earnings", "That reads as a results multiplier, which this agent may never claim.", at, m[0].length);
    }
  }

  for (const { re, why } of DISCOUNT_PATTERNS) {
    for (const m of body.matchAll(re)) add("discount", `The text contains ${why}, which is sales language this agent does not use.`, m.index ?? 0, m[0].length);
  }

  // ⚠️⚠️ A COMMITMENT INSIDE QUOTATION MARKS IS A SCRIPT, NOT A PROMISE, AND
  // THIS IS MEASURED RATHER THAN ASSUMED. Swept over every reply the agent has
  // ever sent, the only commitment this rule found was in the sentence
  // `"Here's what it'd look like for your business" beats "I can build you
  // something" every time` — teaching a member what NOT to say to a prospect.
  // Refusing that would refuse the community's whole teaching register, which
  // quotes example sentences constantly.
  //
  // ⚠️ THE EXEMPTION IS FOR THIS RULE ONLY. An income claim or another member's
  // words are just as published for being in quotes; a promise is the one thing
  // that changes meaning when it is somebody else's line.
  const quoted = quotedSpans(body);
  const insideQuotes = (at: number, len: number): boolean =>
    quoted.some(([from, to]) => at >= from && at + len <= to);

  for (const { re, why } of COMMITMENT_PATTERNS) {
    for (const m of body.matchAll(re)) {
      const at = m.index ?? 0;
      if (insideQuotes(at, m[0].length)) continue;
      add("commitment", `That is ${why}, which this agent cannot make on Jake's behalf.`, at, m[0].length);
    }
  }

  for (const { re, why } of CONFIDENTIAL_PATTERNS) {
    for (const m of body.matchAll(re)) {
      add("confidential", `That says something about ${why}, which never appears in an answer.`, m.index ?? 0, m[0].length);
    }
  }

  // ⚠️ RUN AFTER the earnings and offer-price rules, and only on what they left:
  // a price already refused as an income claim does not need a second finding
  // telling the reader to hedge it.
  if (violations.every((v) => v.rule !== "earnings" && v.rule !== "offer-price")) {
    for (const m of body.matchAll(MONEY_RE)) {
      const at = m.index ?? 0;
      if (!PRICE_HEDGE.test(around(at, m[0].length))) {
        add(
          "tool-price",
          "That states a price as fact. Prices move weekly and members hold Jake to them — say what the tool does and send them to its own pricing page.",
          at,
          m[0].length,
        );
      }
    }
  }

  const prefix = communityPrefix(ctx.communityUrl);
  const allowed = ctx.allowedUrls ? new Set(ctx.allowedUrls.map(normaliseUrl)) : null;
  for (const { url, index } of linksIn(body)) {
    const host = hostOf(url);
    const path = pathOf(url);
    if (/^(?:javascript|data|file):/i.test(url) || /\/\/[^/@\s]+@/.test(url)) {
      add("link", "That is not a link to a web page.", index, url.length);
      continue;
    }
    if (PLACEHOLDER_HOSTS.includes(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      add("link", `${host} is a placeholder domain, so that link goes nowhere.`, index, url.length);
      continue;
    }
    if (SHORTENER_HOSTS.includes(host)) {
      add("link", `${host} hides where the link actually goes.`, index, url.length);
      continue;
    }
    if (/[?&](?:aff|aff_id|affiliate|partner|promo)=|[?&]tag=[\w-]+-\d{2}\b/i.test(path)) {
      add("link", "That link carries an affiliate or partner tag.", index, url.length);
      continue;
    }
    if (host.endsWith("skool.com")) {
      if (prefix && !path.startsWith(prefix)) {
        add("link", "That is a skool.com link outside this community.", index, url.length);
        continue;
      }
      if (allowed && !allowed.has(normaliseUrl(url))) {
        // The community root, its plans page and the classroom index are pages
        // every member already has; they are signposts, not citations, and the
        // upgrade nudge is REQUIRED to link the first of them.
        const tail = prefix ? path.slice(prefix.length).replace(/\/+$/, "") : path.replace(/\/+$/, "");
        const signpost = tail === "" || /^\/(?:plans|about|classroom)$/.test(tail);
        if (!signpost) {
          add(
            "link",
            "That classroom or post link was not in what the drafter was shown, so nothing proves the page exists.",
            index,
            url.length,
          );
        }
      }
    }
  }

  const allowedMentions = new Set([...OWN_HANDLES, ...(ctx.allowedMentions ?? [])].map(handleKey));
  for (const { handle, index } of mentionsIn(body)) {
    if (allowedMentions.has(handleKey(handle))) continue;
    add(
      "mention",
      `"@${handle}" is not in this conversation, and a typed @name is inert text on Skool in any case — mentions are typed as chips.`,
      index,
      handle.length + 1,
    );
  }

  const ceiling = ctx.maxChars ?? CEILING[ctx.surface];
  if (body.length > ceiling) {
    violations.push({
      rule: "length",
      detail: `${body.length} characters against a ${ceiling} ceiling for a ${ctx.surface}. That is a generation that has come apart, not a long answer.`,
      excerpt: excerptAt(body, ceiling, 0),
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    detail: violations.length === 0
      ? "Outgoing check passed."
      : `Refused by the outgoing check — ${violations.map((v) => `${v.rule}: ${v.detail} ${v.excerpt}`).join(" | ")}`,
  };
}

/**
 * Turn a refusal into instructions the drafter can act on.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE A REFUSAL USED TO BE THE END OF THE ROAD. A refused
 * reply was recorded as `skipped` and a refused post as `abandoned`, on the
 * reasoning that replaying identical words would be refused identically — true,
 * and it quietly made the check a way of handing work back to Jake. Jake,
 * 2026-09-02: **"I'm not checking the skool agent everyday — I want it to work
 * automatically and never 'left for you'."** So the words are not replayed: the
 * drafter is told exactly what was wrong and writes them again.
 *
 * ⚠️ IT NAMES THE FRAGMENT, NOT JUST THE RULE. "No unverified links" is advice
 * the drafter already had and followed as best it could; the excerpt is the part
 * it cannot argue with, and it is what makes one repair pass enough rather than
 * a lottery.
 *
 * ⚠️ AND IT ASKS FOR A REPAIR, NOT A REWRITE. The refused draft is usually good
 * — Fred's was — and a fresh attempt would throw away a correct answer to fix
 * two brackets. The instruction is deliberately narrow, and the check runs again
 * on whatever comes back, so a model that ignores it loses nothing but a turn.
 */
export function repairInstruction(check: OutgoingCheck): string {
  if (check.ok) return "";
  const lines = check.violations.map((v, i) => `${i + 1}. ${v.detail}\n   Where: ${v.excerpt}`);
  return [
    "⚠️ YOUR PREVIOUS DRAFT WAS REFUSED BY THE PRE-SEND CHECK. THIS INSTRUCTION OVERRIDES ANYTHING ABOVE THAT CONFLICTS WITH IT.",
    "",
    "What was wrong with it:",
    "",
    ...lines,
    "",
    "Write it again, fixing exactly those and changing as little else as possible. Keep the answer, the structure, the voice and everything that was not named above.",
    "",
    "How to fix each kind:",
    "- An unfilled blank: fill it in with a real value, or rewrite the sentence without it. A blank inside a prompt you are DEMONSTRATING is fine — put the prompt in quotes or backticks so it reads as something to copy.",
    "- A link that was not in your grounding: DELETE IT. Say the thing in words, or point at the classroom index instead, or link nothing at all — a post with no link goes out, a post with that link does not. Never keep, shorten or guess at a link you cannot see in what you were given.",
    "- A price, an earnings figure or a results claim: take the number out and send them to the tool's own pricing page, or say what it does instead of what it pays.",
    "- An @mention: delete it. A typed @name notifies nobody here.",
    "- Too long: cut it back to the point.",
    "",
    "Do not mention this instruction, the check, or the fact that anything was rewritten.",
    "",
    // ⚠️ SPELLED OUT BECAUSE THE ABSTRACT VERSION ABOVE WAS NOT ENOUGH. On
    // 2026-09-06 a repaired post kept the refused link and appended the model's
    // own realisation about it — "Wait — that lesson link isn't one I ca…" — so
    // the second draft was refused for the same rule as the first, plus this.
    "⚠️ SEND BACK ONLY THE FINISHED TEXT. Never write about the text: no \"wait\", no \"actually, that link\",",
    "no note about what you decided against or why. If you change your mind halfway through a sentence,",
    "delete the whole sentence and write the one you meant. A draft that argues with itself is refused again.",
  ].join("\n");
}
