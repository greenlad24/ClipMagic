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
  /writer.?critical|flags?\b|fact.?sheet|research (?:summary|notes)|sources?\b|video outline|production notes?|thumbnail|title options?|word count|budget|📹|read (?:this |before|first)|before writing|guardrails?|constraints?|briefing|notes? to jake|spine of (?:this|the) video|vocabulary|\bthe cast\b|cast and locked|writer'?s?\b|after the script|full prompts?\b|long version|prompt summary|copy-paste version/i;
// ↑ 2026-10-02: an outline planned "AFTER THE SCRIPT — the long version of the
// prompt" and it was drafted as a spoken section. The long prompts are written
// inline (<<<FULL PROMPT>>>) and moved after the script by code.
// ↑ 2026-10-02: the last eight runs' first "sections" were briefings for the
// writer ("🔒 READ BEFORE WRITING A SINGLE LINE", "WRITER GUARDRAILS", "NOTES TO
// JAKE BEFORE RECORDING", "THE CAST", "VOCABULARY — use these words") and the
// section writer turned each into a SECOND cold open, which Jake deleted by hand
// in every run. They are still in the outline every section writer reads.

/**
 * The video's opening, planned as an outline section: "SECTION 0 — Opening",
 * "Cold open", "Intro + welcome", "SECTION 1 — Welcome + the tool, named with its
 * offer". Stage 3 writes the opening (and code locks the welcome line), so a
 * section like this was drafted as a SECOND opening — the Linearity run of
 * 2026-10-02 shipped the chosen hook, then another "Look at this… / By the end of
 * this video… / welcome" straight under `## SCRIPT`. Matched on the start of the
 * name (after any "SECTION n —" prefix), so "Opening the app" style steps are
 * only dropped when the name is the opening itself.
 */
const OPENING_SECTION =
  /^(?:(?:section|part|beat)\s*\d+\s*[—–:.-]\s*)?(?:the\s+)?(?:opening(?!\s+(?:the|a|an|your|it|up)\b)|cold[- ]open|intro(?:duction)?\s*(?:\+|&|and)\s*welcome|welcome\b)/i;

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
    OPENING_SECTION.test(s.name) ||
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
  // The runtime is a FLOOR, not a ceiling. Scale UP to fill the pot when the
  // outline asked for less than the video has room for, but never scale DOWN:
  // if the outline sized its sections at more than the runtime suggests, that is
  // the material saying it needs the space, and squeezing it is how a walkthrough
  // turns into a summary. Padding is prevented by the rules against filler, not
  // by a word cap.
  const scale = Math.max(1, pot / weightSum);
  return weights.map((w) => Math.max(MIN_SECTION_WORDS, Math.round((w * scale) / 25) * 25));
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
 * Every bracketed note a writer leaves for Jake: `[VERIFY ON SCREEN: …]` and
 * `[SHOOT DAY: …]`. ⚠️ NONE OF THESE MAY REACH THE NARRATION (Jake 2026-10-02,
 * P1 of the writing study: he deleted 60 of them by hand across six runs, and
 * the approved lesson against them lost to the prompts that required them).
 * They are parked by toCleanProse so the bracket sweep cannot silently delete a
 * flag, then MOVED by extractProductionNotes into the PRODUCTION NOTES appendix
 * after the script — never left in the prose.
 */
export const PRODUCTION_MARKER_RE = /\[(?:VERIFY|SHOOT[ _-]?DAY)\b[^\]\n]{0,300}\]/gi;

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
 * [VERIFY ...] / [SHOOT DAY ...] markers are the one bracket that survives this
 * function: stripping them here would silently delete every flag the writer
 * raised — handing Jake a confident-sounding click path with no hint that a
 * control in it was never confirmed. They survive ONLY so that
 * extractProductionNotes can move them out of the narration into the
 * PRODUCTION NOTES appendix; the final assembly never leaves one in the prose.
 *
 * Paragraph breaks survive. Nothing else structural does.
 */
