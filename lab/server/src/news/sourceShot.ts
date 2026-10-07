/**
 * AI News Stream — the SOURCE beat of a story (Jake, 2026-10-07): "a slow
 * scroll of the story source in full screen (not inside the presentation).
 * There's something powerful about seeing a source and they have unique
 * images … Right now to show this I'd have to switch tabs".
 *
 * News sites refuse to be framed, so the page is captured here, server-side:
 * one full-page screenshot of the story's best source (the real page, its real
 * images), stored as a JPEG and served behind the sign-in. The show screens
 * scroll it slowly (web daily/stage/StoryShow.tsx `SourceScroll`).
 *
 * HOW A PAGE IS TAKEN. Headless Chromium (the container's, via puppeteer-core —
 * the same one the Deep Dive page capture uses, and ONE AT A TIME with it:
 * `serialBrowser`), 1280 CSS px wide at 1.5× (= a 1920-px image, 1:1 on a
 * 1080p screen), ads/trackers/video blocked, cookie banners clicked away,
 * fixed bars and modal overlays hidden, the page walked top→bottom so lazy
 * images load, then cut at MAX_CSS_H.
 *
 * WHICH PAGE. The slide's best source (deck.ts already picked the biggest
 * READABLE outlet), then the next ones in outlets.ts priority order that
 * access.ts doesn't know to be walled — at most MAX_TRIES captures a story. A
 * page that comes back as an error / bot-check / sign-in or subscription wall,
 * or with almost no text, is skipped for the next.
 *
 * Stored on the slide (`news_slides.source_shot`, JSON): { file, url, name, w,
 * h, capturedAt } — or { failed, tried[] } when nothing could be taken, and
 * the story opens on its title card instead. Files are keyed by the URL, so a
 * rebuild or a second deck with the same source reuses the capture.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { config } from "../config.js";
import { isHardPaywall, wallPhrase } from "./access.js";
import { rankBestSources } from "./outlets.js";
import { CHROME_UA, DISMISS_COOKIES, FAILED_PAGE_RE, STEALTH_SCRIPT, loadPuppeteer, serialBrowser } from "./deepDiveMedia.js";
import { slides, stories, type SlideRecord } from "./db.js";

/** Beside the Deep Dive's media (already a known area of the data volume). */
export const shotDir = (): string => path.join(config.dataDir, "news-deepdive", "_sources");
export const SHOT_FILE_RE = /^[a-f0-9]{20}\.jpg$/;

const CSS_W = 1280;
const VIEW_H = 800;
const DPR = 1.5;
/** ~5 screens of page: the top of an article is what the audience sees in the few seconds it's up. */
const MAX_CSS_H = 4000;
const MAX_TRIES = 4;
/** A capture is reused for a week. */
const TTL_MS = 7 * 86_400_000;

export interface SourceShot { file: string; url: string; name: string; w: number; h: number; capturedAt: string }
export interface ShotResult { ok: boolean; shot?: SourceShot; tried: Array<{ name: string; url: string; reason: string }> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileFor = (url: string) => `${crypto.createHash("sha1").update(url).digest("hex").slice(0, 20)}.jpg`;

// Ads, trackers and consent managers: they slow the page, cover the article and
// (ads) put someone else's brand on Jake's screen.
const BLOCK_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|googletagservices\.com|adservice\.google\.[a-z.]+|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|rubiconproject\.com|pubmatic\.com|openx\.net|casalemedia\.com|moatads\.com|scorecardresearch\.com|chartbeat\.(com|net)|quantserve\.com|teads\.tv|sharethrough\.com|indexww\.com|smartadserver\.com|yieldmo\.com|33across\.com|media\.net|adsafeprotected\.com|doubleverify\.com|hotjar\.com|segment\.(io|com)|optimizely\.com|permutive\.(com|app)|piano\.io|tinypass\.com|connatix\.com|jwpcdn\.com|primis\.tech|anyclip\.com|ex\.co|playwire\.com)$/i;

