// Render an SVG/HTML file to PNG with the recorder image's Chromium (pre-production assets: sketches,
// plates). The host has no image library; this keeps asset production inside one container.
//   node rasterize.mjs <in.svg|in.html> <out.png> <width> <height>
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const [src, dst, w, h] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const body = fs.readFileSync(src, "utf8");
const html = src.endsWith(".svg") ? `<html><body style="margin:0">${body}</body></html>` : body;
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: dst, clip: { x: 0, y: 0, width: +w, height: +h } });
await browser.close();
process.stdout.write(JSON.stringify({ ok: true, out: dst }) + "\n");
