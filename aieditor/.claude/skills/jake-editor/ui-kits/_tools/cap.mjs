// UI-kit capture driver (scratch helper; NOT part of the shared recorder).
// Same browser identity as agent_rec.mjs (macchrome.mjs), same click guard (clickguard.mjs), dark scheme,
// same CSS viewport 1536x864 @ 2560/1536. Adds what the recorder lacks: evaluate + PNG screenshots.
// File queue: write /w/q/NNNN.json {cmd,...}; result lands in /w/q/NNNN.out.json.
// EXTRA HARD RULES here: Enter is never pressed; nothing labelled send/submit/delete/rename/archive/share is clicked.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME, launchArgs, identity, dress } from "/app/screencast/macchrome.mjs";
import { check as guardCheck, describeInPage } from "/app/screencast/clickguard.mjs";

const W = "/w", Q = path.join(W, "q");
fs.mkdirSync(Q, { recursive: true });
const profileDir = process.argv[2] || undefined;
const SESSION = profileDir ? "logged_in" : "outside";
const CSS_W = 1536, CSS_H = 864, SCALE = +(process.env.CAP_SCALE || 2560 / 1536);
const log = (s) => fs.appendFileSync(path.join(W, "cap.log"), `${new Date().toISOString()} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profileDir,
  protocolTimeout: 300000, args: launchArgs(["--font-render-hinting=none", "--renderer-process-limit=1"]) });
const ID = await identity(browser);
const page = (await browser.pages())[0] ?? (await browser.newPage());
await dress(page, ID);
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: process.env.CAP_SCHEME || "dark" }]);
await page.setViewport({ width: CSS_W, height: CSS_H, deviceScaleFactor: SCALE });
page.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
browser.on("targetcreated", async (tg) => { if (tg.type() === "page") { try { const p = await tg.page(); if (p !== page) await p.close(); } catch {} } });
log(`started session=${SESSION} chrome=${ID.full}`);

const OWN_DENY = /\b(send|submit|delete|remove chat|rename|archive|share|log ?out|upgrade|buy|pay)\b/i;
async function guard(a, q) {
  const target = q ? await page.evaluate(describeInPage, q).catch(() => null) : null;
  const g = guardCheck(a, target, SESSION);
  if (!g.ok) return g;
  if (a.type === "key" && /enter|return/i.test(a.key || "")) return { ok: false, why: "Enter is never pressed in a kit capture" };
  if (a.type === "click" && target) {
    const labs = [target.text, target.aria, target.label, target.title, target.testid].filter(Boolean).join(" | ");
    if (OWN_DENY.test(labs) && !a.force_label_ok) return { ok: false, why: `own rule: "${labs.slice(0, 80)}"` };
  }
  return { ok: true, target };
}

async function run(m) {
  if (m.cmd === "open") {
    const g = await guard({ type: "open", url: m.url });
    if (!g.ok) return { ok: false, refused: g.why };
    await page.goto(m.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log(`goto: ${e}`));
    await sleep((m.settle ?? 5) * 1000);
    return { ok: true, url: page.url(), title: await page.title() };
  }
  if (m.cmd === "eval") {
    const code = fs.readFileSync(path.join(W, "js", m.file), "utf8");
    const r = await page.evaluate(`(async () => { const ARG = ${JSON.stringify(m.arg ?? null)}; ${code} })()`);
    if (m.out) { fs.writeFileSync(path.join(W, m.out), typeof r === "string" ? r : JSON.stringify(r, null, 1)); return { ok: true, out: m.out }; }
    return { ok: true, r };
  }
  if (m.cmd === "shot") {
    const o = { path: path.join(W, m.out), type: "png" };
    if (m.clip) o.clip = { x: m.clip[0], y: m.clip[1], width: m.clip[2], height: m.clip[3] };
    else if (m.selector) { const el = await page.$(m.selector); if (!el) return { ok: false, error: "no element" }; const b = await el.boundingBox(); const p = m.pad || 0; o.clip = { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p }; }
    await page.screenshot(o);
    return { ok: true, out: m.out, clip: o.clip || null };
  }
  if (m.cmd === "click" || m.cmd === "hover") {
    const q = m.selector ? { selector: m.selector, ...(m.nth != null ? { nth: m.nth } : {}) } : { x: m.x, y: m.y };
    const g = await guard({ type: m.cmd === "click" ? "click" : "hover", selector: m.selector, x: m.x, y: m.y }, q);
    if (!g.ok) { log(`REFUSED ${JSON.stringify(m)} ${g.why}`); return { ok: false, refused: g.why }; }
    let x = m.x, y = m.y;
    if (m.selector) {
      const b = await page.evaluate((sel, nth) => { const all = [...document.querySelectorAll(sel)];
        const e = nth != null ? all[nth] : all.find((x) => { const r = x.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
        if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, m.selector, m.nth ?? null);
      if (!b) return { ok: false, error: "no element" };
      [x, y] = b;
    }
    await page.mouse.move(x, y, { steps: 5 });
    if (m.cmd === "click") await page.mouse.click(x, y);
    await sleep((m.settle ?? 1) * 1000);
    return { ok: true, at: [x, y], target: g.target };
  }
  if (m.cmd === "type") {
    const g = await guard({ type: "type", text: m.text }, { focused: true });
    if (!g.ok) return { ok: false, refused: g.why };
    await page.keyboard.type(m.text, { delay: 25 });
    await sleep(500);
    return { ok: true };
  }
  if (m.cmd === "key") {
    const g = await guard({ type: "key", key: m.key }, { focused: true });
    if (!g.ok) return { ok: false, refused: g.why };
    const parts = m.key.split("+");
    for (const p of parts.slice(0, -1)) await page.keyboard.down(p);
    await page.keyboard.press(parts[parts.length - 1]);
    for (const p of parts.slice(0, -1).reverse()) await page.keyboard.up(p);
    await sleep((m.settle ?? 0.6) * 1000);
    return { ok: true };
  }
  if (m.cmd === "scroll") {
    await page.mouse.move(m.x ?? CSS_W / 2, m.y ?? CSS_H / 2);
    await page.mouse.wheel({ deltaY: m.by || 400 });
    await sleep((m.settle ?? 1) * 1000);
    return { ok: true };
  }
  if (m.cmd === "url") return { ok: true, url: page.url() };
  return { ok: false, error: `unknown ${m.cmd}` };
}

let quit = false;
while (!quit) {
  const files = fs.readdirSync(Q).filter((f) => /^\d+\.json$/.test(f)).sort();
  for (const f of files) {
    const outp = path.join(Q, f.replace(".json", ".out.json"));
    if (fs.existsSync(outp)) continue;
    let m; try { m = JSON.parse(fs.readFileSync(path.join(Q, f), "utf8")); } catch { continue; }
    if (m.cmd === "quit") { fs.writeFileSync(outp, '{"ok":true}'); quit = true; break; }
    let r; try { r = await run(m); } catch (e) { r = { ok: false, error: String(e?.message || e).slice(0, 400) }; }
    fs.writeFileSync(outp, JSON.stringify(r));
    log(`${f} ${m.cmd} -> ${JSON.stringify(r).slice(0, 200)}`);
  }
  await sleep(200);
}
await browser.close();
log("quit");
process.exit(0);
