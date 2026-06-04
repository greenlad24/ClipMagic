/**
 * Motion-graphics render service.
 *
 * Renders the director's chosen Remotion compositions to ALPHA (transparent)
 * clips that the ffmpeg step composites onto the finished video. Everything in
 * here is designed to be *optional and safe*:
 *
 *  • Gated by config.motionGraphicsEnabled (MOTION_GRAPHICS=1). When off, this
 *    module is never imported by the build path.
 *  • @remotion/* are loaded with a dynamic import so a box WITHOUT the packages
 *    (or without headless Chromium) never breaks the normal render — we catch,
 *    log once, and the caller falls back to compositing nothing.
 *  • Concurrency is bounded by a tiny semaphore (config.motionConcurrency,
 *    default 1) because each headless-Chromium render is heavy and shares a
 *    4 vCPU / 8 GB droplet with ffmpeg.
 *
 * Alpha format choice: we render VP8/VP9 WebM with yuva420p ("vp8" codec +
 * pixelFormat "yuva420p"). WebM-alpha composites cleanly in ffmpeg via the
 * `overlay` filter and is far lighter than ProRes 4444 (which is ~10× the bytes
 * and needs a .mov muxer) — the right trade on a small shared box. The codec is
 * overridable via MOTION_CODEC for a server that prefers ProRes.
 */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { MotionGraphicClip } from "../render/manifest.js";

const FPS = 30;

/**
 * The @remotion/* SSR packages are OPTIONAL runtime dependencies — they're heavy
 * (headless Chromium) and only present on a server with the motion-graphics
 * feature provisioned. We therefore load them through indirected dynamic imports
 * so the lab type-checks and builds WITHOUT them installed; if they're missing
 * at runtime the import throws and every caller falls back gracefully.
 */
export const importRenderer = (): Promise<any> =>
  import(/* @vite-ignore */ "@remotion/renderer" as string);
const importBundler = (): Promise<any> =>
  import(/* @vite-ignore */ "@remotion/bundler" as string);

export interface RenderedGraphic {
  clip: MotionGraphicClip;
  /** Local path to the rendered alpha clip (WebM/ProRes), or null if it failed. */
  file: string | null;
}

// ── Availability probe (cached) ──────────────────────────────────────────────
let availability: Promise<boolean> | null = null;

/**
 * True only if the @remotion SSR packages can be imported AND a headless browser
 * can be opened (which downloads Chromium on first call). Cached so we probe once
 * per process. Any failure → false (caller skips motion graphics and renders
 * normally).
 *
 * Note: renderer 4.x exports `openBrowser` (not `ensureBrowser`); opening a
 * browser here both validates Chromium and triggers the one-time download, so the
 * first real render doesn't pay that latency. We close it immediately — each
 * render opens its own.
 */
export async function motionAvailable(): Promise<boolean> {
  if (!config.motionGraphicsEnabled) return false;
  if (!availability) {
    availability = (async () => {
      try {
        const renderer = await importRenderer();
        if (typeof renderer.selectComposition !== "function") {
          throw new Error("@remotion/renderer missing selectComposition");
        }
        if (typeof renderer.openBrowser === "function") {
          const browser = await renderer.openBrowser("chrome");
          await browser.close?.();
        }
        return true;
      } catch (e) {
        console.warn(
          `[motion] disabled — Remotion/Chromium unavailable: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return false;
      }
    })();
  }
  return availability;
}

// ── Bundle (cached across renders) ───────────────────────────────────────────
let bundlePromise: Promise<string> | null = null;

/**
 * The cached Remotion serve-URL bundle. Exported so sibling stages (e.g. the
 * Meme/Sticker editor's emphasis stickers) reuse the SAME bundle + Chromium
 * availability probe instead of rebuilding their own — same Remotion project,
 * one bundle per process.
 */
export async function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { bundle } = await importBundler();
      fs.mkdirSync(config.motionBundleDir, { recursive: true });
      console.log(`[motion] bundling Remotion project (${config.motionEntryPoint})…`);
      const url = await bundle({
        entryPoint: config.motionEntryPoint,
        outDir: config.motionBundleDir,
      });
      console.log("[motion] bundle ready");
      return url;
    })();
  }
  return bundlePromise;
}

// ── Tiny semaphore for render concurrency ────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= config.motionConcurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  return () => {
    active--;
    waiters.shift()?.();
  };
}

function codecConfig(): { codec: string; pixelFormat: string; ext: string } {
  const codec = process.env.MOTION_CODEC || "vp8";
  if (codec === "prores") return { codec: "prores", pixelFormat: "yuva444p10le", ext: "mov" };
  // vp8/vp9 both take yuva420p for WebM-alpha.
  return { codec, pixelFormat: "yuva420p", ext: "webm" };
}

/**
 * Render one graphic to an alpha clip. The clip's on-screen length comes from
 * the director (endTime − startTime); we pass it to the composition as
 * `durationInFrames` so the composition only owns the motion, not the duration.
 * Never throws — returns { file: null } on any failure so the overlay step skips
 * just this graphic.
 */
async function renderOne(
  serveUrl: string,
  clip: MotionGraphicClip,
): Promise<RenderedGraphic> {
  const release = await acquire();
  try {
    const { selectComposition, renderMedia } = await importRenderer();
    const { codec, pixelFormat, ext } = codecConfig();

    const lengthSec = Math.max(0.6, clip.endTime - clip.startTime);
    const durationInFrames = Math.max(1, Math.round(lengthSec * FPS));
    const inputProps = { ...clip.data, durationInFrames };

    const composition = await selectComposition({
      serveUrl,
      id: clip.kind,
      inputProps,
    });

    const outFile = path.join(config.tmpDir, `mg_${clip.kind}_${randomUUID()}.${ext}`);
    await renderMedia({
      serveUrl,
      composition: { ...composition, durationInFrames },
      codec: codec as never,
      pixelFormat: pixelFormat as never,
      // Alpha REQUIRES png frames — Remotion rejects yuva* with any other image
      // format. This is what makes the background truly transparent (no matte).
      imageFormat: "png" as never,
      outputLocation: outFile,
      inputProps,
      concurrency: config.motionChromiumConcurrency,
      ...(codec === "prores" ? { proResProfile: "4444" as never } : {}),
    });

    return { clip, file: outFile };
  } catch (e) {
    console.warn(
      `[motion] graphic "${clip.kind}" @${clip.startTime}s failed — skipping: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { clip, file: null };
  } finally {
    release();
  }
}

/**
 * Render every graphic for a manifest. Returns only the ones that succeeded.
 * If the bundle itself can't build, returns [] (render proceeds graphics-free).
 */
export async function renderMotionGraphics(
  clips: MotionGraphicClip[],
): Promise<RenderedGraphic[]> {
  if (!clips.length) return [];
  if (!(await motionAvailable())) return [];

  let serveUrl: string;
  try {
    serveUrl = await getBundle();
  } catch (e) {
    console.warn(
      `[motion] bundle failed — rendering without motion graphics: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    bundlePromise = null; // allow a retry next render
    return [];
  }

  const results = await Promise.all(clips.map((c) => renderOne(serveUrl, c)));
  return results.filter((r) => r.file !== null);
}
