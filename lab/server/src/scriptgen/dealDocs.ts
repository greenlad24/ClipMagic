/**
 * Turning everything a brand sends into something Claude can read (Jake
 * 2026-10-02: "all of the limits have to be solved first — most of the briefs
 * are in Notion or PDFs", "also Loom and videos shared over Drive").
 *
 * Every reader returns DocParts: text, PDFs (read by Claude as documents) and
 * images. dealBrief.ts collects them and makes ONE Opus call.
 *
 *   files   PDF → document · image → image · text → text
 *           Word / PowerPoint / Excel / OpenDocument / RTF → LibreOffice → PDF
 *           Keynote / Pages / Numbers → LibreOffice, else the images inside
 *           video / audio → ffmpeg → Groq Whisper (transcribeMediaFile)
 *   links   YouTube → transcript (fallback: yt-dlp audio)
 *           Google Docs / Slides / Sheets / Drive files & folders → Drive API
 *             (read-only grant on the sponsor inbox; private shares work),
 *             else the public export / download
 *           Notion (notion.so / notion.site) → a real browser, logged in as the
 *             sponsor inbox when the page is private (login code read from Gmail),
 *             every toggle opened, files inside the page downloaded
 *           Loom / Vimeo / Dropbox / Wistia / any video page → yt-dlp → transcript
 *           Dropbox files → direct download
 *           anything else → plain fetch, and a real browser when the page needs
 *             JavaScript to show its text
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transcribeWithGroq } from "../ai/transcribe.js";
import { fetchTranscript } from "./videoResearch.js";
import * as gmail from "../deals/integrations/gmail.js";
import { withPage, type BrowserProfile } from "../browser/runtime.js";
import { getTool, addTool, profileDir } from "../scout/store.js";

const run = promisify(execFile);

export interface DocParts {
  texts: string[];
  pdfs: Array<{ label: string; mediaType: "application/pdf"; data: string }>;
  images: Array<{ label: string; mediaType: string; data: string }>;
  /** What was read / not read, for the "Read" list in the UI. */
  notes: Array<{ label: string; read: boolean; note?: string }>;
}
export const emptyParts = (): DocParts => ({ texts: [], pdfs: [], images: [], notes: [] });
export function mergeParts(into: DocParts, more: DocParts): DocParts {
  into.texts.push(...more.texts); into.pdfs.push(...more.pdfs); into.images.push(...more.images); into.notes.push(...more.notes);
  return into;
}

const MAX_TEXT = 40_000;
const MAX_PDF = 30 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_MEDIA = 800 * 1024 * 1024;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n… (cut at ${n} characters)` : s);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 120);

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "dealdoc-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/* ── kinds ───────────────────────────────────────────────────────────────── */

const ext = (name: string) => (name.match(/\.([a-z0-9]{1,6})$/i)?.[1] ?? "").toLowerCase();
export const isMedia = (name: string, mime = "") => /^(video|audio)\//i.test(mime) || /^(mp4|mov|m4v|webm|mkv|avi|wmv|mp3|m4a|wav|aac|ogg|flac)$/.test(ext(name));
const isPdf = (name: string, mime = "") => /pdf/i.test(mime) || ext(name) === "pdf";
const isImage = (name: string, mime = "") => /^image\/(png|jpe?g|webp|gif)$/i.test(mime) || /^(png|jpe?g|webp|gif)$/.test(ext(name));
const isOffice = (name: string, mime = "") =>
  /^(docx?|pptx?|xlsx?|odt|odp|ods|rtf|ppsx?|dotx?)$/.test(ext(name)) ||
  /officedocument|msword|ms-powerpoint|ms-excel|opendocument|rtf/i.test(mime);
const isIWork = (name: string) => /^(key|pages|numbers)$/.test(ext(name));
const isText = (name: string, mime = "") => /^text\/|json|csv|markdown|xml/i.test(mime) || /^(txt|md|csv|tsv|json|srt|vtt)$/.test(ext(name));
const imageMime = (name: string, mime = "") => (/^image\//i.test(mime) ? mime.toLowerCase() : `image/${ext(name).replace("jpg", "jpeg") || "png"}`);

/* ── converters ──────────────────────────────────────────────────────────── */

/** Office / OpenDocument / RTF (and iWork, when LibreOffice can) → PDF bytes. */
export async function officeToPdf(buf: Buffer, name: string): Promise<Buffer> {
  return withTmp(async (dir) => {
    const src = path.join(dir, `in.${ext(name) || "docx"}`);
    await writeFile(src, buf);
    await run("soffice", [`-env:UserInstallation=file://${dir}/lo`, "--headless", "--norestore", "--nologo", "--convert-to", "pdf", "--outdir", dir, src], { timeout: 180_000 });
    const out = (await readdir(dir)).find((f) => f.endsWith(".pdf"));
    if (!out) throw new Error("LibreOffice produced no PDF");
    return readFile(path.join(dir, out));
  });
}

