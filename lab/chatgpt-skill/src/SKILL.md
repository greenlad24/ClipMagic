---
name: clipmagic-research-pack
description: Runs the research half of Jake Dawson's YouTube script methodology (check the product's UI in a real browser, read the newest high-view tutorials on the topic, live web research, fact sheet, detailed outline) and delivers ONE downloadable research-pack .md file that the ClipMagic Script Generator imports to write the script. Use whenever Jake asks to research a video, build a research pack, prep a script, research a tool for a video, or "do the research part" for a Jake Dawson video — even if he just names a topic or a tool.
---

# ClipMagic Research Pack

You are doing the **research half** of Jake Dawson's 7-stage scripting methodology. The ClipMagic Script Generator writes the script (hooks, sections, outro, review) afterwards. It **starts from your pack and trusts it completely**: it will not re-research anything. Whatever you get wrong, the script gets wrong. Whatever you leave out, the script cannot contain.

The deliverable is **one file**, `research-pack-<slug>.md`, in the exact format in `templates/research-pack-template.md`. Not a chat summary.

## Ground rules (read before every run)

1. **The stage prompts in `references/` are Jake's canonical text. Follow them word for word.** Never paraphrase, shorten, or "improve" them. Each stage below tells you which file to load and which placeholders to fill in.
2. **Every stage is its own step, with its own output.** Finish one stage's document before you start the next. A later stage must never quietly rewrite an earlier one's output. The pack carries each output exactly as that stage produced it.
3. **Do not skip stages to save time.** If a stage can't be done (for example, the product needs a login Jake hasn't given you), write what happened in that section and carry on. Never invent the missing output.
4. **The evidence order is fixed:** what you saw on screen today (UI check) > what the newest tutorials show > the written web. Each stage prompt explains how to apply it.
5. **Today's date matters.** Before you start, work out:
   - `{{TODAY}}`: today, e.g. "September 18, 2026"
   - `{{THIS_MONTH}}`: e.g. "September 2026"
   - `{{RECENT_WINDOW}}`: the month three months back, e.g. "June 2026"
   - `{{ONE_YEAR_AGO}}`: the month twelve months back, e.g. "September 2025"
   - `{{YEAR}}`: e.g. "2026"
6. **Tools.** Use **agent mode** (the browser) for the UI check and the YouTube transcripts. Use web search for Stage 1. If agent mode isn't available in this chat, say so at the start. Then ask Jake for screenshots of the product (pricing page, dashboard, the main feature screens) and treat those as the UI check.

## Stage 0: Intake (ask, then confirm)

Jake gives you an idea, a title, a tool or a brief. Before any research, settle these and **show them back to Jake in one short block for a yes or an edit**:

- **title**: the video's working title. If he only gave an idea, follow `references/70-stage0-classify.md` to propose 3–5 titles and let him pick.
- **video_type**: one of `Tutorial`, `List/Roundup`, `Tool Review`, `Business Guide`, `Opinion` (definitions in `references/70-stage0-classify.md`).
- **core_topic**: the tool, concept or strategy to research (short: a product name or a named concept).
- **specific_focus**: the angles and questions the research must answer, taken from the idea and the brief.
- **item_count**: for a list video, how many items the idea and brief actually support (never read off the title). Otherwise `none`.
- **brief**: anything Jake said about what the video must land. Keep it verbatim.
- **sponsored?**: organic (default) or sponsored by whom. This only changes the competitor rule. See `references/01-system-context.md` and `references/02-sponsored-override.md`.
- **developer workflow?**: `yes` only if the topic, focus or brief is about a developer tool or asks for one (CLI, API, SDK, GitHub, terminal, Claude Code, Cursor, webhooks and similar). Otherwise `no`. This picks which variant of the tutorial block you use.

