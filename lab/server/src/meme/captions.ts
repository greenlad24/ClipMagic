/**
 * Server-side caption builder for the Meme/Sticker editor.
 *
 * Turns Groq's word-level timestamps into the viral 2–3-word SubtitleEvent
 * chunks the render path (render/ass.ts) already burns in. The short-form
 * creator builds these in the frontend (src/utils); the meme editor runs fully
 * server-side from raw transcription, so it needs its own small chunker — kept
 * deliberately simple and matching the established SubtitleEvent shape.
 *
 * Punctuation in a word ends a chunk early (a natural phrase boundary), so lines
 * break where the narrator pauses — the kinetic-caption feel.
 */
import type { SubtitleEvent } from "../render/manifest.js";
import type { TranscriptWord } from "../ai/transcribe.js";

/** Max words shown per caption chunk (viral 2–3 word cadence). */
const MAX_WORDS_PER_CHUNK = 3;
/** A gap longer than this between words forces a new chunk (a real pause). */
const PAUSE_GAP_SECONDS = 0.45;

function endsPhrase(word: string): boolean {
  return /[.!?,;:]$/.test(word.trim());
}

export function buildCaptionEvents(words: TranscriptWord[]): SubtitleEvent[] {
  const clean = words
    .map((w) => ({ ...w, word: (w.word ?? "").trim() }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (clean.length === 0) return [];

  const events: SubtitleEvent[] = [];
  let chunk: TranscriptWord[] = [];

  const flush = () => {
    if (chunk.length === 0) return;
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    events.push({
      start,
      end,
      words: chunk.map((w) => ({
        text: w.word,
        start: w.start,
        end: w.end,
        // The render highlights the active word per its template; emphasis here
        // marks none specially (the meme look leans on the sticker, not recolor).
        emphasis: false,
      })),
    });
    chunk = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const w = clean[i];
    const prev = chunk[chunk.length - 1];
    // Break on a real pause before adding this word to the current chunk.
    if (prev && w.start - prev.end > PAUSE_GAP_SECONDS) flush();
    chunk.push(w);
    if (chunk.length >= MAX_WORDS_PER_CHUNK || endsPhrase(w.word)) flush();
  }
  flush();

  return events;
}
