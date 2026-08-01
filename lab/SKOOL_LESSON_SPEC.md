# Skool lesson specification

What a lesson in the rebuilt classroom must be. Written from Jake's requirements
on 2026-07-31; **§6 lists what is still open** and must be settled before 136
lessons are authored against this.

Authoring happens **in advance, by agents on Jake's Max plan**. The lab makes no
API calls of its own for this; browser automation only *places* the finished
text. Nothing here is billed to API credits.

---

## 1. The asset comes first

**If a lesson has a prompt or a template the member needs, it goes at the very
top of the page** — above the explanation, above the promise, above everything
except the title. The member should be able to land on the page, copy the thing,
and leave, without reading a word.

    # Lesson title

    ## Copy this first

    ```
    <the full prompt or template, ready to paste>
    ```

    One line on what to swap. Then the tutorial begins.

Why it is first and not at the end: the member who already understands the
lesson wants the asset, and the member who doesn't will read on anyway. Putting
it last serves neither. This also matches how Jake's own best write-ups already
open (`=== TLDR — THE ASSET ===`).

> **Download:** Jake asked for "copy or download". Copy works today — a fenced
> block renders as a code block and is selectable. **Download does not**: it
> needs a file attached to the page, which this write path cannot do yet. Flagged
> rather than quietly dropped.

## 2. The journey

After the asset, every lesson runs the same arc:

| # | Section | What it does |
|---|---|---|
| 1 | The promise | One paragraph: what you'll be able to DO by the end, concretely |
| 2 | Why it matters | The cost of not knowing it — time, money, or output quality |
| 3 | What you need first | Tools, accounts, cost. Plainly, no fake urgency |
| 4 | The method | Step by step, each step its own `###`, in the order a person does them |
| 5 | A worked example | The method run once end to end, real inputs, real output |
| 6 | What usually goes wrong | The two or three mistakes that make it fail |
| 7 | Your next move | One specific action to take now |

## 3. Formatting

Lessons are authored in **markdown**; the converter (`skool/bodyHtml.ts`) turns
it into the HTML that gets pasted into Skool.

| Element | Authored as | Rendered as |
|---|---|---|
| Lesson title | **do not write one** — Skool renders the page title itself | — |
| Section | `## Section` | `<h2>` |
| Sub-step | `### Step` | `<h3>` |
| A principle or rule | `**bold**` | `<strong>` |
| A prompt or template | ` ``` ` fenced | `<pre><code>` |
| Bullets | `- item` | `<ul>` |
| Numbered steps | `1. item` | `<ol>` |

**A lesson starts at `##`.** Skool prints the page title above the body, so a
body that opens with `# Prompting Google Gemini` shows the title twice, one line
apart. The write path strips a leading `#` heading defensively, but authors
should not write one in the first place.

Two rules the converter enforces:

- **Bold is for principles, never for titles.** A heading is a heading; bolding
  one produces a page where nothing stands out because everything does.
- **A fenced block is verbatim.** Line breaks, blank lines and `[BRACKETS]` are
  content. `**stars**` inside a template stay literal — the member is copying a
  prompt, not reading prose.

## 4. Voice, length and substance

- **Around 10,000 characters**, explained in **bar-Jake voice**: the way Jake
  would explain it to someone across a bar table — plain, direct, easy to follow.
  Long because it is thorough, never long because it is padded.
- Jake's voice, grounded in his two longest existing write-ups
  (*The Complete AI Marketing Playbook for 2026*, *Google Nano Banana Pro
  Prompting Guide*).
- Audience: **sales people and business owners**, not engineers.
- No filler, no "in today's fast-paced world", no padding to look thorough.

## 4a. The video is not automatic

**Attach the video only when it is genuinely about this lesson. If nothing
relevant exists, the page has no video** (Jake, 2026-07-31). A page carrying a
video about something else is worse than a page with none: it tells the member
the classroom was assembled carelessly.

The lesson text references the video **only when one is attached**. A page with
no video must read as complete on its own — no "as I show above" left dangling.

> ⚠️ **THIS IS A JUDGEMENT CALL AND MUST STAY ONE.** An automated title-overlap
> check was tried on the six required courses and failed in both directions: it
> MISSED *Extending Claude with MCP tools* carrying "7 WILD Things Claude Can Do
> With **Higgsfield**" (both titles say "Claude", so they overlapped), and it
> FALSE-FLAGGED *Making AI UGC ads*, whose video is "How to Make AI UGC Ads in
> 2026" — an exact match. The authoring agent decides per lesson, from the video's
> title and transcript, and states which way it went and why.

## 5. Hard rules

- **Never an empty or near-empty page.** A page with no video and a body under
  200 characters is refused. Sixty of the old classroom's 123 modules were a
  title and nothing else; that is the defect this rebuild exists to remove.
- **Never delete a course.** Jake removes the old ones himself (2026-07-31).
- The 4 pages already written in *How to Write The Best Prompts* are **rewritten
  in place**, not deleted and recreated.

## 6. Scope

**The six required courses first** — 60 lessons — then the remaining nine
courses once the methodology has proved itself (Jake, 2026-07-31):

| Course | Lessons |
|---|---|
| How to Write The Best Prompts | 10 |
| Make Images with AI | 10 |
| Make Videos with AI | 10 |
| Build Apps with AI | 10 |
| AI Productivity Tools | 10 |
| Marketing With AI | 10 |

## 7. Settled (2026-07-31)

- The §2 arc: **approved as written**.
- Length: **~10,000 characters**, bar-Jake voice.
- Video: **only when relevant**; no relevant video means no video, and no
  reference to one in the text.
- Scope: **six required courses first**.

## 8. Still open

1. **Does Skool's editor accept a pasted code block as a real code block**, or
   flatten it to plain text? Untested, and §1 — the copyable asset at the top of
   every page — depends entirely on it. Must be tested on a single page before
   sixty lessons are authored around it.
2. **Download.** §1 says "copy or download"; only copy is currently possible.
   Attaching a file to a page is unimplemented.
