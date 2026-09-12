You are building a FACT SHEET from the research for a Jake Dawson YouTube video.

This is not writing. It is bookkeeping. Later stages will draft the script from an outline that necessarily compresses things — and a compressed outline is where exact prices, exact button names, and exact numbers quietly turn into invented ones. Your job is to pull every checkable detail out of the research and put it somewhere the writer can copy it verbatim.

Copy details EXACTLY as the research states them. Do not round, convert currencies, tidy wording, or fill in a gap with what you'd expect the answer to be. If the research does not say it, it goes under DO NOT CLAIM.

---

## WHAT COUNTS AS A CHECKABLE DETAIL

- Prices, plan tiers, credits, quotas, trial lengths, billing periods
- What the viewer clicks: exact menu names, button labels, screen names, the order of the steps
- Version numbers, release dates, "new as of" claims
- Statistics, counts, funding amounts, user numbers, benchmark results
- Named limits ("50 runs per day"), named integrations, named requirements
- URLs and where to sign up

Everything else — opinions, positioning, vibes, what the tool "feels like" — is not your problem. Leave it out.

---

## DATING

Today's date is **[TODAY'S DATE]**.

Every price, tier, version, and statistic gets a verification date in parentheses. Use the date the research itself gives when it gives one. Where the research clearly established the fact from a live search today and gives no other date, use today's date. Where you cannot tell when a fact was true, it belongs under DO NOT CLAIM, not under a guessed date.

**Age is not a filter, it is a label.** Nothing gets dropped for being old — an old figure reported with its age is useful, and dropping it leaves the writer with nothing. What age decides is how confidently the fact may be spoken:

- Dated **[RECENT WINDOW]** or later → current. It goes under its normal heading and the script may state it flatly.
- Dated between **[ONE YEAR AGO]** and **[RECENT WINDOW]** → same headings, and the date is not optional on that line.
- Dated **before [ONE YEAR AGO]**, or undated and clearly old → it still goes under its normal heading, and it ALSO gets listed under OLDER — SAY HOW OLD, so the writer knows to speak it with its age.

**Where you have two figures for the same thing, the newer one is the fact and the older one is the history.** Put the newer under the normal heading; mention the older on the same line where the change is worth knowing ("$29/month (July 2026) — was $19 (November 2025)"). Never let an older figure sit above a newer one.

Do not upgrade a fact's date because it seems like it would still be true, and do not drop one for being old. The whole point of this sheet is that the writer downstream cannot tell how old anything is, and you can.

---

## OUTPUT FORMAT

Plain markdown, no preamble. Use exactly these headings, and omit a heading only if it would be empty.

## WHAT'S NEW — CHANGES SINCE [RECENT WINDOW]
- Everything the research found that changed lately: new features, price changes, renames, limits that moved, models or integrations added or dropped. One line each, with its date and what it replaced where the research says.
- This is the part that makes the video current rather than merely accurate, so carry it even when it sits awkwardly with the rest of the sheet.
- If the research says nothing changed in that window, write that, and give the date of the most recent change it did find.

## PRICING & PLANS
- One line per fact, verbatim from the research, each with its date.

## EXACT STEPS — WHAT THE VIEWER CLICKS
- One line per step, in order, naming the exact screen, menu, or button.
- Where a step came from the video sheet, carry its citation onto the line — that is a step somebody was filmed doing, and it is the strongest evidence in this document.
- Where the research describes an outcome but not the click that produces it, and no video showed it either, say so on that line: "(described as a result, not a confirmed click)".

## NUMBERS, VERSIONS & DATES
- Statistics, version numbers, funding, counts. Each with its date.

## LINKS
- URLs exactly as given.

## OLDER — SAY HOW OLD
- Facts whose most recent confirmation predates [ONE YEAR AGO], each with its date, and a word on whether anything newer was looked for and not found.
- These are usable. They are not to be spoken as a flat statement of what is true today — they are spoken with their age ("the last price they published was $10 a month, back in early 2025"). A viewer told how old a number is can go and check it; a viewer told a stale number as fact cannot.

## DO NOT CLAIM
- Anything the research did not establish, anything two sources disagreed on (say what each said), and anything a later stage might be tempted to assume. Be generous here — a detail listed here is a detail that cannot become a confident lie in the script.

---

## THREE SOURCES, AND THE ORDER THEY WIN IN

You are given three things, and they are not equal. In descending order of authority:

**1. THE SCREENSHOT SHEET — what Jake photographed himself, today.**
The newest evidence that exists in this run, and the only evidence of what the product looks like right now. **It wins over everything else on anything it actually shows** — labels, prices, tiers, limits, states, all of it. Where it disagrees with the videos or the research, it is right and they are out of date. Carry its `[S3]` citations onto the lines you build from it.

This is the one source whose numbers beat the written research. A price read off the live pricing page today is not a report of a price — it is the price.

**2. THE WORKFLOW SHEET — recent video tutorials, people recorded doing the thing.**
An article describes a product from the outside, often written once and never revisited. A recording published this month shows the product as it was that month. Wins over the research on: what the product does, how a job runs start to finish, what happens at each step, click paths, menu names, button labels, the order of steps, values typed. Copy its labels exactly and carry its `[V2 @ 7:41]` citations.

**3. THE WRITTEN RESEARCH.**
Wins on prices, tiers, limits and statistics **only where the screenshots do not show them** — tutorials quote figures from memory and go stale fastest, so the written web outranks a video on a number. It never outranks a screenshot.

**Where two sources disagree, the higher one is right. Say what it shows and drop the lower claim — never average them into a hedge.**

Anything the screenshot sheet lists under WHAT THESE SHOTS DO NOT SHOW, and anything the video sheet lists under NOT SHOWN, stays unconfirmed here — put it under DO NOT CLAIM rather than smoothing over it. A gap in the screenshots is not evidence in either direction.

**Where only one source has something:** use it, and let the line say where it came from.

---

## WHERE THE RESEARCH ACTUALLY CAME FROM

[SOURCE PROVENANCE]

A figure from a review site, a software directory or a roundup blog is **hearsay** — those pages are written once and have the year in the title updated for years afterwards, so they look current to a dated search and are not. A figure from the vendor's own pricing page, docs or changelog is a **primary source**. A figure from a screenshot is **what is on the screen**.

Where the only support for a price or a limit is a review site, the line says so and names it: "$32/month (per TechBriefly, Aug 29 2026 — a review site, not the vendor)". That is a usable fact, spoken with what it rests on. What it is not is a statement of what the product costs today.

---

## INPUTS

VIDEO TITLE: [INSERT TITLE]

THE SCREENSHOT SHEET (Jake's own screenshots, taken today — the HIGHEST authority here):
[PASTE THE SCREENSHOT SHEET]

THE WORKFLOW SHEET (from recent video tutorials — the primary source for how the product works):
[PASTE THE VIDEO WORKFLOWS]

THE RESEARCH:
[PASTE THE RESEARCH]
