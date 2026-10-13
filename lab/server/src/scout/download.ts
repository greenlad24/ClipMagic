/**
 * ⬇ Download one UX test as a zip (Jake 2026-10-13: "a download button in the
 * UX scout drawer … a specific report for a specific script including all of
 * the images, a good formatted PDF with all of the insights and the process").
 *
 *   GET /api/scout/jobs/:id/download  →  "UX test - <tool> - <script>.zip"
 *     UX test report.pdf        the print page /ux-report/:id (web
 *                               scout/UxReportPrint.tsx — the drawer's own
 *                               report renderer and step builder), printed by
 *                               the container's Chromium
 *     report.md                 the report as the tester wrote it
 *     process.md                every step, in order, with its screenshot file
 *     key-screenshots/K01 - <caption>.jpg
 *     screenshots/step-001.jpg  every screenshot, in step order
 *     files-given/              the files the tester was given to use
 *
 * The PDF page is opened with the DOWNLOADER'S OWN session cookie (forwarded
 * from this request), so nothing here mints a session or sits outside the gate.
 */
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { config } from "../config.js";
import { getJob, getTool, listEvents, jobDir, assetsDir, type ScoutEvent } from "./store.js";
import { getRun } from "../db/scriptRuns.js";
import { loadPuppeteer } from "../news/deepDiveMedia.js";

const safe = (s: string, n = 80) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n).trim();

function allEvents(jobId: string): ScoutEvent[] {
  const out: ScoutEvent[] = [];
  for (;;) {
    const page = listEvents(jobId, out.length ? out[out.length - 1].seq : 0, 400);
    out.push(...page);
    if (page.length < 400) return out;
  }
}

/** The steps as text — one block per screenshot, the actions before it and the notes after it. */
function processMarkdown(events: ScoutEvent[], shotName: Map<string, string>, keyNo: Map<string, number>, keyCaption: Map<string, string>): string {
  const lines: string[] = ["# The process — every step of the test", ""];
  let pending: string[] = [];
  let n = 0;
  for (const e of events) {
    const time = new Date(e.at).toISOString().slice(11, 19);
    if (e.kind === "action") pending.push(e.text);
    else if (e.kind === "shot" && e.file) {
      n++;
      const k = keyNo.get(e.file);
      lines.push(`## Step ${n}${k ? ` · K${k}` : ""} — ${e.text}`, `_${time} UTC · screenshots/${shotName.get(e.file) ?? e.file}_`, "");
      if (k && keyCaption.get(e.file)) lines.push(`**Key screenshot K${k}:** ${keyCaption.get(e.file)}`, "");
      for (const a of pending) lines.push(`- ${a}`);
      if (pending.length) lines.push("");
      pending = [];
    } else if (e.kind === "key_shot") continue; // shown under its own step (above)
    else if (e.kind === "note") lines.push(`> ${e.text.replace(/\n/g, "\n> ")}`, "");
    else if (e.kind === "error") lines.push(`> **Problem:** ${e.text}`, "");
  }
  for (const a of pending) lines.push(`- ${a}`);
  return lines.join("\n") + "\n";
}

async function printPdf(jobId: string, title: string, cookie: string): Promise<Buffer> {
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    executablePath: process.env.DEEPDIVE_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars", "--mute-audio"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1400 });
    const base = `http://127.0.0.1:${config.port}`;
    const m = /(?:^|;\s*)cm_session=([^;]+)/.exec(cookie);
    if (m) await page.setCookie({ name: "cm_session", value: m[1], domain: "127.0.0.1", path: "/" });
    await page.goto(`${base}/ux-report/${encodeURIComponent(jobId)}?title=${encodeURIComponent(title)}`, { waitUntil: "networkidle0", timeout: 120_000 });
    // the page sets data-ready once the test is loaded and every screenshot has decoded
    await page.waitForSelector("[data-report-ready]", { timeout: 120_000 });
    const failed = await page.$eval("[data-report-ready]", (el: any) => el.getAttribute("data-report-error"));
    if (failed) throw new Error(failed);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font:9px system-ui,sans-serif;color:#888;padding:0 14mm;display:flex;justify-content:space-between"><span>${safe(title, 90).replace(/[<&]/g, "")}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function downloadScoutJob(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id);
  const job = getJob(id);
  if (!job) { res.status(404).json({ error: { message: "UX test not found." } }); return; }
  if (job.status !== "done") { res.status(409).json({ error: { message: `This UX test is ${job.status} — only a finished test can be downloaded.` } }); return; }
  const tool = getTool(job.toolSlug);
  const toolName = tool?.name || job.toolSlug;
  const run = job.runId ? getRun(job.runId) : null;
  const scriptTitle = run?.title || job.goal.slice(0, 70);
  const title = `UX test · ${toolName} · ${scriptTitle}`;

  let pdf: Buffer;
  try {
    pdf = await printPdf(id, title, String(req.headers.cookie ?? ""));
  } catch (e) {
    console.error("[scout] PDF failed:", e);
    res.status(500).json({ error: { message: `Couldn't make the PDF: ${(e as Error).message}` } });
    return;
  }

  const events = allEvents(id);
  const keyNo = new Map(job.keyShots.map((k, i) => [k.file, i + 1] as const));
  const shotName = new Map<string, string>();
  let n = 0;
  for (const e of events) {
    if (e.kind !== "shot" || !e.file || shotName.has(e.file)) continue;
    n++;
    const k = keyNo.get(e.file);
    shotName.set(e.file, `step-${String(n).padStart(3, "0")}${k ? ` K${k}` : ""}.jpg`);
  }

  const zipName = `${safe(`UX test - ${toolName} - ${scriptTitle}`, 120)}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => { console.error("[scout] zip failed:", err); res.destroy(err); });
  archive.pipe(res);

  archive.append(pdf, { name: "UX test report.pdf" });
  const head = [`# ${title}`, "", `**Goal:** ${job.goal}`, job.summary ? `\n**In short:** ${job.summary}` : "", `\n**Tested:** ${job.finishedAt ?? ""} · ${shotName.size} screenshots`, "", "---", ""].join("\n");
  archive.append(head + (job.report ?? "") + "\n", { name: "report.md" });
  archive.append(processMarkdown(events, shotName, keyNo, new Map(job.keyShots.map((k) => [k.file, k.caption] as const))), { name: "process.md" });
  const dir = jobDir(id);
  job.keyShots.forEach((k, i) => {
    const p = path.join(dir, path.basename(k.file));
    if (fs.existsSync(p)) archive.file(p, { name: `key-screenshots/K${String(i + 1).padStart(2, "0")} - ${safe(k.caption, 70) || "screenshot"}.jpg` });
  });
  for (const [file, name] of shotName) {
    const p = path.join(dir, path.basename(file));
    if (fs.existsSync(p)) archive.file(p, { name: `screenshots/${name}` });
  }
  const assets = assetsDir(id);
  if (fs.existsSync(assets)) for (const f of fs.readdirSync(assets)) archive.file(path.join(assets, f), { name: `files-given/${f}` });
  await archive.finalize();
}