export function toCleanProse(text: string): string {
  const markers: string[] = [];
  // Park the markers behind a sentinel while the bracket sweep runs. It has to be
  // something the prose can never legitimately contain: a bare digit placeholder
  // would be indistinguishable from a real number, and restoring it would delete
  // "50 images" as readily as a parked marker.
  const parked = text.replace(PRODUCTION_MARKER_RE, (m) => {
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
/**
 * The verbs a prompt starts with.
 *
 * The first list was written from imagination and missed most of what Jake
 * actually types. In one script "Clean it up into a dated journal entry…",
 * "Check my emails and draft replies…", "Go through every note in this
 * folder…", "Read this note and put a five-bullet summary…" and "Package that
 * whole process up as a skill" were ALL real prompts, and not one of them was
 * collected — the appendix was quietly missing most of the video's value.
 */
const PROMPT_VERBS =
  "create|design|write|make|generate|build|draw|translate|summarize|summarise|analyze|analyse|" +
  "explain|rewrite|edit|plot|compare|outline|suggest|give me|act as|help me|show|remove|change|add|" +
  "clean|check|go through|read|search|pull|package|run|find|sort|organize|organise|group|tag|" +
  "turn|take|put|draft|list|extract|split|merge|rename|move|save|update|review|scan|look|" +
  // The conversational openers a person types into a chat box (P20): "Can you
  // make…", "I want five…", "Use my notes to…". Short prompts are written this
  // way now, and the summary has to keep finding them.
  "can you|could you|please|i want|i need|use|tell me|plan|schedule|post|send|connect|turn this";

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
  // Optionally preceded by one short clause — "Before organizing, build me an
  // index file…" is a prompt whose first word is not its verb — or by one short
  // sentence that hands over the material: "Here's my product. Make five short
  // videos for it." is the exemplar shape of a beginner's prompt (P20).
  const verb = new RegExp(
    `^\\s*(?:[^.!?"]{1,60}[.!?]\\s+)?(?:[^,.]{0,40},\\s*)?(?:${PROMPT_VERBS})\\b`,
    "i",
  );

  // Pair the quotes BY POSITION. A regex that searches for "…" will let a short,
  // rejected quote ("a dog in a field") swallow the opening quote of the real
  // prompt that follows it, and the whole appendix silently comes back empty.
  const parts = clean.split('"');
  for (let i = 1; i < parts.length; i += 2) {
    const text = parts[i].trim();
    // "THE PROMPT: "…"" is the section writer's own marker for a prompt on
    // screen — the Linearity script's "A spring sale campaign for our coffee
    // shop: …" opens with no verb, was missed here, and the summary then quoted
    // a stale version of it instead of what the script says.
    const marked = /\bTHE PROMPT\s*:\s*\**\s*$/i.test(parts[i - 1]);
    if (marked && text.split(/\s+/).length >= 4 && text.length <= 900 && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      out.push({ label: promptLabel(parts[i - 1].replace(/\**\s*THE PROMPT\s*:\s*\**\s*$/i, ""), out.length), text });
      continue;
    }
    // 30 characters let a UI label through: "generate memory from chat history"
    // is a settings toggle Jake reads aloud, not a prompt anyone would copy, and
    // it shipped in the appendix under the heading "Prompt". A real prompt tells
    // the model what to do AND what to do it to, which takes more than a phrase.
    if (text.length < 45 || text.length > 900) continue;
    if (text.split(/\s+/).length < 8) continue;
    if (!verb.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ label: promptLabel(parts[i - 1], out.length), text });
  }
  return out;
}

/**
 * A prompt's label, from the sentence just before it ("Here's a prompt for a
 * poster."), or "Prompt n" when that sentence is only the hand-off.
 */
function promptLabel(before: string, index: number): string {
  const lastSentence = before.split(/(?<=[.!?])\s+/).filter(Boolean).pop() ?? "";
  const label = lastSentence
    .replace(/^(?:so|and|now|alright|okay|ok|then)\b[,\s]*/i, "")
    .replace(/\bI(?:'ll)?\s+type\b[:\s]*$/i, "")
    .replace(/\byou can say\b[:\s]*$/i, "")
    .replace(/[:\-–—\s]+$/, "")
    .trim();

  // A scavenged sentence is only a label if it describes the prompt. The
  // sentence before a prompt is very often the hand-off itself — "you can do
  // this:", "and then this" — which labelled the appendix with the connective
  // instead of the subject. Where it fails, number the prompt: a plain
  // "Prompt 3" is more use than a misleading name.
  const usable =
    label.length >= 8 &&
    label.length <= 80 &&
    // Only the contentless hand-offs. "Here is the morning brief prompt" is a
    // real label; "you can do this" is the sentence that hands over to it.
    !/^(?:you can (?:do|say|type|use)|and then this|then this|like this|watch this|here goes|this|it|so)\b/i.test(
      label,
    ) &&
    // "Here's the one I'm using." / "Just open Claude and type this." — more
    // hand-offs that labelled the Linearity summary.
    !/^(?:here'?s (?:the one|mine|what)|here is (?:the one|mine)|.*\b(?:type|paste|say|use|send) (?:this|it|that)\.?$)/i.test(label);
  return usable ? label : `Prompt ${index + 1}`;
}

// ── Canonical outro ───────────────────────────────────────────────────────────

/**
 * Jake's fixed closing, word for word. Every script ends exactly this way.
 * Applied in code so it is verbatim rather than approximated by the model.
 *
 * It now carries the socials and the bell itself, so the outro stage is told NOT
 * to write those — otherwise the video asks for both twice, thirty seconds apart.
 *
 * It points at the card by THEME, not by title: "even further into AI powered
 * productivity" is true of anything on the channel, so it survives whatever
 * YouTube queues next. Naming an actual follow-up video would be wrong on every
 * script where that is not the one that plays.
 *
 * "short videos", not "short clips" (2026-10-02, P7): "clip" is in BANNED_WORDS,
 * and the code was re-inserting a banned word into every script — the rules
 * pass then "fixed" Jake's own boilerplate.
 */
export const CANONICAL_OUTRO =
  "Oh and by the way, follow me on TikTok and Instagram, because I post short videos there I usually don't put up here, and honestly... well, go over there and see for yourself. The links are down in the description. And I'm starting a new live show on this channel — so click that notification bell to catch the latest show or video the second it goes up. That's the place where you can ask me questions and actually connect with me.\n\nThank you so much for hanging out with me today, and I'll see you in the next video, where we're going to take this even further into AI powered productivity. Just click the video to my left and you'll see exactly what I mean. See you there.";

/** The phrases that mark where the model's own sign-off / next-video tease begins. */
const SIGN_OFF_TRIGGERS = [
  /\bnext up\b/i,
  /\bnext week\b/i,
  /\bin the next (?:video|one)\b/i,
  /\bhere'?s a video you/i,
  /\bclick the video to my left\b/i,
  /\bthanks (?:so much |a lot )?for (?:hanging|watching|sticking)/i,
  /\bthank you so much for hanging\b/i,
  /\bfollow me on (?:tiktok|instagram|ig)\b/i,
  /\boh and by the way\b/i,
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

// ── Canonical welcome ─────────────────────────────────────────────────────────

/**
 * Jake's welcome + subscribe line, word for word (ruled 2026-10-02, P8 of the
 * writing study). He re-worded the free-written welcome in 7 of 8 edited runs,
 * always converging on this; so it is locked in code the same way the outro is.
 * Every hook option carries it verbatim — see ensureCanonicalWelcome.
 */
export const CANONICAL_WELCOME =
  "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI without it turning into another full-time job. If that sounds like you, hit subscribe and smash that like button so more of these videos find you. Let's get into it.";

/** Where a welcome starts: the greeting, or the self-introduction. */
const WELCOME_START_RE =
  /\b(?:hey(?:\s+(?:everyone|everybody|guys|there|folks|all))?\s*[,!—–-]*\s*(?:and\s+)?(?:welcome back|if you'?re new here|i'?m jake)|welcome back to the channel|i'?m jake dawson)/i;

/** A sentence that still belongs to the welcome stretch (identity, the ask, the hand-off). */
const WELCOME_PART_RE =
  /jake dawson|welcome back|subscribe|like button|smash|hit (?:that|the) like|if that sounds like you|let'?s (?:get into it|dive|go\b|get to work|get started|jump in)|^\W*alright\W*$/i;

/** Sentences of one line, each with its [start, end) offsets. */
function sentenceSpans(line: string, from: number): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const re = /[^.!?]*(?:[.!?]+["'”’)]*|$)/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      if (re.lastIndex >= line.length) break;
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    if (re.lastIndex >= line.length) break;
  }
  return out;
}

/**
 * Put the canonical welcome into ONE hook option.
 *
 * Finds the welcome stretch (the greeting or "I'm Jake Dawson" sentence, plus
 * the sentences right after it that are still the welcome — the subscribe ask,
 * "Let's get into it") on the line where it starts, and swaps the whole stretch
 * for CANONICAL_WELCOME. Everything around it — the beat labels, the promise
 * before it, the Skool plug after it — is left alone. A hook with no welcome
 * gets one appended after its last spoken line (before any trailing "JAKE:" or
 * "====" bookkeeping line). Returns the text unchanged when it already carries
 * the canonical line exactly.
 */
export function ensureCanonicalWelcome(hook: string): { text: string; changed: boolean } {
  if (hook.includes(CANONICAL_WELCOME)) return { text: hook, changed: false };
  const lines = hook.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const m = WELCOME_START_RE.exec(line);
    if (!m) continue;
    const spans = sentenceSpans(line, 0);
    const first = spans.findIndex((sp) => m.index >= sp.start && m.index < sp.end);
    if (first === -1) continue;
    // Start at the greeting itself when it sits mid-sentence after a dash or a
    // comma ("…in your life — hey everyone…"); otherwise at the sentence start.
    const sp0 = spans[first];
    const lead = line.slice(sp0.start, m.index);
    const start = /[—–-]\s*$|,\s*$/.test(lead) || /^\s*$/.test(lead) || /["“'‘]\s*$/.test(lead)
      ? m.index
      : sp0.start + (line.slice(sp0.start).length - line.slice(sp0.start).trimStart().length);
    let end = sp0.end;
    for (let k = first + 1; k < spans.length; k++) {
      if (!WELCOME_PART_RE.test(spans[k].text.trim())) break;
      end = spans[k].end;
    }
    // Keep a closing quote / bracket that ended the beat.
    let tail = line.slice(start, end);
    const closer = tail.match(/["”’)\]]+\s*$/);
    if (closer) end -= closer[0].length;
    tail = line.slice(start, end);
    let before = line.slice(0, start);
    // The line is verbatim, capital H and all — so a sentence that ran into it
    // ("…on screen — hey everyone…") is closed with a full stop instead.
    if (/\S\s*[,—–-]\s*$/.test(before)) before = before.replace(/\s*[,—–-]\s*$/, ". ");
    const sep = before.length && !/[\s"“'‘(]$/.test(before) ? " " : "";
    lines[li] = `${before}${sep}${CANONICAL_WELCOME}${line.slice(end)}`;
    return { text: lines.join("\n"), changed: true };
  }
  // No welcome at all: append after the last spoken line.
  let at = lines.length;
  while (at > 0 && (!lines[at - 1].trim() || /^\s*(?:JAKE:|={3,}|-{3,})/.test(lines[at - 1]))) at--;
  lines.splice(at, 0, "", CANONICAL_WELCOME);
  return { text: lines.join("\n"), changed: true };
}

/**
 * The same, across the whole hooks block: every hook option (the four formulas
 * and the free hook) gets the canonical welcome. Splits on the same headings as
 * splitHooks in run.ts and rewrites each option's text in place.
 */
export function lockWelcomeInHooks(hooks: string): { text: string; changed: number } {
  const heading = /^#{0,4}\s*\**\s*(?:FORMULA\s+[A-Z][A-Z0-9-]*\b|OPEN HOOK\b)/i;
  const lines = (hooks || "").split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (heading.test(l)) starts.push(i);
  });
  if (starts.length === 0) return { text: hooks, changed: 0 };
  const out: string[] = lines.slice(0, starts[0]);
  let changed = 0;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const head = lines[from];
    let body = lines.slice(from + 1, to);
    // The trailing "JAKE: pick the formula…" line belongs to the block, not to
    // the last hook — keep it out of the welcome search.
    const jakeAt = body.findIndex((l) => /^\s*JAKE:/.test(l));
    const trailer = jakeAt === -1 ? [] : body.slice(jakeAt);
    if (jakeAt !== -1) body = body.slice(0, jakeAt);
    // A separator rule ("=====") between hooks also stays where it is.
    let sepAt = body.length;
    while (sepAt > 0 && (!body[sepAt - 1].trim() || /^\s*={3,}\s*$/.test(body[sepAt - 1]))) sepAt--;
    const spoken = body.slice(0, sepAt).join("\n");
    const rest = body.slice(sepAt);
    if (!spoken.trim()) {
      out.push(head, ...body, ...trailer);
      continue;
    }
    const r = ensureCanonicalWelcome(spoken);
    if (r.changed) changed++;
    out.push(head, ...r.text.split("\n"), ...rest, ...trailer);
  }
  return { text: out.join("\n"), changed };
}

// ── Production notes (out of the narration) ──────────────────────────────────

/** A line the writer was told to use for an open item: `PRODUCTION NOTE: …`. */
const PRODUCTION_NOTE_LINE_RE = /^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?PRODUCTION NOTE(?:\*\*)?[ \t]*:[ \t]*(.+?)[ \t]*$/gim;

/**
 * Move every note-to-Jake out of the spoken script (P1).
 *
 * Inline `[VERIFY ON SCREEN: …]` / `[SHOOT DAY: …]` markers are cut out of the
 * sentence they sat in (the sentence is tidied around the gap) and become one
 * note each, quoting a little of the sentence so Jake can find the spot; whole
 * `PRODUCTION NOTE: …` lines are lifted out as they are. The returned body has
 * no bracketed note left in it. Notes are de-duplicated, order kept.
 */
export function extractProductionNotes(body: string): { body: string; notes: string[] } {
  const notes: string[] = [];
  const push = (n: string) => {
    const t = n.replace(/\s+/g, " ").trim();
    if (t && !notes.includes(t)) notes.push(t);
  };
  let text = body.replace(PRODUCTION_NOTE_LINE_RE, (_m, note: string) => {
    push(note);
    return "";
  });
  const lines = text.split("\n").map((line) => {
    if (!new RegExp(PRODUCTION_MARKER_RE.source, "i").test(line)) return line;
    const found: string[] = [];
    let cleaned = line.replace(new RegExp(PRODUCTION_MARKER_RE.source, "gi"), (m) => {
      const inner = m.slice(1, -1).trim();
      found.push(inner);
      // A VERIFY marker usually names the control by what it does — "[VERIFY
      // ON SCREEN: the button that starts a new skill]". That description IS the
      // "write the step around it" wording, so it stays in the sentence; a
      // question ("is the trial 14 days?") or a shoot note just comes out.
      const desc = inner.replace(/^[^:]*:\s*/, "");
      const keep =
        /^VERIFY/i.test(inner) &&
        /^(?:the|a|an|your|its|their)\s/i.test(desc) &&
        !/[?]/.test(desc) &&
        desc.length <= 80 &&
        !/\b(?:exact|name|label|called|wording|path)\b/i.test(desc);
      return keep ? ` ${desc} ` : " ";
    });
    cleaned = cleaned
      .replace(/[ \t]+/g, " ")
      .replace(/ +([.,;:!?])/g, "$1")
      .replace(/([.,;:!?])\1+/g, "$1")
      .trim();
    const where = cleaned.length > 110 ? `${cleaned.slice(0, 107)}…` : cleaned;
    for (const f of found) push(where ? `${f} — near: "${where}"` : f);
    return cleaned;
  });
  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { body: text, notes };
}

/**
 * Anything that still reads as a note to Jake inside the spoken script — the
 * check that runs AFTER extraction. Should always come back empty; when it does
 * not, the run says so loudly (the narration must never carry one).
 */
export function findProductionNotesInProse(text: string): string[] {
  const out: string[] = [];
  const res = [
    /\[(?:VERIFY|SHOOT|TODO|TBD|CHECK|CONFIRM|NOTE)\b[^\]\n]{0,120}\]?/gi,
    /\bSHOOT DAY\b[^.\n]{0,80}/g,
    /\bstopwatch this\b[^.\n]{0,40}/gi,
    /^[ \t]*PRODUCTION NOTE[ \t]*:.{0,80}/gim,
    /<<<\s*(?:END\s+)?FULL PROMPT[^>\n]*>>>/gi,
  ];
  for (const re of res) for (const m of text.matchAll(re)) out.push(m[0].trim());
  return [...new Set(out)].slice(0, 20);
}

/** The appendix block Jake reads after the script. Empty string when there is nothing. */
export const PRODUCTION_NOTES_HEADING = "## PRODUCTION NOTES (for Jake — not part of the narration)";
export interface NoteGroup {
  heading: string;
  notes: string[];
}

export function productionNotesAppendix(notes: string[], groups?: NoteGroup[] | null): string {
  if (notes.length === 0) return "";
  const body = groups?.length
    ? groups
        .filter((g) => g.notes.length)
        .map((g) => `### ${g.heading}\n\n${g.notes.map((n) => `- ${n}`).join("\n")}`)
        .join("\n\n")
    : notes.map((n) => `- ${n}`).join("\n");
  return (
    `\n\n---\n\n${PRODUCTION_NOTES_HEADING}\n\n` +
    "Open items the writer could not confirm. Check each one on screen while recording; none of them is read aloud.\n\n" +
    body
  );
}

/**
 * Notes as a list a person can use. Every section writer adds its own, so the
 * same item arrives several times in different words — the Linearity run listed
 * the missing tracking link three times and "don't show the Blue Bottle test
 * brand" four. This is the deterministic half: sentence-case each note, and drop
 * one whose words are mostly another's (keeping the longer, which usually says
 * what to do as well as what is wrong).
 */
export function dedupeNotes(notes: string[]): string[] {
  const clean = notes
    .map((n) => n.replace(/^\s*(?:PRODUCTION NOTE\s*:\s*)/i, "").trim())
    .filter(Boolean)
    .map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  const kept: string[] = [];
  for (const n of clean) {
    const dup = kept.findIndex((k) => overlap(k, n) >= 0.7);
    if (dup === -1) kept.push(n);
    else if (n.length > kept[dup].length) kept[dup] = n;
  }
  return kept;
}

/** The model half: merge what still says the same thing, and group by when Jake needs it. */
export function notesMergePrompt(notes: string[]): string {
  return [
    "Below are the production notes for one YouTube script: open items for Jake to check before or while recording, or at upload. They were written section by section, so several say the same thing in different words.",
    "",
    "Do two things:",
    "1. **Merge duplicates.** Notes about the same item become ONE note that keeps every concrete detail any of them had (a label, a number, a fix). Do not merge notes about different items.",
    "2. **Group them** under exactly these headings, in this order, leaving out an empty one: \"Before the shoot\", \"On the shoot\", \"At upload\".",
    "",
    "Rules: never add an item, a fact or a recommendation that is not in the notes. Keep Jake's words where you can. Each note is one or two plain sentences, starting with a capital letter. Shorter is better.",
    "",
    'Reply with JSON only: {"groups": [{"heading": "Before the shoot", "notes": ["…"]}]}',
    "",
    "NOTES:",
    ...notes.map((n, i) => `${i + 1}. ${n}`),
  ].join("\n");
}

/**
 * Read the merge back, or null when it cannot be trusted: more notes than went
 * in, an unknown heading, or a note that shares too few words with every input
 * (an invented item).
 */
export function parseNotesMerge(text: string, input: string[]): NoteGroup[] | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { groups?: Array<{ heading?: unknown; notes?: unknown }> };
    const allowed = ["Before the shoot", "On the shoot", "At upload"];
    const groups: NoteGroup[] = [];
    let count = 0;
    for (const g of parsed.groups ?? []) {
      const heading = typeof g.heading === "string" ? allowed.find((a) => a.toLowerCase() === g.heading!.toString().trim().toLowerCase()) : undefined;
      if (!heading || !Array.isArray(g.notes)) return null;
      const notes = g.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim());
      for (const n of notes) if (!input.some((i) => overlap(i, n) >= 0.4)) return null;
      count += notes.length;
      groups.push({ heading, notes });
    }
    if (count === 0 || count > input.length) return null;
    return allowed.map((h) => groups.filter((g) => g.heading === h).flatMap((g) => g.notes)).flatMap((notes, i) => (notes.length ? [{ heading: allowed[i], notes }] : []));
  } catch {
    return null;
  }
}

// ── Full prompts (the long copy-paste versions, after the script) ────────────

/**
 * Jake, 2026-10-02: "the short versions should be in the script and the long
 * versions after the script, in a separate section". The spoken/on-screen prompt
 * stays one to three plain sentences (P20); the section writer ALSO writes the
 * comprehensive version straight after it, fenced so code can lift it out:
 *
 *     <<<FULL PROMPT>>>
 *     …the long, structured version…
 *     <<<END FULL PROMPT>>>
 *
 * The blocks never reach the narration, the review passes or any word count:
 * they are lifted out before Stage 7 and re-attached as the FULL PROMPTS
 * appendix, each numbered to match its short version in the PROMPT SUMMARY.
 */
export interface FullPromptBlock {
  /** The short prompt it belongs to — the last quoted prompt before the block. */
  short: string;
  /** Optional label written on the fence: `<<<FULL PROMPT: Weekly report>>>`. */
  label: string;
  text: string;
}

/** A properly fenced block. It may not swallow the next block's opening fence. */
const FULL_PROMPT_RE =
  /^[ \t]*<<<\s*FULL PROMPT\b[ \t]*:?[ \t]*([^>\n]*?)[ \t]*>>>[ \t]*\n((?:(?!<<<\s*FULL PROMPT)[\s\S])*?)\n[ \t]*<<<\s*END\s+FULL PROMPT\s*>>>[ \t]*$/gim;
/** An opening fence whose END was lost: the block runs to the next blank line. */
const FULL_PROMPT_OPEN_RE =
  /^[ \t]*<<<\s*FULL PROMPT\b[ \t]*:?[ \t]*([^>\n]*?)[ \t]*>>>[ \t]*\n([\s\S]*?)(?=\n[ \t]*\n|(?![\s\S]))/gim;

/** The last quoted span (≥ 20 chars) in a stretch of text. */
function lastQuoted(text: string): string {
  const clean = text.replace(/[“”]/g, '"');
  const parts = clean.split('"');
  for (let i = parts.length - 2; i >= 1; i -= 1) {
    if (i % 2 === 1 && parts[i].trim().length >= 20) return parts[i].trim();
  }
  return "";
}

/** Lift the fenced full-prompt blocks out of a body. */
export function extractFullPrompts(body: string): { body: string; blocks: FullPromptBlock[] } {
  const blocks: FullPromptBlock[] = [];
  const lift = (label: string, inner: string, offset: number, whole: string): string => {
    const before = whole.slice(Math.max(0, offset - 1500), offset);
    const text = inner.replace(/^\s*\n/, "").replace(/\s+$/, "");
    if (text.trim()) blocks.push({ short: lastQuoted(before), label: (label || "").trim(), text });
    return "";
  };
  const out = (body || "")
    .replace(FULL_PROMPT_RE, (_m, label: string, inner: string, offset: number, whole: string) =>
      lift(label, inner, offset, whole),
    )
    .replace(FULL_PROMPT_OPEN_RE, (_m, label: string, inner: string, offset: number, whole: string) =>
      lift(label, inner, offset, whole),
    )
    // A stray END fence with nothing to close.
    .replace(/^[ \t]*<<<\s*END\s+FULL PROMPT\s*>>>[ \t]*$/gim, "");
  return { body: out.replace(/\n{3,}/g, "\n\n").trim(), blocks };
}

/** Remove the blocks without keeping them — for measuring a section's spoken words. */
export function stripFullPromptBlocks(body: string): string {
  return extractFullPrompts(body).body;
}

const wordSet = (t: string) =>
  new Set((t.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 2));

function overlap(a: string, b: string): number {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/** The quoted span in the spoken script that is closest to `short` (≥ 50% word overlap), verbatim. */
export function spokenQuoteFor(spokenBody: string, short: string): string | null {
  const parts = spokenBody.replace(/[“”]/g, '"').split('"');
  let best: string | null = null;
  let bestScore = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const q = parts[i].trim();
    if (q.split(/\s+/).length < 4) continue;
    const sc = overlap(short, q);
    if (sc > bestScore) {
      bestScore = sc;
      best = q;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

export const PROMPT_SUMMARY_HEADING = "## PROMPT SUMMARY (for the description / pinned comment)";
export const FULL_PROMPTS_HEADING = "## FULL PROMPTS (copy-paste versions — not read aloud)";

/**
 * The two prompt appendices, numbered so each full version matches its short one.
 *
 * Builds on extractPrompts: the short prompts it finds in the spoken script are
 * numbered 1…n in the PROMPT SUMMARY. Each full block is paired with the short
 * prompt it was written after (by word overlap, so a light edit by the review
 * pass still pairs), and takes that number and label. A block whose short
 * version extractPrompts could not find (an unquoted prompt — the known blind
 * spot) adds its short text to the summary under the next number, so the two
 * lists always line up.
 */
export function promptAppendices(spokenBody: string, blocks: FullPromptBlock[]): {
  text: string;
  shortCount: number;
  fullCount: number;
} {
  const shorts = extractPrompts(spokenBody).map((p) => ({ label: p.label, text: p.text }));
  const fullFor = new Map<number, string[]>();
  for (const b of blocks) {
    let best = -1;
    let bestScore = 0;
    shorts.forEach((s, i) => {
      const sc = b.short ? overlap(b.short, s.text) : 0;
      if (sc > bestScore) {
        bestScore = sc;
        best = i;
      }
    });
    if (best === -1 || bestScore < 0.5) {
      // The short version as the SCRIPT says it, not as the writer first wrote
      // it: a later pass can edit the spoken prompt, and the summary has to
      // match what the viewer sees on screen word for word.
      const spoken = b.short ? spokenQuoteFor(spokenBody, b.short) : null;
      // A long version whose short prompt is no longer in the script at all
      // belongs to nothing the viewer sees — the Linearity rerun shipped a
      // "Prompt 2 — full version" for a prompt the review had cut. Drop it.
      if (!spoken && !(b.short && spokenBody.includes(b.short))) continue;
      shorts.push({ label: b.label || `Prompt ${shorts.length + 1}`, text: spoken ?? b.short });
      best = shorts.length - 1;
    }
    fullFor.set(best, [...(fullFor.get(best) ?? []), b.text]);
  }
  const listed = shorts.filter((s) => s.text);
  let text = "";
  if (listed.length > 0) {
    text +=
      `\n\n---\n\n${PROMPT_SUMMARY_HEADING}\n\n` +
      shorts
        .map((p, i) => (p.text ? `**${i + 1}. ${p.label}:** "${p.text}"` : ""))
        .filter(Boolean)
        .join("\n\n");
  }
  let fullCount = 0;
  if (fullFor.size > 0) {
    const parts: string[] = [];
    [...fullFor.keys()].sort((a, b) => a - b).forEach((i) => {
      for (const full of fullFor.get(i) ?? []) {
        fullCount++;
        parts.push(`**${i + 1}. ${shorts[i].label} — full version**\n\n${full}`);
      }
    });
    text +=
      `\n\n---\n\n${FULL_PROMPTS_HEADING}\n\n` +
      "The long version of each prompt, for anyone who wants every detail. The number matches the short prompt in the script and in the summary above.\n\n" +
      parts.join("\n\n");
  }
  return { text, shortCount: listed.length, fullCount };
}

/**
 * The headings that start the after-the-script appendices. Everything from the
 * first of these on is NOT spoken: word counts, diffs, the rules pass and the
 * review re-run all stop there.
 */
export const APPENDIX_HEADING_RE = /^## (?:PROMPT SUMMARY|FULL PROMPTS|PRODUCTION NOTES|OTHER OPENINGS)\b/m;

/** Split the `## SCRIPT` section into the spoken body and the appendix text after it. */
export function splitScriptAppendices(section: string): { body: string; appendix: string } {
  const m = APPENDIX_HEADING_RE.exec(section);
  if (!m) return { body: section, appendix: "" };
  let cut = m.index;
  // Take the `---` rule that introduces the first appendix with it.
  const before = section.slice(0, cut);
  const rule = before.match(/\n*-{3,}\s*\n*$/);
  if (rule) cut -= rule[0].length;
  return { body: section.slice(0, cut).replace(/\s+$/, ""), appendix: section.slice(cut) };
}

/** One appendix's lines back out of a stored document (for the review re-run). */
export function appendixSection(appendix: string, heading: string): string {
  const at = appendix.indexOf(heading);
  if (at === -1) return "";
  const rest = appendix.slice(at + heading.length);
  const next = rest.search(/\n-{3,}\s*\n+## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * Read the stored appendices back into what the assembly needs, so a review
 * re-run keeps the full prompts and the production notes it cannot regenerate
 * (the full prompts were written by the section stage, which a re-run does not
 * call). Each full prompt is re-paired with the short prompt that carried its
 * number in the stored PROMPT SUMMARY.
 */
export function parseStoredAppendices(appendix: string): { blocks: FullPromptBlock[]; notes: string[]; otherOpenings: string } {
  const summary = appendixSection(appendix, PROMPT_SUMMARY_HEADING);
  const shortByNo = new Map<number, string>();
  for (const m of summary.matchAll(/^\*\*(\d+)\.\s[^*]*:\*\*\s*"([\s\S]*?)"\s*$/gm)) {
    shortByNo.set(Number(m[1]), m[2]);
  }
  const full = appendixSection(appendix, FULL_PROMPTS_HEADING);
  const blocks: FullPromptBlock[] = [];
  const heads = [...full.matchAll(/^\*\*(\d+)\.\s(.*?) — full version\*\*\s*$/gm)];
  heads.forEach((h, i) => {
    const from = (h.index ?? 0) + h[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index ?? full.length : full.length;
    const text = full.slice(from, to).trim();
    if (text) blocks.push({ short: shortByNo.get(Number(h[1])) ?? "", label: h[2].trim(), text });
  });
  const notesText = appendixSection(appendix, PRODUCTION_NOTES_HEADING);
  const notes = notesText
    .split("\n")
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .filter(Boolean);
  const otherOpenings = appendixSection(appendix, OTHER_OPENINGS_HEADING);
  return { blocks, notes, otherOpenings };
}

// ── One opening in the script, the alternatives after it (Jake 2026-10-02) ──

export const OPENING_HEADING = "## OPENING";
export const OTHER_OPENINGS_HEADING = "## OTHER OPENINGS (alternatives — swap one in if you prefer; not part of the script)";
const HOOKS_HEADING_RE = /^## HOOKS\b.*$/m;
// Case-SENSITIVE on purpose: Stage 3 writes these labels in capitals, and a hook line
// that merely starts \"Open hook…\" or \"Formula one…\" must not split an option.
const OPTION_LABEL_RE = /^#{0,4}\s*\**\s*((?:FORMULA\s+[A-Z][A-Z0-9-]*\b|OPEN HOOK\b)[^*\n]*)/;

/** The hook options of a `## HOOKS — pick one` block, each with its label. */
export function hookOptions(hooksText: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  let cur: { label: string; text: string } | null = null;
  for (const line of (hooksText || "").split("\n")) {
    const m = line.match(OPTION_LABEL_RE);
    if (m) {
      if (cur) out.push(cur);
      cur = { label: m[1].replace(/\s*[*_]+\s*$/, "").trim(), text: "" };
    } else if (cur) cur.text += line + "\n";
  }
  if (cur) out.push(cur);
  return out.map((h) => ({ label: h.label, text: h.text.trim() })).filter((h) => h.text.length > 0);
}

/**
 * One option as it is SPOKEN: without the formula apparatus around it (the ====
 * rules, "Best for:", "Sub-conversion:", the "**Beat 2 (0:08–0:25)**" labels and
 * the "JAKE: pick the formula…" note). Screen directions stay.
 */
export function spokenHook(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*=+\s*$/.test(l))
    .filter((l) => !/^\s*(?:Best for|Sub-conversion|Retention|Runtime|Length)\s*:/i.test(l))
    .filter((l) => !/^\s*\**\s*Beat\s+\d+[^\n]*\**\s*$/i.test(l))
    .filter((l) => !/^\s*JAKE\s*:/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const labelKey = (s: string) => (s.match(/FORMULA\s+[A-Z][A-Z0-9-]*|OPEN HOOK/i)?.[0] ?? s).toUpperCase().replace(/\s+/g, " ");

/**
 * Jake deleted four of the five hook options by hand in every script (2026-10-02
 * study: 44 of the 93 paragraphs he cut were duplicates, nearly all of them the
 * other openings). So the assembled document now carries ONE opening — the
 * top-ranked hook (`hookRanking[0]`, best virality then SEO), falling back to
 * A-Compressed, his own opening shape, then the first — under `## OPENING`, and
 * the others go after the script under OTHER OPENINGS, where nothing counts them.
 *
 * `top` is the assembled top part (`# title` → `## HOOKS — pick one` → options →
 * optional `## SPONSOR SEGMENT`). A top part with no HOOKS block (a review re-run
 * of a document already in this format) is returned unchanged, with the stored
 * alternatives carried through.
 */
export function arrangeOpenings(
  top: string,
  ranking: Array<{ hook: number; label: string }> | null | undefined,
  carriedOther = "",
  /**
   * Tutorials: take the best-RANKED option that passes Jake's opening shape
   * (openingShapeIssues). The Linearity run's top-ranked hook was the free OPEN
   * HOOK at 216 words and two questions before the welcome — flagged by the
   * check, used anyway — while A-Compressed, in his exact shape, sat unused.
   */
  preferShape = false,
): { top: string; otherAppendix: string; chosen: string | null } {
  const wrap = (body: string) => (body.trim() ? `\n\n---\n\n${OTHER_OPENINGS_HEADING}\n\n${body.trim()}\n` : "");
  const h = HOOKS_HEADING_RE.exec(top);
  if (!h) return { top, otherAppendix: wrap(carriedOther), chosen: null };
  const afterHeading = h.index + h[0].length;
  const seg = top.indexOf("## SPONSOR SEGMENT", afterHeading);
  const hooksText = top.slice(afterHeading, seg === -1 ? undefined : seg);
  const options = hookOptions(hooksText);
  if (options.length === 0) return { top, otherAppendix: wrap(carriedOther), chosen: null };
  // Every option, in ranked order (unranked ones after, in document order).
  const order: number[] = [];
  for (const r of ranking ?? []) {
    let i = options.findIndex((o) => labelKey(o.label) === labelKey(r.label));
    if (i === -1 && r.hook >= 1 && r.hook <= options.length) i = r.hook - 1;
    if (i !== -1 && !order.includes(i)) order.push(i);
  }
  const compressed = options.findIndex((o) => /A-COMPRESSED/i.test(o.label));
  if (!ranking?.length && compressed !== -1) order.push(compressed);
  options.forEach((_, i) => {
    if (!order.includes(i)) order.push(i);
  });
  let pick = order[0] ?? 0;
  if (preferShape) {
    const shaped = order.find((i) => openingShapeIssues(spokenHook(options[i].text)).length === 0);
    if (shaped !== undefined) pick = shaped;
    else if (compressed !== -1) pick = compressed;
  }
  const chosen = options[pick];
  const others = options.filter((_, i) => i !== pick).map((o) => `### ${o.label}\n\n${spokenHook(o.text)}`);
  const before = top.slice(0, h.index);
  const sponsor = seg === -1 ? "" : top.slice(seg);
  return {
    top: `${before}${OPENING_HEADING}\n\n${spokenHook(chosen.text)}\n\n${sponsor}`,
    otherAppendix: wrap(others.join("\n\n")),
    chosen: chosen.label,
  };
}

// ── Writing-study checks (measured, never modelled) ──────────────────────────

/**
 * The opening shape Jake rebuilds every opening into (P3): "Look at this …" /
 * "By the end of this video, you'll X — even if you've never Y in your life" /
 * the exact prompts on screen / the welcome. Checked on the text BEFORE the
 * welcome: at most four paragraphs and about 120 words, the promise sentence
 * present, and no list of questions the video promises to answer.
 */
export function openingShapeIssues(hook: string): string[] {
  const spoken = hook
    .split("\n")
    .filter((l) => !/^\s*(?:={3,}|-{3,}|#{1,6}\s|JAKE:|Best for:|Sub-conversion:)/i.test(l))
    .map((l) =>
      l
        .replace(/^\s*\**\s*Beat\s+\d+\s*(?:\([^)]*\))?\s*:?\s*\**\s*/i, "")
        .replace(/\[[^\]\n]*\]/g, " ")
        .replace(/[*_>]/g, " ")
        .trim(),
    )
    .join("\n");
  const issues: string[] = [];
  const w = WELCOME_START_RE.exec(spoken);
  if (!w) issues.push("no welcome line");
  const pre = (w ? spoken.slice(0, w.index) : spoken).trim();
  const paras = pre.split(/\n\s*\n|\n/).map((p) => p.trim()).filter((p) => /[a-z]/i.test(p));
  const words = (pre.match(/[A-Za-z0-9']+/g) ?? []).length;
  if (paras.length > 4) issues.push(`${paras.length} paragraphs before the welcome (at most 4)`);
  if (words > 130) issues.push(`${words} words before the welcome (about 120 at most)`);
  if (!/by the end of this video/i.test(pre)) issues.push('no "By the end of this video, you\'ll …" promise');
  else if (!/even if you'?ve never/i.test(pre)) issues.push('the promise has no "— even if you\'ve never … in your life" reassurance');
  const questions = (pre.match(/\?/g) ?? []).length;
  if (questions >= 2) issues.push(`${questions} questions before the welcome (no list of questions the video promises to answer)`);
  return issues;
}

/**
 * The technical words a beginner has to act on (P19). The first time one is
 * used it must be named, defused and translated in one plain line — "This is
 * called an MCP. Now, that sounds scary. It's not. It's just the plug that lets
 * Claude use another app for you." — not left as a raw label.
 */
export const JARGON_TERMS = ["MCP", "API key", "API", "OAuth", "webhook", "endpoint", "token", "CLI"];

const EXPLAIN_RE =
  /\b(?:is just|it'?s just|are just|just means|basically|means|think of (?:it|them|this|that)|sounds scary|stands for|in plain english|in other words|is (?:a|an|the) (?:little |tiny |simple )?(?:plug|adapter|key|password|code|link|address|bridge|door)|is like|works like|short for)\b/i;

/** First mentions of a jargon term with no plain-English line near them. */
export function findUnexplainedJargon(text: string): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  const done = new Set<string>();
  for (const term of JARGON_TERMS) {
    if (done.has(term)) continue;
    const re =
      term === "token"
        ? /\btokens?\b/i
        : new RegExp(`\\b${term.replace(/ /g, "\\s+")}s?\\b`, term === term.toUpperCase() ? "" : "i");
    const at = sentences.findIndex((s) => re.test(s));
    if (at === -1) continue;
    // "API key" covers "API": one explanation is enough for both.
    if (term === "API key") done.add("API");
    const near = sentences.slice(Math.max(0, at - 1), at + 3).join(" ");
    if (!EXPLAIN_RE.test(near)) {
      const s = sentences[at];
      out.push(`${term} — "${s.length > 120 ? s.slice(0, 117) + "…" : s}"`);
    }
  }
  return out;
}

/**
 * The exemplars' signature jokes (P24). The 8-word shingle check in
 * exemplarEchoes cannot see a reused 3–6 word joke, and a reused joke is the
 * worst kind of lifted line — the audience has heard it. Steal the move (a joke
 * riding the login step), never the line.
 */
export const EXEMPLAR_JOKE_PHRASES = [
  "first pancakes",
  "cheap day rates",
  "too short for another password",
  "don't call in sick",
  "credits will thank you",
  "keys to a production studio",
  "burning them on a tiny robot",
  "marvel fight scenes",
  "another release cycle",
  "until your eyes cross",
  "like a normal person",
  "plan i'll drown in",
];

export function findExemplarJokes(text: string): string[] {
  const norm = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  return EXEMPLAR_JOKE_PHRASES.filter((p) => norm.includes(p));
}

/**
 * Restatement tails (P11): a paragraph that ends on a short tagline after the
 * point was already made — "That's the whole trick." / "Done." / "Nothing
 * spent." — and the "X, not Y" contrast line. Jake cut about forty of these
 * across eight runs. Reported, never auto-deleted.
 */
const TAGLINE_RE =
  /^(?:that'?s the whole\b|that'?s it\b|that'?s the tell\b|done\b|nothing spent\b|it'?s normal\b|.*\bis just arithmetic\b|nobody\b.*\bnobody\b|same \w+\. (?:smaller|bigger|different)\b)/i;

export function findTaglineEndings(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n|\n/)) {
    const sents = splitSentences(para);
    if (sents.length < 2) continue;
    const last = sents[sents.length - 1];
    const n = wordsOf(last).length;
    if (n === 0 || n > 8) continue;
    if (TAGLINE_RE.test(last.replace(/^["“]/, "")) || /^[^,]{2,40}, not (?:a |an |the )?[^,]{2,40}[.!]$/i.test(last)) {
      out.push(last);
    }
  }
  return [...new Set(out)].slice(0, 20);
}

/**
 * "let's" per 1,000 words (P12) — a SOFT voice target, never a gate. Jake's
 * finished runs: 2.0–11.3; the same runs as generated: 0.8–5.3. And the bare
 * imperative step lines ("Click Save. Paste it. Send.") he turns into "now let's
 * …". Both measured on spoken text only.
 */
export function letsMetrics(text: string): { letsPer1000: number; bareImperatives: string[] } {
  const spoken = text.split(CANONICAL_OUTRO)[0] ?? text;
  const words = wordsOf(spoken).length;
  const lets = (spoken.match(/\blet'?s\b/gi) ?? []).length;
  const bare = splitSentences(spoken).filter(
    (s) =>
      wordsOf(s).length <= 4 &&
      /^(?:click|paste|type|hit|press|open|send|select|copy|tap|choose|drag|save|run)\b/i.test(s.trim()),
  );
  return {
    letsPer1000: words ? Number(((lets / words) * 1000).toFixed(1)) : 0,
    bareImperatives: [...new Set(bare)].slice(0, 12),
  };
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
  /** Times the script puts the viewer in front of something happening on screen. */
  demoAnchors: number;

}

/**
 * The phrasings that hand the viewer something to LOOK at.
 *
 * This is a script read aloud over a screen recording, not an essay. The
 * difference is measurable: "you paste the link and it builds you a marketing
 * clip" describes, while "and look at that box — that's the same bottle" points
 * at the screen. Only the second one needs the video to exist.
 *
 * Deliberately NOT included: the instruction verbs (click, type, paste, open) —
 * a script is never short of those, and the gap is always in showing the RESULT.
 * Also dropped after a hand-check: "shows up", "lands in", "comes back with".
 * They read as demonstrative but a run used all three explanatorily — "it shows
 * up in the note as one line", "the finished note lands in the same place" — and
 * they were the phrasings inflating a generated script's count over a
 * hand-written one's.
 */
const DEMO_ANCHOR_RE =
  /\b(?:look at (?:that|this|it)|and look\b|watch (?:this|that|what happens|it \w+)|check out what happens|and there (?:it|they) (?:is|are)|there (?:it|they) (?:is|are)\b|you(?:'ll| will| should)? see|you can see|see (?:that|how|what)\b|on screen|on the screen|pops? up|right there on|let me show you|i'll show you|let's run it)/i;

/** A sentence that reads a prompt out loud is showing something too. */
const PROMPT_LINE_RE = /^["“']|^\d+\.\s|^(?:here'?s the prompt|so here'?s the prompt)/i;

/**
 * Count the moments the script puts the viewer in front of something.
 *
 * A PER-SECTION FLOOR ONLY. Do not turn this into a score — it was checked
 * against three finished scripts (one hand-written, two generated) and it does
 * not rank them: 4.5 / 4.2 / 4.1 moments per 1000 words, and narrowing it to
 * purely deictic phrasing only moved that to 2.9 / 1.6 / 2.5. The difference
 * between a script that demonstrates and one that lectures is real, and this
 * regex is not what measures it.
 *
 * Two richer versions were built and thrown away, both of which LOOKED like they
 * worked: counting silent paragraphs measured the layout (single newlines vs
 * blank lines), and counting silent WORDS ranked the hand-written script worst of
 * the three. A third bug — an unbounded quoted-span blank that swallowed the
 * narration between two prompts — manufactured a clean 4x gap out of nothing.
 * Check any successor against a script known to be good before trusting it.
 *
 * What survives is the low bar that holds regardless: a section of a DEMO video
 * that never once points at the screen was written as an essay.
 */
export function demoDensity(text: string): { demoAnchors: number } {
  // Two things are blanked before counting. A prompt being read out is on screen
  // for the viewer to copy — the most demonstrative thing the video does, and its
  // interior is not narration. And `[VERIFY ON SCREEN: …]` is a note to Jake, not
  // a line anybody says: left in, it scored a run three anchors that were all
  // production notes.
  // The canonical outro is byte-identical in every script, so its "you'll see
  // exactly what I mean" was a constant +1 on every run — a moment nobody stages.
  const spoken = stripVerifyMarkers(text.split(CANONICAL_OUTRO)[0] ?? text)
    // Bounded, and never across a line break. The first version was
    // /["“][^"”]{40,}["”]/ — with the straight and curly quotes a script actually
    // mixes, one unclosed quote let that span thousands of characters and swallow
    // the real narration between two prompts. It cut a script from 27 counted
    // moments to 3 and looked like a clean result.
    .replace(/["“][^"”\n]{40,600}["”]/g, " ")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^#{1,6}\s/.test(l) &&
        !/^-{3,}$/.test(l) &&
        !PROMPT_LINE_RE.test(l),
    )
    .join("\n");
  const sentences = splitSentences(spoken);

  // SENTENCES that point at the screen, not raw regex hits. "you can see it right
  // there on screen" fires two alternatives and is one moment, not two.
  let demoAnchors = 0;
  for (const sen of sentences) {
    if (new RegExp(DEMO_ANCHOR_RE, "i").test(sen)) demoAnchors++;
  }
  return { demoAnchors };
}

/**
 * The passages that are SUPPOSED to be identical in every video, and so can
 * never be reported as lifted: the canonical end-card outro, the welcome, the
 * tagline, the promise line, the Skool plug, and the subscribe/like asks.
 *
 * Subtracted as SHINGLES, not matched as substrings. An eight-word window lands
 * mid-phrase — "…jake dawson and i help business owners use…" — so a substring
 * test against a tidy list of whole phrases misses almost all of it. The first
 * version did exactly that and reported nine "lifted lines" per script, every
 * one of them boilerplate.
 */
const BOILERPLATE_TEXT = [
  CANONICAL_OUTRO,
  CANONICAL_WELCOME,
  "Thanks so much for hanging out with me today. Before you click away, here's a video you'll probably want to watch next — YouTube's pretty good at this, it'll line up the one video it thinks you'll love next. Just click the video to my left and you'll see exactly what I'm talking about. See you there.",
  "Hey everyone, welcome back to the channel — I'm Jake Dawson, and I help business owners use AI without it turning into another full-time job. Let's get into it. Let's dive right in.",
  "Hey, if you're new here, I'm Jake Dawson, and I help solopreneurs and small business owners get this stuff actually working. If that sounds like you, hit subscribe and smash that like button so more of this finds you.",
  "By the end of this video, you'll be able to, you'll know how to, so you can copy it for your own content, your marketing, or anything you need. Even if you've never done this before.",
  "If you want to go deeper on any of this, I've got a free course inside my Skool community — the prompts from this video are in there as a doc you can copy straight out, and it costs you nothing. Link's in the description.",
  "If you want to go deeper on this, I've got a free course inside my Skool community that walks through it properly — link's in the description.",
  "And if this video saved you some time and money, do me a favor and smash the like button and hit subscribe. I dig into this stuff every single week. Drop a comment down below. I read every one.",
  "The link's in the description if you want to follow along.",
].join("\n\n");

/**
 * Lines the script lifted verbatim out of Jake's published scripts.
 *
 * The three exemplars ride in every stage's system prompt, which makes copying
 * them the path of least resistance — and a joke reused from a published video
 * reads as a rerun to exactly the people most likely to be watching. Jake's
 * instruction: steal the moves, never the sentences.
 *
 * Eight-word shingles: long enough that ordinary shared phrasing ("so you can
 * see what it does") doesn't trip it, short enough to catch a lifted clause
 * inside a rewritten sentence. Boilerplate that is meant to repeat is excluded.
 */
export function exemplarEchoes(script: string, exemplars: string[], shingle = 8): string[] {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[^a-z0-9' ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  const shinglesOf = (t: string) => {
    const w = norm(t);
    const out = new Set<string>();
    for (let i = 0; i + shingle <= w.length; i++) out.add(w.slice(i, i + shingle).join(" "));
    return out;
  };

  const boilerplate = shinglesOf(BOILERPLATE_TEXT);
  const seen = new Set<string>();
  for (const ex of exemplars) {
    for (const g of shinglesOf(ex)) if (!boilerplate.has(g)) seen.add(g);
  }

  const words = norm(script);
  const matches = (i: number) => seen.has(words.slice(i, i + shingle).join(" "));

  // Walk the maximal run of overlapping matches so a lifted sentence is reported
  // ONCE, in full, rather than once per sliding window position.
  const out: string[] = [];
  for (let i = 0; i + shingle <= words.length; i++) {
    if (!matches(i)) continue;
    let j = i;
    while (j + 1 + shingle <= words.length && matches(j + 1)) j++;
    out.push(words.slice(i, j + shingle).join(" "));
    i = j + shingle - 1;
  }
  return out.slice(0, 20);
}

/** The line Stage 2 must give every section: what the viewer watches happen. */
export const ON_SCREEN_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?ON SCREEN(?:\*\*)?\s*:/im;

/**
 * Which outline sections forgot to say what the viewer is looking at.
 *
 * Entertainment is cast at outline time, not rescued at Stage 5 — a section that
 * reaches the writer with no on-screen moment gets written as an essay paragraph,
 * and by then the cheapest fix left is a rewrite of finished prose. Checked here
 * while a one-line repair is still enough.
 */
export function outlineSectionsMissingOnScreen(outline: string): string[] {
  return parseOutlineSections(outline)
    .filter((s) => !ON_SCREEN_RE.test(s.text))
    .map((s) => s.name);
}

/**
 * Splice ON SCREEN lines into an outline WITHOUT asking a model to re-emit it.
 *
 * The coverage pass re-emits the whole document and has to be length-checked
 * because a truncated response silently deletes every section after the cut.
 * A repair that only ever adds one line per header can't fail that way: the
 * model returns the lines, the code puts them where they go.
 */
export function insertOnScreenLines(outline: string, lines: Record<string, string>): string {
  const keyed = new Map(Object.entries(lines).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
  if (keyed.size === 0) return outline;

  const src = outline.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    out.push(src[i]);
    if (!/^\s*#{2,4}\s/.test(src[i])) continue;
    const name = cleanSectionName(src[i]).trim().toLowerCase();
    const line = keyed.get(name);
    if (!line) continue;
    // Only if the section doesn't already have one — never a second copy.
    const end = src.findIndex((l, j) => j > i && /^\s*#{2,4}\s/.test(l));
    const body = src.slice(i + 1, end === -1 ? src.length : end).join("\n");
    if (ON_SCREEN_RE.test(body)) continue;
    out.push("", `ON SCREEN: ${line.replace(/^ON SCREEN:\s*/i, "")}`);
  }
  return out.join("\n");
}

/**
 * Generic approval that could be pasted into a video about any other tool.
 *
 * Slot 5 of the Stage 5 prompt used to OFFER these as approved phrasing, and a
 * finished script closed five separate sections on "that's a huge win" — a
 * reaction on a timer. The phrases are gone from the prompt; this catches the
 * ones the model reaches for anyway.
 */
export const GENERIC_APPROVAL_RE =
  /\b(?:that's a (?:huge|real|big) win|and that's nice|you love to see it|we love to see that|that's still a win|it's a really smart idea|that's interesting)\b/gi;

/** A section whose job is trust, not entertainment — no joke quota applies. */
const TRUST_BEAT_RE = /pricing|price|cost|money|plan|limit|honest|catch|privacy|security|downside|not for/i;

export interface SectionDemoCheck {
  demoAnchors: number;
  genericApproval: string[];
  /** Pricing / limits / privacy — where a joke reads as dodging the question. */
  trustBeat: boolean;
  ok: boolean;
}

/**
 * Check ONE section, while it can still be rewritten cheaply.
 *
 * The whole-script quality numbers arrive at the end of a 25-minute run, by which
 * point nothing is going to be rewritten. The same measurements taken per section
 * can be handed straight back to the review pass that is about to rewrite it
 * anyway — the deterministic finding does the pointing, the model does the
 * writing. Same shape as the claim audit: measure, feed back, re-measure.
 */
export function checkSectionDemo(text: string, sectionName = ""): SectionDemoCheck {
  const { demoAnchors } = demoDensity(text);
  const genericApproval = [...new Set((text.match(GENERIC_APPROVAL_RE) || []).map((m) => m.toLowerCase()))];
  const trustBeat = TRUST_BEAT_RE.test(sectionName);

  return {
    demoAnchors,
    genericApproval,
    trustBeat,
    // A trust beat is allowed to show nothing — that is what it is for. It still
    // may not close on canned approval.
    ok: genericApproval.length === 0 && (trustBeat || demoAnchors >= 1),
  };
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

  const { demoAnchors } = demoDensity(text);

  return {
    words: tokens.length,
    sentences: sentences.length,
    meanSentenceWords: Number(mean.toFixed(2)),
    burstiness: Number(burstiness.toFixed(3)),
    repeatedPhraseCount,
    worstPhraseRepeats,
    worstPhrase,
    discourseMarkerOpenings,
    demoAnchors,
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
  /**
   * AI-register phrasings that survived into the finished script. Measured to
   * appear zero times in any reference script, so a hit is drift, not voice.
   */
  slopPhrases: string[];
  /**
   * Names of the presenters whose tutorials fed the workflow sheet, found in the
   * script. A run said "that's the version Nate actually runs day to day" — Nate
   * being the channel behind two of its four source videos, introduced to the
   * viewer nowhere, and no part of Jake's voice.
   */
  sourceNames: string[];
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
export const BANNED_WORDS = [
  "caveat",
  "clever",
  "neat",
  "which",
  "whether",
  "genuinely",
  "real deal",
  "folks",
  // A tic rather than a word: it was the most-repeated phrase in a finished
  // script (3x) and reads as filler wherever it lands. The tense variants are
  // matched too — the entry is a fragment of the alternation, not a literal.
  "(?:keep|keeps|kept|keeping) coming back to",
  // Jake, 2026-09-08. The approved rule is "call it an image, never a still;
  // call it a video, never a clip" — the beginner noun, used the same way from
  // the first mention to the export step. The rule alone kept losing to the
  // model's own sense of variety, so it is enforced here as well.
  "clip",
  // ⚠️ "STILL" IS ONLY BANNED AS A NOUN, AND THE NARROWNESS IS DELIBERATE. The
  // adverb is Jake's own voice — "it's still free", "still one prompt" — and he
  // uses it more than the generator does; a whole-word ban would edit HIM out,
  // which is the one thing this list must never do. So only the three shapes
  // that cannot be the adverb are matched: the plural, "still image/frame/shot",
  // and an ARTICLE directly in front of it. Demonstratives and numbers are
  // deliberately NOT in that list — "that still counts", "all four still work"
  // and "the same still applies" are the adverb, and flagging them would send
  // the fix pass after Jake's own sentences.
  "stills",
  "still (?:image|images|frame|frames|shot|shots|photo|photos|picture|pictures)",
  "(?:a|an|the|another|generated|single) still",
];

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
  // Plurals count. "a few caveats" is the same word and was escaping the check
  // entirely, because \b after "caveat" fails against the "s".
  const bannedRe = new RegExp(`\\b(${BANNED_WORDS.join("|")})s?\\b`, "gi");
  // ⚠️ COUNTED PER WORD, BECAUSE ONE WORD CAN EAT THE WHOLE REPORT. "clip" runs
  // 30+ times in a video script about video, and with a single flat cap those
  // 30 pushed the one "caveat" — the finding nobody can see for themselves —
  // off the end of the list. Each word gets a few examples; the rule does the
  // rest, in the script and in the prompt.
  const perWord = new Map<string, number>();
  for (const s of sentences) {
    for (const m of s.matchAll(bannedRe)) {
      const word = m[1].toLowerCase();
      const seenOfThis = perWord.get(word) ?? 0;
      if (seenOfThis >= MAX_PER_BANNED_WORD) continue;
      perWord.set(word, seenOfThis + 1);
      const at = m.index ?? 0;
      const snippet = s.slice(Math.max(0, at - 24), at + m[0].length + 24).trim();
      out.push(`"${word}" — …${snippet}…`);
    }
    if (/^picture\b/i.test(s)) out.push(`"Picture …" opener (use "Imagine …") — ${s.slice(0, 46)}…`);
    // A 1–3 word sentence ending in "?" reads as a clipped fragment.
    const w = wordsOf(s);
    if (s.endsWith("?") && w.length >= 1 && w.length <= 3 && !/^(and|so|but|or|now|what|why|how|who|where)\b/i.test(s)) {
      out.push(`clipped question "${s}" — lead with a connective ("And if …?")`);
    }
  }
  // Dedupe, cap.
  return [...new Set(out)].slice(0, MAX_BANNED_FINDINGS);
}

/** Examples reported for any one banned word, so no word crowds out the rest. */
const MAX_PER_BANNED_WORD = 6;
/** …and the ceiling on the whole report. */
const MAX_BANNED_FINDINGS = 60;

/**
 * AI-register phrasings that no human script in the reference set uses.
 *
 * Separate from BANNED_WORDS on purpose. That list is calibrated against Jake's
 * voice and currently fires MORE on his own scripts than on generated ones, so
 * it cannot be extended safely. This list is the opposite: every entry was
 * measured against all three exemplars AND two finished runs (16,516 words) and
 * appears ZERO times in any of them. It costs nothing today and catches the
 * register the model reaches for when it drifts away from the exemplars.
 *
 * Deliberately EXCLUDED after measuring, because they are Jake's voice and a ban
 * would edit him out:
 *   - em dashes            — he uses 10.7-20.0 per 1,000 words, MORE than the
 *                            generated scripts (6.6-11.4). They are his pause mark.
 *   - just / actually / honestly / simply / literally — 11.6 / 8.0 / 10.7 per
 *                            1,000 in his scripts vs 12.0 / 8.6 generated. No
 *                            separation, and his humour is built from them.
 *   - "let's dive in"      — the closer of his own canonical welcome line.
 *   - "unlock", "what if I told you", "in the world of" — each appears in a
 *                            script he wrote himself.
 *
 * Nothing goes in here that has not been checked against the exemplars first.
 */
export const AI_SLOP_PHRASES = [
  // Secret-insight framing and manufactured reveals.
  "what nobody tells you",
  "nobody talks about this",
  "what most people get wrong",
  "the part (?:everyone|nobody) misses",
  "here's the kicker",
  "here's where it gets (?:crazy|wild|interesting)",
  "the uncomfortable truth",
  "that's when it clicked",
  "plot twist",
  // Telling the viewer how to react instead of letting the fact land.
  "let that sink in",
  "that just doesn't happen",
  "that's just unheard of",
  // Written-essay filler. Fine in a blog post, wrong in something spoken.
  "it's worth noting",
  "it's important to note",
  "at the end of the day",
  "in today's world",
  "in the age of",
  "going forward",
  "with regard to",
  "in terms of",
  // Inflation: words that make a sentence sound bigger without saying more.
  "delve into",
  "paradigm shift",
  "game.?changer",
  "supercharges?",
  "this changes everything",
  "move the needle",
  "stands as a testament",
  "marks a pivotal",
  "ever.?evolving",
  "tapestry",
  "multifaceted",
  "meticulous(?:ly)?",
  "paramount",
  "transformative",
  "cutting.?edge",
  "utiliz(?:e|es|ed|ing)",
  "streamlin(?:e|es|ed|ing)",
  "leverag(?:e|es|ed|ing)",
  "facilitat(?:e|es|ed|ing)",
  "robust",
  // Consensus nobody sourced.
  "experts agree",
  "studies show",
  "industry reports suggest",
  "widely regarded as",
  // Endings that manufacture depth or just recap.
  "in conclusion",
  "the future isn't coming",
  // Performing analysis instead of giving the consequence.
  "underscor(?:e|es|ed|ing)",
  "showcas(?:e|es|ed|ing)",
];

/**
 * AI-register phrasings that survived into the finished script, with context.
 *
 * Curly apostrophes are normalised first — a model writes "it's worth noting"
 * with U+2019 about as often as with an ASCII quote, and a list written one way
 * would silently miss the other.
 */
export function findSlopPhrases(text: string): string[] {
  const norm = text.replace(/[\u2018\u2019]/g, "'");
  const re = new RegExp(`\\b(${AI_SLOP_PHRASES.join("|")})\\b`, "gi");
  const out: string[] = [];
  for (const s of splitSentences(norm)) {
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      const snippet = s.slice(Math.max(0, at - 24), at + m[0].length + 24).trim();
      out.push(`"${m[1].toLowerCase()}" — …${snippet}…`);
    }
  }
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

/**
 * Words in a channel name that are never the presenter — the descriptor half of
 * "Nate Herk | AI Automation", and the words any channel might carry.
 */
const CHANNEL_NOISE = new Set([
  "ai", "the", "and", "with", "for", "how", "to", "your", "you", "my", "our",
  "automation", "productivity", "tutorials", "tutorial", "tips", "academy",
  "channel", "media", "studio", "studios", "labs", "lab", "tech", "official",
  "guy", "guru", "school", "hq", "co", "inc", "team", "show", "podcast",
  "claude", "chatgpt", "openai", "anthropic", "gemini", "notion", "obsidian",
]);

/**
 * The presenters whose videos fed the workflow sheet, found in the script.
 *
 * A run said "that's the version Nate actually runs day to day". Nate Herk is
 * the channel behind two of its four source videos — never introduced to the
 * viewer, and a tell that the script is relaying someone else's tutorial rather
 * than speaking in Jake's voice. The source channels are already stored per
 * run, so this is an exact check rather than name detection.
 *
 * `protect` holds the topic and title: a channel token that is also part of the
 * subject ("Claude Tips" on a Claude video) must never be flagged.
 */
export function findSourceNames(script: string, channels: string[], protect = ""): string[] {
  const safe = new Set(
    protect
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean),
  );
  const hits = new Set<string>();
  for (const channel of channels) {
    // "Nate Herk | AI Automation" and "ICOR with Tom" — the presenter is in the
    // first segment; everything after a pipe or dash is the channel's descriptor.
    const head = channel.split(/[|\u2013\u2014-]/)[0];
    for (const word of head.split(/[^A-Za-z']+/).filter(Boolean)) {
      const lower = word.toLowerCase();
      if (word.length < 3) continue;
      if (CHANNEL_NOISE.has(lower) || safe.has(lower)) continue;
      // Only a capitalised word is a name; a lowercased one is a description.
      if (word[0] !== word[0].toUpperCase()) continue;
      if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(script)) {
        hits.add(word);
      }
    }
  }
  return [...hits];
}

/** The script without the prompts the viewer types (THE PROMPT: lines and the quoted prompts extractPrompts finds). */
export function stripPromptText(script: string): string {
  let out = script
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^[ \t]*(?:\**\s*)?THE PROMPT\b[^\n]*$/gim, " ");
  for (const p of extractPrompts(out)) {
    out = out.split(p.text).join(" ");
  }
  return out;
}

export function auditClaims(
  script: string,
  factSheet: string,
  brief = "",
  alsoScanForExperience = "",
  sponsorName = "",
  /** Channels of the tutorials that fed the workflow sheet. */
  sourceChannels: string[] = [],
  /** Topic + title: a channel word that is part of the subject is never a name. */
  protectWords = "",
  /**
   * More evidence for numbers: the UX Scout report and the screenshot sheet.
   * Without them a number the tool showed on screen today ("20% OFF" on the
   * generated ad) was "never established", and the claim-fix pass cut it from
   * the script — and from the prompt the viewer types (2026-10-02).
   */
  evidence = "",
): ClaimAudit {
  const sourceNames = findSourceNames(script, sourceChannels, protectWords);
  const experienceClaims = findExperienceClaims(
    `${alsoScanForExperience}\n${script}`,
    `${brief}\n${factSheet}`,
  );
  const excess = sponsorName ? excessSponsorPlugs(script, sponsorName) : [];
  const bannedWords = findBannedWords(script);
  const slopPhrases = findSlopPhrases(script);
  if (!factSheet.trim()) {
    return {
      unsupportedNumbers: [],
      fencedTopicsMentioned: [],
      experienceClaims,
      excessSponsorPlugs: excess,
      bannedWords,
      slopPhrases,
      sourceNames,
      numbersChecked: 0,
    };
  }

  // Timestamps are production markers, not claims. "Beat 4 (1:10–1:35)" would
  // otherwise contribute 1, 10, 1 and 35 to the audit and drown the real findings.
  // A prompt the viewer types is an example, not a claim: "20% off all whole
  // bean coffee" in the prompt is the sale Jake is inventing for the demo.
  const prose = stripPromptText(script)
    .replace(/\(?\b\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");

  const sheetNumbers = [...extractNumbers(`${factSheet}\n${evidence}`)];
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
    slopPhrases,
    sourceNames,
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
  /** What to call an edit that arrives without its own reason. */
  defaultReason = "brief adherence",
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
    const reason = typeof e.reason === "string" && e.reason.trim() ? e.reason.trim() : defaultReason;

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

// ── Recency ──────────────────────────────────────────────────────────────────

/**
 * The recency ladder, computed from the clock.
 *
 * "Prioritize information from the last 6 months" was already in the research
 * prompt and did nothing, because a model with no clock cannot tell whether a
 * page it just read is inside that window. Turning the window into named months
 * makes it checkable, and lets a search query be anchored to `thisMonth`.
 *
 * These are PREFERENCE anchors, not a cutoff. Older information stays usable —
 * sometimes it is all that exists — it simply loses to anything newer, and it
 * has to be spoken with its age attached. A hard cliff would be worse than the
 * problem it solves: it would throw away the only figure available and leave the
 * script silent about a price rather than honest about how old the price is.
 */
export interface DateWindows {
  /** "September 3, 2026" */
  today: string;
  /** "September 2026" — what a search query gets anchored to. */
  thisMonth: string;
  /** Three months back. Inside this window a fact needs no hedge. */
  recent: string;
  /** Twelve months back. Beyond it a fact is still usable, but its age gets said out loud. */
  oneYear: string;
}

export function dateWindows(now: Date = new Date()): DateWindows {
  const month = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
  const back = (months: number) => {
    // Day 1 first: subtracting a month from the 31st lands in the month after
    // the one we asked for, which would shift the anchor by a month.
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    d.setMonth(d.getMonth() - months);
    return d;
  };
  return {
    today: now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    thisMonth: month(now),
    recent: month(back(3)),
    oneYear: month(back(12)),
  };
}
