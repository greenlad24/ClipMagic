/**
 * The 50-character page-title backstop (Skool greys out SAVE past it and
 * leaves an empty "New page" behind). Run from the builder stage:
 *   docker run --rm -e DB_PATH=/tmp/t.db -e DATA_DIR=/tmp -w /build/server X node dist/scripts/videoSeries.test.js
 */
import assert from "node:assert/strict";
import { fitTitle } from "../skool/videoLessons.js";
import { PAGE_TITLE_MAX } from "../skool/actions.js";

let passed = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

t("short titles are untouched", () => {
  assert.equal(fitTitle("Set Up Claude Cowork and Automate Real Work"), "Set Up Claude Cowork and Automate Real Work");
});
t("the two titles that failed live now fit, at a word boundary", () => {
  for (const raw of [
    "Make Consistent-Character UGC Videos with ChatGPT and Seedance",
    "Make Consistent UGC Videos with GPT-6 Astra and Seedance",
  ]) {
    const out = fitTitle(raw);
    assert.ok(out.length <= PAGE_TITLE_MAX, `${out} is ${out.length}`);
    assert.ok(raw.startsWith(out));
    assert.ok(raw[out.length] === " ", `cut mid-word: ${out}`);
  }
});
t("no trailing punctuation after the cut", () => {
  const out = fitTitle("Automate Invoices, Reports and Folders With Claude Cowork: Full Walkthrough");
  assert.ok(out.length <= PAGE_TITLE_MAX);
  assert.ok(!/[,:;\-–—\s]$/.test(out), out);
});
t("one enormous word is hard-cut rather than emptied", () => {
  const out = fitTitle("x".repeat(80));
  assert.equal(out.length, PAGE_TITLE_MAX);
});
t("whitespace is collapsed before measuring", () => {
  assert.equal(fitTitle("  Claude   Cowork \n Basics "), "Claude Cowork Basics");
});
console.log(`${passed}/5 passed`);