/** The pictures inside a Keynote / Pages / Numbers package (slide previews, screenshots). */
async function iworkImages(buf: Buffer): Promise<Buffer[]> {
  return withTmp(async (dir) => {
    const src = path.join(dir, "in.zip");
    await writeFile(src, buf);
    await run("unzip", ["-qq", "-o", src, "-d", path.join(dir, "x")], { timeout: 60_000 }).catch(() => undefined);
    const files: Array<{ p: string; size: number }> = [];
    const walk = async (d: string): Promise<void> => {
      for (const f of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) await walk(p);
        else if (/\.(jpe?g|png)$/i.test(f.name)) files.push({ p, size: (await stat(p)).size });
      }
    };
    await walk(path.join(dir, "x"));
    // Previews first, then the biggest pictures (slide content rather than icons).
    files.sort((a, b) => Number(/preview|thumb|quicklook/i.test(b.p)) - Number(/preview|thumb|quicklook/i.test(a.p)) || b.size - a.size);
    return Promise.all(files.filter((f) => f.size > 15_000 && f.size < MAX_IMAGE).slice(0, 12).map((f) => readFile(f.p)));
  });
}

/**
 * A PDF's own text, extracted INSIDE the Lab (poppler pdftotext). Text-based PDFs
 * (almost every contract and brief) are then sent as REDACTED TEXT — the PDF
 * itself never leaves the box. Only a scan with no text layer is sent as a PDF.
 */
