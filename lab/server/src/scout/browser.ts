/**
 * UX Scout — the browser it uses.
 *
 * One persistent Chromium profile per tool (DATA_DIR/scout/profiles/<slug>),
 * held by the shared runtime (browser/runtime.ts). Jake logs in once through the
 * live console in the Lab; the cookies stay in the profile for later Scouts.
 *
 * Every action goes through the REAL mouse and keyboard (page.mouse / keyboard),
 * never element.click(): many app UIs are built on pointer events and ignore a
 * synthetic click (learned the hard way on Skool — skool/console.ts).
 *
 * Tabs: apps open new tabs (results, OAuth popups, "open in editor"). The Scout
 * follows a newly opened tab automatically and says so; `tabs` / `tab N` let
 * Claude switch back.
 *
 * NEVER-DO list (enforced by the skill, and these checks): no non-http(s)
 * navigation; file uploads only from the job's own assets folder.
 */
import fs from "node:fs";
import path from "node:path";
import { withPage, screenshotBase64, type BrowserProfile, type AnyPage } from "../browser/runtime.js";
import { profileDir, getTool, normalizeUrl, assetsDir, jobDir } from "./store.js";

function profileFor(slug: string): BrowserProfile {
  const tool = getTool(slug);
  if (!tool) throw new Error(`Unknown tool "${slug}".`);
  return { id: `scout-${tool.slug}`, dir: profileDir(tool.slug), home: tool.homeUrl };
}

/** Per tool: the tab the Scout is working in, and the tabs it has already seen. */
const tabState = new Map<string, { active: AnyPage | null; seen: Set<AnyPage> }>();

