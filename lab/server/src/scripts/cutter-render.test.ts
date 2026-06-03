/**
 * Real-ffmpeg verification of the cut render path (render/cut.ts buildCutArgs),
 * including the new per-splice micro-fade. Synthesizes a short A/V test clip,
 * trims it to two keep-segments, concatenates, then ffprobes the result.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-render.test.ts
 * No API keys needed — pure ffmpeg.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCutArgs, type CutSpec } from "../render/cut.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d.toString()));
    c.on("error", () => resolve({ code: -1, err: "spawn failed" }));
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
}

function probe(file: string, entry: string): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn(FFPROBE, ["-v", "error", "-show_entries", entry, "-of", "csv=p=0", file]);
    let out = "";
    c.stdout.on("data", (d) => (out += d.toString()));
    c.on("close", () => resolve(out.trim()));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cutter-render-"));
  const src = path.join(tmp, "src.mp4");
  const out = path.join(tmp, "out.mp4");

  // 6s clip: color video + a 440Hz tone (so the audio path + fades exercise).
  const gen = await run(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);
  if (gen.code !== 0) { console.error("FAIL  could not synthesize source\n", gen.err.slice(-400)); process.exit(1); }

  // Keep [0.5,2.0] and [4.0,5.5] → expect ~3.0s output, audio present, 2 splices.
  const spec: CutSpec = {
    source: src,
    segments: [{ start: 0.5, end: 2.0 }, { start: 4.0, end: 5.5 }],
    hasAudio: true,
  };
  const { args, totalDuration } = buildCutArgs(spec, out);

  // The filter graph must contain a micro-fade on each kept audio segment.
  const graph = fs.readFileSync(`${out}.filter.txt`, "utf8");
  const fadeIns = (graph.match(/afade=t=in/g) || []).length;
  const fadeOuts = (graph.match(/afade=t=out/g) || []).length;
  let ok = true;
  if (fadeIns !== 2 || fadeOuts !== 2) {
    console.error(`FAIL  expected 2 fade-in + 2 fade-out (got ${fadeIns}/${fadeOuts})`);
    ok = false;
  } else {
    console.log("  ok  micro-fade applied to every audio splice (2 in / 2 out)");
  }

  const render = await run(FFMPEG, args);
  if (render.code !== 0) { console.error("FAIL  render exited nonzero\n", render.err.slice(-600)); process.exit(1); }

  const durStr = await probe(out, "format=duration");
  const dur = parseFloat(durStr);
  if (!Number.isFinite(dur) || Math.abs(dur - totalDuration) > 0.3) {
    console.error(`FAIL  output duration ${durStr} != expected ~${totalDuration.toFixed(2)}s`);
    ok = false;
  } else {
    console.log(`  ok  output duration ${dur.toFixed(2)}s ≈ expected ${totalDuration.toFixed(2)}s`);
  }

  const hasAudio = await probe(out, "stream=codec_type");
  if (!/audio/.test(hasAudio)) { console.error("FAIL  output missing audio stream"); ok = false; }
  else console.log("  ok  output has a valid audio stream");

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  if (!ok) process.exit(1);
  console.log("\nrender checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
