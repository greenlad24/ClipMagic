/**
 * Final upscale stage for the Thumbnail Designer.
 *
 * After the chain crops its result to a clean 16:9, we sharpen it with a LOCAL,
 * FREE Real-ESRGAN pass (realesrgan-ncnn-vulkan, software-Vulkan on a CPU box),
 * then resample to EXACTLY 1920×1080. Upscaling 4× and downsampling back is
 * crisper than a single scale.
 *
 * Bulletproof by design — generation must NEVER fail because of the upscaler:
 *   - If the binary / Vulkan runtime is unavailable, or the run errors / times
 *     out, we FALL BACK to a plain ffmpeg lanczos scale to 1920×1080.
 *   - The Real-ESRGAN runner is INJECTABLE so tests never touch a real binary.
 *
 * The binary is located via REALESRGAN_BIN (default a known install path) and a
 * realesranAvailable() probe. Pinned upstream release: v0.2.5.0 (xinntao), model
 * `realesrgan-x4plus` (4×). Installed into the lab image by lab/Dockerfile.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { TARGET_W, TARGET_H } from "./crop.js";

/** Default install path inside the lab image (see lab/Dockerfile). Overridable. */
export const REALESRGAN_BIN = process.env.REALESRGAN_BIN || "/opt/realesrgan/realesrgan-ncnn-vulkan";
/** Pinned 4× general-purpose model that ships with the upstream binary. */
export const REALESRGAN_MODEL = process.env.REALESRGAN_MODEL || "realesrgan-x4plus";
/** Scale factor (the model is a 4× model). */
const REALESRGAN_SCALE = 4;
/** Hard cap so a stuck upscale can never wedge a generation. */
const REALESRGAN_TIMEOUT_MS = Number(process.env.REALESRGAN_TIMEOUT_MS || 25_000);

/**
 * Real-ESRGAN (ncnn-vulkan) needs a GPU to be practical — on a CPU-only box it
 * runs through software Vulkan (lavapipe) and is so slow it effectively HANGS the
 * generation. So it's OPT-IN: only used when THUMBNAIL_UPSCALER=realesrgan (i.e.
 * you have a GPU). The default path is a fast, SHARPENED ffmpeg scale — instant,
 * clean, no hang.
 */
export function realesrganEnabled(): boolean {
  return (process.env.THUMBNAIL_UPSCALER || "").toLowerCase() === "realesrgan";
}

/** True when the Real-ESRGAN binary is present + executable. Never throws. */
export function realesrganAvailable(bin: string = REALESRGAN_BIN): boolean {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the ffmpeg argv that resamples `input` to EXACTLY 1920×1080. With
 * `sharpen` (the default fallback path, where we're scaling a small chain image
 * UP) it adds a mild unsharp so the result isn't soft; without it (downsampling a
 * crisp Real-ESRGAN 4× image) it's a plain lanczos scale. Pure + exported.
 */
export function buildResampleArgs(input: string, output: string, opts: { sharpen?: boolean } = {}): string[] {
  const vf = opts.sharpen
    ? `scale=${TARGET_W}:${TARGET_H}:flags=lanczos,unsharp=5:5:0.8:5:5:0.0`
    : `scale=${TARGET_W}:${TARGET_H}:flags=lanczos`;
  return ["-y", "-i", input, "-vf", vf, "-frames:v", "1", output];
}

/**
 * Build the realesrgan-ncnn-vulkan argv: 4× upscale `input` → `output` with the
 * pinned model. Pure + exported for unit testing. Models live next to the binary
 * under ./models (the upstream layout); REALESRGAN_MODELS_DIR overrides.
 */
export function buildRealesrganArgs(input: string, output: string): string[] {
  const args = ["-i", input, "-o", output, "-s", String(REALESRGAN_SCALE), "-n", REALESRGAN_MODEL];
  const modelsDir = process.env.REALESRGAN_MODELS_DIR;
  if (modelsDir) args.push("-m", modelsDir);
  return args;
}