async function activePage(slug: string, base: AnyPage): Promise<{ page: AnyPage; switchedTo: string | null }> {
  const st = tabState.get(slug) ?? { active: null, seen: new Set<AnyPage>() };
  tabState.set(slug, st);
  let pages: AnyPage[] = [];
  try { pages = (await base.browser().pages()).filter((p: AnyPage) => !p.isClosed?.()); } catch { pages = [base]; }
  let switchedTo: string | null = null;
  const fresh = pages.filter((p) => !st.seen.has(p));
  if (st.seen.size && fresh.length) {
    // A tab opened since the last action — follow it, like a person would.
    st.active = fresh[fresh.length - 1];
    try { switchedTo = st.active.url(); } catch { switchedTo = "(new tab)"; }
  }
  for (const p of pages) st.seen.add(p);
  if (!st.active || st.active.isClosed?.() || !pages.includes(st.active)) st.active = pages[pages.length - 1] ?? base;
  try { await st.active.bringToFront(); } catch { /* best effort */ }
  try { await st.active.setViewport({ width: 1280, height: 900 }); } catch { /* best effort */ }
  return { page: st.active, switchedTo };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ActionResult {
  ok: boolean;
  message: string;
  url: string | null;
  title: string | null;
  /** JPEG base64 of the page after the action (console use, or saved by the caller). */
  image: string | null;
  /** Extra text output (read / text / tabs). */
  output?: string;
}

export type ScoutAction =
  | { action: "screenshot" }
  | { action: "goto"; url: string }
  | { action: "back" } | { action: "forward" } | { action: "reload" }
  | { action: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { action: "click_frac"; xFrac: number; yFrac: number }
  | { action: "click_ref"; ref: string; double?: boolean }
  | { action: "hover"; x: number; y: number }
  | { action: "hover_ref"; ref: string }
  | { action: "type"; text: string }
  | { action: "key"; combo: string; repeat?: number }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number; x?: number; y?: number }
  | { action: "wait"; seconds: number }
  | { action: "read"; all?: boolean }
  | { action: "text" }
  | { action: "tabs" }
  | { action: "tab"; index: number }
  | { action: "upload"; ref: string; file: string; jobId: string }
  | { action: "zoom"; x0: number; y0: number; x1: number; y1: number };

const MODS: Record<string, string> = { ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", shift: "Shift", alt: "Alt", option: "Alt" };
const KEYS: Record<string, string> = { enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", backspace: "Backspace", delete: "Delete", space: "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End" };

async function pressCombo(page: AnyPage, combo: string): Promise<void> {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (m) mods.push(m); else key = KEYS[p.toLowerCase()] ?? (p.length === 1 ? p : p[0].toUpperCase() + p.slice(1));
  }
  if (!key) throw new Error(`No key in "${combo}".`);
  for (const m of mods) await page.keyboard.down(m);
  try { await page.keyboard.press(key); } finally { for (const m of [...mods].reverse()) await page.keyboard.up(m); }
}

/**
 * Tag every visible interactive element with data-scout-ref and describe it —
 * the Scout's "accessibility tree". Refs stay valid until the page re-renders
 * that element; a stale ref is reported, never guessed.
 */
async function readPage(page: AnyPage, all: boolean): Promise<string> {
  return page.evaluate((includeAll: boolean) => {
    const g: any = globalThis as any;
    const doc = g.document;
    const sel = [
      "a[href]", "button", "input", "textarea", "select", "summary", "label[for]",
      "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=option]", "[role=checkbox]", "[role=switch]",
      "[role=radio]", "[role=combobox]", "[role=slider]", "[contenteditable=true]", "[contenteditable='']", "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const els: any[] = Array.from(doc.querySelectorAll(sel));
    if (includeAll) {
      for (const el of Array.from(doc.querySelectorAll("div,span,li,img,svg")) as any[]) {
        try { if (g.getComputedStyle(el).cursor === "pointer" && !els.includes(el)) els.push(el); } catch { /* skip */ }
      }
    }
    let next = Number(doc.body?.getAttribute("data-scout-next") || "1");
    const lines: string[] = [];
    const vw = g.innerWidth, vh = g.innerHeight;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = g.getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
      let ref = el.getAttribute("data-scout-ref");
      if (!ref) { ref = String(next++); el.setAttribute("data-scout-ref", ref); }
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? `input:${el.type || "text"}` : tag);
      const label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.value || "")
        .replace(/\s+/g, " ").trim().slice(0, 90);
      const state = [el.disabled ? "disabled" : "", el.checked ? "checked" : "", el.getAttribute("aria-selected") === "true" ? "selected" : "", el.getAttribute("aria-expanded") === "true" ? "expanded" : ""].filter(Boolean).join(",");
      const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      lines.push(`[ref_${ref}] ${role} "${label}"${state ? ` (${state})` : ""} @${cx},${cy}${onScreen ? "" : " (off-screen)"}`);
    }
    doc.body?.setAttribute("data-scout-next", String(next));
    const out = lines.join("\n");
    return out.length > 30000 ? `${out.slice(0, 30000)}\n… (truncated — scroll or use \`read\` after narrowing the page)` : out || "(no interactive elements found — try `read --all` or a screenshot)";
  }, all);
}

