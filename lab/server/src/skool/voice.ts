/**
 * Jake's voice, checked in code — the words and phrasings he does not write.
 *
 * ⚠️⚠️ THE LISTS ARE IMPORTED FROM THE SCRIPT GENERATOR, NOT COPIED. Jake,
 * 2026-09-12: "add the new language rules from the script generator to match
 * Jake's voice." There is one Jake and there must be one list: a copy taken
 * today stops tracking the moment he corrects a word over there, and the two
 * halves of his own voice drift apart without anybody being told. So this file
 * DERIVES its list from `scriptgen/edits.ts` and records only what it removes
 * and what it adds — a word he bans for a script is banned here the next time
 * the container builds, with no second edit.
 *
 * `scriptgen/edits.ts` has no imports of its own, so this costs nothing but the
 * module.
 *
 * ⚠️⚠️ WHAT THIS FILE IS ALLOWED TO DO, AND WHAT IT IS NOT. A voice finding is
 * ADVISORY: it earns one repair pass and then the message goes out anyway. It
 * must never park a member's reply, because Jake, 2026-09-02: "I'm not checking
 * the skool agent everyday — I want it to work automatically and never 'left
 * for you'." A reply containing the word "genuinely" is worth one more turn of
 * the model; it is not worth a member waiting for a human who is not coming.
 * The rules that DO park a message live in `outgoing.ts` and `safety.ts` and
 * are about harm, not taste. See `BLOCKING_RULES` there.
 */

import { AI_SLOP_PHRASES, BANNED_WORDS } from "../scriptgen/edits.js";

/**
 * Entries of `BANNED_WORDS` that are right for a video script and wrong here.
 *
 * ⚠️ MEASURED BEFORE BEING DROPPED, over all 33 posts and replies this agent
 * has ever sent (2026-09-12), not decided by taste:
 *
 * - **"which" — 31 hits, and only 2 are the rule's target.** The scriptgen rule
 *   is about the RELATIVE pronoun: "it runs on a schedule, which is handy" →
 *   two short spoken sentences. Almost every "which" on Skool is the
 *   INTERROGATIVE — "Which AI do you actually open every day?", "which app
 *   would you plug in first?" — which is the headline of the ask posts, the
 *   only format in this community that earns comments at all. Banning it flat
 *   would edit Jake out, which the scriptgen list says in as many words it must
 *   never do. Re-added below, narrowed to the comma form.
 * - **"clip" / "stills" / "still image" — 6 hits, every one correct.** Jake's
 *   rule ("call it a video, never a clip") is about how a lesson names the
 *   thing it is teaching a beginner to make. In a DM to a video editor about
 *   her own footage, "clips" is simply the word for the thing, and the replies
 *   that used it were right. The noun ban does not travel to a conversation.
 */
const NOT_FOR_SKOOL = new Set([
  "which",
  "clip",
  "stills",
  "still (?:image|images|frame|frames|shot|shots|photo|photos|picture|pictures)",
  "(?:a|an|the|another|generated|single) still",
]);

/**
 * The relative-pronoun "which" only — a comma directly in front of it.
 *
 * ⚠️ A COMMA, AND DELIBERATELY NOT AN EM DASH. "— which one?" and "— which app
 * would you plug in first?" are questions to the community, and the em dash is
 * how Jake writes a question after a lead-in. Counting the dash as relative put
 * 10 of his own approved lines in the report.
 */
const RELATIVE_WHICH = ",\\s*which";

/**
 * Phrasings this agent reaches for that Jake does not, beyond the shared lists.
 *
 * Each one is here because it appears in something this agent actually sent, or
 * because Jake named it in the script rules and it applies to a message as much
 * as to a script. Nothing is here on suspicion.
 */
const SKOOL_EXTRA: { re: RegExp; why: string }[] = [
  // RULE 10 — don't narrate your own honesty. Both of these went out: "Quick
  // honest bit first, because it saves you a headache later" (Tajuan, 09-03)
  // and "So here's the honest bit first" (09-11). Saying a take is honest
  // spends a sentence claiming it instead of being it.
  {
    re: /\b(?:quick\s+)?honest\s+bit\b|\bmy\s+real\s+take\b|\bhonest\s+thoughts\b|\bfor\s+real\s+this\s+time\b|\bif\s+I'?m\s+being\s+honest\s+with\s+you\b/gi,
    why: "it narrates its own honesty instead of just saying the honest thing (script rule 10)",
  },
  // RULE 10 — don't announce the part you are about to do. The content is the
  // signal that the subject turned; a sentence whose only job is to say one is
  // coming gets cut.
  {
    re: /\blet'?s\s+talk\s+(?:money|pricing|cost|costs)\b|\b(?:that|which)\s+brings\s+(?:us|me)\s+(?:neatly\s+)?to\b|\bbefore\s+(?:we|I)\s+get\s+into\s+that\b/gi,
    why: "it announces a section instead of delivering it (script rule 10)",
  },
  // RULE 2 — never punch down. AI_SLOP_PHRASES already carries "what most
  // people get wrong"; these are the other shapes, and the rule has no
  // exception outside a video hook, which this surface does not have.
  {
    re: /\byou'?re\s+probably\s+(?:making|doing|getting|using)\b|\bthe\s+average\s+(?:user|person|beginner|creator)\b|\bmost\s+people\s+(?:don'?t\s+even|have\s+no\s+idea|aren'?t\s+even|are\s+using\s+this\s+wrong)\b/gi,
    why: "it positions the reader as the one who does not know (script rule 2 — never punch down)",
  },
  // RULE 8 — "Imagine …", never "Picture …". Only as a sentence opener, which
  // is where it reads like a slide deck.
  {
    re: /(?:^|[.!?]\s+|\n)\s*Picture\b/g,
    why: 'it opens on "Picture …" — Jake says "Imagine …" (script rule 8)',
  },
];

