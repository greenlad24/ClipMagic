// Render a faithful preview PNG for each of the 4 subtitle templates using the
// SAME buildAss() the production renderer uses + the bundled fonts. Outputs one
// PNG per style and a stacked contact sheet. Run: node scripts/preview-subtitles.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAss } from "../dist/render/ass.js";
import { SUBTITLE_TEMPLATES } from "../dist/render/manifest.js";
import { config } from "../dist/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "..", "subtitle-previews");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(config.tmpDir, { recursive: true });
const fontsDir = path.dirname(config.fontFile);

const W = 1080, H = 1920;
const BG = "0x4a4f57"; // neutral mid-grey so light + dark styles both read

// Sample caption — 3 words, middle word emphasised so the active-word recolour
// (styles 1 & 2) is visible. Timed so t=0.7s lands on the middle word.
const words = [
  { text: "MAKE", start: 0.0, end: 0.5, emphasis: false },
  { text: "IT",   start: 0.5, end: 1.0, emphasis: true  },
  { text: "POP",  start: 1.0, end: 1.5, emphasis: false },
];
const subtitleEvent = { start: 0, end: 1.5, words, placement: "center", lines: 1 };

const sh = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn(config.ffmpegPath, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.slice(-800)))));
    p.on("error", reject);
  });

const ORDER = ["yellow-mont", "white-mont", "yellow-box", "black-on-yellow"];
const LABELS = {
  "yellow-mont": "1 - Yellow Italic",
  "white-mont": "2 - White Bold",
  "yellow-box": "3 - Yellow Box",
  "black-on-yellow": "4 - Black on Yellow",
};

const crops = [];
for (let i = 0; i < ORDER.length; i++) {
  const name = ORDER[i];
  const style = SUBTITLE_TEMPLATES[name];
  const ass = await buildAss([subtitleEvent], {
    width: W, height: H, style, shift: (t) => t, duration: 2, overlayWindows: [],
  });
  if (!ass) throw new Error(`buildAss returned null for ${name}`);
  const assPath = path.join(config.tmpDir, `prev_${name}.ass`);
  fs.writeFileSync(assPath, ass, "utf8");
  const full = path.join(OUT, `style-${i + 1}-${name}.png`);
  const fdEsc = fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:");
  const assEsc = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // Render the full 1080x1920 frame at t=0.7s.
  await sh([
    "-y", "-f", "lavfi", "-i", `color=c=${BG}:s=${W}x${H}:d=2`,
    "-vf", `ass=${assEsc}:fontsdir=${fdEsc}`,
    "-ss", "0.7", "-frames:v", "1", full, "-loglevel", "error",
  ]);

  // Crop a central band around the caption and add a label header.
  const crop = path.join(config.tmpDir, `crop_${name}.png`);
  const labelEsc = LABELS[name].replace(/:/g, "\\:");
  const dejavu = path.join(fontsDir, "DejaVuSans-Bold.ttf").replace(/:/g, "\\:");
  await sh([
    "-y", "-i", full,
    "-vf",
    `crop=${W}:560:0:680,` +
      `drawbox=x=0:y=0:w=iw:h=70:color=black@0.85:t=fill,` +
      `drawtext=fontfile='${dejavu}':text='${labelEsc}':x=24:y=18:fontsize=38:fontcolor=white`,
    "-frames:v", "1", crop, "-loglevel", "error",
  ]);
  crops.push(crop);
  console.log(`✓ ${name} -> ${full}`);
}

// Stack the 4 labelled crops into one contact sheet.
const sheet = path.join(OUT, "all-4-styles.png");
await sh([
  "-y",
  ...crops.flatMap((c) => ["-i", c]),
  "-filter_complex", `[0:v][1:v][2:v][3:v]vstack=inputs=4[v]`,
  "-map", "[v]", "-frames:v", "1", sheet, "-loglevel", "error",
]);
console.log(`✓ contact sheet -> ${sheet}`);