async function refCenter(page: AnyPage, ref: string): Promise<{ x: number; y: number }> {
  const id = ref.replace(/^ref_/, "");
  const handle = await page.$(`[data-scout-ref="${id.replace(/"/g, "")}"]`);
  if (!handle) throw new Error(`ref_${id} is stale or not on this page any more. Run \`read\` again for fresh refs.`);
  try { await handle.evaluate((el: any) => el.scrollIntoView({ block: "center", inline: "center" })); } catch { /* best effort */ }
  await sleep(250);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`ref_${id} is not visible (no box). Take a screenshot to see why.`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Run one action in the tool's browser. Never throws: failures come back as ok:false. */
export async function runAction(slug: string, act: ScoutAction): Promise<ActionResult> {
  let profile: BrowserProfile;
  try { profile = profileFor(slug); } catch (e) { return { ok: false, message: (e as Error).message, url: null, title: null, image: null }; }
  const res = await withPage(profile, async (base) => {
    const { page, switchedTo } = await activePage(slug, base);
    let message = "OK";
    let output: string | undefined;
    let settle = 900;
    try {
      switch (act.action) {
        case "screenshot": settle = 0; break;
        case "goto": {
          const url = normalizeUrl(act.url);
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e: any) => { if (!/timeout/i.test(String(e))) throw e; });
          message = `Opened ${url}`; settle = 2500; break;
        }
        case "back": await page.goBack({ timeout: 30_000 }).catch(() => null); settle = 1800; break;
        case "forward": await page.goForward({ timeout: 30_000 }).catch(() => null); settle = 1800; break;
        case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null); settle = 2500; break;
        case "click": await page.mouse.click(act.x, act.y, { button: act.button ?? "left", clickCount: act.double ? 2 : 1, delay: 40 }); settle = 1300; break;
        case "click_frac": {
          const vp = page.viewport() ?? { width: 1280, height: 900 };
          await page.mouse.click(Math.round(act.xFrac * vp.width), Math.round(act.yFrac * vp.height), { delay: 40 }); settle = 1300; break;
        }
        case "click_ref": { const c = await refCenter(page, act.ref); await page.mouse.click(c.x, c.y, { clickCount: act.double ? 2 : 1, delay: 40 }); message = `Clicked ${act.ref} at ${c.x},${c.y}`; settle = 1300; break; }
        case "hover": await page.mouse.move(act.x, act.y); settle = 700; break;
        case "hover_ref": { const c = await refCenter(page, act.ref); await page.mouse.move(c.x, c.y); settle = 700; break; }
        case "type": await page.keyboard.type(act.text, { delay: 25 }); settle = 500; break;
        case "key": for (let i = 0; i < Math.min(50, Math.max(1, act.repeat ?? 1)); i++) await pressCombo(page, act.combo); settle = 800; break;
        case "scroll": {
          const vp = page.viewport() ?? { width: 1280, height: 900 };
          await page.mouse.move(act.x ?? vp.width / 2, act.y ?? vp.height / 2);
          const n = Math.min(15, Math.max(1, act.amount ?? 3)) * 120;
          const dx = act.direction === "left" ? -n : act.direction === "right" ? n : 0;
          const dy = act.direction === "up" ? -n : act.direction === "down" ? n : 0;
          await page.mouse.wheel({ deltaX: dx, deltaY: dy }); settle = 700; break;
        }
        case "wait": { const s = Math.min(300, Math.max(1, act.seconds)); await sleep(s * 1000); message = `Waited ${s}s`; settle = 0; break; }
        case "read": output = await readPage(page, !!act.all); settle = 0; break;
        case "text": {
          const t: string = await page.evaluate(() => ((globalThis as any).document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"));
          output = t.length > 20000 ? `${t.slice(0, 20000)}\n… (truncated)` : t; settle = 0; break;
        }
        case "tabs": {
          const pages: AnyPage[] = (await base.browser().pages()).filter((p: AnyPage) => !p.isClosed?.());
          output = (await Promise.all(pages.map(async (p, i) => `${i}${p === page ? " (active)" : ""}: ${await p.title().catch(() => "")} — ${p.url()}`))).join("\n");
          settle = 0; break;
        }
        case "tab": {
          const pages: AnyPage[] = (await base.browser().pages()).filter((p: AnyPage) => !p.isClosed?.());
          const p = pages[act.index];
          if (!p) throw new Error(`No tab ${act.index}. Run \`tabs\`.`);
          tabState.get(slug)!.active = p; await p.bringToFront(); message = `Switched to tab ${act.index}`;
          const shot = await screenshotBase64(p, 72);
          return { ok: true, message, url: p.url(), title: await p.title().catch(() => null), image: shot };
        }
        case "upload": {
          const dir = assetsDir(act.jobId);
          const file = path.resolve(dir, act.file);
          if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) throw new Error(`"${act.file}" is not in this job's assets. Available: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(", ") || "(none)" : "(none)"}`);
          const id = act.ref.replace(/^ref_/, "");
          const handle = await page.$(`[data-scout-ref="${id.replace(/"/g, "")}"]`);
          if (!handle) throw new Error(`ref_${id} is stale. Run \`read\` again.`);
          const isFile = await handle.evaluate((el: any) => el.tagName === "INPUT" && el.type === "file");
          if (isFile) await handle.uploadFile(file);
          else {
            const c = await refCenter(page, act.ref);
            const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), page.mouse.click(c.x, c.y, { delay: 40 })]);
            await chooser.accept([file]);
          }
          message = `Uploaded ${path.basename(file)}`; settle = 2500; break;
        }
        case "zoom": {
          const clip = { x: act.x0, y: act.y0, width: Math.max(10, act.x1 - act.x0), height: Math.max(10, act.y1 - act.y0) };
          const buf = await page.screenshot({ type: "jpeg", quality: 85, clip, encoding: "base64" });
          return { ok: true, message: "Zoomed", url: page.url(), title: await page.title().catch(() => null), image: typeof buf === "string" ? buf : Buffer.from(buf).toString("base64") };
        }
      }
    } catch (e) {
      const shot = await screenshotBase64(page, 72);
      return { ok: false, message: e instanceof Error ? e.message : String(e), url: page.url(), title: await page.title().catch(() => null), image: shot };
    }
    if (settle) await sleep(settle);
    // A click may have opened a tab: follow it now so the screenshot shows it.
    const after = await activePage(slug, base);
    const switched = switchedTo ?? after.switchedTo;
    if (switched) message += ` — a new tab opened (${switched}); now working in it`;
    const shot = await screenshotBase64(after.page, 72);
    return { ok: true, message, url: after.page.url(), title: await after.page.title().catch(() => null), image: shot, output };
  });
  return res ?? { ok: false, message: "The browser could not be started.", url: null, title: null, image: null };
}

