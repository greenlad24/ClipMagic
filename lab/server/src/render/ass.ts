import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SubtitleEvent, SubtitleStyle } from "./manifest.js";
import { config } from "../config.js";
import { cleanCaptionWord } from "./subtitleText.js";

/**
 * Generate an ASS subtitle file for the four approved viral caption styles.
 * All render center-screen, 2–3 words at a time, with the currently-spoken
 * word highlighted (karaoke). Two of the styles sit on an auto-sized rounded
 * box; two use a soft blurred drop shadow.
 *
 * ASS/libass (not stacked drawtext) so captions never overlap, support per-word
 * styling + animation, and use the bundled fonts via fontsdir.
 */

/** #RRGGBB -> ASS &H00BBGGRR */
function assColor(hex: string | null | undefined, fallback = "FFFFFF"): string {
  const v = (hex ?? "").replace("#", "").trim();
  const h = /^[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

function assText(s: string): string {
  return s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

/** Rounded-rect ASS drawing command centered at (cx,cy). */
function roundedRect(cx: number, cy: number, w: number, h: number, r: number): string {
  const hw = w / 2;
  const hh = h / 2;
  r = Math.max(0, Math.min(r, hh, hw));
  const x0 = Math.round(cx - hw);
  const y0 = Math.round(cy - hh);
  const x1 = Math.round(cx + hw);
  const y1 = Math.round(cy + hh);
  return (
    `m ${x0 + r} ${y0} l ${x1 - r} ${y0} b ${x1} ${y0} ${x1} ${y0} ${x1} ${y0 + r} ` +
    `l ${x1} ${y1 - r} b ${x1} ${y1} ${x1} ${y1} ${x1 - r} ${y1} ` +
    `l ${x0 + r} ${y1} b ${x0} ${y1} ${x0} ${y1} ${x0} ${y1 - r} ` +
    `l ${x0} ${y0 + r} b ${x0} ${y0} ${x0} ${y0} ${x0 + r} ${y0}`
  );
}

export interface AssOptions {
  width: number;
  height: number;
  style: SubtitleStyle;
  shift: (t: number) => number;
  duration: number;
  /**
   * Output-time windows (already shifted) where a promo/overlay video is on
   * screen. While a caption overlaps one of these, it's anchored BOTTOM-center
   * so it doesn't cover the promo footage; otherwise it stays centered.
   */
  overlayWindows?: Array<{ start: number; end: number }>;
  /**
   * Optional out-param: buildAss writes how many text measurements were served
   * from the memo cache (hits) vs computed via ffmpeg (misses). Each miss spawns
   * 2 ffmpeg processes, so hits are a direct compute/speed saving. Surfaced in
   * the Optimization Report's speed section.
   */
  measureStats?: { hits: number; misses: number };
}

/**
 * Per-render memo for measured text sizes. Each caption build spawns 2 ffmpeg
 * processes per measurement, and a typical video re-measures the SAME line-height
 * reference string once per event plus repeats phrases — so an unbounded video
 * could spawn 60-90 ffmpeg processes just to size captions. Memoizing on the
 * exact (text, font, size, italic, spacing) tuple collapses those duplicates to
 * one spawn each. The map is created fresh per buildAss() call so it never grows
 * across renders. ~30-90 spawns → ~5-15 per video.
 */
type MeasureCache = Map<string, { w: number; h: number }>;

/**
 * Measure the rendered ink size (px) of a single line at a given font/size by
 * rendering it to a transparent frame and cropping. Used to size the box and
 * fit text to the frame width. Falls back to a heuristic if ffmpeg fails.
 *
 * Results are memoized in `cache` (when provided) keyed by the full measurement
 * tuple so identical lines aren't re-rendered.
 */
async function measureText(
  text: string,
  fontFamily: string,
  fontSize: number,
  italic: boolean,
  letterSpacing: number,
  fontsDir: string,
  cache?: MeasureCache,
  stats?: { hits: number; misses: number },
): Promise<{ w: number; h: number }> {
  const key = cache
    ? `${fontFamily} ${fontSize} ${italic ? 1 : 0} ${letterSpacing} ${text}`
    : "";
  if (cache) {
    const hit = cache.get(key);
    if (hit) {
      if (stats) stats.hits += 1;
      return hit;
    }
  }
  if (stats) stats.misses += 1;
  const result = await measureTextUncached(text, fontFamily, fontSize, italic, letterSpacing, fontsDir);
  if (cache) cache.set(key, result);
  return result;
}

async function measureTextUncached(
  text: string,
  fontFamily: string,
  fontSize: number,
  italic: boolean,
  letterSpacing: number,
  fontsDir: string,
): Promise<{ w: number; h: number }> {
  const W = 4000;
  const H = 1000;
  const styleLine =
    `Style: M,${fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,` +
    `0,${italic ? -1 : 0},0,0,100,100,${letterSpacing},0,1,0,0,5,0,0,0,1`;
  const doc =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n` +
    `[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styleLine}\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    `Dialogue: 0,0:00:00.00,0:00:01.00,M,,0,0,0,,{\\pos(${W / 2},${H / 2})}${assText(text)}\n`;
  const tmp = path.join(config.tmpDir, `meas_${randomUUID()}.ass`);
  const png = path.join(config.tmpDir, `meas_${randomUUID()}.png`);
  fs.writeFileSync(tmp, doc, "utf8");
  const fdEsc = fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:");
  const assEsc = tmp.replace(/\\/g, "/").replace(/:/g, "\\:");
  try {
    // 1) Render the text to a black PNG.
    await new Promise<void>((resolve) => {
      const p = spawn(config.ffmpegPath, [
        "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`,
        "-vf", `ass=${assEsc}:fontsdir=${fdEsc}`,
        "-frames:v", "1", png, "-loglevel", "error",
      ]);
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    // 2) cropdetect (limit=0 = any non-black) over the static PNG, read metadata.
    const meta = await new Promise<string>((resolve) => {
      const p = spawn(config.ffmpegPath, [
        "-loop", "1", "-i", png,
        "-vf", "cropdetect=limit=0:round=2,metadata=print",
        "-frames:v", "2", "-f", "null", "-",
      ]);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", () => resolve(err));
      p.on("error", () => resolve(""));
    });
    const wm = meta.match(/cropdetect\.w=(\d+)/);
    const hm = meta.match(/cropdetect\.h=(\d+)/);
    if (wm && hm) {
      const w = parseInt(wm[1], 10);
      const h = parseInt(hm[1], 10);
      if (w > 0 && h > 0) return { w, h };
    }
  } catch {
    /* fall through */
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* */ }
    try { fs.rmSync(png, { force: true }); } catch { /* */ }
  }
  // Heuristic fallback
  return { w: Math.round(text.length * fontSize * 0.6), h: Math.round(fontSize * 0.75) };
}

/**
 * Build the .ass document. Async because box styles measure the rendered text
 * to size the box precisely. Returns null if there are no usable words.
 */
export async function buildAss(subtitles: SubtitleEvent[], opts: AssOptions): Promise<string | null> {
  const { width, height, style, shift, duration } = opts;
  if (!subtitles || subtitles.length === 0) return null;

  const fontsDir = path.dirname(config.fontFile);
  const baseFont = style.fontFamily || "DejaVu Sans";
  const emphFont = style.emphasisFontFamily || baseFont;
  const fontSize = style.fontSize || 80;
  const primary = assColor(style.lineColor, "FFFFFF");
  const accent = assColor(style.wordColor, "FFFFFF");
  const italic = style.italic ? -1 : 0;
  const ls = typeof style.letterSpacing === "number" ? style.letterSpacing : 0;
  const cx = Math.round(width / 2);
  const cyCenter = Math.round(height / 2);
  const cyBottom = Math.round(height * 0.80); // bottom-center band when a promo plays
  const maxTextWidth = width * 0.9;
  const overlayWindows = opts.overlayWindows ?? [];
  // Memoize text measurements for the lifetime of THIS document build so the
  // same phrase / line-height reference isn't re-rendered through ffmpeg.
  const measureCache: MeasureCache = new Map();
  const measureStats = { hits: 0, misses: 0 };

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
    // Main text style (BorderStyle 1, no outline/shadow — we add shadow as a layer).
    `Style: Txt,${baseFont},${fontSize},${primary},${primary},&H00000000,&H00000000,0,${italic},0,0,100,100,${ls},0,1,0,0,5,40,40,0,1`,
    // Box drawing style.
    `Style: Box,${baseFont},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    // Shadow style (blurred black copy).
    `Style: Shad,${baseFont},${fontSize},&H40000000,&H40000000,&H40000000,&H40000000,0,${italic},0,0,100,100,${ls},0,1,0,0,5,40,40,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];

  // A short gap + fade between consecutive captions so two captions NEVER share
  // a moment on screen (the cause of the overlap bug). Each caption ends 0.1s
  // before the next one starts, and fades out over that 0.1s.
  const GAP = 0.1;
  const FADE_MS = 100;

  for (let ei = 0; ei < subtitles.length; ei++) {
    const event = subtitles[ei];
    const words = (event.words ?? []).filter((w) => (w.text ?? "").trim().length > 0);
    if (words.length === 0) continue;
    // Brand-safe by default: mask profanity in the BURNED-IN text (audio is
    // untouched). Disable per-style with maskProfanity:false.
    const mask = style.maskProfanity !== false;
    const rendered = words.map((w) => {
      const cleaned = cleanCaptionWord(w.text, mask);
      return assText(style.allCaps ? cleaned.toUpperCase() : cleaned);
    });
    const phrase = rendered.join(" ");

    // Fit font to width (and measure for the box). Account for the emphasis
    // word being a heavier face (slightly wider).
    let fs = fontSize;
    const measured = await measureText(phrase, emphFont, fs, !!style.italic, ls, fontsDir, measureCache, measureStats);
    // The active word is enlarged by popScale at render time (line ~329), which
    // widens the centered line. Fit against that worst case (widest word popped)
    // so a popped emphasis word never overflows the frame and gets clipped into
    // orphaned letters at the edges.
    let effectiveW = measured.w;
    if (style.highlightWord && style.popScale && style.popScale > 1 && rendered.length > 0) {
      const longest = rendered.reduce((a, b) => (b.length > a.length ? b : a), "");
      const longestW = (await measureText(longest, emphFont, fs, !!style.italic, ls, fontsDir, measureCache, measureStats)).w;
      effectiveW = measured.w + longestW * (style.popScale - 1);
    }
    if (effectiveW > maxTextWidth) {
      fs = Math.max(40, Math.floor(fs * (maxTextWidth / effectiveW)));
    }
    // Re-measure ink height at the fitted size for accurate box sizing.
    const ink = await measureText(phrase, emphFont, fs, !!style.italic, ls, fontsDir, measureCache, measureStats);

    const startAll = shift(event.start ?? words[0].start);
    if (startAll >= duration) continue;

    // Hard cap this caption's end so it never reaches into the next caption.
    const rawEnd = shift(event.end ?? words[words.length - 1].end);
    const nextEv = subtitles[ei + 1];
    const nextStart =
      nextEv && nextEv.words && nextEv.words.length
        ? shift(nextEv.start ?? nextEv.words[0].start)
        : Infinity;
    // Reading-speed floor: a viral caption that flashes for a few frames is
    // unreadable. Guarantee enough dwell to read the phrase at ~17 CPS (the
    // broadcast/Netflix standard), with a hard 0.5s floor — but never push past
    // the next caption's start (the no-overlap rule still wins).
    const READ_CPS = 17;
    const ceiling = nextStart === Infinity ? duration : nextStart - GAP;
    const readSeconds = Math.max(0.5, phrase.replace(/\s/g, "").length / READ_CPS);
    const desiredEnd = Math.max(rawEnd, startAll + readSeconds);
    const captionEnd = Math.max(
      startAll + 0.05,
      Math.min(desiredEnd, duration, ceiling),
    );
    const fadeTag = `\\fad(0,${FADE_MS})`;

    // Position: bottom-center while a promo/overlay is on screen (so captions
    // don't cover the footage); otherwise middle-center. \an5 = mid-center,
    // \an2-style bottom we emulate with \an5 at a lower Y so the box math (which
    // centers on cy) keeps working.
    // Move a caption to the bottom only when the promo is ALREADY on screen as
    // the caption appears — not for a caption that started before the promo.
    const promo = overlayWindows.some((w) => startAll >= w.start && startAll < w.end);
    const anchor = 5;
    const cy = promo ? cyBottom : cyCenter;

    // ── Box layer (auto-sized) ──
    if (style.box) {
      const fill = style.boxFill ?? 0.82;
      // Use a CONSISTENT line height (ascenders+descenders) so the box doesn't
      // collapse for lowercase-only phrases. Measure a reference once per fit.
      const lineRef = await measureText("Abdfghjpqy", emphFont, fs, !!style.italic, ls, fontsDir, measureCache, measureStats);
      const lineH = Math.max(ink.h, lineRef.h);
      const boxH = lineH / fill;
      const pad = (boxH - lineH) / 2; // equal padding all sides
      const boxW = ink.w + 2 * pad;
      const radius = Math.min(style.boxRadius ?? 60, boxH / 2);
      const boxColor = assColor(style.boxColor, "000000");
      events.push(
        `Dialogue: 0,${assTime(startAll)},${assTime(captionEnd)},Box,,0,0,0,,` +
          `{\\pos(0,0)${fadeTag}\\1c${boxColor}\\bord0\\shad0\\p1}${roundedRect(cx, cy, boxW, boxH, radius)}{\\p0}`
      );
    }

    // Static phrase (no per-word color, no size animation) for the base text.
    const staticPhrase = rendered.map((txt) => `{\\fn${baseFont}\\fs${fs}\\c${primary}}${txt}`).join(" ");

    if (style.highlightWord) {
      // ── Styles 1 & 2: recolor the active word as it's spoken (NO size
      // animation). One event per word, clamped so captions never overlap. ──
      for (let j = 0; j < words.length; j++) {
        const wStart = shift(words[j].start);
        const wEndRaw = j + 1 < words.length ? shift(words[j + 1].start) : rawEnd;
        const wEnd = Math.min(wEndRaw, captionEnd);
        if (wEnd <= wStart || wStart >= duration) continue;
        const fade = j === words.length - 1 ? fadeTag : "";

        // Optional active-word size "pop" (e.g. +18%) for a kinetic karaoke bump.
        const activeFs = style.popScale && style.popScale > 1 ? Math.round(fs * style.popScale) : fs;
        const parts = rendered.map((txt, k) => {
          const isActive = k === j;
          const fnt = isActive ? emphFont : baseFont;
          const col = isActive ? accent : primary;
          const sz = isActive ? activeFs : fs;
          return `{\\fn${fnt}\\fs${sz}\\c${col}}${txt}`;
        });
        const text = `{\\an${anchor}\\pos(${cx},${cy})${fade}}` + parts.join(" ");

        if (style.shadow && !style.box) {
          const shadowText = rendered
            .map((txt, k) => `{\\fn${k === j ? emphFont : baseFont}\\fs${fs}}${txt}`)
            .join(" ");
          events.push(
            `Dialogue: 0,${assTime(wStart)},${assTime(wEnd)},Shad,,0,0,0,,` +
              `{\\an${anchor}\\pos(${cx - 2},${cy + 5})${fade}\\1c&H000000&\\blur15}${shadowText}`
          );
        }
        events.push(`Dialogue: 1,${assTime(wStart)},${assTime(wEnd)},Txt,,0,0,0,,${text}`);
      }
    } else {
      // ── Styles 3 & 4: fully static caption — no highlight, no animation. ──
      const wStart = startAll;
      const wEnd = captionEnd;
      if (wEnd > wStart && wStart < duration) {
        if (style.shadow && !style.box) {
          events.push(
            `Dialogue: 0,${assTime(wStart)},${assTime(wEnd)},Shad,,0,0,0,,` +
              `{\\an${anchor}\\pos(${cx - 2},${cy + 5})${fadeTag}\\1c&H000000&\\blur15}${rendered.map((t) => `{\\fn${baseFont}\\fs${fs}}${t}`).join(" ")}`
          );
        }
        events.push(
          `Dialogue: 1,${assTime(wStart)},${assTime(wEnd)},Txt,,0,0,0,,` +
            `{\\an${anchor}\\pos(${cx},${cy})${fadeTag}}${staticPhrase}`
        );
      }
    }
  }

  if (opts.measureStats) {
    opts.measureStats.hits = measureStats.hits;
    opts.measureStats.misses = measureStats.misses;
  }
  if (events.length === 0) return null;
  return header.join("\n") + "\n" + events.join("\n") + "\n";
}