/** Hide what sits on top of the article: fixed/sticky bars, modal overlays, scroll locks. */
const CLEAN_PAGE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('position', 'static', 'important');
    el.style.setProperty('height', 'auto', 'important');
  }
  let hidden = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'sticky') { el.style.setProperty('position', 'static', 'important'); continue; }
    if (cs.position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    const big = r.width * r.height > vw * vh * 0.35;
    const modal = el.matches('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="overlay" i],[class*="paywall" i],[id*="paywall" i],[class*="popup" i],[class*="newsletter" i],[class*="consent" i],[id*="consent" i],[class*="cookie" i],[id*="cookie" i]');
    // A fixed full-screen WRAPPER can hold the whole article — keep it, unpinned.
    if (big && !modal && (el.innerText || '').length > 1500) { el.style.setProperty('position', 'absolute', 'important'); continue; }
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  // Empty ad slots (the ads themselves are blocked): a box whose only text is "Advertisement".
  const AD = /^(advertisement|advertisements|ad|ads|sponsored|story continues below advertisement|scroll to continue)$/i;
  for (const el of document.querySelectorAll('body *')) {
    if (!el.isConnected || el.children.length > 6 || !AD.test((el.innerText || '').trim())) continue;
    let box = el;
    while (box.parentElement && box.parentElement !== document.body && AD.test((box.parentElement.innerText || '').trim())) box = box.parentElement;
    box.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  // Ad slots with NO text of their own: the "Ad" label is drawn by CSS (::before), and the slot keeps
  // a reserved min-height (Engadget's AdThrive divs leave 250px gaps). Empty + (ad-ish name or an
  // "Ad" pseudo label) + no picture/video inside = hide.
  const AD_NAME = /(^|[-_ ])(adthrive|ad-?slot|ad-?unit|ad-?container|ad-?wrapper|ad-?placeholder|ad-?wrap|dfp|gpt-ad|google-?ad|advert|advertisement|htl-ad|ad)([-_ 0-9]|$)/i;
  const AD_PSEUDO = /^["'](ad|ads|advertisement|sponsored)["']$/i;
  for (const el of document.querySelectorAll('body div, body aside, body section, body figure')) {
    if (!el.isConnected || (el.innerText || '').trim() || el.querySelector('img,picture,video,canvas,svg,iframe[src*="youtube"],iframe[src*="vimeo"],iframe[src*="twitter"],iframe[src*="instagram"]')) continue;
    const named = AD_NAME.test(String(el.className || '') + ' ' + el.id) || el.hasAttribute('data-ad') || el.hasAttribute('data-ad-slot');
    const labelled = AD_PSEUDO.test(getComputedStyle(el, '::before').content) || AD_PSEUDO.test(getComputedStyle(el, '::after').content);
    if (!named && !labelled) continue;
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  for (const v of document.querySelectorAll('video')) { try { v.pause(); } catch (e) {} }
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  return hidden;
})()`;

/** Candidates for a slide: its best source first, then the rest in priority order, walls skipped. */
export function shotCandidates(sl: SlideRecord): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  if (sl.bestSourceUrl) out.push({ name: sl.bestSourceName || "", url: sl.bestSourceUrl });
  const story = sl.story ? stories.get(sl.story) : undefined;
  let blogs: any[] = [], articles: any[] = [];
  try { blogs = JSON.parse(story?.blogSources || "[]"); } catch {}
  try { articles = JSON.parse(story?.articleSources || "[]"); } catch {}
  for (const b of rankBestSources(blogs, articles, story?.headline || sl.topicLabel || "")) {
    if (out.some((o) => o.url === b.url)) continue;
    if (/news\.google\.com/.test(b.url) || isHardPaywall(b.url)) continue;
    out.push({ name: b.name, url: b.url });
  }
  return out.slice(0, 8);
}

function cachedShot(url: string): SourceShot | null {
  const file = fileFor(url);
  const meta = path.join(shotDir(), `${file}.json`);
  try {
    const m = JSON.parse(fs.readFileSync(meta, "utf8")) as SourceShot;
    if (m.url === url && fs.existsSync(path.join(shotDir(), file)) && Date.now() - Date.parse(m.capturedAt) < TTL_MS) return m;
  } catch { /* none */ }
  return null;
}

/** One page → one JPEG, or the reason it can't be shown. `browser` is a puppeteer Browser. */
async function captureOne(browser: any, url: string, name: string): Promise<SourceShot | string> {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);
    await page.setUserAgent(CHROME_UA);
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setViewport({ width: CSS_W, height: VIEW_H, deviceScaleFactor: DPR });
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      try {
        const type = req.resourceType();
        let host = "";
        try { host = new URL(req.url()).hostname; } catch {}
        if (type === "media" || type === "websocket" || BLOCK_HOST.test(host)) req.abort().catch(() => {});
        else req.continue().catch(() => {});
      } catch { /* request already handled */ }
    });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (resp && resp.status() >= 400) return `the site answered ${resp.status()}`;
    await page.waitForNetworkIdle({ idleTime: 700, timeout: 12_000 }).catch(() => undefined);
    await sleep(800);
    await page.evaluate(DISMISS_COOKIES).catch(() => 0);
    await sleep(500);

    const head = String(await page.evaluate("(document.title || '') + '\\n' + (document.body ? document.body.innerText : '')").catch(() => ""));
    if (FAILED_PAGE_RE.test(head.slice(0, 800))) return `looks like an error or bot-check page ("${head.split("\n")[0].slice(0, 60)}")`;
    const wall = wallPhrase(head);
    if (wall) return `a sign-in / subscription wall ("${wall}")`;
    if (head.replace(/\s+/g, " ").trim().length < 600) return "almost no text on the page";

    // Walk down so lazy images and reveal-on-scroll blocks load, then back to the top.
    for (let y = 0; y < MAX_CSS_H; y += 600) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await sleep(180);
    }
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 8_000 }).catch(() => undefined);
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(300);
    await page.evaluate(CLEAN_PAGE).catch(() => 0);
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => undefined);
    // Images still decoding: give the visible ones a moment.
    await page.evaluate(`Promise.race([Promise.all([...document.images].filter(i => i.getBoundingClientRect().top < ${MAX_CSS_H} && !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))), new Promise(r => setTimeout(r, 4000))])`).catch(() => undefined);
    await sleep(300);

    const fullH = Number(await page.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || VIEW_H;
    const h = Math.max(VIEW_H, Math.min(MAX_CSS_H, fullH));
    const png: Buffer = Buffer.from(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: CSS_W, height: h }, captureBeyondViewport: true }));
    const file = fileFor(url);
    fs.mkdirSync(shotDir(), { recursive: true });
    const tmp = path.join(shotDir(), `${file}.tmp`);
    const info = await sharp(png, { limitInputPixels: false }).jpeg({ quality: 80, mozjpeg: true }).toFile(tmp);
    fs.renameSync(tmp, path.join(shotDir(), file));
    const shot: SourceShot = { file, url, name, w: info.width, h: info.height, capturedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(shotDir(), `${file}.json`), JSON.stringify(shot));
    return shot;
  } catch (e) {
    return `the page could not be loaded (${e instanceof Error ? e.message.slice(0, 80) : "error"})`;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function launch(): Promise<any> {
  const puppeteer = await loadPuppeteer();
  return puppeteer.launch({
    executablePath: process.env.DEEPDIVE_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-blink-features=AutomationControlled", "--lang=en-US"],
    defaultViewport: null,
  });
}

/** Capture the first showable source of each slide (one browser, one page at a time). */
export async function captureSlides(list: SlideRecord[], log?: (msg: string) => void): Promise<Map<string, ShotResult>> {
  const out = new Map<string, ShotResult>();
  let browser: any = null;
  try {
    for (const sl of list) {
      const tried: ShotResult["tried"] = [];
      let shot: SourceShot | undefined;
      let captures = 0;
      for (const c of shotCandidates(sl)) {
        const hit = cachedShot(c.url);
        if (hit) { shot = { ...hit, name: c.name || hit.name }; break; }
        if (captures >= MAX_TRIES) break;
        captures++;
        if (!browser) browser = await launch();
        const r = await captureOne(browser, c.url, c.name);
        if (typeof r === "string") { tried.push({ name: c.name, url: c.url, reason: r }); continue; }
        shot = r;
        break;
      }
      out.set(sl.id, { ok: !!shot, shot, tried });
      log?.(shot ? `Source page: ${shot.name || shot.url} (${sl.topicLabel?.slice(0, 40) ?? ""})` : `Source page: none showable for "${sl.topicLabel?.slice(0, 40) ?? ""}" — it opens on its title card`);
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }
  return out;
}

/** Store a result on its slide. */
function save(slideId: string, r: ShotResult): void {
  const value = r.shot ? JSON.stringify(r.shot) : JSON.stringify({ failed: true, tried: r.tried, capturedAt: new Date().toISOString() });
  slides.update(slideId, { sourceShot: value } as Partial<SlideRecord>);
}

const running = new Set<string>();

/**
 * Source pages for a deck's slides. `force` re-takes every one (else only
 * slides with none yet). Serialised with every other Chromium the news tools run.
 */
export async function captureDeckSources(deckId: string, opts: { force?: boolean; log?: (msg: string) => void } = {}): Promise<{ captured: number; failed: number; skipped: number }> {
  if (running.has(deckId)) return { captured: 0, failed: 0, skipped: 0 };
  running.add(deckId);
  try {
    const list = slides.where("deck_id = ? AND (deleted IS NULL OR deleted = 0)", deckId).sort((a, b) => (a.position || 0) - (b.position || 0));
    const todo = list.filter((s) => opts.force || !hasShot(s));
    const results = await serialBrowser(() => captureSlides(todo, opts.log));
    let captured = 0, failed = 0;
    for (const [id, r] of results) { save(id, r); if (r.ok) captured++; else failed++; }
    return { captured, failed, skipped: list.length - todo.length };
  } finally {
    running.delete(deckId);
  }
}

export function hasShot(sl: SlideRecord): boolean {
  try {
    const v = JSON.parse(sl.sourceShot || "null");
    return !!v?.file && fs.existsSync(path.join(shotDir(), v.file));
  } catch { return false; }
}