/** Run the Real-ESRGAN binary with a timeout. Resolves on exit 0, else rejects. */
export type RealesrganRunner = (input: string, output: string) => Promise<void>;

const defaultRealesrganRunner: RealesrganRunner = (input, output) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(REALESRGAN_BIN, buildRealesrganArgs(input, output), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best-effort */
      }
      reject(new Error(`Real-ESRGAN timed out after ${REALESRGAN_TIMEOUT_MS}ms`));
    }, REALESRGAN_TIMEOUT_MS);
    child.stderr.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Real-ESRGAN: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(new Error(`Real-ESRGAN exited with code ${code}\n${stderrTail}`));
    });
  });

/** Dependencies for upscaleToThumbnail — all injectable so tests stay offline. */
export interface UpscaleDeps {
  /** Whether Real-ESRGAN is enabled (opt-in; default reads THUMBNAIL_UPSCALER). */
  enabled?: () => boolean;
  /** Whether the Real-ESRGAN binary is usable. */
  available?: () => boolean;
  /** Runs Real-ESRGAN (input → output). */
  runRealesrgan?: RealesrganRunner;
  /** Runs the ffmpeg resample/fallback (argv, totalDuration). */
  runFfmpegFn?: (args: string[], totalDuration: number) => Promise<unknown>;
}

export interface UpscaleResult {
  /** Path to the final 1920×1080 file. */
  file: string;
  /** Which path produced it — for the chain record / progress note. */
  method: "realesrgan" | "ffmpeg-fallback";
  /** Present when Real-ESRGAN was attempted but we fell back. */
  note?: string;
}

/**
 * Upscale `inputPath` (an already-16:9 image) to EXACTLY 1920×1080 at `outPath`.
 * Real-ESRGAN 4× then ffmpeg-resample when the binary is available; otherwise a
 * single ffmpeg lanczos scale. NEVER throws for a missing/failed upscaler — it
 * falls back. Only a total ffmpeg failure (which would already have failed the
 * crop stage) propagates.
 */
export async function upscaleToThumbnail(
  inputPath: string,
  outPath: string,
  deps: UpscaleDeps = {},
): Promise<UpscaleResult> {
  const enabled = deps.enabled ?? realesrganEnabled;
  const available = deps.available ?? (() => realesrganAvailable());
  const runRealesrgan = deps.runRealesrgan ?? defaultRealesrganRunner;
  const runFfmpegFn = deps.runFfmpegFn ?? ((args: string[], d: number) => runFfmpeg(args, d));

  const fallback = async (note?: string): Promise<UpscaleResult> => {
    // Sharpened scale — this path scales a small chain image UP, so soften-guard it.
    await runFfmpegFn(buildResampleArgs(inputPath, outPath, { sharpen: true }), 1);
    return { file: outPath, method: "ffmpeg-fallback", note };
  };

  // Real-ESRGAN is opt-in (GPU only). Default → fast sharpened ffmpeg scale.
  if (!enabled()) {
    return fallback("Real-ESRGAN disabled (set THUMBNAIL_UPSCALER=realesrgan on a GPU box) — used sharpened ffmpeg scale");
  }
  if (!available()) return fallback("Real-ESRGAN unavailable — used ffmpeg lanczos scale");

  fs.mkdirSync(config.tmpDir, { recursive: true });
  const upscaledTmp = path.join(config.tmpDir, `tn-4x-${crypto.randomBytes(8).toString("hex")}.png`);
  try {
    await runRealesrgan(inputPath, upscaledTmp);
    // Downsample the crisp 4× image to the exact target via ffmpeg.
    await runFfmpegFn(buildResampleArgs(upscaledTmp, outPath), 1);
    return { file: outPath, method: "realesrgan" };
  } catch (e) {
    return fallback(`Real-ESRGAN failed (${e instanceof Error ? e.message : String(e)}) — used ffmpeg lanczos scale`);
  } finally {
    try {
      fs.rmSync(upscaledTmp, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
