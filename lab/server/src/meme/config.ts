/**
 * Tunable constants for the Meme/Sticker editor — collected here so the
 * meme-only knobs (bigger subtitles, the quiet music bed, the sticker SFX level)
 * are named, documented, and unit-testable in one place rather than sprinkled as
 * magic numbers across the pipeline. None of these touch the short-form editor.
 */
import type { SubtitleStyle } from "../render/manifest.js";

/**
 * Caption font-size multiplier for the meme editor ONLY. The short-form editor
 * keeps the base template sizes (96–108px); the meme editor reads bigger/bolder
 * so the commentary captions dominate the frame. 1.3× lands the largest template
 * (yellow-box 108px → 140px) comfortably inside the 9:16 safe width — and ass.ts
 * still auto-fits any line that would otherwise overflow, so it can never clip.
 */
export const MEME_SUBTITLE_FONT_SCALE = 1.3;

/**
 * Linear gain for the random background-music bed in the final mix. Deliberately
 * VERY quiet (0.03) so the narration stays clearly dominant — it's a bed, not a
 * track. Mixed via amix with normalize=0 so this exact gain is preserved.
 */
export const MEME_MUSIC_VOLUME = 0.03;

/**
 * Linear gain for the per-sticker pop SFX in the final mix. Audible punctuation
 * on each sticker entrance, but well under the narration so it never competes
 * with the voice.
 */
export const MEME_SFX_VOLUME = 0.35;

/**
 * Return a copy of a subtitle style with the meme font-size bump applied. Pure +
 * deterministic so the bump is unit-testable and never mutates the shared
 * SUBTITLE_TEMPLATES map. Rounds to a whole pixel (ASS/libass wants integers).
 */
export function memeSubtitleStyle(style: SubtitleStyle): SubtitleStyle {
  return { ...style, fontSize: Math.round(style.fontSize * MEME_SUBTITLE_FONT_SCALE) };
}
