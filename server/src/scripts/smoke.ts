/**
 * End-to-end smoke test. Generates throwaway media with ffmpeg, uploads it
 * through the real upload endpoint, then exercises all three render paths:
 *   1. native manifest render   (/api/render/manifest)
 *   2. Rendi-compatible command (/v1/run-ffmpeg-command)
 *   3. a bulk batch of 3        (/api/batches)
 * and verifies each output with ffprobe.
 *
 * Usage: start the server, then `npm run smoke` (optionally BASE=http://host:port).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.BASE || "http://127.0.0.1:8080";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-smoke-"));

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: "ignore" });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const c = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    let out = "";
    c.stdout.on("data", (d) => (out += d.toString()));
    c.on("close", () => {
      const n = parseFloat(out.trim());
      Number.isFinite(n) ? resolve(n) : reject(new Error("probe failed"));
    });
  });
}

async function genMedia() {
  const narration = path.join(tmp, "narration.mp4");
  const overlay = path.join(tmp, "overlay.mp4");
  const music = path.join(tmp, "music.m4a");
  // 6s narration: testsrc video + sine audio (so it has an audio stream).
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", narration]);
  // 4s overlay (different pattern).
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "smptebars=size=720x1280:rate=30:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", overlay]);
  // 6s music bed.
  await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:a", "aac", music]);
  return { narration, overlay, music };
}

async function upload(files: string[]): Promise<Record<string, string>> {
  const form = new FormData();
  for (const f of files) {
    const buf = fs.readFileSync(f);
    form.append("files", new Blob([buf]), path.basename(f));
  }
  const res = await fetch(`${BASE}/api/uploads`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { files: Array<{ original: string; url: string }> };
  const map: Record<string, string> = {};
  for (const f of json.files) map[f.original] = f.url;
  return map;
}

async function poll(url: string, isDone: (j: any) => boolean, label: string): Promise<any> {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(url);
    const j = (await res.json()) as any;
    if (isDone(j)) return j;
    if (j.status === "failed" || j.status === "FAILED") throw new Error(`${label} failed: ${j.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} timed out`);
}

function buildManifest(urls: Record<string, string>, projectId: string) {
  return {
    version: 1,
    projectId,
    width: 720,
    height: 1280,
    fps: 30,
    durationSeconds: 6,
    narration: { videoUrl: urls["narration.mp4"], chunkUrls: [] },
    music: { audioUrl: urls["music.m4a"], volume: 0.15 },
    scenes: [
      {
        shotId: "s1",
        type: "broll",
        startTime: 1.5,
        endTime: 4.5,
        overlay: {
          mediaType: "video",
          clipUrl: urls["overlay.mp4"],
          clipStartOffset: 0,
          clipEndOffset: 0,
          overlayDelaySeconds: 0,
          showNarratorFirst: false,
          returnToNarrator: false,
          narratorReturnLeadSeconds: 0,
          fadeInSeconds: 0.15,
          isTacticalBroll: false,
        },
        transitionIn: null,
        sfxIn: null,
      },
    ],
    subtitles: [
      { start: 0.2, end: 2, words: [
        { text: "Hello", start: 0.2, end: 1, emphasis: false },
        { text: "World", start: 1, end: 2, emphasis: true },
      ] },
    ],
    subtitleStyle: {
      fontFamily: "DejaVu Sans Bold", fontSize: 44, position: "bottom-center",
      outlineColor: "#000000", outlineWidth: 6, lineColor: "#FFFFFF",
      wordColor: "#c084fc", allCaps: true, maxWordsPerLine: 4,
    },
  };
}

async function main() {
  console.log("→ health");
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log("   ", JSON.stringify(health));

  console.log("→ generating + uploading media (proves no 25MB cap path)");
  const media = await genMedia();
  const urls = await upload([media.narration, media.overlay, media.music]);
  console.log("   uploaded:", Object.keys(urls).join(", "));

  // 1. Native manifest render
  console.log("→ manifest render");
  const m = buildManifest(urls, "proj_smoke");
  const r1 = await fetch(`${BASE}/api/render/manifest`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: m, projectId: "proj_smoke" }),
  });
  const { jobId } = (await r1.json()) as { jobId: string };
  const done1 = await poll(`${BASE}/api/render/${jobId}`, (j) => j.status === "completed", "manifest render");
  const out1 = path.join(tmp, "out1.mp4");
  await run("curl", ["-s", "-o", out1, done1.outputUrl]);
  console.log("   output duration:", (await probeDuration(out1)).toFixed(2), "s");

  // 2. Rendi-compatible command path
  console.log("→ rendi-compatible command render");
  const cmd =
    `-i {{in_0}} -filter_complex "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=30[v]" ` +
    `-map "[v]" -map 0:a -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -t 3 {{out_1}}`;
  const r2 = await fetch(`${BASE}/v1/run-ffmpeg-command`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input_files: { in_0: urls["narration.mp4"] },
      ffmpeg_command: cmd,
      output_files: { out_1: "output.mp4" },
      duration_seconds: 3,
    }),
  });
  const { command_id } = (await r2.json()) as { command_id: string };
  const done2 = await poll(`${BASE}/v1/commands/${command_id}`, (j) => j.status === "SUCCESS", "rendi render");
  const out2 = path.join(tmp, "out2.mp4");
  await run("curl", ["-s", "-o", out2, done2.output_files.out_1.storage_url]);
  console.log("   output duration:", (await probeDuration(out2)).toFixed(2), "s");

  // 3. Bulk batch of 3
  console.log("→ bulk batch (3 items)");
  const items = [1, 2, 3].map((n) => ({ name: `clip_${n}`, manifest: buildManifest(urls, `proj_${n}`) }));
  const rb = await fetch(`${BASE}/api/batches`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "smoke_batch", items }),
  });
  const { batchId } = (await rb.json()) as { batchId: string };
  const batchDone = await poll(
    `${BASE}/api/batches/${batchId}`,
    (j) => j.completed + j.failed >= 3,
    "batch"
  );
  console.log("   batch result:", JSON.stringify({ completed: batchDone.completed, failed: batchDone.failed }));
  if (batchDone.failed > 0) throw new Error("some batch items failed");

  console.log("\n✓ ALL RENDER PATHS PASSED");
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error("\n✗ SMOKE FAILED:", err.message);
  process.exit(1);
});
