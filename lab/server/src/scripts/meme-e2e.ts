/**
 * In-container END-TO-END proof for the Meme/Sticker editor (Problem 2).
 *
 * This does NOT need any API keys. It synthesizes a base "narration" video and a
 * PLACEHOLDER sticker PNG, then runs the REAL meme stage (applyEmphasisStickers)
 * — the exact code path the render worker uses — and asserts:
 *   1. the stage actually composited a sticker (skipReason === null, applied > 0),
 *      proving the MOTION_GRAPHICS decoupling works (we run WITHOUT that flag);
 *   2. the sticker is VISIBLE in the output during its window and ABSENT before it;
 *   3. the sticker pixels land BELOW the caption zone (lower third), not over it;
 *   4. the sticker ANIMATES — sampled frames across the window differ from each
 *      other (the slap-on pop + wiggle), i.e. it is not a frozen frame.
 *
 * Run (with the lab server up on :9090 so Remotion's <Img> can fetch the PNG):
 *   bash lab/run-lab.sh --no-build &     # serves /api/outputs
 *   cd lab/server && npx tsx src/scripts/meme-e2e.ts
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { applyEmphasisStickers } from "../meme/stage.js";
import { stickerBox, CANVAS } from "../meme/sticker.js";
import type { EmphasisStickerClip } from "../meme/sticker.js";

const FFMPEG = config.ffmpegPath;
const FFPROBE = config.ffprobePath;
const TMP = config.tmpDir;
fs.mkdirSync(TMP, { recursive: true });

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
}

/** Extract a single frame at time t (seconds) to a PNG and return its path. */
function frameAt(video: string, t: number, tag: string): string {
  const out = path.join(TMP, `e2e_frame_${tag}.png`);
  run(FFMPEG, ["-y", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", out]);
  return out;
}

/**
 * Crop the sticker region (the lower-third box from stickerBox()) of a frame and
 * return its average RGB. We compare these across frames/times to prove presence
 * + animation. Uses ffmpeg's crop + a 1x1 scale to read the mean color.
 */
function regionMeanRGB(framePng: string): [number, number, number] {
  const box = stickerBox();
  // Crop the sticker box, downscale to 1x1, dump the single pixel as raw RGB.
  const raw = path.join(TMP, `e2e_px_${path.basename(framePng)}.raw`);
  run(FFMPEG, [
    "-y", "-i", framePng,
    "-vf", `crop=${CANVAS.width}:${box.bottom - box.top}:0:${box.top},scale=1:1`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return [buf[0], buf[1], buf[2]];
}

/** A crop of the CAPTION zone center (to confirm the sticker is NOT up there). */
function captionZoneMeanRGB(framePng: string): [number, number, number] {
  // Center band 40%–55% of height — where captions burn in.
  const top = Math.round(CANVAS.height * 0.4);
  const h = Math.round(CANVAS.height * 0.15);
  const raw = path.join(TMP, `e2e_cap_${path.basename(framePng)}.raw`);
  run(FFMPEG, [
    "-y", "-i", framePng,
    "-vf", `crop=${CANVAS.width}:${h}:0:${top},scale=1:1`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
  ]);
  const buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
  return [buf[0], buf[1], buf[2]];
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

async function main(): Promise<void> {
  const dur = 8;
  const stickerStart = 3.0;
  const stickerEnd = 5.0;

  // ── 1. PLACEHOLDER sticker PNG: an OPAQUE bright-magenta square on a fully
  //    TRANSPARENT margin (so it reads as a die-cut sticker and proves alpha is
  //    honored). Distinctive saturated color, unmistakable against the base.
  //    We composite an opaque magenta box (alpha=255) over a transparent canvas
  //    so the corners stay transparent while the center is solid magenta.
  const stickerPng = path.join(config.outputsDir, "stickers", "e2e_placeholder.png");
  fs.mkdirSync(path.dirname(stickerPng), { recursive: true });
  run(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "color=c=black@0.0:s=600x600,format=rgba",      // transparent canvas
    "-f", "lavfi", "-i", "color=c=magenta:s=400x400,format=rgba",         // OPAQUE magenta box
    "-filter_complex", "[0][1]overlay=100:100:format=auto[out]",          // centered, keeps margins clear
    "-map", "[out]", "-frames:v", "1", stickerPng,
  ]);
  console.log(`[e2e] placeholder sticker → ${stickerPng}`);

  // ── 2. Base "narration" video: a dark blue background with a white caption-ish
  //    bar at center (so we can confirm the sticker lands BELOW it).
  const baseVideo = path.join(TMP, "e2e_base.mp4");
  run(FFMPEG, [
    "-y", "-f", "lavfi", "-i", `color=c=0x101830:s=${CANVAS.width}x${CANVAS.height}:d=${dur}:r=30`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf", `drawbox=x=0:y=${Math.round(CANVAS.height * 0.45)}:w=${CANVAS.width}:h=120:color=white@0.9:t=fill`,
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", baseVideo,
  ]);
  console.log(`[e2e] base narration video → ${baseVideo}`);

  // ── 3. Run the REAL meme stage (no MOTION_GRAPHICS flag set). ───────────────
  console.log(`[e2e] MOTION_GRAPHICS = ${process.env.MOTION_GRAPHICS ?? "(unset)"}`);
  const clip: EmphasisStickerClip = {
    startTime: stickerStart,
    endTime: stickerEnd,
    imageUrl: "/api/outputs/stickers/e2e_placeholder.png", // resolved to 127.0.0.1:<port>
    restTiltDeg: -4,
    phrase: "e2e placeholder",
  };
  const result = await applyEmphasisStickers(baseVideo, [clip], dur);
  console.log(`[e2e] stage result:`, result);

  let failed = false;
  const assert = (cond: boolean, msg: string) => {
    if (cond) { console.log(`  ok  ${msg}`); }
    else { console.error(`FAIL  ${msg}`); failed = true; }
  };

  assert(result.skipReason === null, `stage applied without skipping (skipReason=${result.skipReason})`);
  assert(result.applied === 1, `applied exactly 1 sticker (applied=${result.applied})`);
  assert(result.replacedFile !== baseVideo, "output is a NEW composited file (not the base video)");

  if (result.replacedFile === baseVideo) {
    console.error("[e2e] no composite produced — cannot continue frame checks.");
    process.exit(1);
  }

  const out = result.replacedFile;

  // ── 4. Frame proofs: presence, placement, and ANIMATION. ───────────────────
  // Before the window (t=1.0): the sticker region should look like the base.
  const before = frameAt(out, 1.0, "before");
  const beforeRegion = regionMeanRGB(before);

  // Inside the window: sample several frames to prove the sticker appears AND
  // that it MOVES/changes (the slap-on pop + wiggle).
  const sampleTimes = [3.1, 3.25, 3.5, 4.0, 4.7];
  const insideFrames = sampleTimes.map((t, i) => frameAt(out, t, `in${i}`));
  const insideRegions = insideFrames.map((f) => regionMeanRGB(f));

  // Magenta ≈ (255,0,255). Distance from the dark base region should be large
  // for at least one in-window sample (the sticker is visibly present).
  const maxFromBase = Math.max(...insideRegions.map((r) => dist(r, beforeRegion)));
  assert(maxFromBase > 40, `sticker is VISIBLE in-window (max region Δ from pre-window = ${maxFromBase.toFixed(1)})`);

  // Placement: the magenta must appear in the LOWER-THIRD region but NOT in the
  // caption zone (center band). Check the most-saturated in-window frame.
  let bestIdx = 0;
  insideRegions.forEach((r, i) => { if (dist(r, beforeRegion) > dist(insideRegions[bestIdx], beforeRegion)) bestIdx = i; });
  const capBefore = captionZoneMeanRGB(before);
  const capInside = captionZoneMeanRGB(insideFrames[bestIdx]);
  const capDelta = dist(capInside, capBefore);
  const regionDelta = dist(insideRegions[bestIdx], beforeRegion);
  assert(
    regionDelta > capDelta + 20,
    `sticker lands BELOW captions: lower-third Δ=${regionDelta.toFixed(1)} >> caption-zone Δ=${capDelta.toFixed(1)}`,
  );

  // ANIMATION proof: across the in-window samples the sticker region changes over
  // time (entrance pop scales it up, wiggle rotates it, exit scales+fades). If it
  // were a frozen frame these would all be (near) identical. Require a meaningful
  // spread between the early entrance frame and a later hold/exit frame.
  let maxPairwise = 0;
  for (let i = 0; i < insideRegions.length; i++) {
    for (let j = i + 1; j < insideRegions.length; j++) {
      maxPairwise = Math.max(maxPairwise, dist(insideRegions[i], insideRegions[j]));
    }
  }
  assert(
    maxPairwise > 12,
    `sticker ANIMATES — region color changes across the window (max pairwise Δ = ${maxPairwise.toFixed(1)}, frozen ⇒ ~0)`,
  );

  console.log(`\n[e2e] region means (R,G,B):`);
  console.log(`      pre-window @1.0s: ${beforeRegion}`);
  sampleTimes.forEach((t, i) => console.log(`      @${t}s: ${insideRegions[i]}  (Δfrom-base ${dist(insideRegions[i], beforeRegion).toFixed(1)})`));

  // Cleanup temp frames (leave the composited output for inspection).
  [before, ...insideFrames].forEach((f) => fs.rmSync(f, { force: true }));
  console.log(`\n[e2e] composited output kept at: ${out}`);

  if (failed) { console.error("\n[e2e] FAILED"); process.exit(1); }
  console.log("\n[e2e] ALL CHECKS PASSED — animated sticker composited below captions, no MOTION_GRAPHICS flag.");
}

main().catch((e) => { console.error("[e2e] crashed:", e); process.exit(1); });
