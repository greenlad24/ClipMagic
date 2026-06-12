/**
 * Auto-Screencast capture engine.
 *
 * captureScreencast({ url, durationSec, outName }) records a 1080×1920 mp4 of a
 * REAL website into config.outputsDir and returns { file, outputUrl }.
 *
 * Why synthesize instead of live-recording a tab? Real-time screen recording of
 * a headless tab is flaky (frame drops, variable fps, audio plumbing) and slow.
 * Instead we do something deterministic and 100% reliable that LOOKS like a
 * screen recording:
 *   1. Drive the container's EXISTING Chromium via puppeteer-core (no download).
 *   2. Navigate (hard timeout), best-effort dismiss cookie banners.
 *   3. Take ONE tall full-page screenshot (height capped to bound memory).
 *   4. ffmpeg turns that tall image into a smooth top-to-bottom SCROLL over
 *      durationSec (or a subtle slow ZOOM when the page is too short to scroll).
 *
 * Testability: the browser-launch + page ops are INJECTABLE (capturePageImage),
 * and the ffmpeg arg-builder (buildScrollArgs / buildZoomArgs) is a PURE exported
 * function unit-tested without ffmpeg.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { runFfmpeg } from "../render/ffmpeg.js";
import { CHROMIUM_ARGS, chromiumCandidates } from "./chromium.js";

/**
 * puppeteer-core is an OPTIONAL lab dependency installed into a LAB-PRIVATE dir
 * (server/.capture-deps) by run-lab.sh — it is NEVER added to the main app's
 * shared node_modules. We resolve it from there first (createRequire), then fall
 * back to normal specifier resolution (covers a hoisted/global install). Dynamic
 * + untyped so tsc and the server build stay green even when it's absent; if it's
 * genuinely missing the import throws and the caller marks the moment Error.
 */
async function importPuppeteer(): Promise<any> {
  const privateRoot = path.resolve(config.serverRoot, ".capture-deps", "package.json");
  try {
    const req = createRequire(privateRoot);
    const resolved = req.resolve("puppeteer-core");
    return (await import(/* @vite-ignore */ pathToFileURL(resolved).href as string)).default;
  } catch {
    return (await import("puppeteer-core" as string)).default;
  }
}

// ── Tunable constants (tweak here for a different look / container) ───────────
export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;
/** Cap the captured page height to ≤ this many viewports so a 50,000px page
 *  can't blow up memory or produce a glacial scroll. */
export const MAX_PAGE_VIEWPORTS = 6;
/** Navigation hard timeout (ms). */
export const NAV_TIMEOUT_MS = 20_000;
/** A mobile-ish UA so sites serve their narrow, screenshot-friendly layout. */
export const CAPTURE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
/** Common cookie/consent button selectors — clicked best-effort, then ignored. */
export const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "button[aria-label*='accept' i]",
  "button[aria-label*='agree' i]",
  "[id*='accept'][id*='cookie' i]",
  ".cookie-accept",
  "button.accept",
];

// ── Pure ffmpeg arg builders (unit-tested, no ffmpeg needed) ──────────────────

export interface SynthArgs {
  /** Absolute path to the tall screenshot (PNG). */
  imagePath: string;
  /** Pixel height of that screenshot. */
  imageHeight: number;
  /** Target clip length in seconds (>0). */
  durationSec: number;
  /** Absolute output mp4 path. */
  outPath: string;
}

/**
 * Round to a tidy expression-safe number string (ffmpeg filter expressions can't
 * take a trailing dot, and we don't want absurd precision in the command).
 */
function n(x: number): string {
  return Number(x.toFixed(3)).toString();
}

/**
 * SCROLL synthesis: pan a 1080×1920 window from the top of the tall image to its
 * bottom over `durationSec`. The crop y-offset is `min(maxY, maxY * t/dur)` so it
 * is ALWAYS bounded to [0, maxY] and never reads past the image — the key
 * correctness property. Returns the full ffmpeg argv.
 */
