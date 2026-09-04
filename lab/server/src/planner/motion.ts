/**
 * "Generate Motion Graphics" — turning a finished plan's graphic slots into
 * actual full-screen motion graphics.
 *
 * THE SHAPE OF THE PROBLEM, measured off real plans rather than assumed: a
 * planned video is ~55 lines, of which 19–25 are graphic slots, and most of
 * those run 2–4 seconds. So this is twenty-odd short full-screen cards per
 * video, not a handful of hero pieces — which is what makes consistency the
 * whole game and cost worth watching.
 *
 * WHY ONLY THE TEXT KINDS. Higgsfield's output is opaque video: there is no
 * alpha channel anywhere in its API. A generated clip can therefore REPLACE a
 * frame but can never sit over Jake's own footage. `text_gradient` and
 * `text_whiteboard` are exactly the slots that already mean "cut away to a
 * full-screen card", so they map onto that constraint without compromise.
 * screencast / talking_head / stock_footage keep their real footage.
 *
 * WHY A STYLE REFERENCE AND NOT A STYLE DESCRIPTION. Twenty cards described by
 * the same adjectives still come back as twenty different worlds. The one lever
 * that actually holds a look together is `input_images` on the image model. So
 * the flow is: generate a few SAMPLES of one real card, Jake picks the one
 * that is right, and that still becomes the reference every other card is
 * generated against. It is also how this ships without the style-guide PDF —
 * an approved frame is a more precise spec than a written one, and he approves
 * the look before the run spends anything on the other nineteen.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GraphicSlot, PlanLine } from "./types.js";
import { animateStill, downloadAsset, generateStill } from "./higgsfield.js";
import { PLANNER_DIR } from "./ingest.js";

/** The plan kinds that mean "full-screen graphic", and so can be generated. */
const GRAPHIC_KINDS = new Set(["text_gradient", "text_whiteboard"]);

/**
 * How many stills the sample round generates. Three is enough to show what the
 * style base actually produces without spending the price of a fourth on a
 * decision Jake makes from the first two anyway.
 */
export const SAMPLE_COUNT = 3;

/**
 * Which slot to sample the style on: the LONGEST card in the plan.
 *
 * The reference still has to be judged on a real card, and the longest one
 * carries the most text — a headline that only fits at all on the roomiest
 * slot would look approved and then start cropping on card nineteen. Ties go
 * to the earlier slot so the choice is stable across calls.
 */
export function pickSampleSlot(slots: GraphicSlot[]): GraphicSlot | null {
  let best: GraphicSlot | null = null;
  for (const s of slots) {
    if (!best || s.text.length > best.text.length) best = s;
  }
  return best;
}

export type { GraphicSlot };

/**
 * The quote characters a plan can actually arrive with, written as escapes
 * rather than as literal glyphs.
 *
 * ⚠️ These were literal curly quotes once, and at some point the file was
 * rewritten with the curly ones flattened to ASCII — leaving `/["""]/`, which
 * is just `/["]/` with two characters of dead weight and reads as if it still
 * handles both. A plan whose title came back in typographic quotes (the model
 * writes them often) then fell through to the colon split and kept the quote
 * marks, so the card was generated with them printed on it. Escapes cannot
 * degrade invisibly like that.
 */
const CURLY = "\u201C\u201D";
const QUOTED = new RegExp(`["${CURLY}]([^"${CURLY}]+)["${CURLY}]`);
const EDGE_QUOTES = new RegExp(`^["${CURLY}\u2018\u2019]|["${CURLY}\u2018\u2019]$`, "g");

/**
 * Pull the card's own words out of a plan instruction.
 *
 * The planner writes these as `Text (gradient): "Teach it once, it remembers
 * forever"`, so the quoted part is the copy and everything before it is the
 * element name. Falling back to the whole instruction is deliberate: a slot
 * whose quoting drifted should still generate something, rather than silently
 * producing a card with no words on it.
 */
export function cardText(instruction: string): string {
  const quoted = instruction.match(QUOTED);
  if (quoted) return quoted[1].trim();
  const afterColon = instruction.split(":").slice(1).join(":").trim();
  return (afterColon || instruction).replace(EDGE_QUOTES, "").trim();
}

/** Every slot in a plan that can become a generated graphic, in plan order. */
export function graphicSlots(lines: PlanLine[]): GraphicSlot[] {
  return lines
    .map((l, index) => ({ l, index }))
    .filter(({ l }) => GRAPHIC_KINDS.has(l.kind))
    .map(({ l, index }) => ({
      index,
      start: l.start,
      end: l.end,
      kind: l.kind,
      text: cardText(l.instruction),
      durationSec: +(l.end - l.start).toFixed(2),
    }));
}

/**
 * The visual world, in words. This is the FALLBACK: it only does real work on
 * the sample round, because once a sample is approved the reference image
 * carries the look and this drops back to describing the composition.
 *
 * Written from frames of the reference style rather than from memory: deep
 * violet gradient ground with smoky nebula texture, thin glowing outlines,
 * pill-shaped labels, generous margins, one idea per card.
 */
