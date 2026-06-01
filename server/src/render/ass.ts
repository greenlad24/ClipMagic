import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SubtitleEvent, SubtitleStyle } from "./manifest.js";
import { config } from "../config.js";

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
}

/**
 * Measure the rendered ink size (px) of a single line at a given font/size by
 * rendering it to a transparent frame and cropping. Used to size the box and
 * fit text to the frame width. Falls back to a heuristic if ffmpeg fails.
 */
async function measureText(
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
  const cy = Math.round(height / 2);
  const maxTextWidth = width * 0.9;

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

  for (const event of subtitles) {
    const words = (event.words ?? []).filter((w) => (w.text ?? "").trim().length > 0);
    if (words.length === 0) continue;
    const rendered = words.map((w) => assText(style.allCaps ? w.text.toUpperCase() : w.text));
    const phrase = rendered.join(" ");

    // Fit font to width (and measure for the box). Account for the emphasis
    // word being a heavier face (slightly wider).
    let fs = fontSize;
    const measured = await measureText(phrase, emphFont, fs, !!style.italic, ls, fontsDir);
    if (measured.w > maxTextWidth) {
      fs = Math.max(40, Math.floor(fs * (maxTextWidth / measured.w)));
    }
    // Re-measure ink height at the fitted size for accurate box sizing.
    const ink = await measureText(phrase, emphFont, fs, !!style.italic, ls, fontsDir);

    const startAll = shift(event.start ?? words[0].start);
    if (startAll >= duration) continue;

    // ── Box layer (auto-sized) ──
    if (style.box) {
      const fill = style.boxFill ?? 0.82;
      // Use a CONSISTENT line height (ascenders+descenders) so the box doesn't
      // collapse for lowercase-only phrases. Measure a reference once per fit.
      const lineRef = await measureText("Abdfghjpqy", emphFont, fs, !!style.italic, ls, fontsDir);
      const lineH = Math.max(ink.h, lineRef.h);
      const boxH = lineH / fill;
      const pad = (boxH - lineH) / 2; // equal padding all sides
      const boxW = ink.w + 2 * pad;
      const radius = Math.min(style.boxRadius ?? 60, boxH / 2);
      const boxColor = assColor(style.boxColor, "000000");
      const endAll = Math.min(shift(event.end ?? words[words.length - 1].end), duration);
      events.push(
        `Dialogue: 0,${assTime(startAll)},${assTime(endAll)},Box,,0,0,0,,` +
          `{\\pos(0,0)\\1c${boxColor}\\bord0\\shad0\\p1}${roundedRect(cx, cy, boxW, boxH, radius)}{\\p0}`
      );
    }

    // ── Per-word karaoke events ──
    for (let j = 0; j < words.length; j++) {
      const wStart = shift(words[j].start);
      const wEnd =
        j + 1 < words.length ? shift(words[j + 1].start) : shift(event.end ?? words[j].end);
      if (wEnd <= wStart || wStart >= duration) continue;
      const endClamped = Math.min(wEnd, duration);

      const parts = rendered.map((txt, k) => {
        const isActive = k === j;
        const fnt = isActive ? emphFont : baseFont;
        const col = isActive ? accent : primary;
        // Active word: heavier font + accent color + a quick pop (scale 88->108).
        if (isActive) {
          return `{\\fn${fnt}\\fs${fs}\\c${col}\\fscx88\\fscy88\\t(0,110,\\fscx108\\fscy108)}${txt}{\\fn${baseFont}\\c${primary}\\fscx100\\fscy100}`;
        }
        return `{\\fn${fnt}\\fs${fs}\\c${col}}${txt}`;
      });
      const text = `{\\an5\\pos(${cx},${cy})}` + parts.join(" ");

      // Soft shadow layer (no box styles) — a blurred black copy behind.
      if (style.shadow && !style.box) {
        const shadowText = rendered
          .map((txt, k) => `{\\fn${k === j ? emphFont : baseFont}\\fs${fs}}${txt}`)
          .join(" ");
        events.push(
          `Dialogue: 0,${assTime(wStart)},${assTime(endClamped)},Shad,,0,0,0,,` +
            `{\\an5\\pos(${cx - 2},${cy + 5})\\1c&H000000&\\blur15}${shadowText}`
        );
      }
      events.push(`Dialogue: 1,${assTime(wStart)},${assTime(endClamped)},Txt,,0,0,0,,${text}`);
    }
  }

  if (events.length === 0) return null;
  return header.join("\n") + "\n" + events.join("\n") + "\n";
}
