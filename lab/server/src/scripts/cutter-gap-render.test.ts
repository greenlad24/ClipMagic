/**
 * Real-ffmpeg verification of the inter-take GAP in the cut render path. The
 * timeline editor inserts a fixed pause (default 0.35s) between kept takes; this
 * proves the render honors it so the output duration == sum(kept) + gaps —
 * i.e. exactly the preview duration the editor showed.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-gap-render.test.ts
 * No API keys needed — pure ffmpeg.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCutArgs, type CutSpec } from "../render/cut.js";
import { previewDuration } from "../cutter/segments.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => (err += d.toString()));
    c.on("error", () => resolve({ code: -1, err: "spawn failed" }));
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
}
function probe(file: string, entry: string): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn(FFPROBE, ["-v", "error", "-show_entries", entry, "-of", "csv=p=0", file]);
    let out = ""; c.stdout.on("data", (d) => (out += d.toString()));
    c.on("close", () => resolve(out.trim()));
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cutter-gap-"));
  const src = path.join(tmp, "src.mp4");
  const out = path.join(tmp, "out.mp4");

  const gen = await run(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);
  if (gen.code !== 0) { console.error("FAIL  could not synthesize source\n", gen.err.slice(-400)); process.exit(1); }

  const GAP = 0.35;
  // Three kept takes (1.5s each = 4.5s) + 2 gaps of 0.35 = 5.2s expected.
  const segments = [{ start: 0.2, end: 1.7 }, { start: 2.2, end: 3.7 }, { start: 4.2, end: 5.7 }];
  const spec: CutSpec = { source: src, segments, hasAudio: true, gap: GAP };
  const { args, totalDuration } = buildCutArgs(spec, out);

  const body = segments.reduce((s, seg) => s + (seg.end - seg.start), 0);
  const expected = body + GAP * (segments.length - 1);
  let ok = true;

  if (Math.abs(totalDuration - expected) > 1e-6) {
    console.error(`FAIL  buildCutArgs totalDuration ${totalDuration} != expected ${expected}`); ok = false;
  } else console.log(`  ok  totalDuration ${totalDuration.toFixed(2)}s = kept ${body.toFixed(2)} + ${segments.length - 1}×${GAP} gaps`);

  // Same value the client preview would show.
  if (Math.abs(previewDuration(segments, GAP) - expected) > 1e-6) {
    console.error("FAIL  previewDuration != render totalDuration"); ok = false;
  } else console.log("  ok  client previewDuration == render totalDuration (parity)");

  // The filter graph holds the gap (tpad on video, apad on audio) on the first
  // two segments but NOT the last.
  const graph = fs.readFileSync(`${out}.filter.txt`, "utf8");
  const tpads = (graph.match(/tpad=stop_mode=clone/g) || []).length;
  const apads = (graph.match(/apad=pad_dur=/g) || []).length;
  if (tpads !== 2 || apads !== 2) { console.error(`FAIL  expected 2 tpad + 2 apad (got ${tpads}/${apads})`); ok = false; }
  else console.log("  ok  gap padding applied to all-but-last segment (2 video / 2 audio)");

  const render = await run(FFMPEG, args);
  if (render.code !== 0) { console.error("FAIL  render exited nonzero\n", render.err.slice(-600)); process.exit(1); }

  const dur = parseFloat(await probe(out, "format=duration"));
  if (!Number.isFinite(dur) || Math.abs(dur - expected) > 0.35) {
    console.error(`FAIL  output duration ${dur} != expected ~${expected.toFixed(2)}s`); ok = false;
  } else console.log(`  ok  rendered duration ${dur.toFixed(2)}s ≈ expected ${expected.toFixed(2)}s (gaps present)`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  if (!ok) process.exit(1);
  console.log("\ngap-render checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