async function pdfText(buf: Buffer): Promise<string> {
  return withTmp(async (dir) => {
    const src = path.join(dir, "in.pdf");
    await writeFile(src, buf);
    const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", src, "-"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    return String(stdout).replace(/\f/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  });
}

/** PDF bytes → redacted text when it has a text layer, else the PDF (a scan). */
async function pdfParts(buf: Buffer, label: string, how?: string): Promise<DocParts> {
  const p = emptyParts();
  const text = await pdfText(buf).catch(() => "");
  if (text.replace(/\s+/g, "").length > 300) {
    p.texts.push(`${label}${how ? ` (${how})` : ""}\n${clip(redactPersonal(text), 80_000)}`);
    p.notes.push({ label, read: true, note: [how, "personal details removed"].filter(Boolean).join(", ") });
  } else {
    if (buf.length > MAX_PDF) { p.notes.push({ label, read: false, note: "scanned PDF over 30 MB" }); return p; }
    p.pdfs.push({ label, mediaType: "application/pdf", data: buf.toString("base64") });
    p.notes.push({ label, read: true, note: "scanned PDF (no text layer) — read as pages" });
  }
  return p;
}

/** Any audio/video FILE on disk → transcript (mono 16 kHz 32 kbps, 20-minute parts, Groq Whisper). */
async function transcribeFile(file: string, dir: string): Promise<string> {
  await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", "1200", path.join(dir, "part%03d.mp3")], { timeout: 20 * 60_000 });
  const parts = (await readdir(dir)).filter((f) => /^part\d+\.mp3$/.test(f)).sort();
  if (!parts.length) throw new Error("no audio track");
  const texts: string[] = [];
  for (const p of parts) texts.push((await transcribeWithGroq({ data: await readFile(path.join(dir, p)), name: p, type: "audio/mpeg", wantWords: false })).text.trim());
  const text = texts.join("\n").trim();
  if (!text) throw new Error("the recording has no speech");
  return text;
}

export async function transcribeMediaBuffer(buf: Buffer, name: string): Promise<string> {
  return withTmp(async (dir) => {
    const src = path.join(dir, `in.${ext(name) || "mp4"}`);
    await writeFile(src, buf);
    return transcribeFile(src, dir);
  });
}

/** A video PAGE (Loom, Vimeo, Dropbox, Wistia, YouTube, Drive…) → transcript, via yt-dlp. */
export async function transcribeVideoUrl(url: string): Promise<string> {
  return withTmp(async (dir) => {
    await run("yt-dlp", ["--no-playlist", "--no-warnings", "-q", "-f", "bestaudio/best", "--max-filesize", "800M", "-o", path.join(dir, "media.%(ext)s"), url], { timeout: 15 * 60_000 });
    const media = (await readdir(dir)).find((f) => f.startsWith("media."));
    if (!media) throw new Error("nothing could be downloaded");
    return transcribeFile(path.join(dir, media), dir);
  });
}

/* ── one file (attachment, Drive download, Notion file…) ─────────────────── */

export async function fileToParts(buf: Buffer, name: string, mime: string, label: string): Promise<DocParts> {
  const p = emptyParts();
  if (SENSITIVE_DOC.test(name)) { p.notes.push({ label, read: false, note: "payment / identity paperwork — never opened" }); return p; }
  try {
    if (isPdf(name, mime)) {
      return pdfParts(buf, label);
    } else if (isImage(name, mime)) {
      if (buf.length > MAX_IMAGE) { p.notes.push({ label, read: false, note: "image over 5 MB" }); return p; }
      p.images.push({ label, mediaType: imageMime(name, mime), data: buf.toString("base64") });
      p.notes.push({ label, read: true });
    } else if (isMedia(name, mime)) {
      if (buf.length > MAX_MEDIA) { p.notes.push({ label, read: false, note: "video over 800 MB" }); return p; }
      p.texts.push(`${label} — TRANSCRIPT\n${clip(redactPersonal(await transcribeMediaBuffer(buf, name)))}`);
      p.notes.push({ label, read: true, note: "transcribed" });
    } else if (isOffice(name, mime)) {
      return pdfParts(await officeToPdf(buf, name), label, "converted");
    } else if (isIWork(name)) {
      try {
        return await pdfParts(await officeToPdf(buf, name), label, "converted");
      } catch {
        const imgs = await iworkImages(buf);
        if (!imgs.length) throw new Error("no readable pages or pictures inside — export it to PDF");
        imgs.forEach((im, i) => p.images.push({ label: `${label} — picture ${i + 1}`, mediaType: im[0] === 0x89 ? "image/png" : "image/jpeg", data: im.toString("base64") }));
        p.notes.push({ label, read: true, note: `read its ${imgs.length} slide picture(s) (text inside Keynote files isn't extractable)` });
      }
    } else if (isText(name, mime)) {
      p.texts.push(`${label}\n${clip(redactPersonal(buf.toString("utf8")))}`);
      p.notes.push({ label, read: true });
    } else {
      p.notes.push({ label, read: false, note: `unknown file type (${mime || ext(name) || "?"})` });
    }
  } catch (e) {
    p.notes.push({ label, read: false, note: `could not read (${errText(e)})` });
  }
  return p;
}

/* ── Google Drive (read-only grant first, public links second) ───────────── */

const googleId = (url: string) =>
  url.match(/\/(?:document|presentation|spreadsheets|file|forms)\/d\/(?:e\/)?([\w-]{20,})/)?.[1] ??
  url.match(/[?&]id=([\w-]{20,})/)?.[1] ??
  url.match(/\/folders\/([\w-]{10,})/)?.[1] ?? null;

const EXPORT_AS: Record<string, { mime: string; name: string }> = {
  "application/vnd.google-apps.document": { mime: "application/pdf", name: "doc.pdf" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", name: "slides.pdf" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", name: "sheet.csv" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", name: "drawing.pdf" },
};

async function driveFileParts(id: string, label: string, depth = 0): Promise<DocParts | null> {
  const meta = await gmail.driveGet(`/files/${id}`, { fields: "id,name,mimeType,size" });
  if (meta.status === 404 || meta.status === 403) return null; // not shared with the inbox → try the public route
  if (meta.status >= 400) throw new Error(`Drive ${meta.status}`);
  const { name, mimeType } = meta.json;
  const lab = `${label} — "${name}"`;
  if (mimeType === "application/vnd.google-apps.folder") {
    if (depth > 0) return emptyParts();
    const list = await gmail.driveGet("/files", { q: `'${id}' in parents and trashed = false`, fields: "files(id,name,mimeType)", pageSize: "15", includeItemsFromAllDrives: "true" });
    const out = emptyParts();
    out.notes.push({ label: lab, read: true, note: `folder — ${list.json?.files?.length ?? 0} file(s)` });
    for (const f of (list.json?.files ?? []).slice(0, 10)) {
      const sub = await driveFileParts(f.id, `${label} / ${f.name}`, depth + 1).catch((e) => ({ ...emptyParts(), notes: [{ label: `${label} / ${f.name}`, read: false, note: errText(e) }] }));
      if (sub) mergeParts(out, sub);
    }
    return out;
  }
  const exp = EXPORT_AS[mimeType];
  if (exp) {
    const r = await gmail.driveGet(`/files/${id}/export`, { mimeType: exp.mime }, true);
    if (!r.buf) throw new Error(`export failed (${r.status})`);
    return fileToParts(r.buf, exp.name, exp.mime, lab);
  }
  if (/^application\/vnd\.google-apps\./.test(mimeType)) return { ...emptyParts(), notes: [{ label: lab, read: false, note: `Google ${mimeType.split(".").pop()} can't be exported` }] };
  const r = await gmail.driveGet(`/files/${id}`, { alt: "media" }, true);
  if (!r.buf) throw new Error(`download failed (${r.status})`);
  return fileToParts(r.buf, name, mimeType, lab);
}

async function googleLinkParts(url: string, label: string): Promise<DocParts> {
  const id = googleId(url);
  if (id && (await gmail.driveGranted().catch(() => false))) {
    try {
      const viaApi = await driveFileParts(id, label);
      if (viaApi) return viaApi;
    } catch (e) { /* fall through to the public route */ void e; }
  }
  // Public route: exports for Google files, the download link for Drive files.
  const doc = url.match(/docs\.google\.com\/(document|presentation|spreadsheets)\/d\/([\w-]+)/);
  const publicUrl = doc
    ? `https://docs.google.com/${doc[1]}/d/${doc[2]}/export${doc[1] === "spreadsheets" ? "?format=csv" : "?format=pdf"}`
    : id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
  try {
    const res = await fetch(publicUrl, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && !/text\/html/i.test(type)) {
      const name = /pdf/.test(type) ? "file.pdf" : /csv/.test(type) ? "file.csv" : `file.${type.split("/")[1]?.split(";")[0] ?? "bin"}`;
      return fileToParts(Buffer.from(await res.arrayBuffer()), name, type, label);
    }
    // A big Drive video answers with a "can't scan for viruses" page — yt-dlp handles that.
    if (id && /drive\.google\.com/.test(url)) {
      try { return { ...emptyParts(), texts: [`${label} — TRANSCRIPT\n${clip(await transcribeVideoUrl(`https://drive.google.com/file/d/${id}/view`))}`], notes: [{ label, read: true, note: "transcribed" }] }; }
      catch { /* not a video */ }
    }
  } catch { /* report below */ }
  const granted = await gmail.driveGranted().catch(() => false);
  return { ...emptyParts(), notes: [{ label, read: false, note: granted ? "not shared with the sponsor inbox and not public" : "private — reconnect Gmail on the Deal Organizer Connections page to allow read-only Drive access" }] };
}

/* ── a real browser (Notion, and pages that need JavaScript) ─────────────── */

const READER_PROFILE: BrowserProfile = { id: "deal-reader", dir: path.join(process.env.DATA_DIR || "/data", "scriptgen", "browser-profile"), home: "https://www.google.com" };

function notionProfile(): BrowserProfile {
  // The Scout's "Notion" login (Tool logins in the Script Generator) — so Jake can also log in by hand there.
  if (!getTool("notion")) { try { addTool({ name: "Notion", homeUrl: "https://www.notion.so/login" }); } catch { /* exists */ } }
  return { id: "scout-notion", dir: profileDir("notion"), home: "https://www.notion.so" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Log Notion in as the sponsor inbox, reading the login code from Gmail. */
async function notionLogin(page: any): Promise<boolean> {
  const email = gmail.gmailConnected().email;
  if (!email) return false;
  const since = Math.floor(Date.now() / 1000) - 30;
  await page.goto("https://www.notion.so/login", { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => undefined);
  const field = await page.$('input[type="email"]');
  if (!field) return false;
  await field.click({ clickCount: 3 });
  await page.keyboard.type(email, { delay: 30 });
  await page.keyboard.press("Enter");
  await sleep(4000);
  // The code field appears after "Continue"; the code arrives by email.
  let code: string | null = null;
  for (let i = 0; i < 18 && !code; i++) {
    await sleep(5000);
    const list: any = await gmail.listMessages(`from:notion.so after:${since}`, 5).catch(() => ({}));
    for (const m of list?.messages ?? []) {
      const msg: any = await gmail.getMessage(m.id, "full").catch(() => null);
      const subject = (msg?.payload?.headers ?? []).find((h: any) => /^subject$/i.test(h.name))?.value ?? "";
      const hay = `${subject} ${msg?.snippet ?? ""}`;
      const found = hay.match(/\b([A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})+|\d{6})\b/)?.[1];
      if (found && /code/i.test(hay)) { code = found; break; }
    }
  }
  if (!code) return false;
  const codeField = (await page.$('input[type="text"]:not([type="email"])')) ?? (await page.$("input[placeholder*='code' i]"));
  if (!codeField) return false;
  await codeField.click({ clickCount: 3 });
  await page.keyboard.type(code, { delay: 40 });
  await page.keyboard.press("Enter");
  await sleep(8000);
  return !/\/login/.test(page.url());
}

/**
 * Read a rendered Notion page. Notion VIRTUALISES long pages: blocks scrolled
 * out of view are removed from the DOM, so reading innerText at the end returns
 * only the last screen (Linearity's brief came back as "11. …" — 161 of ~2,000
 * words). So: scroll down in steps, open every toggle that comes into view,
 * and COLLECT each top-level block's text by its block id as it passes, in
 * page order.
 */
async function readRenderedNotion(page: any): Promise<{ text: string; files: string[] }> {
  const blocks = new Map<string, string>();
  const files = new Set<string>();
  let title = "";
  let still = 0;
  for (let step = 0; step < 120 && still < 3; step++) {
    // Open what's collapsed in view (twice: a toggle can reveal another).
    for (let k = 0; k < 2; k++) {
      const opened: number = await page.evaluate(() => {
        const els = Array.from((globalThis as any).document.querySelectorAll('.notion-page-content [role="button"][aria-expanded="false"]')) as any[];
        els.slice(0, 50).forEach((el) => { try { el.click(); } catch { /* ignore */ } });
        return els.length;
      });
      if (!opened) break;
      await sleep(700);
    }
    const snap: { title: string; blocks: Array<[string, string]>; files: string[]; moved: boolean } = await page.evaluate(() => {
      const g: any = globalThis as any;
      const d = g.document;
      const root = d.querySelector(".notion-page-content");
      const out: Array<[string, string]> = [];
      // Top-level blocks: every [data-block-id] that isn't inside another block (they sit in wrappers).
      const all = Array.from(root?.querySelectorAll("[data-block-id]") ?? []) as any[];
      const top = all.filter((el) => !el.parentElement?.closest?.("[data-block-id]") || !root.contains(el.parentElement.closest("[data-block-id]")));
      for (const el of top) {
        const id = el.getAttribute?.("data-block-id") ?? "";
        const t = (el.innerText ?? "").trim();
        if (id && t) out.push([id, t]);
      }
      const fl = Array.from(d.querySelectorAll(".notion-page-content a[href]")).map((a: any) => a.href)
        .filter((h: string) => /file\.notion\.so|prod-files-secure|secure\.notion-static|\.pdf(\?|$)|\.(docx?|pptx?|mp4|mov)(\?|$)/i.test(h));
      const sc = d.querySelector(".notion-scroller.vertical") ?? d.scrollingElement;
      const before = sc.scrollTop;
      sc.scrollTop = before + Math.round(g.innerHeight * 0.7);
      const pageTitle = d.querySelector("h1")?.innerText ?? d.title ?? "";
      return { title: pageTitle, blocks: out, files: fl, moved: sc.scrollTop !== before };
    });
    if (!title) title = snap.title;
    for (const [id, t] of snap.blocks) if (!blocks.has(id) || (blocks.get(id)!.length < t.length)) blocks.set(id, t);
    for (const f of snap.files) files.add(f);
    still = snap.moved ? 0 : still + 1;
    await sleep(450);
  }
  // Map insertion order = order the blocks first appeared while scrolling down = page order.
  return { text: `${title}\n\n${[...blocks.values()].join("\n\n")}`.trim(), files: [...files] };
}

async function notionParts(url: string, label: string): Promise<DocParts> {
  const out = emptyParts();
  const res = await withPage(notionProfile(), async (page) => {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => undefined);
    await sleep(2500);
    const walled = async () => /\/login|signup/.test(page.url()) || !(await page.$(".notion-page-content"));
    let loggedIn = false;
    // Automatic login is OFF (Jake 2026-10-02: "no on the Notion login"). A private page
    // is reported, and Jake can log in by hand once under Tool logins → Notion.
    if (await walled() && process.env.DEAL_NOTION_AUTO_LOGIN === "1") {
      loggedIn = await notionLogin(page);
      if (loggedIn) { await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 }).catch(() => undefined); await sleep(3000); }
    }
    if (await walled()) return { ok: false as const, note: loggedIn ? "logged in, but this page isn't shared with the sponsor inbox" : "private Notion page — ask the brand to share it publicly, or log in to Notion once under Script Generator → UX Scout → Tool logins" };
    const r = await readRenderedNotion(page);
    // Files inside the page: download in the page's own session (signed links / cookies).
    const files: Array<{ name: string; type: string; b64: string }> = [];
    for (const href of r.files.slice(0, 6)) {
      const got = await page.evaluate(async (h: string) => {
        try {
          const resp = await fetch(h, { credentials: "include" });
          if (!resp.ok) return null;
          const blob = await resp.blob();
          if (blob.size > 40 * 1024 * 1024) return null;
          const b64: string = await new Promise((resolve) => { const fr = new (globalThis as any).FileReader(); fr.onload = () => resolve(String(fr.result).split(",")[1] ?? ""); fr.readAsDataURL(blob); });
          const name = decodeURIComponent((h.split("?")[0].split("/").pop() ?? "file"));
          return { name, type: blob.type, b64 };
        } catch { return null; }
      }, href);
      if (got) files.push(got);
    }
    return { ok: true as const, text: r.text, files };
  });
  if (!res) { out.notes.push({ label, read: false, note: "the browser could not start" }); return out; }
  if (!res.ok) { out.notes.push({ label, read: false, note: res.note }); return out; }
  if (res.text.length < 80) { out.notes.push({ label, read: false, note: "the page rendered empty" }); return out; }
  out.texts.push(`${label} (Notion page)\n${clip(res.text)}`);
  out.notes.push({ label, read: true, note: res.files.length ? `+ ${res.files.length} file(s) inside` : undefined });
  for (const f of res.files) mergeParts(out, await fileToParts(Buffer.from(f.b64, "base64"), f.name, f.type, `${label} / ${f.name}`));
  return out;
}

/** Any page that needs JavaScript to show its text (DocSend, Canva, Pitch, Gamma, a SPA brief…). */
async function renderedPageText(url: string): Promise<string | null> {
  const text = await withPage(READER_PROFILE, async (page) => {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => undefined);
    await sleep(2500);
    return page.evaluate(() => ((globalThis as any).document.body?.innerText ?? "").trim());
  });
  return text && text.length > 200 ? text : null;
}

/* ── one link ────────────────────────────────────────────────────────────── */

const VIDEO_PAGE = /(?:loom\.com\/(?:share|embed)|vimeo\.com\/|player\.vimeo\.com|wistia\.(?:com|net)|vidyard\.com|streamable\.com|youtube\.com\/(?:watch|shorts|live)|youtu\.be\/|tella\.tv|screenpal|frame\.io)/i;
const youtubeId = (url: string) => url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null;

export async function linkToParts(url: string, label: string): Promise<DocParts> {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep raw */ }
  if (SENSITIVE_DOC.test(label) || SENSITIVE_DOC.test(decoded)) return { ...emptyParts(), notes: [{ label, read: false, note: "payment / identity paperwork — never opened" }] };
  const p = await linkToPartsRaw(url, label);
  p.texts = p.texts.map(redactPersonal); // transcripts, Notion, pages — personal details blanked before anything leaves the Lab
  return p;
}

async function linkToPartsRaw(url: string, label: string): Promise<DocParts> {
  try {
    // Video pages → transcript.
    const yt = youtubeId(url);
    if (yt) {
      const t = await fetchTranscript({ videoId: yt, title: "", channel: "", publishedAt: "", views: 0, seconds: 0, url }).catch(() => null);
      const text = t ?? (await transcribeVideoUrl(url).catch(() => null));
      return text ? { ...emptyParts(), texts: [`${label} — TRANSCRIPT\n${clip(text)}`], notes: [{ label, read: true, note: "transcribed" }] }
        : { ...emptyParts(), notes: [{ label, read: false, note: "no transcript and the audio couldn't be downloaded" }] };
    }
    if (VIDEO_PAGE.test(url)) {
      return { ...emptyParts(), texts: [`${label} — TRANSCRIPT\n${clip(await transcribeVideoUrl(url))}`], notes: [{ label, read: true, note: "transcribed" }] };
    }
    if (/(?:docs|drive)\.google\.com/.test(url)) return googleLinkParts(url, label);
    if (/notion\.(?:so|site|com)\b/.test(url)) return notionParts(url, label);
    if (/dropbox\.com/.test(url)) {
      const direct = url.replace(/([?&])dl=0/, "$1dl=1").replace(/^(?!.*[?&]dl=1)(.*)$/, (m) => `${m}${m.includes("?") ? "&" : "?"}dl=1`);
      const res = await fetch(direct, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(180_000) });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && !/text\/html/i.test(type)) {
        const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() ?? "file");
        return fileToParts(Buffer.from(await res.arrayBuffer()), name, type, label);
      }
    }
    // Anything else: a plain fetch, then a real browser if the page needs JavaScript.
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && !/text\/html/i.test(type) && !/^text\/plain/i.test(type)) {
      const name = decodeURIComponent(new URL(res.url).pathname.split("/").pop() ?? "file");
      return fileToParts(Buffer.from(await res.arrayBuffer()), name, type, label);
    }
    const html = res.ok ? await res.text() : "";
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 600) return { ...emptyParts(), texts: [`${label}\n${clip(text)}`], notes: [{ label, read: true }] };
    const rendered = await renderedPageText(url);
    if (rendered) return { ...emptyParts(), texts: [`${label} (rendered)\n${clip(rendered)}`], notes: [{ label, read: true, note: "read in a browser" }] };
    return { ...emptyParts(), notes: [{ label, read: false, note: res.ok ? "no readable text (it may need a sign-in)" : `the site answered ${res.status}` }] };
  } catch (e) {
    return { ...emptyParts(), notes: [{ label, read: false, note: `could not read (${errText(e)})` }] };
  }
}

