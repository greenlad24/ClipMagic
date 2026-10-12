/**
 * Deep Dive templates = their own storylines (news/deepDiveTemplates.ts; Jake 2026-10-12).
 * Run: cd lab/server && npx tsx src/scripts/deepdive-templates.test.ts
 */
import assert from "node:assert/strict";

const t = await import("../news/deepDiveTemplates.js");
const v1 = await import("../news/deepDive.js");
const v2 = await import("../news/deepDiveV2.js");

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };

const V1 = new Set<string>(v1.SECTION_KINDS as readonly string[]);
const V2 = new Set<string>(v2.V2_KIND_LIST as readonly string[]);

check("every template id has a storyline, and every storyline a template", () => {
  assert.deepEqual([...v1.DEEP_DIVE_TEMPLATES].sort(), t.STORYLINES.map((s) => s.id).sort());
});
check("12 different storylines — no two alike", () => {
  assert.equal(t.STORYLINES.length, 12);
  assert.equal(new Set(t.STORYLINES.map((s) => s.name)).size, 12);
  assert.equal(new Set(t.STORYLINES.map((s) => s.arc)).size, 12);
});
check("every step names only chapter kinds that exist in its format; title first, takeaways last", () => {
  for (const s of t.STORYLINES.filter((x) => !x.legacy)) {
    for (const st of s.steps) {
      for (const k of st.v1) assert.ok(V1.has(k), `${s.id}/${st.role}: v1 kind ${k}`);
      for (const k of st.v2) assert.ok(V2.has(k), `${s.id}/${st.role}: v2 kind ${k}`);
    }
    assert.deepEqual([s.steps[0].v1, s.steps[0].v2], [["title"], ["title"]], `${s.id} opens on title`);
    const last = s.steps[s.steps.length - 1];
    assert.deepEqual([last.v1, last.v2], [["takeaways"], ["takeaways"]], `${s.id} closes on takeaways`);
  }
});
check("no template / an unknown one = the original payoff-first storyline, verbatim", () => {
  for (const id of [null, undefined, "", "nope", "jake"]) {
    const sl = t.storylineFor(id as any);
    assert.equal(sl.id, "jake");
    assert.equal(t.storylinePrompt(sl, "v1", "LEGACY-V1", "SHARED"), "LEGACY-V1");
  }
});
check("a template storyline prompt carries its steps, its kinds for the format and the shared rules", () => {
  const sl = t.storylineFor("midnight");
  const p1 = t.storylinePrompt(sl, "v1", "LEGACY", "SHARED-RULES");
  const p2 = t.storylinePrompt(sl, "v2", "LEGACY", "SHARED-RULES");
  assert.match(p1, /The Countdown/);
  assert.match(p1, /#5/);
  assert.match(p1, /SHARED-RULES/);
  assert.ok(p1.includes('"media"') && !p1.includes('"demo"'), "v1 kinds in the v1 prompt");
  assert.ok(p2.includes('"demo"') && !p2.includes('"media"'), "v2 kinds in the v2 prompt");
});
check("the script rules follow the storyline (the payoff-first lines are swapped, the rest kept)", () => {
  const base = { template: "" } as any;
  const legacy1 = v1.deepDiveRulesFor(base);
  const mystery1 = v1.deepDiveRulesFor({ ...base, template: "aurora" });
  assert.match(legacy1, /Section 2 is the payoff/);
  assert.doesNotMatch(mystery1, /Section 2 is the payoff/);
  assert.match(mystery1, /THE STORYLINE IS "The Mystery"/);
  assert.match(mystery1, /BEATS:/, "the other rules stay");
  const legacy2 = v2.v2ScriptRulesFor(base);
  const verdict2 = v2.v2ScriptRulesFor({ ...base, template: "mono" });
  assert.match(legacy2, /lead with the payoff/);
  assert.doesNotMatch(verdict2, /lead with the payoff/);
  assert.match(verdict2, /THE STORYLINE IS "The Verdict"/);
  assert.match(verdict2, /\[next\]/, "the beat-marker rule stays");
});
console.log(`\ndeepdive-templates: ${passed} passed`);
