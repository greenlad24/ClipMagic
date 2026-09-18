/**
 * Unit tests for the ChatGPT research-pack importer (scriptgen/researchPack.ts).
 * Pure module — run with node's strip-types after rewriting .js specifiers to
 * .ts (see clipmagic-lab-testing), or against the compiled dist.
 */
import {
  parseResearchPack,
  splitPack,
  parseSourceLines,
  parseVideoSourceLines,
  coercePackVideoType,
} from "../scriptgen/researchPack.js";

let passed = 0;
const fail: string[] = [];
function check(name: string, ok: boolean): void {
  if (ok) passed++;
  else fail.push(name);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
}

const NOW = new Date("2026-09-18T08:00:00Z");
const pad = (s: string, n: number) => s + "\n" + "Detail line with a dated fact (verified September 2026).\n".repeat(Math.ceil(n / 55));

const RESEARCH = pad("### WHAT CHANGED RECENTLY\n- Pricing moved to $29/month (Aug 2026).", 900);
const FACTS = pad("## PRICING & PLANS\n- $29/month (Sep 18 2026) [S1]\n\n## DO NOT CLAIM\n- Annual price.", 300);
const OUTLINE = [
  "# Blotato Tutorial",
  "",
  "#### ⏱️ HOOK (0:00-0:30)",
  "Open on the finished calendar.",
  "",
  "#### ⏱️ SETTING UP THE ACCOUNT (0:30-2:00)",
  "ON SCREEN: the sign-up page, then the empty dashboard.",
  "1. Go to Settings → Accounts and click Connect. [V1 @ 2:10]",
  "".padEnd(300, "x"),
  "",
  "#### ⏱️ SCHEDULING THE FIRST POST (2:00-5:00)",
  "ON SCREEN: the composer with a post being scheduled.",
  "".padEnd(300, "y"),
  "",
  "#### ⏱️ WRAP-UP",
  "Comment prompt.",
].join("\n");

function pack(over: Record<string, string | null> = {}): string {
  const sec: Record<string, string | null> = {
    SETUP: [
      "title: How I'd Automate My Socials With Blotato in 2026",
      "video_type: Tutorial",
      "core_topic: Blotato",
      "specific_focus: scheduling posts across platforms",
      "item_count: none",
      "researched_on: 2026-09-17",
    ].join("\n"),
    UI_VERIFICATION: "## WHAT THESE SHOTS ARE\n- [S1] Pricing page, monthly selected.",
    VIDEO_SOURCES: "- Blotato Full Tutorial | Some Channel | https://www.youtube.com/watch?v=abc123 | 2026-08-02 | 123,456",
    VIDEO_WORKFLOWS: "## WORKFLOWS\n### Connect accounts\n1. Settings → Accounts [V1 @ 2:10]",
    RESEARCH,
    SOURCES: "- Blotato Pricing | https://www.blotato.com/pricing\n- [A review](https://reviewsite.io/blotato-review).\n- dup | https://www.blotato.com/pricing",
    FACT_SHEET: FACTS,
    OUTLINE,
    ...over,
  };
  const lines = ["<<<CLIPMAGIC_RESEARCH_PACK v1>>>"];
  for (const [k, v] of Object.entries(sec)) {
    if (v === null) continue;
    lines.push(`<<<${k}>>>`, v);
  }
  lines.push("<<<END>>>");
  return lines.join("\n");
}

// ── A complete pack ──
const good = parseResearchPack(pack(), NOW);
check("a complete pack parses", good.ok);
if (good.ok) {
  const p = good.pack;
  check("title read", p.setup.title === "How I'd Automate My Socials With Blotato in 2026");
  check("video type read", p.setup.videoType === "Tutorial");
  check("item_count none → null", p.setup.itemCount === null);
  check("researched_on read", p.setup.researchedOn === "2026-09-17");
  check("research carried verbatim", p.research === RESEARCH.trim());
  check("outline carried verbatim", p.outline === OUTLINE.trim());
  check("UI check carried", p.uiVerification?.startsWith("## WHAT THESE SHOTS ARE") === true);
  check("sources deduped by url", p.sources.length === 2);
  check("pipe-form source title", p.sources[0].title === "Blotato Pricing");
  check("markdown-link source title + trailing dot stripped", p.sources[1].title === "A review" && p.sources[1].url === "https://reviewsite.io/blotato-review");
  check("video source parsed", p.videoSources.length === 1 && p.videoSources[0].views === 123456 && p.videoSources[0].publishedAt === "2026-08-02" && p.videoSources[0].channel === "Some Channel");
  check("no warnings on a complete, fresh pack", p.warnings.length === 0);
}