/* ── Gmail attachments ───────────────────────────────────────────────────── */

/**
 * Download one attachment. Gmail attachment ids are NOT stable over time — an
 * id stored months ago can answer 500/404 — so on failure the message is read
 * again and the current id for the same filename is used.
 */
export async function downloadAttachment(messageId: string, attachmentId: string, filename: string): Promise<Buffer> {
  try {
    const a: any = await gmail.getAttachment(messageId, attachmentId);
    const buf = Buffer.from(String(a?.data ?? ""), "base64url");
    if (buf.length) return buf;
  } catch { /* stale id — look it up again */ }
  const msg: any = await gmail.getMessage(messageId, "full");
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; parts.push(p); for (const c of p.parts ?? []) walk(c); };
  walk(msg?.payload);
  const hit = parts.find((p) => p.filename === filename && p.body?.attachmentId) ?? parts.find((p) => p.filename && p.filename.toLowerCase() === filename.toLowerCase() && p.body?.attachmentId);
  if (!hit) throw new Error("the attachment is no longer in the email");
  const a: any = await gmail.getAttachment(messageId, hit.body.attachmentId);
  const buf = Buffer.from(String(a?.data ?? ""), "base64url");
  if (!buf.length) throw new Error("empty download");
  return buf;
}

/* ── privacy (Jake 2026-10-02: "no personal info should be out of the Lab — no
 *    invoices or personal details leak out") ───────────────────────────────── */

