/**
 * Unit checks for the SHOOTING-POSITION mix (postiz/renderPosition + the
 * spacingId / fixedOrder additions to postiz/dropSequencing):
 *   - the T-number parser: real upload names, delimiters, and what must NOT match
 *   - positions drive ADJACENCY (no two of the same position in a row)
 *   - the day gap is enforced on spacingId, so few positions don't stretch a plan
 *   - a supplied fixedOrder is honored exactly, and still packed by cadence/gap
 *   - legacy behavior (no spacingId, no fixedOrder) is unchanged
 *
 * PURE — no DB, no network. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-position.test.ts
 */
import assert from "node:assert/strict";
import { positionKeyFromOriginal, POSITION_UNKNOWN } from "../postiz/renderPosition.js";
import { sequenceDrops, type DropFile } from "../postiz/dropSequencing.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

// ── the parser ────────────────────────────────────────────────────────────────
check("reads the position out of a real upload filename", () => {
  assert.equal(positionKeyFromOriginal("1787137810947_T7__253_Entry-Level_Squeeze.mp4"), "t7");
  assert.equal(positionKeyFromOriginal("1787064406688_T7__300__Value___The_centaur.mp4"), "t7");
  assert.equal(positionKeyFromOriginal("1787137729145_T7__249__11m_Jobs_Created.mp4"), "t7");
});

check("accepts the other delimiters and both cases", () => {
  assert.equal(positionKeyFromOriginal("T2 - hook.mp4"), "t2");
  assert.equal(positionKeyFromOriginal("shoot-t12-take3.mp4"), "t12");
  assert.equal(positionKeyFromOriginal("T6.mp4"), "t6");
  assert.equal(positionKeyFromOriginal("clip.T3.mov"), "t3");
});

check("normalizes leading zeros so T07 and T7 are one position", () => {
  assert.equal(positionKeyFromOriginal("a_T07_b.mp4"), "t7");
});

check("does NOT fire on a T that isn't a position token", () => {
  // The real trap: this file exists in the library and must not become "t"-anything.
  assert.equal(positionKeyFromOriginal("1787137785122_T7__252_T-Shaped_Skills.mp4"), "t7"); // real T7 still wins
  assert.equal(positionKeyFromOriginal("T-Shaped_Skills.mp4"), "");
  assert.equal(positionKeyFromOriginal("Entry-Level_Squeeze.mp4"), "");
  assert.equal(positionKeyFromOriginal("NEXT2_take.mp4"), "");
  assert.equal(positionKeyFromOriginal(""), "");
  assert.equal(positionKeyFromOriginal(null), "");
  assert.equal(positionKeyFromOriginal(undefined), "");
});

// ── adjacency ─────────────────────────────────────────────────────────────────
/** Build n files spread over the given position counts. */
function filesFor(counts: Record<string, number>, spacingPerFile = true): DropFile[] {
  const out: DropFile[] = [];
  for (const [pos, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      out.push({
        fileId: `${pos}-${i}`,
        groupId: pos,
        // Each render is its own filename "look" — exactly the nanoid situation.
        spacingId: spacingPerFile ? `${pos}-${i}` : pos,
      });
    }
  }
  return out;
}

function inOrder(a: ReturnType<typeof sequenceDrops>): string[] {
  return a.slice().sort((x, y) => x.order - y.order).map((x) => x.groupId);
}

check("no two clips of the same position land next to each other", () => {
  // The live distribution: T3:62 T7:46 T6:44 T2:30 — no position holds a majority.
  const files = filesFor({ t3: 62, t7: 46, t6: 44, t2: 30 });
  for (const seed of [1, 7, 4242, 99999]) {
    const seq = inOrder(sequenceDrops(files, { videosPerDay: 200, minGapDays: 3, seed }));
    assert.equal(seq.length, 182);
    const repeats = seq.filter((g, i) => i > 0 && g === seq[i - 1]).length;
    assert.equal(repeats, 0, `seed ${seed} produced ${repeats} same-position neighbours`);
  }
});

check("a dominant position repeats only as often as the counts force", () => {
  // 10 of one position and 2 of another cannot alternate: at best the 2 split the
  // run into 3 blocks, so 7 repeats is the arithmetic floor.
  const seq = inOrder(sequenceDrops(filesFor({ t1: 10, t2: 2 }), { videosPerDay: 50, minGapDays: 0, seed: 5 }));
  const repeats = seq.filter((g, i) => i > 0 && g === seq[i - 1]).length;
  assert.equal(repeats, 7);
});

