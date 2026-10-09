// Render the ChatGPT kit standalone (same DPR + crop as the live screenshots) → /s/rep/<state>.png
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { CHROME } from "/app/screencast/macchrome.mjs";

const K = JSON.parse(fs.readFileSync("/s/scene_kit.json", "utf8"));
const OUT = "/s/rep";
fs.mkdirSync(OUT, { recursive: true });
const DPR = 2560 / 1536;
// runtime.js fill(): escaped unless the key ends with _html
const fill = (tpl, vals) => String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
  const v = vals[k] == null ? "" : String(vals[k]);
  return k.endsWith("_html") ? v : v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
});
// prompt_menu.js scope(): every rule under .kit-chatgpt
const cls = "kit-chatgpt";
const scope = (css) => String(css || "").replace(/(^|\})\s*([^{}@]+)\{/g, (m, a, sel) =>
  `${a} ${sel.split(",").map((s) => (s.trim().startsWith(":root") ? `.${cls}` : `.${cls} ${s.trim()}`)).join(",")}{`);
const tokenCss = Object.entries(K.tokens).map(([k, v]) => `${k}:${v}`).join(";");
const icon = (label) => (K.menu.items.find((i) => i.label === label) || {}).icon_html || "";
const caret = '<span class="cg-caret"></span>';
const comp = (v) => fill(K.composer.html, { model: K.composer.model, placeholder: "", layout_class: "", caret_html: "", chips_html: "", state_html: "", ...v });
const chip = (v) => fill(K.chip.html, v);
// the attachment the capture used: the same canvas drawing
const thumbJs = `(() => { const c=document.createElement('canvas'); c.width=640; c.height=480; const g=c.getContext('2d'); const gr=g.createLinearGradient(0,0,0,480); gr.addColorStop(0,'#f6a96b'); gr.addColorStop(0.6,'#f3d9a4'); gr.addColorStop(1,'#d9c08f'); g.fillStyle=gr; g.fillRect(0,0,640,480); g.fillStyle='#fff3c4'; g.beginPath(); g.arc(320,250,60,0,7); g.fill(); g.fillStyle='#3d8fb8'; g.fillRect(0,300,640,60); document.querySelectorAll('img[data-thumb]').forEach(i=>i.src=c.toDataURL()); })()`;
const apple = "data:image/png;base64," + fs.readFileSync("/s/w/img3.png").toString("base64");
const items = K.menu.items.map((it, i) => fill(K.menu.item_html, { icon_html: it.icon_html, label: it.label, desc: it.desc }).replace('class="cg-item"', i === 0 ? 'class="cg-item cg-hover"' : 'class="cg-item"')).join("");

const STATES = {
  composer: { h: 100, css: K.composer.css, html: comp({ placeholder: K.composer.placeholder }) },
  "composer-short": { h: 100, css: K.composer.css, html: comp({ prompt: "Hi", caret_html: caret, layout_class: "is-multiline" }) },
  "composer-multiline": { h: 150, css: K.composer.css, html: comp({ prompt: "Create a photo of a glass bottle on a beach at sunset", caret_html: caret, layout_class: "is-multiline" }) },
  "composer-pill": { h: 150, css: K.composer.css + "\n" + K.chip.css, html: comp({ chips_html: chip({ kind: "skill", name: "Create image", icon_html: icon("Create image") }), prompt: "a glass bottle on a beach at sunset" }) },
  "composer-typing": { h: 100, css: K.composer.css, html: comp({ prompt: "Create a photo", caret_html: caret }) },
  "composer-attachments": { h: 294, css: K.composer.css + "\n" + K.chip.css, html: comp({ placeholder: K.composer.placeholder,
    chips_html: chip({ kind: "image", name: "beach-reference.png", thumb_html: '<img data-thumb alt="">' }) + chip({ kind: "file", name: "brief.txt" }) }) },
  "working-sweep": { h: 140, css: K.working.css, html: [-50, 10, 40, 80].map((x) => `<div style="--cg-sweep-x:${x}%;height:30px">` + fill(K.working.html, { text: "Creating image" }) + "</div>").join("") },
  menu: { h: 426, css: K.menu.css, html: fill(K.menu.html, { items_html: items }) },
  "result-image": { h: 500, top: 0, css: K.result.user.css + "\n" + K.result.image.css,
    html: `<div style="height:24.1px"></div><div style="width:768px;display:flex;justify-content:flex-end;align-items:center;gap:4px;height:28px;color:var(--cg-text-2)"><span style="display:flex">${fs.existsSync("/s/kit/chatgpt/assets/reply-arrow.svg") ? fs.readFileSync("/s/kit/chatgpt/assets/reply-arrow.svg", "utf8") : ""}</span><img src="${apple}" style="width:33.6px;height:28px;object-fit:cover;border-radius:4px;opacity:.5"></div>`
      + `<div style="height:8px"></div>` + fill(K.result.user.html, { text: "Make the aspect ratio 16:9", user_actions_html: K.result.user.user_actions_html })
      + `<div style="height:4px"></div>` + fill(K.result.image.html, { src: apple, alt: "Generated image 1", actions_html: K.result.image.actions_html }) },
  "result-text": { h: 440, css: K.result.user.css + "\n" + K.result.text.css + "\n" + K.working.css,
    html: fill(K.result.user.html, { text: "Create a small set of distinct logo options for my brand, company, or project. Make each option differ in concepts and keep them recognizable at small and large sizes. Preserve all supplied wording exactly. Do not invent brand names, taglines, or additional wording.\n\nAsk clarifying questions about the brand and purpose, required wording, intended impression, and visual style. Present relevant logo style directions when available.", user_actions_html: K.result.user.user_actions_html })
      + `<div style="height:4px"></div>` + fill(K.result.text.html, { text_html: "<p>I'll use your answers to create 3–4 distinct logo concepts, each designed to work at small and large sizes.</p>", actions_html: "" })
      + `<div style="height:22px"></div>` + fill(K.working.html, { text: "Waiting for your answer" }) },
};

const only = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--font-render-hinting=none", "--hide-scrollbars"] });
const page = await browser.newPage();
for (const [name, st] of Object.entries(STATES)) {
  if (only.length && !only.includes(name)) continue;
  await page.setViewport({ width: 816, height: st.h, deviceScaleFactor: DPR });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Inter";src:url("file:///fonts/Inter.ttf");font-weight:100 900}
html,body{margin:0;background:#000;width:816px;height:${st.h}px;overflow:hidden}
.wrap{position:absolute;left:24px;top:${st.top ?? 24}px;width:768px}
${scope(st.css)}
</style></head><body><div class="wrap ${cls}" style="${tokenCss}">${st.html}</div></body></html>`;
  fs.writeFileSync(`${OUT}/${name}.html`, html);
  await page.goto(`file://${OUT}/${name}.html`, { waitUntil: "load" });
  await page.evaluate(thumbJs);
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: 816, height: st.h } });
  console.log(name);
}
await browser.close();