// ── Required sections ──
const noOutline = parseResearchPack(pack({ OUTLINE: null }), NOW);
check("missing OUTLINE is refused", !noOutline.ok && noOutline.errors.some((e) => e.includes("OUTLINE")));
const stub = parseResearchPack(pack({ RESEARCH: "Research goes here." }), NOW);
check("a stub RESEARCH is refused", !stub.ok && stub.errors.some((e) => /RESEARCH is only/.test(e)));
const noTitle = parseResearchPack(pack({ SETUP: "video_type: Tutorial\ncore_topic: Blotato" }), NOW);
check("missing title is refused", !noTitle.ok && noTitle.errors.some((e) => e.includes("title")));
const flat = parseResearchPack(pack({ OUTLINE: "Just a paragraph of outline with no headings. ".repeat(30) }), NOW);
check("an outline with no headings is refused", !flat.ok && flat.errors.some((e) => /fewer than two/.test(e)));
const notAPack = parseResearchPack("Here is your research!\n\n## Research\nlots of text", NOW);
check("a chat transcript with no markers is refused", !notAPack.ok && notAPack.errors[0].includes("No <<<SECTION>>> markers"));
check("empty input is refused", !parseResearchPack("   ", NOW).ok);

// ── Optional sections → warnings, not errors ──
const lean = parseResearchPack(pack({ UI_VERIFICATION: "none", VIDEO_WORKFLOWS: "none", VIDEO_SOURCES: "none" }), NOW);
check("no UI check / no videos still imports", lean.ok);
if (lean.ok) {
  check("...with uiVerification null", lean.pack.uiVerification === null);
  check("...with videoWorkflows null (so stage 1.6 is NOT re-bought)", lean.pack.videoWorkflows === null);
  check("...and both warned about", lean.pack.warnings.some((w) => /UI verification/.test(w)) && lean.pack.warnings.some((w) => /workflow sheet/.test(w)));
}
const stale = parseResearchPack(pack({ SETUP: "title: T\ncore_topic: X\nresearched_on: 2026-08-01" }), NOW);
check("a month-old pack warns about its age", stale.ok && stale.pack.warnings.some((w) => /48 days ago/.test(w)));
const noScreen = parseResearchPack(pack({ OUTLINE: OUTLINE.replace(/ON SCREEN:[^\n]*\n/g, "") }), NOW);
check("sections missing ON SCREEN warn", noScreen.ok && noScreen.pack.warnings.some((w) => /no ON SCREEN line/.test(w)));
const noDnc = parseResearchPack(pack({ FACT_SHEET: FACTS.replace("DO NOT CLAIM", "OTHER") }), NOW);
check("a fact sheet without DO NOT CLAIM warns", noDnc.ok && noDnc.pack.warnings.some((w) => /DO NOT CLAIM/.test(w)));

// ── What chat UIs do to the file ──
const decorated = pack()
  .replace("<<<SETUP>>>", "**<<<SETUP>>>**")
  .replace("<<<OUTLINE>>>", "`<<<outline>>>`")
  .replace("<<<FACT_SHEET>>>", "<<< FACT SHEET >>>")
  .replace("title: How", "- **title:** How");
const dec = parseResearchPack(decorated, NOW);
check("bold / backticked / lower-case / spaced markers still parse", dec.ok);
check("bold bullet setup keys still parse", dec.ok && dec.pack.setup.title.startsWith("How I'd"));
const fenced = parseResearchPack(pack({ RESEARCH: "```markdown\n" + RESEARCH + "\n```" }), NOW);
check("a whole-section ```markdown fence is unwrapped", fenced.ok && fenced.pack.research === RESEARCH.trim());
const innerFence = "Intro\n```\nPrompt the viewer types\n```\n" + RESEARCH;
const inner = parseResearchPack(pack({ RESEARCH: innerFence }), NOW);
check("an inner code fence is left alone", inner.ok && inner.pack.research.includes("```\nPrompt the viewer types\n```"));
const crlf = parseResearchPack(pack().replace(/\n/g, "\r\n"), NOW);
check("CRLF line endings parse", crlf.ok);
const dup = splitPack("<<<RESEARCH>>>\nfirst\n<<<RESEARCH>>>\nsecond\n<<<END>>>");
check("a repeated section keeps the last copy and reports it", dup.sections.get("RESEARCH") === "second" && dup.duplicates.includes("RESEARCH"));

// ── Small helpers ──
check("video type: 'Top 10 list' → List/Roundup", coercePackVideoType("Top 10 list") === "List/Roundup");
check("video type: 'tool review' → Tool Review", coercePackVideoType("tool review") === "Tool Review");
check("video type: unknown → Tutorial", coercePackVideoType("screencast") === "Tutorial");
check("list item_count read", (() => {
  const r = parseResearchPack(pack({ SETUP: "title: 7 Things\nvideo_type: List/Roundup\ncore_topic: Higgsfield\nitem_count: 7\nresearched_on: 2026-09-18" }), NOW);
  return r.ok && r.pack.setup.itemCount === 7 && r.pack.setup.videoType === "List/Roundup";
})());
check("bare URL source keeps the url as its title", parseSourceLines("https://example.com/a")[0].title === "https://example.com/a");
check("video line with 'views' suffix", parseVideoSourceLines("- T | C | https://youtu.be/x | 2026-07-01 | 5,000 views")[0].views === 5000);

console.log("");
if (fail.length) {
  console.log(`${passed} passed, ${fail.length} FAILED:`);
  for (const f of fail) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${passed} checks passed.`);