/** A banned entry is a regex fragment, not a literal — see `BANNED_WORDS`. */
const SKOOL_BANNED: string[] = [
  ...BANNED_WORDS.filter((w) => !NOT_FOR_SKOOL.has(w)),
  RELATIVE_WHICH,
];

/**
 * The banned entries that are plain words, for the prompt to quote.
 *
 * ⚠️ DERIVED FROM THE SAME ARRAY THE CHECK USES, so the rule a drafter is given
 * and the rule it is judged by cannot drift. Regex entries are dropped rather
 * than prettified — ",\s*which" is a pattern, and a prompt that told the model
 * to never write ",\s*which" would teach it nothing. Those get written out in
 * prose beside this list, where they can be explained.
 */
export function bannedWordsForPrompt(): string[] {
  return SKOOL_BANNED.filter((w) => /^[a-z][a-z' ]*$/i.test(w));
}

export interface VoiceFinding {
  /** The matched text, lowercased — what to tell the drafter to stop writing. */
  phrase: string;
  /** Why it is wrong, in a sentence the drafter can act on. */
  why: string;
  index: number;
  length: number;
}

/** Cap per distinct phrase, so one repeated word cannot crowd out the rest. */
const MAX_PER_PHRASE = 2;
/** …and on the report, which is read by a model with a job to do. */
const MAX_FINDINGS = 10;

/**
 * Every banned word, slop phrase and Skool-specific tic in the text.
 *
 * `exempt` is the demonstration spans from `outgoing.ts` — a prompt Jake is
 * showing a member how to type is his words about their tool, not his prose,
 * and the placeholder rule already treats those spans that way. A member's own
 * sentence quoted back would be exempt too, which is correct for the same
 * reason: it is not this agent's writing.
 */
export function findVoiceIssues(
  text: string,
  exempt: (index: number, length: number) => boolean = () => false,
): VoiceFinding[] {
  // Curly apostrophes first. A model writes "it's worth noting" with U+2019
  // about as often as with an ASCII quote, and a list written one way silently
  // misses the other — `findSlopPhrases` normalises for exactly this reason.
  // Replacing one character with one character keeps every index valid.
  const norm = text.replace(/[‘’]/g, "'");
  const found: VoiceFinding[] = [];
  const perPhrase = new Map<string, number>();

  const push = (match: string, why: string, index: number, length: number): void => {
    if (exempt(index, length)) return;
    const key = match.toLowerCase().trim();
    const seen = perPhrase.get(key) ?? 0;
    if (seen >= MAX_PER_PHRASE) return;
    perPhrase.set(key, seen + 1);
    found.push({ phrase: key, why, index, length });
  };

  // Plurals count: "a few caveats" is the same word, and \b after "caveat"
  // fails against the "s" — the scar is recorded on `findBannedWords`.
  const banned = new RegExp(`\\b(${SKOOL_BANNED.join("|")})s?\\b`, "gi");
  for (const m of norm.matchAll(banned)) {
    push(m[0], `"${m[0].trim().toLowerCase()}" is not a word Jake writes`, m.index ?? 0, m[0].length);
  }

  const slop = new RegExp(`\\b(${AI_SLOP_PHRASES.join("|")})\\b`, "gi");
  for (const m of norm.matchAll(slop)) {
    push(m[0], `"${m[0].trim().toLowerCase()}" is AI-register filler, not this voice`, m.index ?? 0, m[0].length);
  }

  for (const { re, why } of SKOOL_EXTRA) {
    for (const m of norm.matchAll(re)) {
      // The opener patterns capture the leading punctuation or newline; point
      // the excerpt at the word itself so the drafter sees what to change.
      const lead = m[0].length - m[0].trimStart().length;
      push(m[0].trim(), why, (m.index ?? 0) + lead, m[0].trim().length);
    }
  }

  return found
    .sort((a, b) => a.index - b.index)
    .slice(0, MAX_FINDINGS);
}

/* ──────────────────── restating what they just said ──────────────────── */

/**
 * Words that carry no subject, so sharing them is not an echo.
 *
 * Short words are dropped by length rather than listed — the test below only
 * counts words of 4 characters or more, which removes "the", "and", "for",
 * "you", "get" and most of the rest without a dictionary.
 */
const ECHO_STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "what", "when", "where", "which", "from",
  "have", "just", "like", "into", "your", "yours", "mine", "they", "them", "then",
  "than", "been", "being", "about", "there", "here", "some", "more", "most", "much",
  "very", "really", "still", "also", "want", "wanted", "know", "think", "thing",
  "things", "make", "made", "good", "great", "help", "would", "could", "should",
  "because", "thanks", "thank", "hello", "start", "started", "starting",
]);

