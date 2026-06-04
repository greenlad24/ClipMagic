/**
 * In-container PROOF that the pre-baked-executable render path works.
 *
 * Sets REMOTION_BROWSER_EXECUTABLE to an explicit Chromium binary and renders a
 * Remotion STILL via the SAME code path the production stages use
 * (motion/render.ts → browserExecutable() → selectComposition/renderMedia with
 * `browserExecutable`). This proves Remotion uses the supplied executable rather
 * than auto-downloading — the whole point of pre-baking Chromium into the image.
 *
 * Run with an explicit chrome:
 *   cd lab/server && \
 *   REMOTION_BROWSER_EXECUTABLE=/path/to/chrome \
 *   MOTION_ENTRY_POINT=../remotion/src/index.ts \
 *   npx tsx src/scripts/motion-render-proof.ts
 */
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { getBundle, importRenderer, browserExecutable, remotionRuntimeAvailable } from "../motion/render.js";

async function main() {
  const exe = browserExecutable();
  console.log(`[proof] REMOTION_BROWSER_EXECUTABLE = ${exe ?? "(unset)"}`);
  if (!exe) {
    console.error("[proof] No REMOTION_BROWSER_EXECUTABLE set — set it to prove the explicit path.");
    process.exit(2);
  }
  if (!fs.existsSync(exe)) {
    console.error(`[proof] Executable does not exist: ${exe}`);
    process.exit(2);
  }

  // 1) Runtime probe must succeed using the explicit executable (opens + closes
  //    the browser). If this passes, Chromium launched WITHOUT a download.
  const ready = await remotionRuntimeAvailable();
  console.log(`[proof] remotionRuntimeAvailable() = ${ready}`);
  if (!ready) {
    console.error("[proof] Probe failed — Chromium could not launch with the explicit executable.");
    process.exit(1);
  }

  // 2) Bundle + render a still of stat-callout through the real code path.
  const serveUrl = await getBundle();
  const { selectComposition, renderStill } = await importRenderer();
  const inputProps = { value: 10, suffix: "x", label: "Faster", durationInFrames: 60 };

  const composition = await selectComposition({
    serveUrl,
    id: "stat-callout",
    inputProps,
    browserExecutable: exe, // explicit pre-baked executable
  });

  const outFile = path.join(config.tmpDir, "motion-proof-stat-callout.png");
  fs.mkdirSync(config.tmpDir, { recursive: true });
  await renderStill({
    serveUrl,
    composition,
    frame: 40,
    output: outFile,
    inputProps,
    browserExecutable: exe, // explicit pre-baked executable
  });

  const size = fs.statSync(outFile).size;
  console.log(`[proof] rendered still: ${outFile} (${size} bytes)`);
  if (size < 1000) {
    console.error("[proof] Still is suspiciously small — render likely failed.");
    process.exit(1);
  }
  console.log("[proof] SUCCESS — Remotion rendered using the explicit pre-baked executable.");
}

main().catch((e) => {
  console.error("[proof] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