/** Save a base64 JPEG into the job folder; returns the file name. */
export function saveJobShot(jobId: string, image: string, seq: number): string {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(seq).padStart(4, "0")}.jpg`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(image, "base64"));
  return name;
}

/* ── session import (when a tool's login blocks the server) ─────────────────── */

/**
 * Bring a session over from Jake's own browser (Jake 2026-10-02: Linearity's
 * login answers 403 to the server's data-centre IP, email login too). Accepts a
 * cookie export (Cookie-Editor JSON, cookies.txt or a Cookie header) for the
 * tool's own domain, and/or a local-storage copy — Cognito / Firebase / Supabase
 * apps keep their session tokens in localStorage, not cookies. The profile is
 * persistent, so this is done once.
 *
 * localStorage copy = the JSON from running, in DevTools on the logged-in tab:
 *   copy(JSON.stringify({origin: location.origin, local: {...localStorage}}))
 * A bare {key: value} object is accepted too (applied to the tool's home origin).
 */
export async function importSession(slug: string, input: { cookies?: string; storage?: string }): Promise<{ cookies: number; storageKeys: number; origin: string | null; result: ActionResult }> {
  const { parseCookiesFor } = await import("../engage/cookies.js");
  const tool = getTool(slug);
  if (!tool) throw new Error("Unknown tool.");
  const host = new URL(tool.homeUrl).hostname.replace(/^www\./, "");
  const root = host.split(".").slice(-2).join(".");
  const parsed = input.cookies?.trim() ? parseCookiesFor(input.cookies, { domains: [root], defaultDomain: `.${root}` }) : { cookies: [], total: 0, kept: 0 };
  let origin: string | null = null;
  let local: Record<string, string> = {};
  if (input.storage?.trim()) {
    let obj: any;
    try { obj = JSON.parse(input.storage.trim()); } catch { throw new Error("The local-storage copy isn't valid JSON — paste exactly what the console copied."); }
    if (obj && typeof obj === "object" && obj.local && typeof obj.local === "object") { origin = typeof obj.origin === "string" ? obj.origin : null; local = obj.local; }
    else local = obj;
    if (!origin) origin = new URL(tool.homeUrl).origin;
    if (!new URL(origin).hostname.endsWith(root)) throw new Error(`That local storage is from ${origin}, not ${root}.`);
  }
  if (!parsed.cookies.length && !Object.keys(local).length) throw new Error(`Nothing to import for ${root} — check the cookies are from ${root} and the storage copy is from the logged-in tab.`);
  const profile = { id: `scout-${tool.slug}`, dir: profileDir(tool.slug), home: tool.homeUrl };
  await withPage(profile, async (page) => {
    if (parsed.cookies.length) await page.setCookie(...(parsed.cookies as any[]));
    if (origin && Object.keys(local).length) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.evaluate((items: Record<string, string>) => {
        for (const [k, v] of Object.entries(items)) { try { (globalThis as any).localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } catch { /* quota */ } }
      }, local);
    }
    return true;
  });
  const result = await runAction(slug, { action: "goto", url: origin ?? tool.homeUrl });
  return { cookies: parsed.cookies.length, storageKeys: Object.keys(local).length, origin, result };
}
