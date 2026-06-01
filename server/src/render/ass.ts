import type { SubtitleEvent, SubtitleStyle } from "./manifest.js";

/**
 * Generate an ASS subtitle file for viral, "popping" captions (the
 * YouTube-Shorts / Hormozi look): 2–3 word chunks, center-screen, big bold
 * text with a thick outline, the CURRENTLY-SPOKEN word highlighted in the
 * accent color and scaled up with a quick pop-in.
 *
 * Why ASS (libass) instead of stacked drawtext filters:
 *  - Each caption is a timed event, so captions never overlap (the drawtext
 *    approach layered every line and they bled into each other).
 *  - Native per-word styling + transform animation (\t) for the pop.
 *  - One filter regardless of caption count (drawtext added one filter each).
 */

/** #RRGGBB  ->  ASS &HBBGGRR (ASS is little-endian BGR, no alpha). */
function assColor(hex: string | null | undefined, fallback = "FFFFFF"): string {
  const v = (hex ?? "").replace("#", "").trim();
  const h = /^[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

/** seconds -> ASS time  H:MM:SS.cc */
function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Escape text for an ASS dialogue field. */
function assText(s: string): string {
  return s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

export interface AssOptions {
  width: number;
  height: number;
  style: SubtitleStyle;
  /** Shift a timeline time into the (possibly trimmed) output time. */
  shift: (t: number) => number;
  /** Output duration — events past this are dropped. */
  duration: number;
}

/**
 * Build the full .ass document. Returns null if there are no usable words.
 *
 * For each caption phrase we emit one Dialogue event PER WORD spanning that
 * word's spoken window; the phrase text stays put while the active word is
 * recolored + scaled. Consecutive word windows don't overlap, so captions are
 * always clean and in sync with the voice.
 */
export function buildAss(subtitles: SubtitleEvent[], opts: AssOptions): string | null {
  const { width, height, style, shift, duration } = opts;
  if (!subtitles || subtitles.length === 0) return null;

  const fontName = (style.fontFamily || "DejaVu Sans").replace(/\s+Bold$/i, "");
  const fontSize = style.fontSize || 72;
  const primary = assColor(style.lineColor, "FFFFFF");      // normal words
  const accent = assColor(style.wordColor, "FFD400");       // active word
  const outline = assColor(style.outlineColor, "000000");
  const outlineW = typeof style.outlineWidth === "number" ? style.outlineWidth : 8;
  const shadow = 2;
  const bold = -1; // -1 = true in ASS
  const italic = style.italic ? -1 : 0;
  // Alignment 5 = middle-center (numpad layout). MarginV is ignored for
  // vertical centering but we keep generous L/R margins so long lines wrap/fit.
  const marginLR = Math.round(width * 0.06);
  // Auto-fit: estimate rendered width per glyph so a big-font 3-word caption
  // shrinks to fit instead of clipping at the edges (matches the render guard).
  const maxTextWidth = width * 0.9;
  const estCharW = 0.62;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Pop,${fontName},${fontSize},${primary},${accent},${outline},&H64000000,${bold},${italic},0,0,100,100,0,0,1,${outlineW},${shadow},5,${marginLR},${marginLR},0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];

  for (const event of subtitles) {
    const words = (event.words ?? []).filter((w) => (w.text ?? "").trim().length > 0);
    if (words.length === 0) continue;
    const upper = style.allCaps;
    const rendered = words.map((w) => assText(upper ? w.text.toUpperCase() : w.text));

    // Shrink this caption's font if the full phrase would overflow the width
    // (the active word pops to 115%, so budget for that).
    const phraseLen = rendered.join(" ").length;
    const estWidth = phraseLen * fontSize * estCharW * 1.15 + outlineW * 2;
    const fitFontSize =
      estWidth > maxTextWidth
        ? Math.max(36, Math.floor(fontSize * (maxTextWidth / estWidth)))
        : fontSize;
    const sizeTag = fitFontSize !== fontSize ? `{\\fs${fitFontSize}}` : "";

    for (let j = 0; j < words.length; j++) {
      const wStart = shift(words[j].start);
      // Active until the next word starts (no gaps within a caption), clamped
      // to the caption end / next word.
      const wEnd =
        j + 1 < words.length
          ? shift(words[j + 1].start)
          : shift(event.end ?? words[j].end);
      if (wEnd <= wStart) continue;
      if (wStart >= duration) continue;
      const endClamped = Math.min(wEnd, duration);

      // Build the phrase: active word in accent + scaled with a quick pop;
      // other words in the primary color at normal scale.
      const parts = rendered.map((txt, k) => {
        if (k === j) {
          // pop: scale 80% -> 115% over 120ms, accent color
          return `{\\c${accent}\\fscx80\\fscy80\\t(0,120,\\fscx115\\fscy115)}${txt}{\\c${primary}\\fscx100\\fscy100}`;
        }
        return txt;
      });
      const line = sizeTag + parts.join(" ");
      events.push(
        `Dialogue: 0,${assTime(wStart)},${assTime(endClamped)},Pop,,0,0,0,,${line}`
      );
    }
  }

  if (events.length === 0) return null;
  return header.join("\n") + "\n" + events.join("\n") + "\n";
}
