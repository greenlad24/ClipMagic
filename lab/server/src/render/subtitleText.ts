/**
 * Subtitle text hygiene — shared by the ASS renderer and the drawtext fallback.
 *
 * Two concerns the raw Whisper output gets wrong for burned-in viral captions:
 *   1. Profanity. The transcript faithfully includes swear words; on-screen they
 *      make captions un-brand-safe (and risk demonetization on most platforms).
 *      We MASK the visible text (e.g. "f***") while the audio is untouched.
 *   2. Casing / spacing artifacts. Word-level ASR sometimes yields stray double
 *      spaces, a lone dangling letter, or a trailing comma on a 2-3 word chunk
 *      that reads awkwardly as a viral caption. We tidy those.
 *
 * Everything here is pure + deterministic so it can be unit-checked, and it only
 * touches DISPLAY text — timings and the audio track are never affected.
 */

/**
 * Common English profanity stems. We match the punctuation-stripped, lowercased
 * token and mask all but the first letter, preserving length so the caption keeps
 * its rhythm ("shit" -> "s***"). Kept intentionally small + conservative: only
 * unambiguous profanity, so real words ("class", "assist") are never masked
 * (we match whole tokens / known leetless stems, not substrings).
 */
const PROFANITY = new Set([
  "fuck", "fucks", "fucked", "fucking", "fucker", "fuckers", "motherfucker", "motherfuckers",
  "shit", "shits", "shitty", "bullshit", "shat",
  "bitch", "bitches", "bitching",
  "asshole", "assholes", "dumbass", "jackass",
  "dick", "dickhead", "cock",
  "cunt", "twat",
  "bastard", "bastards",
  "pussy",
  "wanker", "bollocks",
]);

/** Strip surrounding punctuation, keep inner apostrophes/hyphens for matching. */
function coreToken(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Mask a single token if it's profane, preserving leading punctuation, capital
 * pattern of the first letter, and trailing punctuation. "Fucking!" -> "F******!"
 */
export function maskProfaneWord(word: string): string {
  const core = coreToken(word);
  if (!core || !PROFANITY.has(core)) return word;
  // Find the core's span inside the original token so we keep edge punctuation.
  const lower = word.toLowerCase();
  const idx = lower.indexOf(core);
  if (idx < 0) return word;
  const before = word.slice(0, idx);
  const matched = word.slice(idx, idx + core.length);
  const after = word.slice(idx + core.length);
  const masked = matched[0] + "*".repeat(Math.max(1, matched.length - 1));
  return before + masked + after;
}

/**
 * Apply display hygiene to one caption word: optional profanity mask + trim.
 * `maskProfanity` defaults to true (brand-safe captions); callers can disable it.
 */
export function cleanCaptionWord(word: string, maskProfanity = true): string {
  let w = (word ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (maskProfanity) w = maskProfaneWord(w);
  return w;
}

/**
 * Tidy a full rendered caption phrase: collapse repeated spaces and drop a
 * trailing comma/semicolon that dangles awkwardly at the end of a short viral
 * chunk (the next chunk continues the sentence, so the comma adds nothing).
 */
export function cleanCaptionPhrase(phrase: string): string {
  return phrase
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1") // no space before punctuation
    .replace(/[,;:]\s*$/, "")         // drop a dangling trailing clause comma
    .trim();
}
