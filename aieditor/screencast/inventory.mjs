// Page inventory for the recording director: what a script may target on <url>.
//   node inventory.mjs <url> <out.json> [shot.jpg]
// Visible clickable/heading texts with their boxes (CSS px of a 1920×1080 desktop) and a
// screenshot, so Claude writes steps against what is REALLY on the page.
import fs from "node:fs";
import puppeteer from "puppeteer-core";
const [url, out, shot] = process.argv.slice(2);
import { CHROME, launchArgs, identity, dress } from "./macchrome.mjs";
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, args: launchArgs() });
const p = await b.newPage();
await dress(p, await identity(b));
await p.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
const items = await p.evaluate(() => {
  const sel = "a,button,[role=button],input,textarea,select,h1,h2,h3,label,[role=tab],[role=switch]";
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || st.visibility === "hidden" || st.display === "none" || +st.opacity < 0.2) continue;
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (!text || text.length > 80) continue;
    out.push({ tag: el.tagName.toLowerCase(), text, box: [r.x, r.y + scrollY, r.width, r.height].map(Math.round), above_fold: r.y < innerHeight });
  }
  return { title: document.title, height: document.documentElement.scrollHeight, items: out.slice(0, 160) };
});
if (shot) await p.screenshot({ path: shot, type: "jpeg", quality: 70 });
fs.writeFileSync(out, JSON.stringify({ url, ...items }, null, 1));
await b.close();
console.log(JSON.stringify({ ok: true, items: items.items.length }));