**Word budget** (`{{WORD_BUDGET}}`), which the outline must be built for:
- List/Roundup with an item_count: `max(1500, item_count × 230)`
- Every other case: **1800** words (the default "10–12 minutes minimum" target). If Jake names a length in minutes, use `minutes × 150`.
- `{{MINUTES}}` = round(`{{WORD_BUDGET}}` / 150). For a Tool Review, `{{WORDS_PER_STORY}}` = round(`{{WORD_BUDGET}}` × 0.62 / 3 / 50) × 50.

**The system context.** Everything Jake's pipeline sends to every research and outline stage is in `references/01-system-context.md`: the voice rules, SOUL, the rule amendments, the approved lessons and the three human exemplar scripts. Read it once at the start and keep it in mind. It is why the outline has to be written for *this* channel.

## Stage 0.4: UI check in the browser (the newest evidence in the run)

Open the product yourself in agent mode and capture what is on screen **today**:

1. The vendor's own site. The pricing page first: capture it with the monthly/annual toggle in **each** state, and scroll so every tier is visible.
2. The screens this video will walk through: sign-up or onboarding, the dashboard, the feature screens named in the focus, and any settings or menus the steps need.
3. The changelog or "what's new" page, if there is one.

If a screen needs Jake's account, **pause and ask him to take over the browser and log in**. Never type his credentials and never create accounts on his behalf. If he declines, capture only what's public and list the rest as not shown.

Number your captures S1, S2, … in order. For each, note the URL and what you had just clicked (that becomes "Jake's note" for that shot). Then follow `references/10-stage0.4-ui-check.md` word for word, with these fills:
- `[TODAY'S DATE]` → `{{TODAY}}`, `[INSERT TOPIC]` → core_topic, `[INSERT TITLE]` → title.
- "Screenshots taken by Jake" means **your captures from today**. They carry the same authority.

The output is the **UI VERIFICATION** document. It must end with its SHOT LIST. Give that list to Jake too: it's what he can grab in 30 seconds if something's missing.

## Stage 1.6: The newest tutorials (the primary source for how the product works)

Follow `references/20-video-search.md`. It has the exact query rules and selection rules the pipeline uses. In short:
- Pick 2–3 YouTube searches that cover different **angles** (the product's name, the job it's used for, the thing it replaces). Add the word "tutorial" to each.
- Keep only videos **published in the last 3 months** (after `{{RECENT_WINDOW}}`), **at least 4 minutes long**, in **English**, and **not** promising money in the title.
- Relevance first: the video must actually SHOW this topic being done on screen. Views and recency only break ties. Take **at most 4**. Fewer is fine, and none is a correct answer.
- For each pick, open it in the browser. Open the transcript (description → "…more" → **Show transcript**) and copy it **with its timestamps**. Record title, channel, URL, publish date (YYYY-MM-DD) and view count.

Then follow `references/21-stage1.6-workflows.md` word for word: `[INSERT TOPIC]` → core_topic, and `[INSERT TRANSCRIPTS]` → the transcripts, each headed `V1`, `V2`, … with its title, channel, publish date, views and length. When selecting and extracting, apply the developer-workflow audience gate in `references/20-video-search.md` (unless developer workflow = yes).

The output is the **VIDEO WORKFLOWS** sheet. If nothing qualified, write `none` in both video sections of the pack and say why in one line.

## Stage 1: Web research

Build the research instruction in this order, then follow it:
1. `references/31-research-date-block.md` with the date fills.
2. `references/32-first-party-block.md` with the vendor's real domain(s). **Run those `site:` searches first.** Skip this block only if the topic isn't a product.
3. `references/30-stage1-research.md` word for word: type → video_type, title → title, topic → core_topic, focus → specific_focus (or "(none specified)"), `[Current date]` → `{{TODAY}}`.

Keep these in view while researching, as the pipeline does: the brief (`references/60-injected-blocks.md` § BRIEF), the UI VERIFICATION (§ UI CHECK) and, if you have a workflow sheet, § TUTORIALS plus § WHERE TO SPEND THE SEARCHES. **Don't re-research what the UI check or the videos already show.** Spend the searches on today's numbers, what changed recently, the NOT SHOWN gaps and the brief.