/**
 * The opener is the FIRST SENTENCE, and the cap is only for a runaway one.
 *
 * ⚠️⚠️ IT WAS THE FIRST 200 CHARACTERS AND THAT WAS MEASURING THE WRONG THING.
 * Verified live 2026-09-12 against the thread this exists for: once the prompt
 * stopped opening on approval, the drafts came back "The results and the
 * outcome pitch aren't either/or, they work best stacked. 2.6M views for
 * clients is your proof." and "Both stacked beats picking one. Keep the 2.6M in
 * the pitch." Both open on the ANSWER, which is exactly what was asked for —
 * and a 200-character window reached into the second and third sentences and
 * flagged them for the words any honest answer about her pitch has to use.
 *
 * A restatement lives in the FIRST sentence: that is the shape of the thing
 * ("Love this — fitness influencers are a smart niche to pick."). Past it, a
 * reply is allowed to talk about the subject it was asked about, and a check
 * that cannot tell those apart spends a repair pass on every good reply — which
 * is how a guard gets switched off in a week.
 *
 * All three of the real restatements are still caught at 3 (video/editor/
 * outreach, love/fitness/influencers/niche, 2.6m/views/clients/social/proof)
 * and both good drafts now pass at 2.
 */
const OPENER_CHARS = 200;

/**
 * The first sentence, or the first line, whichever ends sooner.
 *
 * ⚠️ A FULL STOP ONLY ENDS A SENTENCE WHEN WHITESPACE FOLLOWS IT, AND THE
 * FIXTURE THAT PROVES IT IS "2.6M". Splitting on a bare `[.!?]` cut the opener
 * "That's a strong hand to play — 2.6M views with real clients is proper social
 * proof." at "…play — 2." — three words, nothing shared, and the loudest real
 * restatement in the whole thread reported CLEAN. Decimals, "e.g." and a URL's
 * dots all do this, and the failure is silent in the direction that passes.
 */
function firstSentence(text: string): string {
  const t = text.trim().slice(0, OPENER_CHARS);
  const m = t.match(/[.!?](?=\s|$)|\n/);
  return m?.index === undefined ? t : t.slice(0, m.index + 1);
}

const contentWords = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s.]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^\.+|\.+$/g, ""))
      .filter((w) => w.length >= 4 && !ECHO_STOPWORDS.has(w)),
  );

/**
 * How many of their own content words the reply's opening hands back to them.
 *
 * ⚠️⚠️ THIS IS A HEURISTIC AND IT IS DELIBERATELY ADVISORY. Jake, 2026-09-12:
 * "in a DM thread I don't want the bot to repeat the idea that the other person
 * said in the first paragraph or at all in the next message, just continue the
 * conversation like normal people would do." The prompt carries the rule; this
 * measures whether it held, because the same complaint had already been made
 * twice about opening tics (OVERRIDE 4 and OVERRIDE 5) and each time the rule
 * alone was not enough.
 *
 * Measured against the thread Jake sent, which is the whole reason this exists:
 *   "A video editor getting into AI for outreach — that's a good spot to be in"
 *     vs "I'm a video editor, and I got into AI mainly for work … outreach" → 4
 *   "Love this — fitness influencers are a smart niche to pick"
 *     vs "My niche is fitness influencers" → 3
 *   "That's a strong hand to play — 2.6M views with real clients is proper
 *    social proof" vs "hitting 2.6M views with clients … social proof" → 5
 *
 * A reply that opens on the ANSWER shares one or two topic nouns at most, which
 * is why the threshold is 3 — and why a false positive costs one repair turn
 * and never a parked message.
 */
export const ECHO_THRESHOLD = 3;

export function echoedWords(replyText: string, theirText: string): string[] {
  const opener = firstSentence(replyText);
  // Their LAST message is what a restatement restates, but the caller passes
  // whatever it collected — for a run of unanswered messages that is all of
  // them, which is correct: opening by summarising any of them is the failure.
  const theirs = contentWords(theirText);
  return [...contentWords(opener)].filter((w) => theirs.has(w));
}