check("unresolved renders share one group, so they can't run consecutively either", () => {
  const files = filesFor({ [POSITION_UNKNOWN]: 8, t3: 8 });
  const seq = inOrder(sequenceDrops(files, { videosPerDay: 50, minGapDays: 0, seed: 3 }));
  const repeats = seq.filter((g, i) => i > 0 && g === seq[i - 1]).length;
  assert.equal(repeats, 0);
});

// ── spacing is NOT the adjacency key ─────────────────────────────────────────
check("a 3-day gap on 4 positions does not stretch the plan", () => {
  // The trap this guards: if the gap were applied to the position, 182 clips over
  // 4 positions at gap 3 would sprawl across ~130+ days. Spacing is per-look.
  const a = sequenceDrops(filesFor({ t3: 62, t7: 46, t6: 44, t2: 30 }), {
    videosPerDay: 2,
    minGapDays: 3,
    seed: 1,
  });
  const days = Math.max(...a.map((x) => x.dayOffset)) + 1;
  assert.equal(days, 91, `expected 182/2 = 91 days, got ${days}`);
});

check("the gap still bites when files DO share a look", () => {
  const a = sequenceDrops(filesFor({ t1: 4, t2: 4 }, false), { videosPerDay: 4, minGapDays: 3, seed: 1 });
  const byGroup = new Map<string, number[]>();
  for (const x of a) byGroup.set(x.groupId, [...(byGroup.get(x.groupId) ?? []), x.dayOffset]);
  for (const [g, days] of byGroup) {
    const sorted = days.sort((p, q) => p - q);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] >= 3, `${g}: ${sorted[i - 1]} → ${sorted[i]} breaks the gap`);
    }
  }
});

check("legacy files with no spacingId behave exactly as before", () => {
  const legacy: DropFile[] = [
    { fileId: "a1", groupId: "alpha" },
    { fileId: "a2", groupId: "alpha" },
    { fileId: "b1", groupId: "beta" },
    { fileId: "b2", groupId: "beta" },
  ];
  const a = sequenceDrops(legacy, { videosPerDay: 4, minGapDays: 3, seed: 1 });
  const alphaDays = a.filter((x) => x.groupId === "alpha").map((x) => x.dayOffset).sort((p, q) => p - q);
  assert.ok(alphaDays[1] - alphaDays[0] >= 3, "the gap must still apply to groupId when spacingId is absent");
});

// ── fixedOrder ────────────────────────────────────────────────────────────────
check("a supplied order is emitted exactly, not re-shuffled", () => {
  const files = filesFor({ t1: 3, t2: 3 });
  const wanted = ["t2-0", "t1-0", "t2-1", "t1-1", "t2-2", "t1-2"];
  const a = sequenceDrops(files, { videosPerDay: 6, minGapDays: 0, seed: 1, fixedOrder: wanted });
  const got = a.slice().sort((x, y) => x.order - y.order).map((x) => x.fileId);
  assert.deepEqual(got, wanted);
});

check("a supplied order is still packed by cadence and gap", () => {
  const files = filesFor({ t1: 2, t2: 2 });
  const wanted = ["t1-0", "t2-0", "t1-1", "t2-1"];
  const a = sequenceDrops(files, { videosPerDay: 2, minGapDays: 0, seed: 1, fixedOrder: wanted });
  assert.deepEqual(
    a.slice().sort((x, y) => x.order - y.order).map((x) => x.dayOffset),
    [0, 0, 1, 1],
  );
});

check("ids missing from the supplied order still get placed, after the listed ones", () => {
  const files = filesFor({ t1: 2, t2: 2 });
  const a = sequenceDrops(files, { videosPerDay: 9, minGapDays: 0, seed: 1, fixedOrder: ["t2-1"] });
  const got = a.slice().sort((x, y) => x.order - y.order).map((x) => x.fileId);
  assert.equal(got[0], "t2-1");
  assert.equal(got.length, 4, "no video may be dropped");
  assert.equal(new Set(got).size, 4);
});

check("an empty fixedOrder falls through to the seeded interleave", () => {
  const files = filesFor({ t1: 6, t2: 6 });
  const withEmpty = inOrder(sequenceDrops(files, { videosPerDay: 20, minGapDays: 0, seed: 11, fixedOrder: [] }));
  const without = inOrder(sequenceDrops(files, { videosPerDay: 20, minGapDays: 0, seed: 11 }));
  assert.deepEqual(withEmpty, without);
});

console.log(`\n${passed} checks passed`);
