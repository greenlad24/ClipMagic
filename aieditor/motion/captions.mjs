// captions.mjs IN.json OUT.ass — word-by-word captions for the Auto Editor, built by the
// Lab's OWN caption code (/app/dist/render: captionChunks = the shared 2–3-word chunker,
// ass.ts = the karaoke ASS builder) so a short's captions read exactly like the
// short-form editor's (Jake 2026-10-04: "reuse the short-form editor's caption engine").
// Runs in the clipmagic-lab image: docker run … --entrypoint node clipmagic-lab:latest
//   /app/motion/captions.mjs /w/in.json /w/out.ass
// IN: { words: [{word, start, end}] (output-time seconds), width, height, duration,
//       template: "white-mont" | …, overrides?: {wordColor…}, keepClear?: true }
// keepClear (default): every caption sits in the engine's BOTTOM band (y = 0.80 H), so
// it never covers the graphics, which live in the 9:16 frame's shirt zone.
import fs from "node:fs";
const { buildAss } = await import("/app/dist/render/ass.js");
const { buildSubtitleEvents } = await import("/app/dist/render/captionChunks.js");
const { SUBTITLE_TEMPLATES } = await import("/app/dist/render/manifest.js");

const [inPath, outPath] = process.argv.slice(2);
const req = JSON.parse(fs.readFileSync(inPath, "utf8"));
const style = { ...SUBTITLE_TEMPLATES[req.template || "white-mont"], ...(req.overrides || {}) };
const events = buildSubtitleEvents(req.words);
const ass = await buildAss(events, {
  width: req.width, height: req.height, style, shift: (t) => t, duration: req.duration,
  overlayWindows: req.keepClear === false ? [] : [{ start: -1, end: req.duration + 1 }],
});
fs.writeFileSync(outPath, ass || "");
console.log(JSON.stringify({ events: events.length, bytes: (ass || "").length }));