The output is the **RESEARCH** document. It has to include the WHAT CHANGED RECENTLY section and dated sources. Also list every page you actually opened in the pack's **SOURCES** section: one per line, `- Page title | https://url`.

## Stage 1.5: Fact sheet

Follow `references/40-stage1.5-factsheet.md` word for word. Fills: dates, title, the UI VERIFICATION, the VIDEO WORKFLOWS (or "(no recent video tutorials were found for this topic)"), the RESEARCH, and `[SOURCE PROVENANCE]`. For that last one, write one or two plain lines: how many of the SOURCES are on the vendor's own domain (name them) and how many are review, roundup or directory sites. If none are the vendor's, say so plainly.

The output is the **FACT SHEET**, with exactly the headings the prompt defines, including DO NOT CLAIM.

## Stage 2: Outline

Assemble the outline instruction exactly like the pipeline does, with parts separated by `---`:
1. **Tool Review only:** `references/60-injected-blocks.md` § SCRIPT STRUCTURE (fill `{{WORDS_PER_STORY}}`).
2. § OUTLINE FIDELITY (fill the dates, `{{WORD_BUDGET}}` and `{{MINUTES}}`).
3. § STEPS.
4. `references/50-stage2-outline.md` word for word. Replace `[SELECT ONE: …]` with video_type and `[INSERT VIDEO TITLE HERE]` with the title. Replace the whole `[PASTE YOUR RESEARCH HERE - …]` block with the RESEARCH document.

Keep the brief, the UI check and the tutorials blocks in view, as in Stage 1.

**Format rules the Script Generator depends on:**
- Each content section is a markdown heading (`##`, `###` or `####`), like the template's `#### ⏱️ SECTION NAME (0:30-2:00)`. The writer drafts one section per heading, so don't add headings inside a section except where the template itself has them. For a Tool Review, use only `##` (see § SCRIPT STRUCTURE).
- Every content section has an `ON SCREEN:` line saying what the viewer watches happen.
- Exact prices, click paths, labels and numbers are copied in **verbatim, with their dates**. The writer sees only this outline and the fact sheet.
- Anything unconfirmed is marked `[VERIFY ON SCREEN: …]` around the smallest detail, never around a whole step.

The output is the **OUTLINE**.

## Deliver the pack

Fill `templates/research-pack-template.md` exactly:
- Keep every `<<<MARKER>>>` line exactly as written, on its own line, with nothing else on it. The importer splits the file on those lines.
- Put each stage's output in full under its marker. **Do not summarise, trim or re-edit any of them.**
- Use `none` for a section you truly have nothing for (UI_VERIFICATION, VIDEO_SOURCES, VIDEO_WORKFLOWS only). RESEARCH, FACT_SHEET and OUTLINE are required, and the importer refuses a pack without them.
- `researched_on:` is today as YYYY-MM-DD.

Save it as a downloadable file named `research-pack-<short-slug>.md` and give Jake the download link. Then, in 3–5 lines, tell him: how many tutorials were used, whether the vendor's pricing page was captured live, how many `[VERIFY ON SCREEN]` markers the outline has, and the top items from the UI check's SHOT LIST.

He uploads the file in ClipMagic → Script Generator → **Import research from ChatGPT**.

## Self-check before you hand it over

- [ ] Every stage prompt was followed as written. Nothing paraphrased.
- [ ] The UI check cites `[S#]` on every line, and pricing shows the billing-toggle state.
- [ ] The workflow steps cite `[V# @ m:ss]`. No sentences were copied from transcripts, and no presenter is named.
- [ ] The research has WHAT CHANGED RECENTLY, and every price has a date.
- [ ] The fact sheet has DO NOT CLAIM, and review-site prices are labelled second-hand.
- [ ] The outline has ≥2 content headings, each with an ON SCREEN line, and it's sized for `{{WORD_BUDGET}}` words.
- [ ] No income claims, no punching down, and competitor mentions follow the sponsored/organic rule.
- [ ] Every marker line is present and untouched. The file is attached as a download.
