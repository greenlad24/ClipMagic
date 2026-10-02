/**
 * Deep Dive media pipeline — the pure pieces: scene cuts → clip windows, and
 * the model's boxes (pixels of the copy it saw) → natural-pixel boxes.
 *
 *   node --experimental-strip-types src/scripts/deepdive-media.test.ts
 */
import assert from "node:assert/strict";
import { buildWindows, toNaturalBox, MEDIA_FILE_RE } from "../news/deepDiveMedia.js";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok ${n} - ${name}`); };

t("every window is 3–12s (except a short whole video)", () => {
  const cuts = [0.4, 1.0, 1.6, 2.2, 9.0, 9.5, 30.0, 31.0, 31.8, 45.2, 47.0, 60.0];
  const w = buildWindows(cuts, 70);
  for (const x of w) assert.ok(x.end - x.start >= 1.5 && x.end - x.start <= 12.01, JSON.stringify(x));
  for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].end - 0.01, "no overlap");
  assert.equal(w[0].start, 0);
  assert.equal(w[w.length - 1].end, 70);
});

t("a long static shot is split", () => {
  const w = buildWindows([], 40);
  assert.ok(w.length >= 4);
  assert.ok(w.every((x) => x.end - x.start <= 12));
});

t("a burst of tiny shots is merged", () => {
  const cuts = Array.from({ length: 20 }, (_, i) => 0.5 * (i + 1));
  const w = buildWindows(cuts, 10);
  assert.ok(w.length <= 3, JSON.stringify(w));
  assert.ok(w.every((x) => x.end - x.start >= 3));
});

t("toNaturalBox scales sent px → natural px, pads 4% and clamps", () => {
  assert.deepEqual(toNaturalBox([500, 500, 600, 600], 1000, 1000, 1000, 1000), [496, 496, 108, 108]);
  assert.deepEqual(toNaturalBox([640, 360, 740, 410], 1280, 720, 1920, 1080), [954, 536, 162, 83]);
  assert.deepEqual(toNaturalBox([-5, -5, 2000, 900], 1280, 720, 1920, 1080), [0, 0, 1920, 1080]);
  assert.equal(toNaturalBox([10, 10, 10, 10], 100, 100, 100, 100), null);
  assert.equal(toNaturalBox([1, 2, 3] as any, 100, 100, 100, 100), null);
});

t("served file names", () => {
  assert.ok(MEDIA_FILE_RE.test("0123456789abcdef.mp4"));
  assert.ok(MEDIA_FILE_RE.test("0123456789abcdef-t12.jpg"));
  assert.ok(!MEDIA_FILE_RE.test("0123456789abcdef.page.json"));
  assert.ok(!MEDIA_FILE_RE.test("../0123456789abcdef.mp4"));
});

console.log(`${n} passed`);