/** Payment / identity paperwork that is NEVER opened or sent anywhere. */
// Letter boundaries, not \\b: "Invoice_2026-09.pdf" has no word boundary after "Invoice" (the underscore is a word character).
export const SENSITIVE_DOC = /(?<![a-z])(invoice|inv[\s_-]?\d+|receipt|remittance|bank|iban|swift|wire|payment[\s_-]?(details|info|form)|billing|vendor[\s_-]?(form|setup|registration)|supplier[\s_-]?form|w[\s_-]?8(?:[\s_-]?ben(?:[\s_-]?e)?)?|w[\s_-]?9|1099|tax|vat[\s_-]?(cert|form|number)|passport|driver'?s?[\s_-]?licen[cs]e|id[\s_-]?card|purchase[\s_-]?order|\bpo[\s_-]?\d{3,})(?![a-z])/i;

const REDACTIONS: Array<[RegExp, string | ((m: string) => string)]> = [
  // IBAN, SWIFT/BIC, card numbers, routing/account numbers (labelled), tax ids (labelled)
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[bank details removed]"],
  [/\b(?:swift|bic)(?:\s*(?:code|\/bic))?\s*[:#]?\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi, "[bank details removed]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number removed]"],
  [/\b(?:account|acct|routing|aba|sort[\s-]?code|bsb|ifsc|clabe)\s*(?:no\.?|number|#)?\s*[:#]?\s*[A-Z0-9][A-Z0-9 -]{4,30}\d\b/gi, "[bank details removed]"],
  [/\b(?:tax|vat|ein|tin|ssn|steuer(?:nummer)?|ust-?id(?:nr)?)\s*(?:id|no\.?|number|#)?\s*[:#]?\s*[A-Z]{0,3}[0-9][0-9 -]{5,20}\b/gi, "[tax id removed]"],
  // phone numbers (international or with 9+ digits)
  [/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g, (m: string) => (m.replace(/\D/g, "").length >= 9 ? "[phone removed]" : m)],
  // email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email removed]"],
];

/** Blank personal / payment details out of text before it leaves the Lab or is stored. */
export function redactPersonal(text: string): string {
  let out = String(text ?? "");
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep as any);
  return out;
}

/** Deep-redact every string in a JSON value (Claude's answer, before it is stored). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactPersonal(value) as any;
  if (Array.isArray(value)) return value.map(redactDeep) as any;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as any).map(([k, v]) => [k, redactDeep(v)])) as any;
  return value;
}
