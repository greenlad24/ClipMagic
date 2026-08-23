/**
 * Unit checks for the Bulk Scheduler's HIDDEN-RENDERS store
 * (postiz/hiddenRenders): the persisted "not posting this" list behind the
 * picker's hide button.
 *
 *   - a missing file degrades to "nothing hidden" (never throws)
 *   - a CORRUPT file degrades the same way (never throws)
 *   - hide / restore round-trip through the file
 *   - both directions are IDEMPOTENT (a double-click can't duplicate or break)
 *   - the returned list is deduped + sorted, and junk entries are dropped
 *   - an empty request is a no-op that still reports the current list
 *   - AUTO-HIDE after a schedule run: a fully-posted render parks itself, a
 *     partially failed one does not, and non-render sources are never parked
 *
 * No network / no AI. Points at a throwaway file via BULK_HIDDEN_RENDERS_PATH,
 * so it never touches the real data dir. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-hidden-renders.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// MUST be set before importing the module under test (the path is resolved
// lazily per call, but this keeps the intent obvious and order-independent).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-renders-"));
const FILE = path.join(TMP, "bulk-hidden-renders.json");
process.env.BULK_HIDDEN_RENDERS_PATH = FILE;

const { listHiddenRenders, setRendersHidden, rendersToAutoHide } = await import(
  "../postiz/hiddenRenders.js"
);

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
  total++;
  try {
    reset();
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

/** Start every case from "no file on disk". */
function reset() {
  try {
    fs.rmSync(FILE);
  } catch {
    /* already absent */
  }
}

check("a missing file means nothing is hidden", () => {
  assert.deepEqual(listHiddenRenders(), []);
});

check("a corrupt file degrades to nothing hidden", () => {
  fs.writeFileSync(FILE, "{not json at all");
  assert.deepEqual(listHiddenRenders(), []);
});

check("a file with the wrong shape degrades to nothing hidden", () => {
  fs.writeFileSync(FILE, JSON.stringify({ names: "nope" }));
  assert.deepEqual(listHiddenRenders(), []);
});

check("hiding persists and is readable back", () => {
  const out = setRendersHidden(["b.mp4"], true);
  assert.deepEqual(out, ["b.mp4"]);
  assert.deepEqual(listHiddenRenders(), ["b.mp4"]);
  assert.ok(fs.existsSync(FILE), "expected the list to be written to disk");
});

check("hiding twice does not duplicate", () => {
  setRendersHidden(["a.mp4"], true);
  const out = setRendersHidden(["a.mp4"], true);
  assert.deepEqual(out, ["a.mp4"]);
});

check("restoring removes it, and restoring again is a no-op", () => {
  setRendersHidden(["a.mp4", "b.mp4"], true);
  assert.deepEqual(setRendersHidden(["a.mp4"], false), ["b.mp4"]);
  assert.deepEqual(setRendersHidden(["a.mp4"], false), ["b.mp4"]);
});

check("restoring something never hidden changes nothing", () => {
  setRendersHidden(["a.mp4"], true);
  assert.deepEqual(setRendersHidden(["ghost.mp4"], false), ["a.mp4"]);
});

check("many at once (hide all / restore all) work in one call", () => {
  assert.deepEqual(setRendersHidden(["c.mp4", "a.mp4", "b.mp4"], true), [
    "a.mp4",
    "b.mp4",
    "c.mp4",
  ]);
  assert.deepEqual(setRendersHidden(["c.mp4", "a.mp4", "b.mp4"], false), []);
});

check("the list comes back sorted regardless of insertion order", () => {
  setRendersHidden(["z.mp4"], true);
  setRendersHidden(["m.mp4"], true);
  setRendersHidden(["a.mp4"], true);
  assert.deepEqual(listHiddenRenders(), ["a.mp4", "m.mp4", "z.mp4"]);
});

check("junk names are dropped, valid ones in the same call still apply", () => {
  const out = setRendersHidden(["", null as unknown as string, "real.mp4"], true);
  assert.deepEqual(out, ["real.mp4"]);
});

check("an empty request writes nothing and reports the current list", () => {
  setRendersHidden(["a.mp4"], true);
  assert.deepEqual(setRendersHidden([], true), ["a.mp4"]);
  assert.deepEqual(setRendersHidden([], false), ["a.mp4"]);
});

check("hand-edited duplicates in the file are collapsed on read", () => {
  fs.writeFileSync(FILE, JSON.stringify({ names: ["dup.mp4", "dup.mp4", "x.mp4"] }));
  assert.deepEqual(listHiddenRenders(), ["dup.mp4", "x.mp4"]);
});

// ── auto-hide after a schedule run ───────────────────────────────────────────
const render = (fileId: string, ref: string) => ({ fileId, source: { kind: "render", ref } });

check("a render whose every post succeeded is parked", () => {
  const posts = [render("f1", "a.mp4"), render("f1", "a.mp4")];
  const results = [
    { fileId: "f1", ok: true },
    { fileId: "f1", ok: true },
  ];
  assert.deepEqual(rendersToAutoHide(posts, results), ["a.mp4"]);
});

check("a partially failed render stays visible for the retry", () => {
  const posts = [render("f1", "a.mp4"), render("f1", "a.mp4")];
  const results = [
    { fileId: "f1", ok: true },
    { fileId: "f1", ok: false },
  ];
  assert.deepEqual(rendersToAutoHide(posts, results), []);
});

check("a fully failed render is never parked", () => {
  assert.deepEqual(rendersToAutoHide([render("f1", "a.mp4")], [{ fileId: "f1", ok: false }]), []);
});

check("only the clean files in a mixed run are parked", () => {
  const posts = [render("f1", "a.mp4"), render("f2", "b.mp4"), render("f3", "c.mp4")];
  const results = [
    { fileId: "f1", ok: true },
    { fileId: "f2", ok: false },
    { fileId: "f3", ok: true },
  ];
  assert.deepEqual(rendersToAutoHide(posts, results), ["a.mp4", "c.mp4"]);
});

check("uploads and cloud clips have no picker tile, so they're never parked", () => {
  const posts = [
    { fileId: "u1", source: { kind: "upload", ref: "up.mp4" } },
    { fileId: "c1", source: { kind: "cloud", ref: "https://x/y.mp4" } },
  ];
  const results = [
    { fileId: "u1", ok: true },
    { fileId: "c1", ok: true },
  ];
  assert.deepEqual(rendersToAutoHide(posts, results), []);
});

check("a post with no result at all is not parked", () => {
  assert.deepEqual(rendersToAutoHide([render("f1", "a.mp4")], []), []);
});

check("auto-hide reaches the persisted list through setRendersHidden", () => {
  const names = rendersToAutoHide([render("f1", "posted.mp4")], [{ fileId: "f1", ok: true }]);
  assert.deepEqual(setRendersHidden(names, true), ["posted.mp4"]);
  assert.deepEqual(listHiddenRenders(), ["posted.mp4"]);
  // ...and it's restorable like any hand-hidden clip.
  assert.deepEqual(setRendersHidden(["posted.mp4"], false), []);
});

console.log(`\n${passed}/${total} checks passed`);
fs.rmSync(TMP, { recursive: true, force: true });
