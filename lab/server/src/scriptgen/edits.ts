/**
 * Pure text helpers for the script stages. No imports, no side effects — run.ts
 * owns the model calls and the persistence; this module only decides what the
 * text becomes (Stage 5.5 CTA parsing, Stage 6.5 edit surgery) and what the
 * writer is told it has already said (the Stage 5 continuity ledger).
 */

// ── Stage 5 continuity ledger ─────────────────────────────────────────────────

export interface ContinuityLedger {
  /**
   * Phrases used THREE OR MORE times already. Not two — Jake's approved scripts
   * say "let me show you" eight times in a tutorial and "if you want to" eight
   * times in a listicle, because that's the beat that resets a viewer's
   * attention before each demo. Repetition is the teaching cadence, not a defect.
   * Only genuine over-use gets flagged, and only in the sections that follow.
   */
  overusedPhrases: string[];
}

const LEDGER_CAP = 24;
/** A phrase has to be spent this many times before it counts as over-used. */
const OVERUSE_THRESHOLD = 3;

/**
 * Discourse markers. These are the connective tissue of speech — "Now,", "So,",
 * "Alright," — and Jake reuses them on purpose; a script without them reads like
 * an essay. They are NEVER flagged as repetition. What we flag is whatever
 * follows one: "Now, here's the thing" six times is a stock phrase; "Now," six
 * times is just a person talking.
 */
const DISCOURSE_MARKERS = new Set([
  "now", "so", "alright", "ok", "okay", "and", "but", "look", "anyway",
  "honestly", "well", "right", "oh", "actually", "listen", "see", "yeah",
]);

/** Drop up to two leading discourse markers ("Now, so…" → …). */
function stripMarkers(words: string[]): string[] {
  let i = 0;
  while (i < words.length && i < 2 && DISCOURSE_MARKERS.has(words[i])) i++;
  return words.slice(i);
}

/** Split prose into sentences, dropping markdown headers and [stage directions]. */
function splitSentences(text: string): string[] {
  const cleaned = text
    .replace(/^#{1,6}.*$/gm, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ");
  return cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wordsOf(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Rank by descending count, then drop the counts. */
function topBy(counts: Map<string, number>, min: number, cap: number): string[] {
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k]) => k);
}

/**
 * Build the "you've leaned on this too hard" ledger from the sections drafted so far.
 *
 * Stage 5 drafts each section in its own API call, so the model cannot see the
 * rest of the video. An earlier version of this flagged a phrase after ONE use,
 * and an opener after one use, and every short reaction. Measured against Jake's
 * approved scripts that was plainly wrong: they repeat freely, and the version
 * that suppressed repetition also flattened the sentence rhythm (burstiness
 * 0.655 → 0.582) — which is the one thing every approved script beats us on.
 *
 * So this now flags only genuine over-use: a phrase spent three or more times.
 * Openers and short reactions are not tracked at all.
 */
export function buildContinuityLedger(previousFinals: string[]): ContinuityLedger {
  const text = previousFinals.join("\n\n");
  if (!text.trim()) return { overusedPhrases: [] };

  const tokens = wordsOf(text);
  const phraseCounts = new Map<string, number>();
  for (const n of [4, 5]) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join(" ");
      phraseCounts.set(gram, (phraseCounts.get(gram) ?? 0) + 1);
    }
  }

  // A 5-gram that repeats also makes its 4-gram halves repeat; keep the longest
  // form. Strip any leading discourse marker so the flagged phrase is the stock
  // phrase itself ("here's the thing"), not the marker that introduced it.
  const overused = topBy(phraseCounts, OVERUSE_THRESHOLD, LEDGER_CAP * 2)
    .map((g) => stripMarkers(g.split(" ")).join(" "))
    .filter((g) => g.split(" ").length >= 3);
  const deduped = [...new Set(overused)];
  const overusedPhrases = deduped
    .filter((g) => !deduped.some((other) => other !== g && other.length > g.length && other.includes(g)))
    .slice(0, LEDGER_CAP);

  return { overusedPhrases };
}

// ── Word budget ───────────────────────────────────────────────────────────────

/** Jake speaks at roughly this rate, so runtime and word count are interchangeable. */
export const WORDS_PER_SPOKEN_MINUTE = 150;

/**
 * Parse "12 minutes minimum", "10–12 minutes", "15 min" → the number of minutes.
 * Takes the LAST number in a range, since "10–12" means aim for 12.
 */
export function parseTargetMinutes(targetLength: string): number | null {
  const nums = [...targetLength.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < 180);
  if (nums.length === 0) return null;
  return nums[nums.length - 1];
}

/** Words a single list item gets: measured from the 25-item gold (5,761 / 25). */
export const WORDS_PER_LIST_ITEM = 230;

/**
 * How many words the spoken script should run to.
 *
 * A list is sized by its items, not by a runtime — and the item count is a
 * QUALITY decision made upstream, by Stage 0, from the IDEA and the BRIEF. Five
 * genuinely good use cases beat twenty-five padded ones, so this never inflates
 * a list to hit a length; it just gives each item the room the approved 25-item
 * script gave its items.
 *
 * The count never comes from the title. A title is written to be clicked, not to
 * be true: "I Tested Twin.so for 30 Days" is not a thirty-item list, and it is
 * not evidence that anyone tested anything for thirty days.
 *
 * Everything else derives from the run's stated target length at Jake's speaking
 * rate. "12 minutes minimum" was being read as a floor with no ceiling, which is
 * how a Tool Review ended up at 5,673 words — thirty-eight minutes of talking.
 * Where no runtime is given, fall back to the approved scripts: a review lands
 * at 2,231 words, a tutorial at 1,836.
 */
