#!/usr/bin/env python3
"""
Assemble the ChatGPT research-pack skill from the Script Generator's own prompts.

The stage prompts are Jake's canonical text and must be word-for-word identical
to what the pipeline runs, so they are COPIED from server/src/scriptgen/prompts
here, never hand-maintained in a second place. The blocks the pipeline builds in
code (research date rules, the vendor-first searches, the outline fidelity rules,
the video query/selection rules, the system preamble) are rendered by running the
REAL compiled functions inside the lab container — see render_blocks().

Run from the host (needs docker + the running clipmagic-clipmagic-lab-1):
    python3 lab/chatgpt-skill/build.py
Output: lab/chatgpt-skill/dist/clipmagic-research-pack/ and .zip next to it.

Re-run whenever a prompt in scriptgen/prompts changes, and re-upload the zip.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import io
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
LAB = HERE.parent
SCRIPTGEN = LAB / "server" / "src" / "scriptgen"
PROMPTS = SCRIPTGEN / "prompts"
CONTAINER = "clipmagic-clipmagic-lab-1"
NAME = "clipmagic-research-pack"

# The code-built prompt blocks live in run.ts as non-exported functions. They are
# lifted out verbatim and executed as-is, so the rendered text is exactly what
# the pipeline sends.
RUN_TS_BLOCKS = [
    "briefBlock",
    "stepScaffoldBlock",
    "researchDateBlock",
    "storyStructureBlock",
    "outlineFidelityBlock",
    "screenshotBlock",
    "workflowBlock",
    "researchScopeBlock",
]

# Sentinels: numbers no real budget produces, swapped for placeholders after
# rendering. storyStructureBlock/outlineFidelityBlock do arithmetic on the budget.
BUDGET = 99999

RENDER_MJS = r"""
import * as b from "/root/skillrender/blocks.ts";
const src = await import("/app/dist/scriptgen/sources.js");
const vr = await import("/app/dist/scriptgen/videoResearch.js");
const pr = await import("/app/dist/scriptgen/prompts.js");
const W = { today: "{{TODAY}}", thisMonth: "{{THIS_MONTH}}", recent: "{{RECENT_WINDOW}}", oneYear: "{{ONE_YEAR_AGO}}" };
const B = %d;
const out = {
  brief: b.briefBlock("{{BRIEF}}"),
  steps: b.stepScaffoldBlock(),
  researchDate: b.researchDateBlock(W).replace(`update ${new Date().getFullYear()}"`, 'update {{YEAR}}"'),
  story: b.storyStructureBlock(B),
  fidelity: b.outlineFidelityBlock(W, B),
  shots: b.screenshotBlock("{{UI_VERIFICATION}}"),
  workflowNonDev: b.workflowBlock("{{VIDEO_WORKFLOWS}}", false),
  workflowDev: b.workflowBlock("{{VIDEO_WORKFLOWS}}", true),
  scope: b.researchScopeBlock("{{SPECIFIC_FOCUS}}"),
  firstParty: src.firstPartyBlock("Acmetool", ["acmetool.com", "acmetool.ai"]),
  audience: vr.audienceRule(false),
  queries: vr.queriesPrompt("{{CORE_TOPIC}}", "{{SPECIFIC_FOCUS}}", false),
  selection: vr.selectionPrompt("{{CORE_TOPIC}}", [], vr.VIDEO_COUNT, "{{SPECIFIC_FOCUS}}", false),
  consts: { SEARCH_MONTHS: vr.SEARCH_MONTHS, VIDEO_COUNT: vr.VIDEO_COUNT, QUERY_COUNT: vr.QUERY_COUNT },
  preambleOrganic: pr.systemPreamble(false, false),
  preambleSponsored: pr.systemPreamble(false, true),
};
process.stdout.write(JSON.stringify(out));
""" % BUDGET


def extract_blocks() -> str:
    src = (SCRIPTGEN / "run.ts").read_text()
    parts = ["type DateWindows = { today: string; thisMonth: string; recent: string; oneYear: string };"]
    for n in RUN_TS_BLOCKS:
        m = re.search(r"^function " + n + r"\(.*?^\}\n", src, re.S | re.M)
        if not m:
            sys.exit(f"build: could not find function {n} in run.ts")
        parts.append("export " + m.group(0))
    return "\n".join(parts)


def render_blocks() -> dict:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, text in (("blocks.ts", extract_blocks()), ("render.mjs", RENDER_MJS)):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    # docker cp is broken on this container ("mkdirat var/run") — tar-pipe instead.
    subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "sh", "-c",
         "rm -rf /root/skillrender && mkdir -p /root/skillrender && tar -C /root/skillrender -xf -"],
        input=buf.getvalue(), check=True,
    )
    # The .mjs runs from /app so the dist imports resolve their node_modules.
    res = subprocess.run(
        ["docker", "exec", CONTAINER, "sh", "-c",
         "cp /root/skillrender/render.mjs /app/.skillrender.mjs && "
         "node --experimental-strip-types /app/.skillrender.mjs; s=$?; rm -f /app/.skillrender.mjs; exit $s"],
        capture_output=True, check=True,
    )
    return json.loads(res.stdout)


def sub_budget(text: str) -> str:
    per_story = round((BUDGET * 0.62) / 3 / 50) * 50
    return (
        text.replace(f"**{per_story} words**", "**{{WORDS_PER_STORY}} words**")
        .replace(f"**{BUDGET} words**", "**{{WORD_BUDGET}} words**")
        .replace(f"roughly {round(BUDGET / 150)} minutes", "roughly {{MINUTES}} minutes")
    )


def sponsored_override(organic: str, sponsored: str) -> str:
    """The one section the two preambles differ in, as the sponsored text."""
    o, s = organic.splitlines(), sponsored.splitlines()
    i = 0
    while i < min(len(o), len(s)) and o[i] == s[i]:
        i += 1
    j = 0
    while j < min(len(o), len(s)) - i and o[-1 - j] == s[-1 - j]:
        j += 1
    return "\n".join(s[i: len(s) - j])


def prompt(name: str) -> str:
    return (PROMPTS / f"{name}.md").read_text()


def main() -> None:
    r = render_blocks()
    for k in ("story", "fidelity"):
        r[k] = sub_budget(r[k])
        if str(BUDGET) in r[k]:
            sys.exit(f"build: budget sentinel survived in {k}")
    fp = r["firstParty"].replace("Acmetool", "{{PRODUCT}}").replace("acmetool.com", "{{VENDOR_DOMAIN}}")
    fp = "\n".join(l for l in fp.splitlines() if "acmetool.ai" not in l)

    out = HERE / "dist" / NAME
    if out.exists():
        shutil.rmtree(out)
    (out / "references").mkdir(parents=True)
    (out / "templates").mkdir()

    shutil.copy(HERE / "src" / "SKILL.md", out / "SKILL.md")
    shutil.copy(HERE / "src" / "research-pack-template.md", out / "templates" / "research-pack-template.md")

    def ref(fname: str, title: str, body: str, note: str = "") -> None:
        head = f"<!-- {title}. Generated by lab/chatgpt-skill/build.py from the Script Generator. Do not edit here. -->\n"
        if note:
            head += f"<!-- {note} -->\n"
        (out / "references" / fname).write_text(head + "\n" + body.rstrip() + "\n")

    ref("01-system-context.md", "The system prompt every research/outline stage runs under (organic video)",
        r["preambleOrganic"])
    ref("02-sponsored-override.md", "For a SPONSORED video, this replaces the matching section of 01-system-context.md",
        sponsored_override(r["preambleOrganic"], r["preambleSponsored"]))
    ref("10-stage0.4-ui-check.md", "Stage 0.4 prompt, verbatim", prompt("stage0.4-screenshots"),
        "In the skill, 'screenshots taken by Jake' = the captures you made in the browser today.")

    vs = [
        "# How the pipeline finds the tutorials",
        "",
        f"- Window: published in the last **{r['consts']['SEARCH_MONTHS']} months** only. Never widen it — an old click path presented as current is the failure this stage exists to prevent.",
        f"- Searches: up to **{r['consts']['QUERY_COUNT']}**, each with the word `tutorial` appended. US / English results.",
        "- Drop anything under **4 minutes** (Shorts, teasers, 'what is X' explainers), anything not in English, and any title promising money ($, income, '/month', 'make money', 'passive income').",
        "- Candidates are ranked by views ONLY among those that pass relevance; relevance is judged with the selection rules below.",
        f"- Keep at most **{r['consts']['VIDEO_COUNT']}**.",
        "",
        "## Choosing the searches (the pipeline's exact prompt)",
        "",
        r["queries"],
        "",
        "## Choosing the videos (the pipeline's exact prompt — the candidates are the results you found)",
        "",
        r["selection"],
        "",
        "## The audience gate (omit ONLY when the developer-workflow answer at intake is yes)",
        "",
        r["audience"],
    ]
    ref("20-video-search.md", "Stage 1.6 video search + selection rules, rendered from videoResearch.ts", "\n".join(vs))
    ref("21-stage1.6-workflows.md", "Stage 1.6 prompt, verbatim", prompt("stage1.6-workflows"))
    ref("30-stage1-research.md", "Stage 1 prompt, verbatim", prompt("stage1-research"))
    ref("31-research-date-block.md", "Prepended to Stage 1, rendered from run.ts researchDateBlock()", r["researchDate"])
    ref("32-first-party-block.md", "Prepended to Stage 1 when the topic is a product, rendered from sources.ts firstPartyBlock()", fp,
        "{{VENDOR_DOMAIN}} = the product's real domain (list the likely alternatives too, e.g. .com/.ai/.io).")
    ref("40-stage1.5-factsheet.md", "Stage 1.5 prompt, verbatim", prompt("stage1.5-factsheet"))
    ref("50-stage2-outline.md", "Stage 2 prompt, verbatim", prompt("stage2-outline"))

    blocks = [
        "# Blocks the pipeline adds to the stages, rendered from run.ts",
        "",
        "Each section below is used where SKILL.md says. Fill the {{PLACEHOLDERS}}.",
        "",
        "# § BRIEF — in view of Stage 1, 1.5 and 2 when Jake gave a brief", r["brief"],
        "", "# § UI CHECK — in view of Stage 1.6, 1 and 2 when there is a UI VERIFICATION", r["shots"],
        "", "# § TUTORIALS (no developer workflow) — in view of Stage 1 and 2 when there is a workflow sheet", r["workflowNonDev"],
        "", "# § TUTORIALS (developer workflow = yes) — use INSTEAD of the one above", r["workflowDev"],
        "", "# § WHERE TO SPEND THE SEARCHES — with the tutorials block in Stage 1", r["scope"],
        "", "# § SCRIPT STRUCTURE — Stage 2, Tool Review ONLY, first", r["story"],
        "", "# § OUTLINE FIDELITY — Stage 2, before the outline prompt", r["fidelity"],
        "", "# § STEPS — Stage 2, after OUTLINE FIDELITY", r["steps"],
    ]
    ref("60-injected-blocks.md", "Code-built prompt blocks", "\n".join(blocks))
    ref("70-stage0-classify.md", "Stage 0 prompt, verbatim (intake: type, titles, focus, item count)", prompt("stage0-classify"))

    zpath = HERE / "dist" / f"{NAME}.zip"
    if zpath.exists():
        zpath.unlink()
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f"{NAME}/{f.relative_to(out)}")
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"built {out} ({total:,} bytes) and {zpath} ({zpath.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
