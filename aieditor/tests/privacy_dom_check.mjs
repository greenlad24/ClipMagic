// The DOM half of tests/test_privacy.py — runs INSIDE aieditor-screencast with this folder mounted under
// /app (so puppeteer-core resolves from /app/node_modules) and screencast/ at /app/screencast:
//   node /app/ptests/privacy_dom_check.mjs file:///app/ptests/fixtures/privacy/form.html
// Prints one JSON line: the boxes privacyBoxes() returns (x2 scale) and a sampler run.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { privacyBoxes, privacySampler } from "/app/screencast/privacy_dom.mjs";

const url = process.argv[2];
const exe = ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(url, { waitUntil: "load" });
  const boxes = await privacyBoxes(page, [".account-email"], 2);
  const name = await page.evaluate(() => { const r = document.querySelector("#n").getBoundingClientRect(); return [r.x * 2, r.y * 2, r.width * 2, r.height * 2]; });
  const s = privacySampler({ scale: 2, extra: [] });
  for (let f = 0; f < 31; f++) await s.tick(page, f / 30);       // 1 s of frames -> samples at 0, .25, .5, .75, 1.0
  const file = path.join(os.tmpdir(), "privacy.json");
  s.flush(file, 0.5);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(JSON.stringify({ boxes, name, samples: written.map((x) => x.t), sample_boxes: written[0]?.boxes.length ?? 0 }));
} finally {
  await browser.close();
}
