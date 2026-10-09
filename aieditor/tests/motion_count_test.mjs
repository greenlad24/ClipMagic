// Count-up must reproduce the reference's REACH counter (gVPZU1btFA8 f3321–3353) EXACTLY,
// and the days counter on 22 of 23 frames (the reference skips "08").
// run: docker run --rm -v /opt/clipmagic/aieditor:/a:ro --entrypoint node clipmagic-lab:latest /a/tests/motion_count_test.mjs
import fs from "node:fs";
globalThis.window = {};
new Function(fs.readFileSync(new URL("../motion/engine.js", import.meta.url), "utf8"))();
const at = window.__textAt;
const REACH = [1235, 1346, 1542, 1833, 2234, 2760, 3431, 4273, 5316, 6600, 8177, 10108, 12469, 15332, 18731, 22582,
  26618, 30469, 33868, 36731, 39092, 41023, 42600, 43884, 44927, 45769, 46440, 46966, 47367, 47658, 47854, 47965, 48000];
const reach = { count: { from: 1200, to: 48000, start: 3320, dur: 33, ease: [0.65, 0, 0.35, 1] } };
let bad = 0;
REACH.forEach((v, i) => {
  const got = at(reach, 3321 + i), want = v.toLocaleString("en-US");
  if (got !== want) { bad++; console.log(`REACH f${3321 + i}: got ${got} want ${want}`); }
});
const DAYS = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 13, 13, 14];
const days = { count: { from: 1, to: 14, start: 3283.75, dur: 26, ease: [0.65, 0, 0.35, 1], pad: 2 } };
let dbad = 0;
DAYS.forEach((v, i) => { if (at(days, 3284 + i) !== String(v).padStart(2, "0")) dbad++; });
console.log(`REACH ${REACH.length - bad}/${REACH.length} exact; days ${DAYS.length - dbad}/${DAYS.length}`);

// Gap list G5 (p3): the screencast system the camera reads must carry the reference camera's numbers —
// nothing past ×1.65 (the old zoom_deep 2.0 is retired), moves timed 0.5–0.9 s ahead of the word, the
// ZM01 entry curve, same-app gotos as hard cuts, one ZM10 push per hold (no outward release/drift).
const sys = JSON.parse(fs.readFileSync(new URL("../motion/screencast_system.json", import.meta.url), "utf8"));
const cam = sys.camera || sys.screencast?.camera;
const g5 = [
  ["zoom_cap <= 1.65", cam.zoom_cap <= 1.65],
  ["zoom_deep <= 1.65 (2.0 retired)", cam.zoom_deep <= 1.65],
  ["word_lead_s inside 0.5-0.9", cam.word_lead_s >= 0.5 && cam.word_lead_s <= 0.9],
  ["ZM01 zoom-in curve (.31,.10,.22,1)", JSON.stringify(cam.zoom_in_ease) === JSON.stringify([0.31, 0.1, 0.22, 1.0])],
  ["same-site goto = hard cut", cam.xfade_same_site === false],
  ["hold_max_s 3 (P1)", cam.hold_max_s === 3.0],
  ["ZM10 push curve present", Array.isArray(cam.push_ease) && cam.push_ease.length === 4],
  ["typing not zoomed (K1)", cam.type_zoom === false],
];
const g5bad = g5.filter(([, ok]) => !ok);
g5bad.forEach(([n]) => console.log(`G5 camera system: FAIL ${n}`));
console.log(`G5 camera system ${g5.length - g5bad.length}/${g5.length}`);
process.exit(bad || g5bad.length ? 1 : 0);