export const STYLE_BASE = [
  "A full-screen 16:9 motion-graphic title card for a premium YouTube tutorial.",
  "Deep violet-to-indigo gradient background with soft smoky nebula texture and subtle grain.",
  "Typography is the subject: a single short headline, centred, large, clean geometric sans-serif,",
  "bright white with a faint purple glow, generous margins, nothing cropped.",
  "Thin glowing purple outlines and pill-shaped lozenge accents where a shape is needed.",
  "No people, no logos, no watermark, no UI chrome, no borders, no extra words beyond the headline.",
].join(" ");

/** What the still must render, given the card's copy. */
export function stillPrompt(text: string, styleExtra?: string): string {
  return [
    STYLE_BASE,
    styleExtra?.trim() ? styleExtra.trim() : "",
    `The headline reads exactly: "${text}".`,
    "Spell it exactly as written, with correct spacing and no additional text anywhere in the frame.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * What the animation may move. Deliberately narrow: the still is already
 * correct, so the video model's job is atmosphere, not authorship. Anything
 * that invites it to re-render the lettering risks the one thing the two-step
 * pipeline exists to protect.
 */
export function motionPrompt(): string {
  return [
    "Hold the composition exactly as it is. The text stays perfectly still, sharp and unchanged.",
    "Only the background moves: the nebula drifts slowly, the glow breathes, a very slow push in.",
    "No cuts, no camera shake, no new elements, no text changes.",
  ].join(" ");
}

export const MOTION_NEGATIVE =
  "text changing, misspelled text, extra text, warping letters, new objects, people, logos, watermark, cuts, fast motion";

/** Kling renders 5s or 10s only; pick the shorter one that covers the slot. */
export function motionDuration(slotSeconds: number): 5 | 10 {
  return slotSeconds > 5 ? 10 : 5;
}

/** Where a run's generated assets live. */
export function motionDir(runId: string): string {
  return path.join(PLANNER_DIR, runId, "motion");
}

export interface GeneratedGraphic {
  index: number;
  start: number;
  end: number;
  text: string;
  /** Higgsfield's hosted still, reusable as a style reference. */
  stillUrl: string;
  videoUrl: string;
  /** Local file, relative to the run's motion directory. */
  file: string;
  durationSec: number;
}

/**
 * Generate ONE card, still then motion. Kept separate from any loop so the
 * sample round, a single retry, and the full run are all the same code path.
 */
export async function generateGraphic(opts: {
  runId: string;
  slot: GraphicSlot;
  /** Approved style still(s). Empty on the sample round. */
  referenceImages?: string[];
  styleExtra?: string;
  /** Sample rounds want the still only — animating an unapproved look is waste. */
  stillOnly?: boolean;
  fileStem?: string;
}): Promise<GeneratedGraphic> {
  const { runId, slot } = opts;
  const dir = motionDir(runId);
  await mkdir(dir, { recursive: true });

  const stillUrl = await generateStill({
    prompt: stillPrompt(slot.text, opts.styleExtra),
    aspectRatio: "16:9",
    referenceImages: opts.referenceImages,
  });

  const stem = opts.fileStem ?? `slot-${String(slot.index).padStart(3, "0")}`;
  if (opts.stillOnly) {
    const file = `${stem}.png`;
    await downloadAsset(stillUrl, path.join(dir, file));
    return { ...slotFields(slot), stillUrl, videoUrl: "", file, durationSec: slot.durationSec };
  }

  const videoUrl = await animateStill({
    imageUrl: stillUrl,
    prompt: motionPrompt(),
    durationSec: motionDuration(slot.durationSec),
    negativePrompt: MOTION_NEGATIVE,
  });
  const file = `${stem}.mp4`;
  await downloadAsset(videoUrl, path.join(dir, file));
  return { ...slotFields(slot), stillUrl, videoUrl, file, durationSec: slot.durationSec };
}

function slotFields(slot: GraphicSlot): Pick<GeneratedGraphic, "index" | "start" | "end" | "text"> {
  return { index: slot.index, start: slot.start, end: slot.end, text: slot.text };
}

const run = promisify(execFile);

/**
 * Make a generated clip exactly as long as the slot it has to fill.
 *
 * This is not a nicety — NOTHING Kling returns is ever the right length. It
 * renders 5s or 10s and nothing else, while measured slots are mostly 2–4s and
 * a few run 14–15s. So every clip is either too long or too short:
 *
 *  • Too long (the common case): trim. The opening is the strongest part of a
 *    push-in, so keep the head and cut the tail.
 *  • Too short (slots past the 10s ceiling): slow it down with setpts rather
 *    than loop it. The motion is a slow drift, so 0.7x reads as intended pacing,
 *    whereas a loop puts a visible seam in the middle of a held card.
 *
 * Video only: these clips carry no audio, and the narration runs underneath
 * from the original video.
 */
export async function fitToSlot(srcPath: string, destPath: string, slotSeconds: number): Promise<void> {
  const generated = await probeDuration(srcPath);
  const target = Math.max(0.5, slotSeconds);
  if (generated >= target) {
    await run("ffmpeg", ["-y", "-i", srcPath, "-t", target.toFixed(3), "-an", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", "-crf", "18", destPath]);
    return;
  }
  const factor = target / generated;
  await run("ffmpeg", ["-y", "-i", srcPath, "-filter:v", `setpts=${factor.toFixed(4)}*PTS`,
    "-t", target.toFixed(3), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", destPath]);
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", file]);
  const n = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Could not read a duration from ${file}`);
  return n;
}
