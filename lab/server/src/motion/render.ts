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
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { config } from "../config.js";
import type { MotionGraphicClip } from "../render/manifest.js";

const FPS = 30;

/**
 * The @remotion/* SSR packages are OPTIONAL runtime dependencies — they're heavy
 * (headless Chromium) and live in the SEPARATE remotion workspace
 * (lab/remotion/node_modules), NOT the server's node_modules (which the lab
 * symlinks to the main app's libs). So a plain `import("@remotion/renderer")`
 * resolved from this file fails even when Remotion is installed.
 *
 * We therefore resolve the packages from the remotion project dir (next to
 * config.motionEntryPoint) via createRequire, then import the resolved absolute
 * path. We fall back to the bare specifier (covers a hoisted/global install).
 * Either way, if the packages are genuinely absent the import throws and every
 * caller falls back gracefully — the lab still type-checks and builds WITHOUT
 * them installed because these are dynamic, untyped imports.
 */
function remotionRequire(): NodeRequire {
  // motionEntryPoint = .../remotion/src/index.ts → resolve from the remotion root
  // so its node_modules is on the resolution path.
  const remotionRoot = path.resolve(path.dirname(config.motionEntryPoint), "..");
  return createRequire(path.join(remotionRoot, "package.json"));
}

async function importRemotionPkg(pkg: string): Promise<any> {
  try {
    const resolved = remotionRequire().resolve(pkg);
    return await import(/* @vite-ignore */ pathToFileURL(resolved).href as string);
  } catch {
    // Fall back to normal specifier resolution (hoisted/global install).
    return import(/* @vite-ignore */ pkg as string);
  }
}

export const importRenderer = (): Promise<any> => importRemotionPkg("@remotion/renderer");
const importBundler = (): Promise<any> => importRemotionPkg("@remotion/bundler");

/**
 * The pre-baked Chromium executable Remotion should use, or undefined to let
 * Remotion download/locate its own. In the Docker image config sets this to the
 * apt-installed /usr/bin/chromium so a render never depends on Remotion's CDN.
 * Exported so EVERY Remotion call site (the runtime probe, the short-form motion
 * stage, AND the meme/sticker stage) passes the SAME executable.
 */
export function browserExecutable(): string | undefined {
  return config.remotionBrowserExecutable || undefined;
}

export interface RenderedGraphic {
  clip: MotionGraphicClip;
  /** Local path to the rendered alpha clip (WebM/ProRes), or null if it failed. */
  file: string | null;
}

// ── Availability probe (cached) ──────────────────────────────────────────────
let availability: Promise<boolean> | null = null;

/**
 * True only if the @remotion SSR packages can be imported AND a headless browser
 * can be opened (which downloads Chromium on first call). This probe is about
 * the RUNTIME ENVIRONMENT only — it does NOT consult any feature flag — so any
 * caller (motion graphics OR the meme/sticker editor) can ask "is Remotion +
 * Chromium usable here?" without coupling to MOTION_GRAPHICS. Cached so we probe
 * once per process. Any failure → false.
 *
 * Note: renderer 4.x exports `openBrowser` (not `ensureBrowser`); opening a
 * browser here both validates Chromium and triggers the one-time download, so the
 * first real render doesn't pay that latency. We close it immediately — each
 * render opens its own.
 */
export async function remotionRuntimeAvailable(): Promise<boolean> {
  if (!availability) {
    availability = (async () => {
      try {
        const renderer = await importRenderer();
        if (typeof renderer.selectComposition !== "function") {
          throw new Error("@remotion/renderer missing selectComposition");
        }
        if (typeof renderer.openBrowser === "function") {
          // Use the pre-baked Chromium when configured (REMOTION_BROWSER_EXECUTABLE)
          // so the probe — and therefore every real render — never triggers
          // Remotion's runtime Chromium download.
          const exe = browserExecutable();
          const browser = await renderer.openBrowser(
            "chrome",
            exe ? { browserExecutable: exe } : undefined,
          );
          await browser.close?.();
        }
        return true;
      } catch (e) {
        console.warn(
          `[remotion] unavailable — Remotion/Chromium not usable here: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return false;
      }
    })();
  }
  return availability;
}

/**
 * Motion-graphics availability: the runtime probe AND the MOTION_GRAPHICS flag.
 * The flag gates the SHORT-FORM DIRECTOR's motion graphics only. The meme/sticker
 * editor must NOT use this — it calls remotionRuntimeAvailable() directly so its
 * stickers run whenever Chromium is present, regardless of the flag.
 */
export async function motionAvailable(): Promise<boolean> {
  // MOTION_GRAPHICS=0 force-disables the short-form motion stage globally.
  if (config.motionGraphicsForceDisabled) return false;
  return remotionRuntimeAvailable();
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
    const exe = browserExecutable();

    const lengthSec = Math.max(0.6, clip.endTime - clip.startTime);
    const durationInFrames = Math.max(1, Math.round(lengthSec * FPS));
    const inputProps = { ...clip.data, durationInFrames };

    const composition = await selectComposition({
      serveUrl,
      id: clip.kind,
      inputProps,
      ...(exe ? { browserExecutable: exe } : {}),
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
      // Pre-baked Chromium (REMOTION_BROWSER_EXECUTABLE) — never a runtime download.
      ...(exe ? { browserExecutable: exe } : {}),
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