export function wordBudget(videoType: string, targetLength: string, itemCount?: number | null): number {
  const minutes = parseTargetMinutes(targetLength);
  const fromRuntime = minutes ? minutes * WORDS_PER_SPOKEN_MINUTE : null;
  const itemBased = /list|round/i.test(videoType);

  // An item count only sizes a video that IS a list. Stage 0 will happily report
  // "5 use cases" for a Tool Review whose brief lists five examples — but a
  // review is three builds and a runtime, not five items, and honouring the
  // count there budgets 1,150 words for a twelve-minute video.
  if (itemBased && itemCount && itemCount > 0) {
    return Math.max(1500, itemCount * WORDS_PER_LIST_ITEM);
  }
  if (itemBased) return fromRuntime ?? 5800;
  if (/review/i.test(videoType)) return fromRuntime ?? 2200;
  if (/tutorial/i.test(videoType)) return fromRuntime ?? 2000;
  return fromRuntime ?? 2200;
}

// ── Outline section parsing ───────────────────────────────────────────────────

export interface OutlineSection {
  name: string;
  text: string;
  /** The outline's own allocation ("PHASE 3 — … (~350 words)"), when it states one. */
  targetWords: number | null;
}

/** Turn a "#### ⏱️ SECTION (timestamp)" header line into a short section name. */
function cleanSectionName(header: string): string {
  return (
    header
      .replace(/^#+/, "")
      .replace(/⏱️/g, "")
      .replace(/[️⏱]/g, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim() || "Section"
  );
}

/**
 * The word count an outline header allocates to its own section: "(~350 words)",
 * "— ~1200 words". Stage 2 writes these and they encode its judgement about where
 * the video's weight belongs — which the even split then threw away.
 */
function headerTargetWords(header: string): number | null {
  const m = header.match(/~\s*(\d{2,5})\s*words/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Headers that are apparatus for the writer, not sections of the video.
 *
 * The Expertise run drafted "⚠️ WRITER-CRITICAL FLAGS (read before writing a
 * word)" and "FACT SHEET (carry verbatim into the section-writer's sheet)" as
 * spoken script — 310 words of instructions-to-self read out to camera — and they
 * each took a full share of the word budget on the way past.
 */
const APPARATUS_HEADER =
  /writer.?critical|flags?\b|fact.?sheet|research (?:summary|notes)|sources?\b|video outline|production notes?|thumbnail|title options?|word count|budget|📹/i;

/**
 * Split the Stage 2 outline into draftable sections by its markdown headers,
 * dropping the HOOK section (Stage 3 owns it), any trailing WRAP-UP/CTA section
 * (Stage 6 owns it), and the writer-apparatus blocks. If the outline has no
 * headers, the whole thing (minus a HOOK header block if present) is one section.
 */
export function parseOutlineSections(outline: string): OutlineSection[] {
  const text = outline.trim();
  if (!text) return [];
  const lines = text.split("\n");
  const headerIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Models emit section headers as level 2–4 markdown headers (##/###/####),
    // not always ####. Split on any of them; noise headers are filtered below.
    if (/^\s*#{2,4}\s/.test(lines[i])) headerIdx.push(i);
  }
  if (headerIdx.length === 0) {
    return [{ name: "Main content", text, targetWords: null }];
  }

  const raw: { name: string; text: string; bodyLen: number; depth: number; targetWords: number | null }[] = [];
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h];
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
    const block = lines.slice(start, end).join("\n").trim();
    const bodyLen = lines.slice(start + 1, end).join("\n").trim().length;
    const depth = (lines[start].match(/^\s*(#+)/)?.[1] ?? "##").length;
    raw.push({
      name: cleanSectionName(lines[start]),
      text: block,
      bodyLen,
      depth,
      targetWords: headerTargetWords(lines[start]),
    });
  }

  /**
   * A header whose children carry the content — "## THE ROADMAP" over four
   * "### PHASE n" sections. Drafting it as well as its children says the same
   * thing twice and spends a section's budget on a table of contents. It's a
   * container when the next header is DEEPER than this one and this one says
   * little itself; a section with a real body and sub-headers is still a section.
   */
  const isContainer = (i: number): boolean => {
    const next = raw[i + 1];
    return next !== undefined && next.depth > raw[i].depth && raw[i].bodyLen < 200;
  };

  // Drop non-script headers: the outline title (starts with a quote), the hook
  // (Stage 3), writer apparatus, containers whose children follow, and near-empty
  // headers.
  const droppable = (s: (typeof raw)[number], i: number): boolean =>
    /hook/i.test(s.name) ||
    APPARATUS_HEADER.test(s.name) ||
    s.name.startsWith('"') ||
    s.bodyLen < 40 ||
    isContainer(i);
  const filtered = raw.filter((s, i) => !droppable(s, i));
  // Drop trailing wrap-up / CTA / outro sections (Stage 6 owns the close).
  while (filtered.length && /wrap.?up|cta|call to action|outro/i.test(filtered[filtered.length - 1].name)) {
    filtered.pop();
  }

  if (filtered.length > 0) {
    return filtered.map((s) => ({ name: s.name, text: s.text, targetWords: s.targetWords }));
  }
  // Everything got filtered — fall back to the whole outline minus any hook block.
  const nonHook = raw.filter((s) => !/hook/i.test(s.name));
  if (nonHook.length > 0) {
    return [{ name: "Main content", text: nonHook.map((s) => s.text).join("\n\n"), targetWords: null }];
  }
  return [{ name: "Main content", text, targetWords: null }];
}

/** The least a drafted section can be asked for before it stops being a section. */
export const MIN_SECTION_WORDS = 150;
/** The hook and outro are written by their own stages, so they aren't drawn from this pot. */
export const SECTION_BUDGET_SHARE = 0.85;

/**
 * Split the word budget across the drafted sections, honouring the weights the
 * outline set for itself.
 *
 * This used to be `budget * 0.85 / total`, floored at 150 — an even split. On the
 * Expertise run that gave all ten "sections" exactly 150 words each: the floor,
 * for everything. The outline had asked for 300 / 250 / 350 / 300 across its four
 * phases and ~100 for the bridge, and every one of those judgements was discarded.
 * So the walkthrough the video existed for got the same room as a linking
 * sentence, and "I'll talk you through it as I go" was all 150 words could buy.
 *
 * A section that states its own target keeps its RATIO against the others; the
 * targets are then scaled to whatever budget the run actually has, so an outline
 * that over- or under-allocates in absolute terms still lands on the runtime. A
 * section that states no target is weighted at the mean of those that do, so it
 * asks for an ordinary share rather than nothing.
 */
export function allocateSectionWords(sections: { targetWords: number | null }[], budget: number): number[] {
  const total = sections.length;
  if (total === 0) return [];
  const pot = budget * SECTION_BUDGET_SHARE;

  const declared = sections.map((s) => s.targetWords).filter((n): n is number => typeof n === "number" && n > 0);
  // No section sized itself — nothing to honour, so fall back to an even split.
  const fallbackWeight = declared.length > 0 ? declared.reduce((a, b) => a + b, 0) / declared.length : 1;
  const weights = sections.map((s) => (s.targetWords && s.targetWords > 0 ? s.targetWords : fallbackWeight));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    return sections.map(() => Math.max(MIN_SECTION_WORDS, Math.round(pot / total / 25) * 25));
  }
  return weights.map((w) =>
    Math.max(MIN_SECTION_WORDS, Math.round((pot * w) / weightSum / 25) * 25),
  );
}

// ── Deliverable shaping ───────────────────────────────────────────────────────

/**
 * A control the writer could not confirm, left for Jake to fill from the screen.
 *
 * The generator cannot know the interface of a product the web has never
 * documented — Expertise came back with 5KB of research and no button names. The
 * old rule told the writer to describe the goal instead ("open the settings for
 * that agent"), which is how a tutorial ends up promising a walkthrough and
 * delivering a shrug. Now the writer commits to the real step sequence and marks
 * only the control it can't verify, so the scaffold is right and the gap is
 * visible rather than smoothed over.
 */
export const VERIFY_MARKER_RE = /\[VERIFY[^\]\n]{0,160}\]/gi;

/**
 * Private-use code points, used only inside toCleanProse to hold a marker's place
 * while the bracket sweep runs. Nothing a model writes and nothing Jake reads can
 * contain these, which is the whole requirement — see toCleanProse.
 */
const PARK_OPEN = "\uE000";
const PARK_CLOSE = "\uE001";
const PARK_RE = /\uE000(\d+)\uE001/g;

/**
 * Drop the verify markers. They are for Jake's eyes on the page, not part of what
 * the script asserts: the claim audit would read "[VERIFY: is the trial 14 days?]"
 * as the script claiming 14, and the quality metrics would count its words as
 * spoken prose.
 */
export function stripVerifyMarkers(text: string): string {
  return text
    .replace(VERIFY_MARKER_RE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;!?])/g, "$1")
    .replace(/ +\n/g, "\n")
    .trim();
}

/**
 * Turn a drafted script body into the continuous prose Jake actually reads.
 *
 * His approved scripts have no markdown headers, no "**Beat 4 (1:10–1:35):**"
 * markers, and no bracketed stage directions. Ours had all three, which made the
 * artifact look like a spec rather than a script — and polluted the claim audit,
 * because "Beat 4 (1:10–1:35)" contributes the numbers 1, 10, 1 and 35.
 *
 * [VERIFY ...] markers are the one bracket that survives: they are the whole
 * point of the step scaffold, and stripping them here would silently delete every
 * flag the writer raised — handing Jake a confident-sounding click path with no
 * hint that a control in it was never confirmed. That is worse than no steps.
 *
 * Paragraph breaks survive. Nothing else structural does.
 */
export function toCleanProse(text: string): string {
  const markers: string[] = [];
  // Park the markers behind a sentinel while the bracket sweep runs. It has to be
  // something the prose can never legitimately contain: a bare digit placeholder
  // would be indistinguishable from a real number, and restoring it would delete
  // "50 images" as readily as a parked marker.
  const parked = text.replace(VERIFY_MARKER_RE, (m) => {
    markers.push(m);
    return `${PARK_OPEN}${markers.length - 1}${PARK_CLOSE}`;
  });
  const cleaned = parked
    .replace(/^#{1,6}\s.*$/gm, "") // markdown headers
    .replace(/^\s*\*\*Beat\s+\d+[^*]*\*\*\s*:?\s*$/gim, "") // beat markers on their own line
    .replace(/\*\*Beat\s+\d+\s*\([^)]*\)\s*:?\*\*\s*/gi, "") // inline beat markers
    .replace(/^\s*\(?\d{1,2}:\d{2}\s*[\u2013\u2014-]\s*\d{1,2}:\d{2}\)?\s*$/gm, "") // bare timestamp lines
    .replace(/\[[^\]\n]{0,120}\]/g, "") // [stage directions]
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold emphasis — Jake reads words, not asterisks
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.replace(PARK_RE, (_, i) => markers[Number(i)] ?? "");
}

/** One copy-pasteable prompt lifted out of a script. */
export interface ExtractedPrompt {
  /** A short label derived from the sentence that introduced it, when there is one. */
  label: string;
  text: string;
}

/** Verbs that open an actual prompt rather than an ordinary quoted phrase. */
const PROMPT_VERBS =
  "create|design|write|make|generate|build|draw|translate|summarize|summarise|analyze|analyse|" +
  "explain|rewrite|edit|plot|compare|outline|suggest|give me|act as|help me|show|remove|change|add";

/**
 * Pull the exact prompts a script tells the viewer to copy.
 *
 * The preamble's content rules already demand the "exact prompts format — show
 * the literal prompt, not just the concept", and the approved tutorial ships a
 * PROMPT SUMMARY appendix of them for the description. This finds them so the
 * appendix can be assembled without a model call.
 *
 * A prompt is a quoted span that opens with an instruction verb and is long
 * enough to be worth copying. Short quotes ("done", "in progress") are dialogue.
 */
export function extractPrompts(script: string): ExtractedPrompt[] {
  const clean = script.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const out: ExtractedPrompt[] = [];
  const seen = new Set<string>();
  const verb = new RegExp(`^\\s*(?:${PROMPT_VERBS})\\b`, "i");

  // Pair the quotes BY POSITION. A regex that searches for "…" will let a short,
  // rejected quote ("a dog in a field") swallow the opening quote of the real
  // prompt that follows it, and the whole appendix silently comes back empty.
  const parts = clean.split('"');
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i].trim();
    if (text.length < 30 || text.length > 900) continue;
    if (!verb.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Label from the sentence just before the quote ("Here's a prompt for a poster.")
    const before = parts[i - 1];
    const lastSentence = before.split(/(?<=[.!?])\s+/).filter(Boolean).pop() ?? "";
    const label = lastSentence
      .replace(/^(?:so|and|now|alright|okay|ok|then)\b[,\s]*/i, "")
      .replace(/\bI(?:'ll)?\s+type\b[:\s]*$/i, "")
      .replace(/\byou can say\b[:\s]*$/i, "")
      .replace(/[:\-–—\s]+$/, "")
      .trim();

    out.push({ label: label.length >= 4 && label.length <= 80 ? label : "Prompt", text });
  }
  return out;
}

// ── Canonical outro ───────────────────────────────────────────────────────────

/**
 * Jake's fixed closing, word for word. Every script ends exactly this way — no
 * teasing what the next video is about, because YouTube picks it. Applied in
 * code so it's verbatim, not approximated by the model.
 */
export const CANONICAL_OUTRO =
  "Thanks so much for hanging out with me today. Before you click away, here's a video you'll probably want to watch next — YouTube's pretty good at this, it'll line up the one video it thinks you'll love next. Just click the video to my left and you'll see exactly what I'm talking about. See you there.";

/** The phrases that mark where the model's own sign-off / next-video tease begins. */
const SIGN_OFF_TRIGGERS = [
  /\bnext up\b/i,
  /\bnext week\b/i,
  /\bin the next (?:video|one)\b/i,
  /\bhere'?s a video you/i,
  /\bclick the video to my left\b/i,
  /\bthanks (?:so much |a lot )?for (?:hanging|watching|sticking)/i,
  /\bcatch you (?:in|on|next|later)\b/i,
  /\b(?:i'?ll )?see you (?:in|next|there|soon)\b/i,
  /\bthat'?s (?:it|all) for (?:today|this one)\b/i,
];

/**
 * Replace whatever sign-off the model wrote with the canonical one.
 *
 * Keeps everything up to the sign-off (the Skool plug, socials, bell, and the
 * comment prompt all live before it), strips the model's own "thanks / next up /
 * see you" tail, and appends CANONICAL_OUTRO verbatim. Only the last stretch of
 * the script is searched, so a "see you" earlier in the body can't trip it.
 */
export function ensureCanonicalOutro(body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  const WINDOW = 900;
  const tailStart = Math.max(0, trimmed.length - WINDOW);
  const head = trimmed.slice(0, tailStart);
  const tail = trimmed.slice(tailStart);

  let cut = -1;
  for (const re of SIGN_OFF_TRIGGERS) {
    const m = re.exec(tail);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) {
    // No sign-off found — append onto the end.
    return `${trimmed}\n\n${CANONICAL_OUTRO}`;
  }
  // Back up to the start of the sentence the trigger sits in.
  const beforeTrigger = tail.slice(0, cut);
  const lastStop = Math.max(beforeTrigger.lastIndexOf(". "), beforeTrigger.lastIndexOf("! "), beforeTrigger.lastIndexOf("? "));
  const keepTail = lastStop >= 0 ? beforeTrigger.slice(0, lastStop + 1) : "";
  const kept = `${head}${keepTail}`.replace(/\s+$/, "");
  return `${kept}\n\n${CANONICAL_OUTRO}`;
}

// ── Script quality metrics ────────────────────────────────────────────────────

export interface ScriptQuality {
  words: number;
  sentences: number;
  meanSentenceWords: number;
  /** sd/mean of sentence length. Humans are bursty; a teleprompter is uniform. */
  burstiness: number;
  /** Distinct 4-word phrases used more than once. */
  repeatedPhraseCount: number;
  /** Times the worst offender repeats. */
  worstPhraseRepeats: number;
  worstPhrase: string | null;
  /** Sentences opening with a discourse marker — reported, never penalized. */
  discourseMarkerOpenings: number;
}

/**
 * Measure the two things a script can be bad at without being wrong: saying the
 * same thing twice, and sounding like a machine. Computed in code so a prompt
 * change can be judged against a number instead of a vibe.
 *
 * Caveat for whoever compares two runs: repeated-phrase counts grow
 * superlinearly with length (more text, more chances for any phrase to recur),
 * so only compare scripts of similar size. `worstPhraseRepeats` and `burstiness`
 * are length-stable and safe to compare directly.
 */
export function scriptQuality(text: string): ScriptQuality {
  const sentences = splitSentences(text);
  const tokens = wordsOf(text);
  const lens = sentences.map((s) => wordsOf(s).length).filter((n) => n > 0);

  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const variance = lens.length ? lens.reduce((a, l) => a + (l - mean) ** 2, 0) / lens.length : 0;
  const burstiness = mean ? Math.sqrt(variance) / mean : 0;

  const counts = new Map<string, number>();
  for (let i = 0; i + 4 <= tokens.length; i++) {
    const g = tokens.slice(i, i + 4).join(" ");
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let worstPhrase: string | null = null;
  let worstPhraseRepeats = 0;
  let repeatedPhraseCount = 0;
  for (const [g, n] of counts) {
    if (n < 2) continue;
    repeatedPhraseCount++;
    if (n > worstPhraseRepeats) {
      worstPhraseRepeats = n;
      worstPhrase = g;
    }
  }

  const discourseMarkerOpenings = sentences.filter((s) => {
    const w = wordsOf(s);
    return w.length > 0 && DISCOURSE_MARKERS.has(w[0]);
  }).length;

  return {
    words: tokens.length,
    sentences: sentences.length,
    meanSentenceWords: Number(mean.toFixed(2)),
    burstiness: Number(burstiness.toFixed(3)),
    repeatedPhraseCount,
    worstPhraseRepeats,
    worstPhrase,
    discourseMarkerOpenings,
  };
}

// ── Claim audit (deterministic — no model call) ───────────────────────────────

export interface ClaimAudit {
  /** Numbers asserted in the script that appear nowhere in the fact sheet. */
  unsupportedNumbers: string[];
  /**
   * Fenced topics the script MENTIONS. Not necessarily violations — a good script
   * often names a fenced claim in order to knock it down ("there's a line going
   * around that this has zero learning curve. That's marketing."). Presence
   * testing can't tell assertion from rebuttal, so these are flagged for a human,
   * never treated as failures.
   */
  fencedTopicsMentioned: string[];
  /**
   * First-person claims about testing the tool over a period of time. These come
   * from the title far more often than from anything that happened — "I Tested
   * Twin.so for 30 Days" produced "I ran this on real jobs for a full 30 days"
   * in a script where nobody ran anything. Flagged unless the brief backs them.
   */
  experienceClaims: string[];
  /** Sponsor plugs beyond the two allowed (one early, one at the close). */
  excessSponsorPlugs: string[];
  /** Banned words / phrasings that survived into the finished script. */
  bannedWords: string[];
  /** Numbers checked, for context on how meaningful the above is. */
  numbersChecked: number;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/**
 * Pull every number a script asserts, as digits — including the spelled-out ones.
 * A spoken script says "twenty euros a month" and "a thousand credits", never
 * "€20". An audit that only matches digits is an audit that finds nothing.
 */
export function extractNumbers(text: string): Set<number> {
  const found = new Set<number>();
  const lower = text.toLowerCase();

  for (const m of lower.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) found.add(n);
  }

  // Walk word-numbers: "three thousand six hundred", "twenty", "fourteen".
  const words = lower.match(/[a-z]+/g) ?? [];
  let current = 0;
  let running = 0;
  let active = false;
  const flush = () => {
    if (active && running + current > 0) found.add(running + current);
    current = 0;
    running = 0;
    active = false;
  };
  for (const w of words) {
    if (w in NUMBER_WORDS) {
      current += NUMBER_WORDS[w];
      active = true;
    } else if (w in SCALES) {
      current = (current || 1) * SCALES[w];
      if (SCALES[w] >= 1000) {
        running += current;
        current = 0;
      }
      active = true;
    } else if (w === "a") {
      // "a thousand" — a bare article can precede a scale.
      continue;
    } else if (w === "and" && (running > 0 || current >= 100)) {
      // "three hundred and five" continues; "between three and ten" does NOT —
      // without this, a range reads as a sum and invents the number thirteen.
      continue;
    } else {
      flush();
    }
  }
  flush();
  return found;
}

/**
 * Distinctive terms from a DO NOT CLAIM bullet, for presence-testing in the script.
 * A bullet like "**SOC 2 / ISO / GDPR compliance status**" is really three claims;
 * split on the slashes so each can be matched on its own, or none of them match.
 */
function forbiddenTerms(line: string): string[] {
  const bolded = [...line.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]);
  const quoted = [...line.matchAll(/["“”']([^"“”']{4,60})["“”']/g)].map((m) => m[1]);
  return [...bolded, ...quoted]
    .flatMap((t) => t.split(/\s*\/\s*|\s+\band\b\s+/))
    .map((t) => t.replace(/[.,;:]$/, "").trim())
    .filter((t) => t.length >= 4 && t.split(/\s+/).length <= 6);
}

/**
 * Check the finished script against the Stage 1.5 fact sheet, in code.
 *
 * Two questions, both answerable without a model: does the script state a number
 * the research never established, and does it touch a topic the fact sheet
 * explicitly fenced off? Cheap enough to run on every script, and it catches the
 * exact failure the fact sheet exists to prevent — a confident invented figure.
 *
 * Small integers (years, counts like "three things", step numbers) are ignored:
 * they're prose, not claims, and flagging them would bury the real findings.
 */
/**
 * "I ran it for a full 30 days", "over the last few weeks I've been testing…" —
 * first-person claims that a period of use actually happened. `support` is the
 * brief plus the fact sheet: if neither says Jake used the tool for that long,
 * the claim was invented, and it almost always came from the title.
 */
export function findExperienceClaims(script: string, support: string): string[] {
  const DURATION = String.raw`(?:\d{1,3}|a|an|one|two|three|four|five|six|several|a few|a couple of|the last|the past)\s+(?:full\s+)?(?:day|days|week|weeks|month|months|year|years)`;
  const VERB = "tested|ran|used|spent|been (?:testing|running|using)|put";
  const re = new RegExp(
    String.raw`\bI(?:'ve)?\s+(?:${VERB})\b[^.!?]{0,90}?\b${DURATION}\b|\bfor\s+(?:a\s+full\s+)?${DURATION}\b[^.!?]{0,40}?\b(?:testing|of testing|using it)\b`,
    "gi",
  );

  const supportLower = support.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of script.matchAll(re)) {
    const claim = m[0].replace(/\s+/g, " ").trim();
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Supported if the brief/fact sheet independently says so.
    const duration = claim.match(new RegExp(DURATION, "i"))?.[0]?.toLowerCase();
    if (duration && supportLower.includes(duration)) continue;
    out.push(claim);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * @param alsoScanForExperience extra text (the hooks) checked for invented
 *   experience but NOT for numbers — hook boilerplate carries timestamps and
 *   production notes that are not claims, yet its opening beats are exactly
 *   where "I ran this for a full 30 days" tends to land.
 */
/** Words Jake never wants in a script. Whole-word, case-insensitive. */
export const BANNED_WORDS = ["caveat", "clever", "which", "whether", "genuinely", "real deal"];

/**
 * Banned words and phrasings in the finished script, with a little context so
 * they can be found and rewritten. Enforced in code because a prompt instruction
 * to "never use X" does not reliably hold — the model reaches for these anyway.
 *
 * Also flags "Picture …" as a sentence opener (Jake says "Imagine …") and bare
 * clipped question fragments ("No door?") that should lead with a connective
 * ("And if there's no door?").
 */
export function findBannedWords(text: string): string[] {
  const out: string[] = [];
  const sentences = splitSentences(text);
  const bannedRe = new RegExp(`\\b(${BANNED_WORDS.join("|")})\\b`, "gi");
  for (const s of sentences) {
    for (const m of s.matchAll(bannedRe)) {
      const at = m.index ?? 0;
      const snippet = s.slice(Math.max(0, at - 24), at + m[0].length + 24).trim();
      out.push(`"${m[1].toLowerCase()}" — …${snippet}…`);
    }
    if (/^picture\b/i.test(s)) out.push(`"Picture …" opener (use "Imagine …") — ${s.slice(0, 46)}…`);
    // A 1–3 word sentence ending in "?" reads as a clipped fragment.
    const w = wordsOf(s);
    if (s.endsWith("?") && w.length >= 1 && w.length <= 3 && !/^(and|so|but|or|now|what|why|how|who|where)\b/i.test(s)) {
      out.push(`clipped question "${s}" — lead with a connective ("And if …?")`);
    }
  }
  // Dedupe, cap.
  return [...new Set(out)].slice(0, 40);
}

/**
 * Sentences that push the sponsor's offer or link — "free to start, no card",
 * "link's in the description", the sponsor domain used as a call to action.
 * Two are welcome in a sponsored video (one early, one at the close); more reads
 * as an ad, not a recommendation. Returns every promotional sentence found, in
 * order, so the caller can tell the two keepers from the excess.
 */
export function findSponsorPlugs(body: string, sponsorName = ""): string[] {
  // "free to start / no card" only ever describes the sponsor — Jake's own Skool
  // and socials are not free trials — so the offer alone is a plug.
  const OFFER = /\bfree to (?:start|try)\b|\bno (?:credit )?card\b|\bstart(?:s)? (?:free|for free)\b|\bcredit card (?:needed|required)\b/i;
  // A bare "link's in the description" is used for the sponsor, for Skool, AND
  // for TikTok/Instagram — so it only counts as a SPONSOR plug when the sponsor
  // is named in the same sentence. Otherwise the outro's social/Skool CTAs would
  // be miscounted as sponsor over-promotion.
  const LINK =
    /\blink('?s)?\s+(?:in|below|down|is|sitting|right)\b|\bdrop(?:ping)?\s+(?:the|a)\s+link\b|\blink'?s (?:there|below|down)\b/i;
  // Strip a ".so"/".com" style TLD so "Twin.so" and "Twin" both match on "Twin".
  const bareName = sponsorName.replace(/\.(so|com|io|ai|co|app|dev)\b.*$/i, "").trim();
  const domain =
    bareName.length >= 2
      ? new RegExp(`\\b${bareName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")}`, "i")
      : null;
  const namesSponsor = (s: string): boolean => Boolean(domain && domain.test(s));
  const promotional = (s: string): boolean => {
    if (OFFER.test(s)) return true;
    if (LINK.test(s) && namesSponsor(s)) return true;
    // Sponsor named with a go-there verb ("go try Twin", "sign up at twin.so").
    return namesSponsor(s) && /\b(?:go|visit|head|try|sign\s*up|check (?:it|them) out|grab)\b/i.test(s);
  };
  return splitSentences(body).filter(promotional);
}

/** The promotional sentences BEYOND the two allowed (first + last). */
export function excessSponsorPlugs(body: string, sponsorName = ""): string[] {
  const plugs = findSponsorPlugs(body, sponsorName);
  if (plugs.length <= 2) return [];
  // Keep the first and the last; everything between them is excess.
  return plugs.slice(1, -1);
}

export function auditClaims(
  script: string,
  factSheet: string,
  brief = "",
  alsoScanForExperience = "",
  sponsorName = "",
): ClaimAudit {
  const experienceClaims = findExperienceClaims(
    `${alsoScanForExperience}\n${script}`,
    `${brief}\n${factSheet}`,
  );
  const excess = sponsorName ? excessSponsorPlugs(script, sponsorName) : [];
  const bannedWords = findBannedWords(script);
  if (!factSheet.trim()) {
    return {
      unsupportedNumbers: [],
      fencedTopicsMentioned: [],
      experienceClaims,
      excessSponsorPlugs: excess,
      bannedWords,
      numbersChecked: 0,
    };
  }

  // Timestamps are production markers, not claims. "Beat 4 (1:10–1:35)" would
  // otherwise contribute 1, 10, 1 and 35 to the audit and drown the real findings.
  const prose = script
    .replace(/\(?\b\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");

  const sheetNumbers = [...extractNumbers(factSheet)];
  const sheetSet = new Set(sheetNumbers);
  // Below 10 the numbers are prose ("three things", "step two"), not claims.
  const scriptNumbers = [...extractNumbers(prose)].filter((n) => n >= 10);

  /** Spoken scripts round: "almost twelve percent" for a sheet's 11.8%. */
  const supported = (n: number): boolean => {
    if (n >= 1900 && n <= 2100) return true; // years, not claims
    if (sheetSet.has(n)) return true;
    if (sheetSet.has(n / 100) || sheetSet.has(n * 100)) return true; // scale shift
    return sheetNumbers.some((s) => s > 0 && Math.abs(s - n) / s <= 0.05);
  };

  const unsupported = scriptNumbers.filter((n) => !supported(n));

  const doNotClaim = factSheet.split(/##\s*DO NOT CLAIM/i)[1] ?? "";
  const lowerScript = prose.toLowerCase();
  const mentioned: string[] = [];
  for (const line of doNotClaim.split("\n")) {
    if (!line.trim().startsWith("-")) continue;
    for (const term of forbiddenTerms(line)) {
      if (lowerScript.includes(term.toLowerCase()) && !mentioned.includes(term)) mentioned.push(term);
    }
  }

  return {
    unsupportedNumbers: unsupported.sort((a, b) => a - b).map(String).slice(0, 25),
    fencedTopicsMentioned: mentioned.slice(0, 25),
    experienceClaims,
    excessSponsorPlugs: excess,
    bannedWords,
    numbersChecked: scriptNumbers.length,
  };
}

// ── Stage 2.5 — brief-coverage pass parsing ───────────────────────────────────

/** One "what TO include" item from the brief, and where the outline puts it. */
export interface CoverageItem {
  /** The brief's request, in the brief's own words. */
  item: string;
  /** 'covered' — already in the outline. 'added' — this pass gave it a home. 'gap' — deliberately not carried. */
  status: "covered" | "added" | "gap";
  /** Which outline section carries it, or why it was left out. */
  where: string;
}

export interface CoveragePass {
  /** The outline, with any missing brief item now given a real section. */
  outline: string;
  score: number;
  verdict: string;
  items: CoverageItem[];
}

/**
 * Split the Stage 2.5 response into its coverage report and the revised outline.
 *
 * Delimited (===COVERAGE=== / ===OUTLINE===) rather than JSON, for the same
 * reason as the CTA pass: the outline runs to 13KB and JSON-escaping a document
 * that size is needless truncation risk. The coverage lines are
 * `status | item | where`, which survives a model that drifts on whitespace.
 *
 * Returns null if the shape isn't there, so the caller keeps the Stage 2 outline.
 */
export function parseCoveragePass(raw: string): CoveragePass | null {
  const m = raw.match(/^===COVERAGE===[ \t]*$([\s\S]*?)^===OUTLINE===[ \t]*$([\s\S]*)/m);
  if (!m) return null;
  const outline = m[2].trim();
  if (!outline) return null;

  const report = m[1];
  const scoreMatch = report.match(/^\s*SCORE:\s*(\d{1,3})\s*$/m);
  const score = scoreMatch ? Math.max(0, Math.min(100, Number(scoreMatch[1]))) : 0;
  const verdictMatch = report.match(/^\s*VERDICT:\s*(.+)$/m);
  const verdict = verdictMatch ? verdictMatch[1].trim() : "No verdict returned.";

  const items: CoverageItem[] = [];
  for (const line of report.split("\n")) {
    const row = line.match(/^\s*(covered|added|gap)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/i);
    if (!row) continue;
    items.push({
      status: row[1].toLowerCase() as CoverageItem["status"],
      item: row[2].trim(),
      where: row[3].trim(),
    });
  }
  return { outline, score, verdict, items };
}

// ── Stage 5.5 — CTA pass parsing ──────────────────────────────────────────────

export interface CtaPass {
  hooks: string;
  script: string;
  notes: string[];
}

/**
 * Split the Stage 5.5 response into its three delimited blocks. The prompt asks
 * for ===HOOKS=== / ===SCRIPT=== / ===NOTES=== each on its own line — a
 * delimiter rather than JSON, because the pass re-emits the entire hooks doc
 * plus the entire script and JSON-escaping that is needless truncation risk.
 * Returns null if the shape isn't there, so the caller can keep the pre-CTA text.
 */
export function parseCtaPass(raw: string): CtaPass | null {
  const m = raw.match(/^===HOOKS===[ \t]*$([\s\S]*?)^===SCRIPT===[ \t]*$([\s\S]*?)^===NOTES===[ \t]*$([\s\S]*)/m);
  if (!m) return null;
  const hooks = m[1].trim();
  const script = m[2].trim();
  if (!hooks || !script) return null;
  const notes = m[3]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  return { hooks, script, notes };
}

// ── Stage 6.5 — brief-adherence edits ─────────────────────────────────────────

/** The longest sentence we'll accept as a single surgical edit. Beyond this it's a rewrite. */
export const MAX_EDIT_CHARS = 1200;
/** An anchor is a sentence or two. A longer `find` would let one edit swallow whole sections. */
export const MAX_FIND_CHARS = 600;
/** Matches the prompt's own cap, enforced here so a runaway response can't shred the script. */
export const MAX_EDITS = 8;
/** Even 8 legal edits shouldn't reshape the script: bound total growth and shrink. */
export const MAX_GROWTH = 1.25;
export const MIN_SHRINK = 0.9;

/** A truncated quote for the applied/skipped audit lines. */
function snippet(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= 60 ? one : `${one.slice(0, 57)}…`;
}

/**
 * Apply the Stage 6.5 edits to the script by exact string surgery.
 *
 * An edit only lands if its `find` text occurs EXACTLY ONCE in the script as it
 * stands at that moment. Zero matches means the model paraphrased instead of
 * quoting; multiple matches means the target is ambiguous. Both are discarded.
 * This is what makes the pass structurally incapable of rewriting the script:
 * the model never returns script text, only anchors and one-sentence patches.
 *
 * Three further bounds close the gaps a determined model could still walk
 * through: `find` is length-capped (else one edit anchors on the whole script
 * and swaps it for a line), and the running total is held inside a growth
 * ceiling and a shrink floor (else eight legal edits stacked on one anchor add
 * up to a rewrite anyway).
 */
export function applyBriefEdits(
  script: string,
  rawEdits: unknown,
): { script: string; applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  let out = script;
  const list = Array.isArray(rawEdits) ? rawEdits : [];
  const ceiling = Math.ceil(script.length * MAX_GROWTH);
  const floor = Math.floor(script.length * MIN_SHRINK);

  for (const raw of list.slice(0, MAX_EDITS)) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const find = typeof e.find === "string" ? e.find.trim() : "";
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const mode = e.mode === "replace" ? "replace" : e.mode === "insert_after" ? "insert_after" : null;
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : "brief adherence";

    if (!mode || !find || !text) {
      skipped.push(`Malformed edit discarded (${snippet(find || String(e.mode ?? "?"))}).`);
      continue;
    }
    if (text.length > MAX_EDIT_CHARS) {
      skipped.push(`Edit too long to be a sentence-level fix, discarded: ${snippet(text)}`);
      continue;
    }
    if (find.length > MAX_FIND_CHARS) {
      skipped.push(`Anchor too long to be a sentence-level target, discarded: "${snippet(find)}"`);
      continue;
    }
    const occurrences = out.split(find).length - 1;
    if (occurrences === 0) {
      skipped.push(`Anchor sentence not found verbatim, discarded: "${snippet(find)}"`);
      continue;
    }
    if (occurrences > 1) {
      skipped.push(`Anchor sentence appears ${occurrences}× (ambiguous), discarded: "${snippet(find)}"`);
      continue;
    }

    const next = out.split(find).join(mode === "replace" ? text : `${find} ${text}`);
    if (next.length > ceiling || next.length < floor) {
      skipped.push(`Edit would reshape the script rather than patch it, discarded: "${snippet(find)}"`);
      continue;
    }

    out = next;
    applied.push(`${mode === "replace" ? "Replaced" : "Inserted after"} "${snippet(find)}" — ${reason}`);
  }

  if (list.length > MAX_EDITS) {
    skipped.push(`${list.length - MAX_EDITS} further edits ignored (cap is ${MAX_EDITS}).`);
  }
  return { script: out, applied, skipped };
}