export function buildScrollArgs(a: SynthArgs): string[] {
  const dur = Math.max(0.5, a.durationSec);
  const maxY = Math.max(0, a.imageHeight - VIDEO_H);
  // y = clamp(maxY * t/dur, 0, maxY). Using min() with a constant ceiling keeps
  // the last frame pinned to the bottom even if rounding nudges t past dur.
  const yExpr = `min(${n(maxY)}\\,${n(maxY)}*t/${n(dur)})`;
  const vf =
    `crop=${VIDEO_W}:${VIDEO_H}:0:'${yExpr}',` +
    `format=yuv420p`;
  return ffmpegImageToVideo(a, dur, vf);
}

/**
 * ZOOM synthesis (fallback for short pages with no scroll room): a subtle slow
 * push-in from 1.0 to 1.08 over the clip. Uses zoompan on the (already
 * window-cropped) image. Returns the full ffmpeg argv.
 */
export function buildZoomArgs(a: SynthArgs): string[] {
  const dur = Math.max(0.5, a.durationSec);
  const frames = Math.max(1, Math.round(dur * FPS));
  // Crop the top window first so we never zoom into letterboxing, upscale 2× so
  // the zoom has resolution to spare, then zoompan to 1080×1920.
  const zExpr = `min(1.08\\,1.0+0.08*on/${frames})`;
  const vf =
    `crop=${VIDEO_W}:${VIDEO_H}:0:0,scale=${VIDEO_W * 2}:${VIDEO_H * 2},` +
    `zoompan=z='${zExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `s=${VIDEO_W}x${VIDEO_H}:fps=${FPS},format=yuv420p`;
  return ffmpegImageToVideo(a, dur, vf);
}

/** Shared argv assembly for a still-image → H.264 9:16 clip. */
function ffmpegImageToVideo(a: SynthArgs, dur: number, vf: string): string[] {
  return [
    "-y",
    "-loop", "1",
    "-i", a.imagePath,
    "-t", n(dur),
    "-r", String(FPS),
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    // ffmpeg's -progress stream (parsed by runFfmpeg) goes to stdout.
    "-progress", "pipe:1",
    a.outPath,
  ];
}

/**
 * Choose scroll vs zoom from the captured page height. Exported so the decision
 * is unit-testable. A page taller than the viewport by at least SCROLL_MIN_EXTRA
 * pixels scrolls; anything shorter does the subtle zoom.
 */
export const SCROLL_MIN_EXTRA = 120;
export function chooseSynthesis(imageHeight: number): "scroll" | "zoom" {
  return imageHeight - VIDEO_H >= SCROLL_MIN_EXTRA ? "scroll" : "zoom";
}

// ── Browser capture (injectable for tests) ────────────────────────────────────

export interface CapturedPage {
  /** Absolute path to the tall PNG screenshot written to tmp. */
  imagePath: string;
  /** Pixel height of that screenshot. */
  imageHeight: number;
}

/** Injectable page-capture seam: the real impl drives Chromium; tests stub it. */
export type CapturePageImage = (url: string, tmpImagePath: string) => Promise<CapturedPage>;

/**
 * The real Chromium-backed page capture. Tries each Chromium candidate until one
 * launches (the configured exe may be a broken snap shim). Strict cleanup: the
 * browser is closed in `finally`.
 */
export const capturePageImage: CapturePageImage = async (url, tmpImagePath) => {
  // puppeteer-core is an OPTIONAL lab dependency, dynamically imported so tsc and
  // the server build stay green even when it isn't installed (mirrors how the
  // Remotion stage imports @remotion/* lazily). If it's absent, the caller gets a
  // clear, catchable error and the moment is marked Error.
  let puppeteer: any;
  try {
    puppeteer = await importPuppeteer();
  } catch {
    throw new Error(
      "puppeteer-core is not installed — run the lab with CAPTURE_INSTALL=1 to enable screencast capture.",
    );
  }

  const candidates = chromiumCandidates();
  if (candidates.length === 0) {
    throw new Error("no Chromium executable found for screencast capture");
  }

  let browser: any = null;
  let lastLaunchErr = "";
  for (const exe of candidates) {
    try {
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: "new",
        args: CHROMIUM_ARGS,
      });
      break;
    } catch (e) {
      lastLaunchErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (!browser) {
    throw new Error(`Chromium failed to launch (tried ${candidates.length} path(s)): ${lastLaunchErr}`);
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent(CAPTURE_UA);
    await page.setViewport({ width: VIDEO_W, height: VIDEO_H, deviceScaleFactor: 1 });

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout/i.test(msg)) throw new Error(`navigation timeout loading ${url}`);
      throw new Error(`page failed to load ${url}: ${msg}`);
    }

    // Best-effort consent dismissal — click whatever's there, ignore failures.
    for (const sel of CONSENT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ delay: 20 }).catch(() => {});
          break;
        }
      } catch {
        /* selector invalid or detached — ignore */
      }
    }
    // Let any reflow settle.
    await new Promise((r) => setTimeout(r, 400));

    // Bound the captured height: clamp the body so a 50,000px page can't OOM.
    const maxH = VIDEO_H * MAX_PAGE_VIEWPORTS;
    // Evaluated in the BROWSER context (not Node), so reference the DOM through a
    // string expression — tsc's Node lib has no `document`, and we don't want to
    // pull the whole DOM lib into the server build just for this one line.
    const fullHeight: number = await page.evaluate(
      "Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0,document.body?document.body.offsetHeight:0)",
    );
    const captureHeight = Math.min(Math.max(fullHeight, VIDEO_H), maxH);

    await page.screenshot({
      path: tmpImagePath,
      type: "png",
      clip: { x: 0, y: 0, width: VIDEO_W, height: captureHeight },
    });

    return { imagePath: tmpImagePath, imageHeight: captureHeight };
  } finally {
    await browser.close().catch(() => {});
  }
};

// ── Public capture API ────────────────────────────────────────────────────────

export interface CaptureScreencastInput {
  url: string;
  durationSec: number;
  /** Output base name (without extension); a uuid is appended for uniqueness. */
  outName: string;
  /** Test seam: override the page-capture step. Defaults to the real Chromium. */
  capture?: CapturePageImage;
  /** Test seam: override the ffmpeg runner. Defaults to render/ffmpeg runFfmpeg. */
  runFfmpegImpl?: typeof runFfmpeg;
}

export interface CaptureScreencastResult {
  /** Absolute path of the produced mp4 in outputsDir. */
  file: string;
  /** Local URL the render's resolveInput can resolve (/api/outputs/<name>). */
  outputUrl: string;
}

function safeBase(name: string): string {
  return (name || "screencast").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/**
 * Capture a website screencast end-to-end. Records into config.outputsDir and
 * returns the local output URL that resolveInput composites at render time.
 * Throws with a clear message on failure; ALWAYS deletes the temp screenshot.
 */
export async function captureScreencast(
  input: CaptureScreencastInput,
): Promise<CaptureScreencastResult> {
  const capture = input.capture ?? capturePageImage;
  const ffmpeg = input.runFfmpegImpl ?? runFfmpeg;
  const durationSec = Math.max(2, Math.min(12, input.durationSec || 5));

  fs.mkdirSync(config.outputsDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });

  const id = randomUUID().slice(0, 8);
  const base = `screencast_${safeBase(input.outName)}_${id}`;
  const tmpImage = path.join(config.tmpDir, `${base}.png`);
  const outFile = path.join(config.outputsDir, `${base}.mp4`);

  let captured: CapturedPage;
  try {
    captured = await capture(input.url, tmpImage);
  } catch (e) {
    try { fs.rmSync(tmpImage, { force: true }); } catch { /* */ }
    throw e instanceof Error ? e : new Error(String(e));
  }

  try {
    const synthArgs: SynthArgs = {
      imagePath: captured.imagePath,
      imageHeight: captured.imageHeight,
      durationSec,
      outPath: outFile,
    };
    const args =
      chooseSynthesis(captured.imageHeight) === "scroll"
        ? buildScrollArgs(synthArgs)
        : buildZoomArgs(synthArgs);
    await ffmpeg(args, durationSec);
  } finally {
    // Temp screenshot is never needed after synthesis — delete it either way.
    try { fs.rmSync(captured.imagePath, { force: true }); } catch { /* */ }
  }

  return { file: outFile, outputUrl: `/api/outputs/${base}.mp4` };
}
