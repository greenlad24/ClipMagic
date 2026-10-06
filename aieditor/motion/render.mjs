// render.mjs SCENE.json OUTDIR [FIRST LAST]
// Renders every frame of a motion scene to OUTDIR/f<frame>.png with a transparent
// background (premultiplied-free RGBA), driving engine.js with window.__seek(frame).
// Runs in the clipmagic-lab image (puppeteer-core + chromium). Deterministic: no clocks,
// no requestAnimationFrame — the page only changes when __seek is called.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const [scenePath, outDir, firstArg, lastArg] = process.argv.slice(2);
const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
const first = firstArg !== undefined ? Number(firstArg) : scene.first ?? 0;
const last = lastArg !== undefined ? Number(lastArg) : scene.last ?? first + scene.frames - 1;
fs.mkdirSync(outDir, { recursive: true });

const fontFaces = Object.entries(scene.fonts || { "Space Grotesk": "SpaceGrotesk.ttf", "Space Mono": "SpaceMono-Bold.ttf", Inter: "Inter.ttf",
  Roboto: "Roboto.ttf", "Open Sans": "OpenSans.ttf" })
  .map(([fam, file]) => `@font-face{font-family:"${fam}";src:url("file://${path.join(here, "fonts", file)}");font-weight:100 900}`)
  .join("\n");
const html = `<!doctype html><html><head><meta charset=utf-8><style>${fontFaces}</style></head><body></body></html>`;
const tmpHtml = path.join(outDir, ".scene.html");
fs.writeFileSync(tmpHtml, html);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files", "--font-render-hinting=none", "--disable-lcd-text"],
});
try {
  const page = await browser.newPage();
  // scene.scale: lay out in design px (e.g. 1080×1920) and render at scale× (2 → 2160×3840)
  await page.setViewport({ width: scene.width, height: scene.height, deviceScaleFactor: scene.scale || 1 });
  await page.goto(`file://${tmpHtml}`);
  await page.addScriptTag({ path: path.join(here, "engine.js") });
  await page.evaluate((sc) => window.__load(sc), scene);
  if (process.env.MEASURE) {
    // ink boxes only (to size fonts against a measured reference box), no frames
    console.log(JSON.stringify(await page.evaluate(() => window.__inks())));
    process.exit(0);
  }
  // Keyframes are in the REFERENCE's frames (scene.fps, 24). scene.outFps (e.g. 30 for
  // the shorts) resamples: output frame n shows the moment first + n·fps/outFps, so the
  // measured timing holds in real time. Files are numbered by OUTPUT frame then.
  const outFps = scene.outFps || scene.fps;
  const n = outFps === scene.fps ? last - first + 1 : Math.floor(((last - first) * outFps) / scene.fps) + 1;
  for (let i = 0; i < n; i++) {
    const f = outFps === scene.fps ? first + i : first + (i * scene.fps) / outFps;
    const name = outFps === scene.fps ? first + i : (scene.outFirst || 0) + i;
    await page.evaluate((fr) => window.__seek(fr), f);
    await page.screenshot({ path: path.join(outDir, `f${String(name).padStart(5, "0")}.png`), omitBackground: !scene.backdrop, type: "png" });
  }
} finally {
  await browser.close();
  fs.rmSync(tmpHtml, { force: true });
}
console.log(`rendered frames → ${outDir}`);
