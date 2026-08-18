/**
 * Die-cut cut-out for GENERATED sticker images.
 *
 * WHY THIS EXISTS: the cheap generator we now use — GPT Image 2 via Segmind —
 * **does not support a transparent background**. Asking for one is a hard 400
 * ("Transparent background is not supported for this model"), verified against
 * the live API. The old OpenAI gpt-image-1 path got alpha for free via
 * `background:"transparent"`; the cheaper model cannot, so we make our own.
 *
 * THE TECHNIQUE: ask the model for a flat CHROMA-GREEN background (see
 * `GREEN_SCREEN_PROMPT`), then key that green out locally with ffmpeg
 * (`chromakey` + `despill`) into an RGBA PNG. Flat cartoon sticker art on a flat
 * green field keys almost perfectly — verified on a real generation, no fringe.
 * The keying is FREE (local ffmpeg), so the cut-out costs nothing on top of the
 * already-6× cheaper image.
 *
 * THE SAFETY VALVE: a key is destructive if the model ignored the instruction.
 * So we never key blind — we SAMPLE the four corners first and only key when
 * they agree with each other AND are genuinely green (`looksLikeGreenScreen`).
 * A model that returned a white studio background, or a subject bleeding to the
 * edges, fails that test and we keep the opaque image untouched: a slightly less
 * die-cut sticker beats a sticker with its face keyed out.
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { config } from "../config.js";

/**
 * Appended to every GENERATED sticker prompt so the image arrives on a flat
 * keyable field. Explicit about the two things that break a key: gradients /
 * shadows in the background, and green ON the subject.
 */
export const GREEN_SCREEN_PROMPT =
  "The ENTIRE background must be one flat, solid, pure chroma green (#00FF00) — " +
  "completely uniform, with NO gradient, NO shadow, NO texture, and NO vignette. " +
  "The subject must fill most of the frame, must NOT touch the frame edges, and " +
  "must contain NO green anywhere on itself.";

/** An RGB triple sampled from the image. */
export type Rgb = [number, number, number];

/**
 * Decide whether an image really is a flat green-screen we may key out.
 *
 * PURE (no I/O) so the guard — the thing standing between a good sticker and a
 * keyed-out face — is unit-testable. Two conditions, both required:
 *   1. GREEN: every corner is green-dominant (a strong green channel that
 *      clearly beats both red and blue). A white/grey/black background fails.
 *   2. UNIFORM: the corners agree with each other within `tolerance` per
 *      channel. A gradient, a busy background, or a subject that runs off the
 *      edge makes the corners disagree, and we decline to key.
 */
export function looksLikeGreenScreen(corners: Rgb[], tolerance = 42): boolean {
  if (corners.length < 4) return false;
  for (const [r, g, b] of corners) {
    if (g < 110) return false; // not a bright green field
    if (g < r * 1.6 || g < b * 1.6) return false; // not green-DOMINANT
  }
  // Uniformity: spread across the corners must stay inside the tolerance.
  for (let ch = 0; ch < 3; ch++) {
    const vals = corners.map((c) => c[ch]);
    if (Math.max(...vals) - Math.min(...vals) > tolerance) return false;
  }
  return true;
}

/** Average an RGB set into the single colour we hand to `chromakey`. */
export function averageRgb(colors: Rgb[]): Rgb {
  const n = Math.max(1, colors.length);
  const sum = colors.reduce<Rgb>(
    (acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]],
    [0, 0, 0],
  );
  return [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)];
}

/** Format an RGB triple as the `0xRRGGBB` literal ffmpeg's chromakey wants. */
export function toFfmpegHex([r, g, b]: Rgb): string {
  const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `0x${hex(r)}${hex(g)}${hex(b)}`;
}

/** Spawn ffmpeg and resolve its raw stdout bytes (used for pixel sampling). */
function ffmpegStdout(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)),
    );
  });
}

/** Spawn ffmpeg for its side effect (writing a file); resolve on exit 0. */
function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${tail}`)),
    );
  });
}

/** The sample grid side — the image is scaled to N×N and the corners read off. */
const SAMPLE_N = 32;

/**
 * Read the four corner colours of an image. Scaling to 32×32 first averages away
 * JPEG-ish noise and makes the read one tiny raw buffer instead of a full decode.
 */
export async function sampleCorners(file: string): Promise<Rgb[] | null> {
  try {
    const raw = await ffmpegStdout([
      "-v", "error",
      "-i", file,
      "-vf", `scale=${SAMPLE_N}:${SAMPLE_N},format=rgb24`,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-",
    ]);
    const need = SAMPLE_N * SAMPLE_N * 3;
    if (raw.length < need) return null;
    const at = (x: number, y: number): Rgb => {
      const i = (y * SAMPLE_N + x) * 3;
      return [raw[i], raw[i + 1], raw[i + 2]];
    };
    // One pixel in from each edge — the very edge row can carry encoder ringing.
    const e = 1;
    const f = SAMPLE_N - 2;
    return [at(e, e), at(f, e), at(e, f), at(f, f)];
  } catch {
    return null;
  }
}

/**
 * Turn a green-screen still into a transparent die-cut PNG, IN PLACE-safe (it
 * writes a sibling file and returns its path).
 *
 * Returns the ORIGINAL path unchanged whenever keying is unsafe or fails — the
 * caller always gets a usable image, never a broken one. `keyed` tells the
 * caller which happened, purely so it can be logged.
 */
export async function cutOutGreenScreen(
  file: string,
): Promise<{ file: string; keyed: boolean; reason: string }> {
  const corners = await sampleCorners(file);
  if (!corners) return { file, keyed: false, reason: "could not sample the background" };
  if (!looksLikeGreenScreen(corners)) {
    return { file, keyed: false, reason: "background is not a flat green screen — left opaque" };
  }

  const key = toFfmpegHex(averageRgb(corners));
  const out = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}_cut.png`);
  try {
    await ffmpegRun([
      "-y", "-v", "error",
      "-i", file,
      // similarity 0.30 / blend 0.08 clears the field and keeps a soft edge;
      // despill removes the green light that bounces onto the subject's outline.
      "-vf", `chromakey=${key}:0.30:0.08,despill=type=green:mix=0.5:expand=0,format=rgba`,
      "-frames:v", "1",
      out,
    ]);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      return { file, keyed: false, reason: "key produced no image — left opaque" };
    }
    return { file: out, keyed: true, reason: `keyed ${key}` };
  } catch (e) {
    return {
      file,
      keyed: false,
      reason: `key failed (${e instanceof Error ? e.message : String(e)}) — left opaque`,
    };
  }
}
